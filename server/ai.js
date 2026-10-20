import Anthropic from '@anthropic-ai/sdk';
import { extractText, getDocumentProxy } from 'unpdf';

// AI_PROVIDER: one or more of anthropic, openrouter, gemini, azure, llamacpp, comma-separated and tried in order.
// All but anthropic share the OpenAI-compatible chat/completions path.
const KNOWN = ['anthropic', 'openrouter', 'gemini', 'azure', 'llamacpp'];
export const PROVIDERS = (process.env.AI_PROVIDER || 'anthropic').split(',').map((p) => p.trim()).filter((p) => KNOWN.includes(p));
if (!PROVIDERS.length) PROVIDERS.push('anthropic');
export const PROVIDER = PROVIDERS.join(',');
const list = (v, fallback = '') => (v || fallback).split(',').map((m) => m.trim()).filter(Boolean);
const LLAMACPP_URL = (process.env.LLAMACPP_URL || 'http://localhost:8080').replace(/\/$/, '');
const LLAMACPP_TIMEOUT_MS = Number(process.env.LLAMACPP_TIMEOUT_MIN || 30) * 60_000;
const AZURE_ENDPOINT = (process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/$/, '');
const OPENAI_COMPAT = {
  llamacpp: {
    name: 'LLM locale',
    url: `${LLAMACPP_URL}/v1/chat/completions`,
    headers: {},
    // Reasoning models (Qwen3…) can spend the whole token budget thinking before the JSON: off for structured output.
    models: [undefined], // llama-server serves whatever model it loaded
    extra: (schema) => (schema ? { chat_template_kwargs: { enable_thinking: false } } : {}),
  },
  openrouter: {
    name: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'X-Title': 'DailyMeal' },
    // Comma-separated list, tried in order: free models come and go, so a failure moves on to the next one.
    models: list(process.env.OPENROUTER_MODEL, 'nvidia/nemotron-3-super-120b-a12b:free,nvidia/nemotron-3.5-super-vl:free'),
    // require_parameters: route only to providers that honour response_format (JSON schema).
    // Long silent reasoning before the JSON trips OpenRouter's upstream idle timeout: off for structured output.
    extra: (schema, model) => ({
      model,
      provider: { require_parameters: true },
      ...(schema && { reasoning: { enabled: false } }),
    }),
  },
  gemini: {
    name: 'Google Gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    headers: { Authorization: `Bearer ${process.env.GEMINI_API_KEY}` },
    models: list(process.env.GEMINI_MODEL, 'gemini-flash-latest'),
    extra: (schema, model) => ({ model }),
  },
  azure: {
    name: 'Azure OpenAI',
    // v1 API: the model is the deployment name, no api-version needed.
    url: `${AZURE_ENDPOINT}/openai/v1/chat/completions`,
    headers: { 'api-key': process.env.AZURE_OPENAI_API_KEY },
    models: list(process.env.AZURE_OPENAI_DEPLOYMENT),
    // Reasoning deployments (o-series, gpt-5) reject max_tokens and a custom temperature.
    limits: (maxTokens) => ({ max_completion_tokens: maxTokens }),
    extra: (schema, model) => ({ model }),
  },
};
const client = PROVIDERS.includes('anthropic') ? new Anthropic() : null; // reads ANTHROPIC_API_KEY
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
export const SLOTS = ['colazione', 'spuntino', 'pranzo', 'merenda', 'cena'];

// --- JSON schemas (structured outputs require additionalProperties:false + required on every object)
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const str = { type: 'string' };
const strs = { type: 'array', items: str };
const item = obj({ options: { ...strs, description: 'alternative separate da "oppure", ognuna con grammatura' }, optional: { type: 'boolean', description: 'true se FACOLTATIVO' } });
const items = { type: 'array', items: item };
const slot = { type: 'string', enum: SLOTS, description: 'spuntino = metà mattina (tra colazione e pranzo); merenda = pomeriggio (tra pranzo e cena), anche se il piano la chiama "spuntino"' };
const OUT_KINDS = ['lavoro', 'ristorante', 'entrambi'];

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
    description: 'pasti validi per tutti i giorni (es. colazione dolce/salata, merenda), ESCLUSI lo spuntino pre/post allenamento (va in workout_snack) e il pranzo al lavoro/mensa (va in eating_out). Nei giorni che rimandano a questi (es. "vedi pagina 6") lascia items vuoti',
    items: obj({ name: str, slot, items }),
  },
  workout_snack: { ...items, description: 'spuntino pre/post allenamento; [] se assente' },
  eating_out: {
    type: 'array',
    description: 'indicazioni per pasti fuori casa; [] se assenti',
    items: obj({ name: str, kind: { type: 'string', enum: OUT_KINDS, description: 'lavoro = pranzo in ufficio/mensa/bar; ristorante = ristorante, pizza, sushi, aperitivo; entrambi = valido in tutti e due i casi' }, items }),
  },
  free_meal: obj({ weekday: { type: 'integer', description: '0 se assente' }, slot: { type: 'string', enum: [...SLOTS, ''] }, rule: str }),
  glossary: { type: 'array', description: 'definizioni categorie (pesce magro, carne magra, verdura...) con esempi', items: obj({ term: str, definition: str }) },
  tips: { ...strs, description: 'consigli e regole generali, brevi e autonomi (idratazione, cotture, reflusso, peso...)' },
  sport_tips: { ...strs, description: 'consigli legati all\'attività fisica; [] se assenti' },
});

