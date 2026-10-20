// Plans converted outside the app (Claude, ChatGPT…): the prompt to use and a strict check of what comes back.
import { PLAN_SCHEMA, cleanPlan } from './ai.js';

export const MAX_IMPORT_BYTES = 1_000_000;

export const planPrompt = () => `Ti allego il mio piano alimentare (PDF). Convertilo in JSON seguendo ESATTAMENTE lo schema qui sotto.

Regole:
- Trascrivi fedelmente: non inventare alimenti e non cambiare le grammature.
- Ogni alimento obbligatorio è un elemento di "items"; le alternative separate da "oppure" vanno in "options"; "optional": true per gli alimenti FACOLTATIVI.
- Ogni alimento deve avere la sua grammatura o quantità, come scritta nel piano (es. "100g Pasta", "2 Uova").
- Se il piano indica le porzioni per pasto valide tutti i giorni (es. "Pranzo: 100g cereali oppure…"), mettile in "shared_meals" e lascia vuoti gli "items" dei giorni.
- Un eventuale "menù di esempio" o "menù settimanale tipo" senza grammature NON va in "days": riportalo al massimo come voce del "glossary".
- weekday: 1 = lunedì … 7 = domenica. "slot" solo tra: colazione, spuntino, pranzo, merenda, cena (spuntino = metà mattina, merenda = pomeriggio).
- Rispondi SOLO con il JSON, senza testo prima o dopo.

SCHEMA:
${JSON.stringify(PLAN_SCHEMA, null, 1)}`;

const DEFAULTS = { object: () => ({}), array: () => [], string: () => '', integer: () => 0, boolean: () => false };

/** Rebuilds `value` following the schema: unknown keys dropped, missing fields defaulted, wrong types reported. */
function coerce(schema, value, path, errors) {
  if (errors.length >= 8) return undefined;
  const v = value === undefined || value === null ? DEFAULTS[schema.type]() : value;
  switch (schema.type) {
    case 'object':
      if (typeof v !== 'object' || Array.isArray(v)) return errors.push(`${path}: atteso un oggetto`), undefined;
      return Object.fromEntries(Object.entries(schema.properties).map(([k, s]) => [k, coerce(s, v[k], `${path}.${k}`, errors)]));
    case 'array':
      if (!Array.isArray(v)) return errors.push(`${path}: attesa una lista`), undefined;
      return v.slice(0, 500).map((x, i) => coerce(schema.items, x, `${path}[${i}]`, errors));
    case 'string':
      if (typeof v !== 'string') return errors.push(`${path}: atteso un testo`), undefined;
      if (schema.enum && !schema.enum.includes(v)) return errors.push(`${path}: "${v.slice(0, 30)}" non valido (ammessi: ${schema.enum.filter(Boolean).join(', ')})`), undefined;
      return v.trim().slice(0, 2000);
    case 'integer':
      if (!Number.isInteger(v)) return errors.push(`${path}: atteso un numero intero`), undefined;
      return v;
    case 'boolean':
      if (typeof v !== 'boolean') return errors.push(`${path}: atteso true/false`), undefined;
      return v;
    default:
      return undefined;
  }
}

/**
 * Parses an externally produced plan. Throws an Error with readable reasons when it can't be used.
 * @param {string} text JSON, possibly wrapped in a ```json fence by the chatbot
 */
export function importPlan(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('File vuoto');
  if (Buffer.byteLength(text) > MAX_IMPORT_BYTES) throw new Error('File troppo grande');
  // Chatbots wrap the JSON in fences or a sentence: keep from the first { to the last }.
  const body = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let raw;
  try { raw = JSON.parse(body); } catch { throw new Error('Non è un JSON valido: copia solo la risposta del chatbot, dalla prima { all\'ultima }'); }
  const errors = [];
  const plan = coerce(PLAN_SCHEMA, raw, 'piano', errors);
  if (!errors.length) {
    if (!plan.days.length) errors.push('piano.days: nessun giorno trovato');
    plan.days.forEach((d, i) => { if (!(d.weekday >= 1 && d.weekday <= 7)) errors.push(`piano.days[${i}].weekday: deve essere tra 1 e 7`); });
    if ([...plan.days.flatMap((d) => d.meals), ...plan.shared_meals].some((m) => m.items.some((it) => !it.options.length))) {
      errors.push('un alimento non ha alternative ("options" vuoto)');
    }
  }
  if (errors.length) throw new Error(`Il piano non è nel formato atteso: ${[...new Set(errors)].slice(0, 5).join('; ')}`);
  return cleanPlan(plan);
}
