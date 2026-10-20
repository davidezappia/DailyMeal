import express from 'express';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { q } from './db.js';
import { parsePlan, generateMenu, ask, cleanPlan, SLOTS, PROVIDER, PROVIDERS, isoWeekday } from './ai.js';
import { composeDay, addDays, planChoices, isPlanItem, mentionsExcluded } from './day.js';
import { sanitizeMeal, vocabulary } from './guard.js';
import { rotateMenu } from './rotation.js';
import { importPlan, planPrompt, MAX_IMPORT_BYTES } from './plan-import.js';

const app = express();
const PORT = process.env.PORT || 3000;
const MENU_DAYS = 14;
const SESSION_MS = 180 * 864e5;
const REQUIRED_ENV = {
  anthropic: ['ANTHROPIC_API_KEY'], openrouter: ['OPENROUTER_API_KEY'], gemini: ['GEMINI_API_KEY'],
  azure: ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_DEPLOYMENT'], llamacpp: [],
};
for (const p of PROVIDERS) for (const v of REQUIRED_ENV[p]) if (!process.env[v]) console.warn(`${v} non impostata: il motore AI "${p}" non funzionerà.`);

app.set('trust proxy', process.env.TRUST_PROXY === 'true');
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  next();
});
app.use(express.json({ limit: '15mb' }));
app.use(express.static('public')); // no max-age: ETag revalidation so updates show up immediately

// ---------- helpers
const loadPlan = (uid) => { const p = q.plan(uid); return p && cleanPlan(p); };
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const text = (s, max = 300) => (typeof s === 'string' ? s.trim().slice(0, max) : '');
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const hash = (pw, salt = randomBytes(16).toString('hex')) => `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
const verify = (pw, stored) => {
  const [salt, h] = stored.split(':');
  return timingSafeEqual(Buffer.from(h, 'hex'), scryptSync(pw, salt, 64));
};
const cookie = (req, name) => req.headers.cookie?.split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];
const signupOpen = () => process.env.ALLOW_SIGNUP === 'true' || q.userCount() === 0;

function startSession(req, res, uid) {
  const token = randomBytes(32).toString('hex');
  q.createSession(token, uid, Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${req.secure ? '; Secure' : ''}`);
}

// shortcut: in-memory login throttle, resets on restart; fine for a home server.
const fails = new Map();
const throttled = (ip) => (fails.get(ip)?.n || 0) >= 5 && Date.now() - fails.get(ip).t < 60_000;

// Background AI jobs, one per user. shortcut: lost on restart, the user just retries.
const jobs = new Map();
function runJob(uid, label, fn) {
  if (jobs.get(uid)?.status === 'running') return false;
  jobs.set(uid, { status: 'running', label });
  fn().then(
    () => jobs.set(uid, { status: 'done', label }),
    (e) => { console.error(`[job ${uid}] ${label}:`, e); jobs.set(uid, { status: 'error', label, error: e.message }); },
  );
  return true;
}

const HISTORY_DAYS = 60;
const usesAI = (uid) => q.settings(uid).ai !== false;

async function fillMenu(uid, from, days) {
  const plan = loadPlan(uid);
  const excluded = q.settings(uid).excluded || [];
  if (!usesAI(uid)) {
    const history = q.menuRange(uid, addDays(from, -HISTORY_DAYS), addDays(from, -1));
    const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
    for (const d of rotateMenu({ plan, dates, favorites: q.favorites(uid), history, excluded })) q.saveMenuDay(uid, d.date, d.meals);
    return;
  }
  const vocab = vocabulary(plan);
  const hm = housemate(uid);
  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const weeks = [];
  for (let i = 0; i < dates.length; i += 7) weeks.push(dates.slice(i, i + 7));
  // One call per week, in parallel: faster than one long generation.
  await Promise.all(weeks.map(async (w) => {
    const shared = hm ? w.map((date) => ({ date, meals: homeMeals(hm.id, date) })).filter((x) => x.meals.length) : [];
    for (const d of await generateMenu(plan, w, q.favorites(uid), excluded, shared)) {
      if (!w.includes(d.date)) continue;
      // Never store what the model wrote as-is: rebuild every meal from plan options.
      const meals = d.meals.map((m) => sanitizeMeal(plan, isoWeekday(d.date), m, vocab, excluded)).filter(Boolean);
      q.saveMenuDay(uid, d.date, meals);
    }
  }));
}

