import Anthropic from '@anthropic-ai/sdk';
import { extractText, getDocumentProxy } from 'unpdf';

// AI_PROVIDER: "anthropic" (default) or "llamacpp" (llama-server on the LAN, OpenAI-compatible API).
export const PROVIDER = process.env.AI_PROVIDER === 'llamacpp' ? 'llamacpp' : 'anthropic';
const LLAMACPP_URL = (process.env.LLAMACPP_URL || 'http://localhost:8080').replace(/\/$/, '');
const LLAMACPP_TIMEOUT_MS = Number(process.env.LLAMACPP_TIMEOUT_MIN || 30) * 60_000;
const client = PROVIDER === 'anthropic' ? new Anthropic() : null; // reads ANTHROPIC_API_KEY
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
export const SLOTS = ['colazione', 'spuntino', 'pranzo', 'merenda', 'cena'];

// --- JSON schemas (structured outputs require additionalProperties:false + required on every object)
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const str = { type: 'string' };
const strs = { type: 'array', items: str };
const item = obj({ options: { ...strs, description: 'alternative separate da "oppure", ognuna con grammatura' }, optional: { type: 'boolean', description: 'true se FACOLTATIVO' } });
const items = { type: 'array', items: item };
const slot = { type: 'string', enum: SLOTS };

const PLAN_SCHEMA = obj({
  title: str,
  author: { ...str, description: 'nutrizionista/medico, "" se assente' },
  valid_from: { ...str, description: 'YYYY-MM-DD o ""' },
  days: {
    type: 'array',
    description: 'una voce per giorno della settimana previsto dal piano. Se il piano non distingue i giorni, ripeti lo stesso schema per 1..7',
    items: obj({
      weekday: { type: 'integer', description: '1=lunedì ... 7=domenica' },
      meals: { type: 'array', items: obj({ slot, free: { type: 'boolean', description: 'pasto libero' }, items }) },
    }),
  },
  shared_meals: {
    type: 'array',
    description: 'pasti validi per tutti i giorni (es. colazione dolce/salata, merenda), ESCLUSO lo spuntino pre/post allenamento che va solo in workout_snack. Nei giorni che rimandano a questi (es. "vedi pagina 6") lascia items vuoti',
    items: obj({ name: str, slot, items }),
  },
  workout_snack: { ...items, description: 'spuntino pre/post allenamento; [] se assente' },
  eating_out: { type: 'array', description: 'indicazioni per pasti fuori/mensa/ristorante; [] se assenti', items: obj({ name: str, items }) },
  free_meal: obj({ weekday: { type: 'integer', description: '0 se assente' }, slot: { type: 'string', enum: [...SLOTS, ''] }, rule: str }),
  glossary: { type: 'array', description: 'definizioni categorie (pesce magro, carne magra, verdura...) con esempi', items: obj({ term: str, definition: str }) },
  tips: { ...strs, description: 'consigli e regole generali, brevi e autonomi (idratazione, cotture, reflusso, peso...)' },
  sport_tips: { ...strs, description: 'consigli legati all\'attività fisica; [] se assenti' },
});

const MENU_SCHEMA = obj({
  days: {
    type: 'array',
    items: obj({
      date: str,
      meals: {
        type: 'array',
        items: obj({ slot, title: { ...str, description: 'nome del piatto, breve' }, items: { ...strs, description: 'alimenti concreti con grammature' }, free: { type: 'boolean' } }),
      },
    }),
  },
});

function call(args) {
  return PROVIDER === 'llamacpp' ? callLlamaCpp(args) : callClaude(args);
}

async function callClaude({ system, content, schema, maxTokens = 64000, effort = 'medium' }) {
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content }],
    output_config: { effort, ...(schema && { format: { type: 'json_schema', schema } }) },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('Richiesta rifiutata dal modello');
  if (msg.stop_reason === 'max_tokens') throw new Error('Risposta troncata (max_tokens)');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return schema ? JSON.parse(text) : text;
}

/** Local models can't read PDFs: turn document blocks into plain text. */
async function toText(content) {
  if (typeof content === 'string') return content;
  const parts = await Promise.all(content.map(async (b) => {
    if (b.type !== 'document') return b.text;
    const pdf = await getDocumentProxy(new Uint8Array(Buffer.from(b.source.data, 'base64')));
    const { text } = await extractText(pdf, { mergePages: true });
    if (!text.trim()) throw new Error('Il PDF non contiene testo (è una scansione?): serve Claude per leggerlo');
    return `<documento>\n${text}\n</documento>`;
  }));
  return parts.join('\n\n');
}