/** Menu schema where every food must be one of the plan's own options (enum), so the model can't invent ingredients. */
function menuSchema(plan) {
  const options = [...new Set([...plan.days.flatMap((d) => d.meals), ...plan.shared_meals]
    .flatMap((m) => m.items.flatMap((i) => i.options)))];
  const pick = obj({
    option: { type: 'string', enum: options, description: 'alternativa del piano, copiata identica' },
    detail: { ...str, description: `specifica breve dell'alimento scelto (es. "riso basmati", "zucchine"), "" se non serve. Nessun ingrediente aggiuntivo` },
  });
  return obj({
    days: {
      type: 'array',
      items: obj({
        date: str,
        meals: {
          type: 'array',
          items: obj({ slot, title: { ...str, description: 'nome breve del piatto, composto solo dagli alimenti scelti' }, items: { type: 'array', items: pick }, free: { type: 'boolean' } }),
        },
      }),
    },
  });
}

/** Tries each configured provider in order (each with its own model list) until one answers. */
async function call(args) {
  let lastError;
  for (const p of PROVIDERS) {
    try {
      return await (p === 'anthropic' ? callClaude(args) : callOpenAICompat(OPENAI_COMPAT[p], args));
    } catch (e) {
      lastError = e;
      if (PROVIDERS.length > 1) console.warn(`[ai] ${p} fallito: ${e.message}`);
    }
  }
  throw lastError;
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

/** OpenAI-compatible endpoints get the PDF as extracted text, not as a document block. */
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

/**
 * Tries each configured model in turn. App-side rather than OpenRouter's own `models` fallback,
 * which can't help once streaming has started (idle timeouts, invalid JSON mid-answer).
 */
async function callOpenAICompat(api, args) {
  const { models, name } = api;
  if (!models.length) throw new Error(`${name}: nessun modello configurato`);
  const userText = await toText(args.content);
  let lastError;
  for (const model of models) {
    try {
      return await callOnce(api, { ...args, userText }, model);
    } catch (e) {
      lastError = e;
      if (models.length > 1) console.warn(`[ai] ${name} ${model} fallito: ${e.message}`);
    }
  }
  throw models.length > 1 ? new Error(`Nessun modello disponibile (${models.length} provati). Ultimo errore: ${lastError.message}`) : lastError;
}

// Streams so slow generations aren't killed by fetch's 5-minute headers timeout.
async function callOnce(api, { system, userText, schema, maxTokens = 32000 }, model) {
  const res = await fetch(api.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...api.headers },
    signal: AbortSignal.timeout(LLAMACPP_TIMEOUT_MS),
    body: JSON.stringify({
      messages: [{ role: 'system', content: system }, { role: 'user', content: userText }],
      ...(api.limits ? api.limits(maxTokens) : { max_tokens: maxTokens, temperature: schema ? 0.4 : 0.6 }),
      stream: true,
      ...api.extra(schema, model),
      ...(schema && { response_format: { type: 'json_schema', json_schema: { name: 'output', strict: true, schema } } }),
    }),
  }).catch((e) => { throw new Error(`${api.name} non raggiungibile: ${e.message}`); });
  if (res.status === 429) throw new Error(`${api.name}: limite di richieste raggiunto, riprova più tardi`);
  if (!res.ok) throw new Error(`${api.name}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);

  let text = '', buf = '', finish = null;
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
      const event = JSON.parse(line.slice(5));
      if (event.error) throw new Error(`${api.name}: ${event.error.message || 'errore durante la generazione'}`);
      const choice = event.choices?.[0];
      text += choice?.delta?.content || '';
      finish = choice?.finish_reason || finish;
    }
  }
  if (finish === 'length') throw new Error(`Risposta di ${api.name} troncata: serve un modello con più contesto`);
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!schema) return text;
  try { return JSON.parse(text); } catch { throw new Error(`${api.name} ha restituito JSON non valido: prova un altro modello`); }
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
// Idempotent: also applied when reading plans saved before a fix.
export function cleanPlan(plan) {
  const workout = /allenament|workout/i;
  const atWork = /lavoro|mensa|ufficio/i;
  const shared = plan.shared_meals.filter((m) => !(workout.test(m.name) && plan.workout_snack.length) && !atWork.test(m.name));
  const sharedSlots = new Set(shared.map((m) => m.slot));
  // A day item like "COLAZIONE DOLCE (vedi pagina 6)" is a pointer to the shared meals, not a food.
  const isPointer = (i) => i.options.every((o) => /vedi|pagina|pag\.|\b(colazione|merenda)\b/i.test(o) && !/\d+\s*g\b/i.test(o));
  const guessKind = (name) => (atWork.test(name) ? 'lavoro' : /ristorante|pizz|sushi|aperitiv|cinese|pok|pasto preferito/i.test(name) ? 'ristorante' : 'entrambi');
  return {
    ...plan,
    eating_out: [
      ...plan.shared_meals.filter((m) => atWork.test(m.name)).map(({ name, items }) => ({ name, kind: 'lavoro', items })),
      ...plan.eating_out.map((o) => ({ ...o, kind: OUT_KINDS.includes(o.kind) ? o.kind : guessKind(o.name) })),
    ],
    shared_meals: shared,
    days: plan.days.map((d) => ({
      ...d,
      meals: d.meals.map((m) => (sharedSlots.has(m.slot) && m.items.every(isPointer) ? { ...m, items: [] } : m)),
    })),
  };
}

// Names (person, nutritionist) and dates aren't needed to plan meals: keep them out of every prompt.
const planForPrompt = ({ title, author, valid_from, ...rest }) => JSON.stringify(rest);

const MAX_FAVORITES_IN_PROMPT = 20;

/**
 * @param {object} plan @param {string[]} dates YYYY-MM-DD
 * @param {Array<{slot:string, weekday:number, title:string, items:string[]}>} favorites meals the user liked
 * @param {string[]} excluded foods the user must avoid (intolerances)
 * @param {Array<{date:string, meals:{slot:string,title:string,items:string[]}[]}>} household the housemate's home meals on the same dates
 * Returns raw model output: callers must pass each meal through guard.sanitizeMeal.
 */
export async function generateMenu(plan, dates, favorites = [], excluded = [], household = []) {
  const days = dates.map((d) => `${d} (weekday ${isoWeekday(d)})`).join('\n');
  const favs = favorites.slice(0, MAX_FAVORITES_IN_PROMPT)
    .map((f) => `- ${f.slot}, weekday ${f.weekday}: ${f.title} (${f.items.join(', ')})`).join('\n');
  const shared = household.flatMap((d) => d.meals.map((m) => `- ${d.date} ${m.slot}: ${m.title} (${m.items.join(', ')})`)).join('\n');
  const houseRule = shared
    ? `\n\nA casa mangia anche un convivente con un piano diverso. Questi sono i suoi pranzi e cene: quando il TUO piano lo permette, per lo stesso giorno e pasto scegli alternative e dettagli con gli stessi ingredienti principali (stessa verdura, stessa proteina, stesso cereale) e un titolo simile, così si cucina una volta sola. Grammature e alternative restano solo quelle del tuo piano:
${shared}`
    : '';
  const favRule = favs
    ? `\n\nCombinazioni che piacciono all'utente: riproponine alcune (1-3 a settimana), identiche, solo nello stesso pasto e, per pranzo e cena, nello stesso weekday (colazione e merenda vanno bene in qualsiasi giorno):\n${favs}`
    : '';
  const { days: out } = await call({
    system: 'Sei un nutrizionista-cuoco. Trasformi un piano alimentare in un menu concreto, vario e realistico per la cucina di casa italiana.',
    content: `Piano (JSON):\n${planForPrompt(plan)}\n\nCrea il menu per questi giorni:\n${days}

Regole:
- Per ogni giorno usa lo schema del suo weekday; per i pasti che rimandano a shared_meals scegli tra quelli.
- Per ogni alimento obbligatorio scegli UNA alternativa: "option" deve essere copiata identica dal piano. Includi i facoltativi solo se ci stanno bene.
- "detail" serve solo a specificare l'alternativa scelta (es. quale cereale, quale verdura o frutta di stagione). NON aggiungere ingredienti, salse o condimenti che il piano non prevede.
- Varia le scelte tra i giorni (stessa alternativa al massimo 2 volte a settimana), usa frutta e verdura di stagione per la data.
- "title" è il nome del piatto composto SOLO dagli alimenti scelti (es. "Riso basmati con zucchine").${excluded.length ? `
- L'utente NON può mangiare: ${excluded.join(', ')}. Non scegliere mai alternative che li contengono.` : ''}
- Pasto libero: free=true, title "Pasto libero", items [].
- Non aggiungere lo spuntino pre/post allenamento: lo gestisce l'app.${favRule}${houseRule}`,
    schema: menuSchema(plan),
  });
  return out;
}

export function ask(plan, context, question) {
  return call({
    system: `Sei l'assistente del piano alimentare dell'utente. Rispondi in italiano, in modo breve e pratico (max ~120 parole), basandoti SOLO sul piano qui sotto e sulla giornata corrente. Se la domanda esce dal piano o riguarda sintomi/salute, suggerisci di sentire il nutrizionista. Formattazione: solo frasi brevi, elenchi con "- " e **grassetto**; niente tabelle né titoli.\n\nPIANO:\n${planForPrompt(plan)}`,
    content: `Giornata corrente:\n${JSON.stringify(context)}\n\nDomanda: ${question}`,
    maxTokens: 4000,
    effort: 'low',
  });
}

export const isoWeekday = (date) => new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