// ---------- auth
app.post('/api/signup', (req, res) => {
  if (!signupOpen()) return bad(res, 'Registrazione chiusa', 403);
  const username = text(req.body.username, 40).toLowerCase(), name = text(req.body.name, 60), pw = req.body.password;
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) return bad(res, 'Username: 3-40 caratteri tra lettere, numeri, . _ -');
  if (typeof pw !== 'string' || pw.length < 8) return bad(res, 'La password deve avere almeno 8 caratteri');
  if (q.userByName(username)) return bad(res, 'Username già in uso', 409);
  startSession(req, res, q.createUser(username, name || username, hash(pw)));
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  if (throttled(req.ip)) return bad(res, 'Troppi tentativi, riprova tra un minuto', 429);
  const u = q.userByName(text(req.body.username, 40).toLowerCase());
  if (!u || typeof req.body.password !== 'string' || !verify(req.body.password, u.pass_hash)) {
    const f = fails.get(req.ip);
    fails.set(req.ip, { n: f && Date.now() - f.t < 60_000 ? f.n + 1 : 1, t: Date.now() });
    return bad(res, 'Credenziali non valide', 401);
  }
  fails.delete(req.ip);
  startSession(req, res, u.id);
  res.json({ ok: true });
});

app.get('/api/signup-open', (req, res) => res.json({ open: signupOpen() }));

app.use('/api', (req, res, next) => {
  const token = cookie(req, 'sid');
  req.user = token && q.sessionUser(token);
  if (!req.user) return bad(res, 'Non autenticato', 401);
  next();
});

// Irreversible: asks for the password again so a stray tap or a borrowed phone can't wipe the account.
app.delete('/api/account', (req, res) => {
  if (throttled(req.ip)) return bad(res, 'Troppi tentativi, riprova tra un minuto', 429);
  const u = q.userByName(req.user.username);
  if (typeof req.body.password !== 'string' || !verify(req.body.password, u.pass_hash)) {
    const f = fails.get(req.ip);
    fails.set(req.ip, { n: f && Date.now() - f.t < 60_000 ? f.n + 1 : 1, t: Date.now() });
    return bad(res, 'Password non corretta', 403); // not 401: the UI treats 401 as an expired session
  }
  q.deleteUser(u.id);
  jobs.delete(u.id);
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  q.deleteSession(cookie(req, 'sid'));
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const uid = req.user.id;
  const settings = q.settings(uid);
  res.json({ ai: PROVIDER, household: settings.household ? { username: settings.household, linked: !!housemate(uid) } : null, user: req.user, plan: q.planMeta(uid) || null, settings: q.settings(uid), job: jobs.get(uid) || null, lastMenuDate: q.lastMenuDate(uid) });
});

// ---------- plan & menu
app.post('/api/plan', (req, res) => {
  const { filename, data, start } = req.body;
  if (typeof data !== 'string' || !isDate(start)) return bad(res, 'Dati mancanti');
  if (!Buffer.from(data.slice(0, 8), 'base64').toString().startsWith('%PDF')) return bad(res, 'Il file non è un PDF');
  const uid = req.user.id;
  if (!usesAI(uid)) return bad(res, "Hai disattivato l'AI: importa il piano in JSON (Profilo → Senza AI) oppure riattiva l'AI");
  const ok = runJob(uid, 'Analisi del piano e creazione menu', async () => {
    const plan = await parsePlan(data);
    if (!plan.days?.length) throw new Error('Non ho trovato un piano settimanale nel PDF');
    q.savePlan(uid, text(filename, 200) || 'piano.pdf', plan);
    q.clearMenuFrom(uid, start);
    await fillMenu(uid, start, MENU_DAYS);
  });
  ok ? res.status(202).json({ ok }) : bad(res, 'Elaborazione già in corso', 409);
});

app.get('/api/plan', (req, res) => res.json(loadPlan(req.user.id)));

app.post('/api/menu/generate', (req, res) => {
  const { from } = req.body;
  if (!isDate(from)) return bad(res, 'Data non valida');
  if (!loadPlan(req.user.id)) return bad(res, 'Carica prima il piano');
  const ok = runJob(req.user.id, 'Creazione menu', () => fillMenu(req.user.id, from, MENU_DAYS));
  ok ? res.status(202).json({ ok }) : bad(res, 'Elaborazione già in corso', 409);
});