// Streams so slow local generations aren't killed by fetch's 5-minute headers timeout.
async function callLlamaCpp({ system, content, schema, maxTokens = 32000 }) {
  const res = await fetch(`${LLAMACPP_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(LLAMACPP_TIMEOUT_MS),
    body: JSON.stringify({
      messages: [{ role: 'system', content: system }, { role: 'user', content: await toText(content) }],
      max_tokens: maxTokens,
      temperature: schema ? 0.4 : 0.6,
      stream: true,
      // Reasoning models (Qwen3…) can spend the whole token budget thinking before the JSON: off for structured output.
      ...(schema && { chat_template_kwargs: { enable_thinking: false } }),
      ...(schema && { response_format: { type: 'json_schema', json_schema: { name: 'output', strict: true, schema } } }),
    }),
  }).catch((e) => { throw new Error(`LLM locale non raggiungibile su ${LLAMACPP_URL}: ${e.message}`); });
  if (!res.ok) throw new Error(`LLM locale: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);

  let text = '', buf = '', finish = null;
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
      const choice = JSON.parse(line.slice(5)).choices?.[0];
      text += choice?.delta?.content || '';
      finish = choice?.finish_reason || finish;
    }
  }
  if (finish === 'length') throw new Error('Risposta del LLM locale troncata: aumenta il contesto (-c) di llama-server');
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!schema) return text;
  try { return JSON.parse(text); } catch { throw new Error('Il LLM locale ha restituito JSON non valido'); }
}

export async function parsePlan(pdfBase64) {
  return cleanPlan(await call({
    system: 'Sei un assistente che digitalizza piani alimentari redatti da nutrizionisti. Trascrivi fedelmente: non inventare alimenti né cambiare grammature.',
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
      { type: 'text', text: 'Estrai questo piano alimentare nello schema richiesto. Mantieni gli alimenti in italiano come scritti.' },
    ],
    schema: PLAN_SCHEMA,
  }));
}

/** Fixes what smaller models get wrong despite the schema descriptions. */
export function cleanPlan(plan) {
  const workout = /allenament|workout/i;
  const shared = plan.shared_meals.filter((m) => !(workout.test(m.name) && plan.workout_snack.length));
  const sharedSlots = new Set(shared.map((m) => m.slot));
  // A day item like "COLAZIONE DOLCE (vedi pagina 6)" is a pointer to the shared meals, not a food.
  const isPointer = (i) => i.options.every((o) => /vedi|pagina|pag\.|\b(colazione|merenda)\b/i.test(o) && !/\d+\s*g\b/i.test(o));
  return {
    ...plan,
    shared_meals: shared,
    days: plan.days.map((d) => ({
      ...d,
      meals: d.meals.map((m) => (sharedSlots.has(m.slot) && m.items.every(isPointer) ? { ...m, items: [] } : m)),
    })),
  };
}

/** @param {object} plan @param {string[]} dates YYYY-MM-DD */
export async function generateMenu(plan, dates) {
  const days = dates.map((d) => `${d} (weekday ${isoWeekday(d)})`).join('\n');
  const { days: out } = await call({
    system: 'Sei un nutrizionista-cuoco. Trasformi un piano alimentare in un menu concreto, vario e realistico per la cucina di casa italiana.',
    content: `Piano (JSON):\n${JSON.stringify(plan)}\n\nCrea il menu per questi giorni:\n${days}

Regole:
- Per ogni giorno usa lo schema del suo weekday; per i pasti che rimandano a shared_meals scegli tra quelli.
- Per ogni alimento obbligatorio scegli UNA alternativa, rispettando esattamente le grammature. Includi i facoltativi solo se ci stanno bene.
- Varia le scelte tra i giorni (stessa alternativa al massimo 2 volte a settimana), usa frutta e verdura di stagione per la data.
- "title" è un piatto concreto (es. "Riso basmati con zucchine e pesto"), "items" la lista pesata degli ingredienti.
- Pasto libero: free=true, title "Pasto libero", items [].
- Non aggiungere lo spuntino pre/post allenamento: lo gestisce l'app.`,
    schema: MENU_SCHEMA,
  });
  return out;
}

export function ask(plan, context, question) {
  return call({
    system: `Sei l'assistente del piano alimentare dell'utente. Rispondi in italiano, in modo breve e pratico (max ~120 parole), basandoti SOLO sul piano qui sotto e sulla giornata corrente. Se la domanda esce dal piano o riguarda sintomi/salute, suggerisci di sentire il nutrizionista.\n\nPIANO:\n${JSON.stringify(plan)}`,
    content: `Giornata corrente:\n${JSON.stringify(context)}\n\nDomanda: ${question}`,
    maxTokens: 4000,
    effort: 'low',
  });
}

export const isoWeekday = (date) => new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