app.put('/api/menu/:date/:slot', (req, res) => {
  const { date, slot } = req.params;
  if (!isDate(date) || !SLOTS.includes(slot)) return bad(res, 'Parametri non validi');
  const plan = loadPlan(req.user.id);
  if (!plan) return bad(res, 'Carica prima il piano');

  let meal;
  if (req.body.favoriteId) {
    // A favorite was already accepted once: reuse it as-is.
    const fav = q.favorites(req.user.id).find((f) => f.id === Number(req.body.favoriteId) && f.slot === slot);
    if (!fav) return bad(res, 'Preferito non trovato', 404);
    meal = { slot, title: fav.title, items: fav.items, free: false };
  } else {
    const items = Array.isArray(req.body.items) ? req.body.items.map((i) => text(i, 300)).filter(Boolean).slice(0, 20) : [];
    if (!items.length) return bad(res, 'Scegli almeno un alimento');
    const choices = planChoices(plan, isoWeekday(date), slot);
    if (!items.every((i) => isPlanItem(choices, i))) return bad(res, 'Alcuni alimenti non sono previsti dal piano');
    meal = { slot, title: text(req.body.title, 120) || slot, items, free: false };
  }
  const excluded = q.settings(req.user.id).excluded || [];
  if (meal.items.some((i) => mentionsExcluded(i, excluded))) return bad(res, 'Il pasto contiene alimenti che hai escluso (intolleranze)');
  const meals = (q.menuDay(req.user.id, date) || []).filter((m) => m.slot !== slot);
  q.saveMenuDay(req.user.id, date, [...meals, meal]);
  // A meal the user composed themselves is one they like: keep it to suggest again.
  if (req.body.favorite !== false) q.saveFavorite(req.user.id, slot, isoWeekday(date), meal.title, meal.items);
  res.json({ ok: true });
});

app.get('/api/favorites', (req, res) => res.json(q.favorites(req.user.id)));
app.post('/api/favorites', (req, res) => {
  const { date, slot } = req.body;
  const title = text(req.body.title, 120);
  if (!isDate(date) || !SLOTS.includes(slot) || !title) return bad(res, 'Parametri non validi');
  const items = Array.isArray(req.body.items) ? req.body.items.map((i) => text(i, 200)).filter(Boolean).slice(0, 20) : [];
  q.saveFavorite(req.user.id, slot, isoWeekday(date), title, items);
  res.json({ ok: true });
});
app.delete('/api/favorites/:id', (req, res) => {
  q.deleteFavorite(req.user.id, Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/job', (req, res) => res.json(jobs.get(req.user.id) || null));

// ---------- days
const dayView = (uid, date) => {
  const plan = loadPlan(uid);
  return plan && composeDay({ date, plan, settings: q.settings(uid), events: q.events(uid, date), menuFor: (d) => q.menuDay(uid, d), favorites: q.favorites(uid) });
};

/** Housemate: linked only when both users named each other, so nobody can attach to someone else's menu. */
function housemate(uid) {
  const name = q.settings(uid).household;
  const other = name && q.userByName(name);
  return other && other.id !== uid && q.settings(other.id).household === q.user(uid).username
    ? { id: other.id, name: other.name, username: other.username } : null;
}
/** Generated lunches and dinners eaten at home: the meals worth cooking together. */
const homeMeals = (uid, date) => (dayView(uid, date)?.meals || [])
  .filter((m) => ['pranzo', 'cena'].includes(m.slot) && m.generated && !m.free && !m.out)
  .map(({ slot, title, items }) => ({ slot, title, items }));
const withHousemate = (uid, view) => {
  const hm = view && housemate(uid);
  if (!hm) return view;
  const theirs = homeMeals(hm.id, view.date);
  return { ...view, housemate: hm.name, meals: view.meals.map((m) => ({ ...m, housemate: m.out ? null : theirs.find((t) => t.slot === m.slot) || null })) };
};

app.get('/api/day/:date', (req, res) => {
  if (!isDate(req.params.date)) return bad(res, 'Data non valida');
  res.json(withHousemate(req.user.id, dayView(req.user.id, req.params.date)));
});

app.get('/api/week', (req, res) => {
  const from = req.query.from;
  if (!isDate(from)) return bad(res, 'Data non valida');
  res.json(Array.from({ length: MENU_DAYS }, (_, i) => dayView(req.user.id, addDays(from, i))).filter(Boolean));
});

const OUT_KINDS = ['casa', 'lavoro', 'ristorante'];
app.put('/api/day/:date/events', (req, res) => {
  const { date } = req.params;
  if (!isDate(date)) return bad(res, 'Data non valida');
  const { sport, out = {}, note } = req.body;
  const cleanOut = Object.fromEntries(Object.entries(out).filter(([s, k]) => SLOTS.includes(s) && OUT_KINDS.includes(k)));
  q.saveEvents(req.user.id, date, { ...(typeof sport === 'boolean' && { sport }), out: cleanOut, note: text(note, 500) });
  res.json(withHousemate(req.user.id, dayView(req.user.id, date)));
});

app.put('/api/settings', (req, res) => {
  const days = (a) => (Array.isArray(a) ? a.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7) : []);
  const fm = req.body.free_meal || {};
  const settings = {
    sport_days: days(req.body.sport_days),
    work_lunch_days: days(req.body.work_lunch_days),
    ai: req.body.ai !== false,
    excluded: Array.isArray(req.body.excluded)
      ? [...new Set(req.body.excluded.map((x) => text(x, 40).toLowerCase()).filter(Boolean))].slice(0, 30) : [],
    household: /^[a-z0-9._-]{3,40}$/.test(String(req.body.household || '').toLowerCase()) && String(req.body.household).toLowerCase() !== req.user.username
      ? String(req.body.household).toLowerCase() : null,
    free_meal: Number.isInteger(fm.weekday) && fm.weekday >= 1 && fm.weekday <= 7 && SLOTS.includes(fm.slot) ? { weekday: fm.weekday, slot: fm.slot } : null,
  };
  q.saveSettings(req.user.id, settings);
  res.json(settings);
});

// ---------- questions
app.get('/api/plan/prompt', (req, res) => res.type('text/plain').send(planPrompt()));

// Plan converted by an external chatbot: validated here, no AI needed.
app.post('/api/plan/import', express.text({ type: '*/*', limit: MAX_IMPORT_BYTES }), (req, res) => {
  const start = req.query.start;
  if (!isDate(start)) return bad(res, 'Data non valida');
  let plan;
  try { plan = importPlan(typeof req.body === 'string' ? req.body : ''); } catch (e) { return bad(res, e.message); }
  const uid = req.user.id;
  const ok = runJob(uid, usesAI(uid) ? 'Creazione menu' : 'Creazione menu senza AI', async () => {
    q.savePlan(uid, text(req.query.filename, 200) || 'piano.json', plan);
    q.clearMenuFrom(uid, start);
    await fillMenu(uid, start, MENU_DAYS);
  });
  ok ? res.status(202).json({ ok }) : bad(res, 'Elaborazione già in corso', 409);
});

app.post('/api/ask', async (req, res) => {
  if (!usesAI(req.user.id)) return bad(res, "La chat usa l'AI: attivala nel Profilo per fare domande");
  const question = text(req.body.question, 1000);
  if (!question || !isDate(req.body.date)) return bad(res, 'Domanda mancante');
  const plan = loadPlan(req.user.id);
  if (!plan) return bad(res, 'Carica prima il piano');
  try {
    const day = dayView(req.user.id, req.body.date);
    const context = { data: day.date, sport: day.sport, pasti: day.meals.map(({ label, title, items, out, free }) => ({ label, title, items, out, free })) };
    res.json({ answer: await ask(plan, context, question) });
  } catch (e) {
    console.error('[ask]', e);
    bad(res, 'Non riesco a rispondere ora, riprova tra poco', 502);
  }
});

// ---------- weight
app.get('/api/weights', (req, res) => res.json(q.weights(req.user.id)));
app.post('/api/weights', (req, res) => {
  const kg = Number(req.body.kg);
  if (!isDate(req.body.date) || !(kg > 20 && kg < 400)) return bad(res, 'Valore non valido');
  q.saveWeight(req.user.id, req.body.date, Math.round(kg * 10) / 10);
  res.json(q.weights(req.user.id));
});
app.delete('/api/weights/:date', (req, res) => {
  q.deleteWeight(req.user.id, req.params.date);
  res.json(q.weights(req.user.id));
});

app.use((err, req, res, next) => {
  console.error(err);
  bad(res, 'Errore interno', 500);
});

app.listen(PORT, () => console.log(`DailyMeal su http://localhost:${PORT} (AI: ${PROVIDER})`));
