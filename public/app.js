// DailyMeal SPA — vanilla JS, hash routing, no build step.
const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');
const $banner = document.getElementById('banner');
const $sheet = document.getElementById('sheet');

const WD = ['', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'];
const WD_SHORT = ['', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
const SLOTS = ['colazione', 'spuntino', 'pranzo', 'merenda', 'cena'];
const SLOT_LABEL = { colazione: 'Colazione', spuntino: 'Spuntino', pranzo: 'Pranzo', merenda: 'Merenda', cena: 'Cena' };
const AI_WHERE = {
  llamacpp: 'Il PDF viene letto dal modello AI sul tuo server: non esce dalla tua rete.',
  openrouter: 'Il testo del PDF viene inviato a OpenRouter (servizio esterno, i modelli gratuiti possono conservare i dati). Prima di caricarlo togli nome, dati personali e informazioni sanitarie non necessarie.',
  anthropic: 'Il PDF viene inviato ad Anthropic (Claude) per essere letto.',
};
const OUT_LABEL = { casa: 'Casa', lavoro: 'Lavoro', ristorante: 'Ristorante' };

let me = null;
const chat = []; // in-memory chat history for the session

// ---------- utils
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const localDate = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const today = () => localDate();
const addDays = (date, n) => { const d = new Date(`${date}T12:00:00`); d.setDate(d.getDate() + n); return localDate(d); };
const fmtDate = (date, opts = { day: 'numeric', month: 'long' }) => new Date(`${date}T12:00:00`).toLocaleDateString('it-IT', opts);
const dayName = (date) => {
  const diff = Math.round((Date.parse(date) - Date.parse(today())) / 864e5);
  return { 0: 'Oggi', 1: 'Domani', [-1]: 'Ieri' }[diff] || WD[new Date(`${date}T12:00:00`).getDay() || 7];
};

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body && JSON.stringify(opts.body),
  });
  if (res.status === 401 && !path.startsWith('/login')) { me = null; location.hash = '#/login'; throw new Error('Sessione scaduta'); }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Errore ${res.status}`);
  return data;
}

function toast(msg, kind = '') {
  const t = Object.assign(document.createElement('div'), { className: `toast ${kind}`, textContent: msg, role: 'status' });
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

const loading = () => { $app.innerHTML = '<div class="loader" aria-label="Caricamento"><span></span><span></span><span></span></div>'; };

// ---------- background job banner
let polling = null;
function watchJob(job) {
  if (!job || job.status !== 'running') {
    $banner.hidden = true;
    if (job?.status === 'error') { $banner.hidden = false; $banner.className = 'error'; $banner.textContent = `${job.label}: ${job.error}`; }
    return;
  }
  $banner.hidden = false;
  $banner.className = 'running';
  $banner.innerHTML = `<span class="spin"></span>${esc(job.label)}… ci vogliono 1-3 minuti`;
  clearTimeout(polling);
  polling = setTimeout(async () => {
    const j = await api('/job').catch(() => null);
    if (j?.status === 'running') return watchJob(j);
    me = await api('/me');
    watchJob(j);
    if (j?.status === 'done') toast('Menu pronto!', 'ok');
    route();
  }, 4000);
}

// ---------- router
const routes = { '': dayPage, day: dayPage, menu: menuPage, ask: askPage, profile: profilePage, login: loginPage };
async function route() {
  const [, name = '', arg] = location.hash.split('/');
  if (!me && name !== 'login') {
    try { me = await api('/me'); watchJob(me.job); } catch { return; }
  }
  $tabs.hidden = name === 'login';
  const tab = name === '' || name === 'day' ? 'day' : name;
  $tabs.querySelectorAll('a').forEach((a) => a.toggleAttribute('aria-current', a.dataset.tab === tab));
  window.scrollTo(0, 0);
  await (routes[name] || dayPage)(arg).catch((e) => { $app.innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`; });
}
addEventListener('hashchange', route);

// ---------- login / signup
async function loginPage() {
  const { open } = await fetch('/api/signup-open').then((r) => r.json());
  let signup = false;
  const render = () => {
    $app.innerHTML = `
      <section class="auth">
        <img src="icon.svg" alt="" width="64" height="64">
        <h1>DailyMeal</h1>
        <p class="muted">Il tuo piano alimentare, giorno per giorno.</p>
        <form id="f" class="card stack">
          ${signup ? '<label>Nome<input name="name" autocomplete="name" required></label>' : ''}
          <label>Username<input name="username" autocomplete="username" autocapitalize="none" required></label>
          <label>Password<input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="${signup ? 8 : 1}" required></label>
          <button class="btn primary">${signup ? 'Crea account' : 'Entra'}</button>
        </form>
        ${open ? `<button class="link" id="sw">${signup ? 'Ho già un account' : 'Crea un nuovo account'}</button>` : ''}
      </section>`;
    document.getElementById('sw')?.addEventListener('click', () => { signup = !signup; render(); });
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      try {
        await api(signup ? '/signup' : '/login', { method: 'POST', body });
        me = null;
        location.hash = '#/';
      } catch (err) { toast(err.message, 'error'); }
    });
  };
  render();
}

// ---------- day
async function dayPage(date = today()) {
  if (!me.plan) return noPlan();
  loading();
  const day = await api(`/day/${date}`);
  renderDay(day);
}

function noPlan() {
  $app.innerHTML = `
    <header class="page-head"><p class="eyebrow">Ciao ${esc(me.user.name)}</p><h1>Iniziamo</h1></header>
    <div class="empty card">
      <div class="empty-icon">📄</div>
      <h2>Carica il tuo piano alimentare</h2>
      <p class="muted">Leggo il PDF del nutrizionista e preparo un menu dettagliato per le prossime 2 settimane.</p>
      <a class="btn primary" href="#/profile">Carica il PDF</a>
    </div>`;
}

const mealIcon = { colazione: '☕', spuntino: '🍎', pranzo: '🥗', merenda: '🥜', cena: '🍽️' };

function mealCard(m, day, extra = '') {
  const outOpts = ['pranzo', 'cena'].includes(m.slot)
    ? `<div class="seg" role="group" aria-label="Dove mangi a ${m.label.toLowerCase()}">${Object.entries(OUT_LABEL).map(([k, v]) =>
        `<button data-out="${m.slot}" data-kind="${k}" aria-pressed="${(m.out || 'casa') === k}">${v}</button>`).join('')}</div>`
    : '';
  const outBlock = m.out === 'lavoro' ? workBlock(m, day) : m.out === 'ristorante' ? restaurantBlock(day) : '';
  const restaurant = m.out === 'ristorante';
  const planned = m.items.length ? `<ul class="items">${m.items.map((i) => m.excludedItems.includes(i) ? `<li class="warn">⚠ ${esc(i)} <strong>(alimento escluso)</strong></li>` : `<li>${esc(i)}</li>`).join('')}</ul>${
      m.generated && !m.verified ? '<p class="unverified">⚠ Pasto creato prima del controllo sul piano: potrebbe contenere alimenti non previsti. Modificalo con ✎ o rigenera il menu.</p>' : ''}`
    : !m.free && m.planOptions.length ? planList(m.planOptions) : '';
  return `
    <article class="meal card slot-${m.slot} ${m.free ? 'free' : ''} ${m.out ? 'is-out' : ''}">
      <header>
        <span class="slot-badge">${mealIcon[m.slot]} ${esc(m.label)}</span>
        ${m.free ? '' : `<span>
          ${m.generated ? `<button class="icon-btn like ${m.liked ? 'on' : ''}" data-like="${m.slot}" aria-pressed="${m.liked}" aria-label="${m.liked ? 'Togli dai preferiti' : 'Mi piace'}">${m.liked ? '♥' : '♡'}</button>` : ''}
          <button class="icon-btn" data-edit="${m.slot}" aria-label="Modifica ${esc(m.label)}">✎</button>
        </span>`}
      </header>
      ${restaurant ? `<h3>Al ristorante</h3>${outBlock}<details class="plan-opts"><summary>Il pasto previsto: ${esc(m.title)}</summary>${planned}</details>` : `
        <h3>${esc(m.title)}</h3>
        ${m.free ? '<p class="muted">Qualsiasi alimento, con buonsenso sulle quantità. 🎉</p>' : ''}
        ${planned}
        ${outBlock}`}
      ${m.housemate ? `<p class="housemate">🏠 ${esc(day.housemate)} mangia: <strong>${esc(m.housemate.title)}</strong></p>` : ''}
      ${extra}
      ${outOpts}
      ${!restaurant && m.items.length && m.planOptions.length && !m.free ? `<details class="plan-opts"><summary>Alternative dal piano</summary>${planList(m.planOptions)}</details>` : ''}
    </article>`;
}

/** On sport days the pre/post-workout snack extends the afternoon snack; without one it gets its own card before dinner. */
function mealsWithWorkout(day) {
  const workout = day.sport && day.workoutSnack.length ? day.workoutSnack : null;
  if (!workout) return day.meals.map((m) => mealCard(m, day)).join('');
  const isSnack = (m) => ['merenda', 'spuntino'].includes(m.slot) && !m.free;
  const lunch = day.meals.findIndex((m) => m.slot === 'pranzo');
  const host = day.meals.find((m, i) => isSnack(m) && i > lunch) || day.meals.find(isSnack);
  const ext = `<div class="workout-ext"><p><strong>⚡ Giorno di sport</strong> · in più, prima o dopo l'allenamento</p>${choices(workout)}</div>`;
  const card = `<article class="meal card workout"><header><span class="slot-badge">⚡ Pre/post allenamento</span></header>${choices(workout)}</article>`;
  return day.meals.map((m) => (m === host ? mealCard(m, day, ext) : (!host && m.slot === 'cena' ? card : '') + mealCard(m, day))).join('')
    + (!host && !day.meals.some((m) => m.slot === 'cena') ? card : '');
}

/** Plan items as a list; an item with alternatives becomes "one of" with each choice on its own line. */
const choices = (items) => `<ul class="choices">${items.map((i) => `<li>${i.optional ? '<span class="tag">facoltativo</span>' : ''}${
  i.options.length > 1 ? `<span class="muted">Una a scelta tra:</span><ul>${i.options.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>` : esc(i.options[0])}</li>`).join('')}</ul>`;

/** Server plan lines ("▸ Name", "Facoltativo: a — oppure — b") rendered like choices(). */
const planList = (lines) => lines.map((l) => (l.startsWith('▸ ') ? `<p class="opt-name">${esc(l.slice(2))}</p>`
  : choices([{ optional: l.startsWith('Facoltativo: '), options: l.replace(/^Facoltativo: /, '').split(' — oppure — ') }]))).join('');

const outOptions = (day, kinds) => day.eatingOut.filter((o) => kinds.includes(o.kind));

function workBlock(m, day) {
  const opts = outOptions(day, ['lavoro', 'entrambi']);
  return `
    <div class="out-note">
      <strong>💼 ${esc(m.label)} al lavoro</strong>
      <p>Porta da casa il pasto qui sopra: preparalo la sera prima e aggiungi il condimento al momento.</p>
      ${opts.length ? `<details><summary>Se mangi in mensa o al bar</summary>${opts.map((o) => `<p class="opt-name">${esc(o.name)}</p>${choices(o.items)}`).join('')}</details>`
        : '<p class="muted">Se mangi in mensa: scegli piatti semplici simili al pasto previsto, con verdure e poco condimento.</p>'}
    </div>`;
}

function restaurantBlock(day) {
  const opts = outOptions(day, ['ristorante', 'entrambi']);
  return `
    <div class="out-note">
      ${opts.length ? opts.map((o) => `<details open><summary>${esc(o.name)}</summary>${choices(o.items)}</details>`).join('')
        : '<p>Il piano non ha indicazioni per il ristorante: scegli un secondo semplice (carne o pesce alla griglia) con verdure, oppure un primo semplice, e niente fritti.</p>'}
      <p class="muted">Se è la cena della settimana in cui vuoi sgarrare, puoi spostare qui il pasto libero dal Profilo.</p>
    </div>`;
}

function renderDay(day) {
  const missing = day.meals.some((m) => !m.generated && !m.free);
  $app.innerHTML = `
    <header class="page-head day-head">
      <a class="nav-arrow" href="#/day/${addDays(day.date, -1)}" aria-label="Giorno precedente">‹</a>
      <div>
        <p class="eyebrow">${fmtDate(day.date, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        <h1>${dayName(day.date)}</h1>
      </div>
      <a class="nav-arrow" href="#/day/${addDays(day.date, 1)}" aria-label="Giorno successivo">›</a>
    </header>
    ${day.date !== today() ? '<a class="pill-link" href="#/">Torna a oggi</a>' : ''}

    <div class="toggles">
      <button class="chip ${day.sport ? 'on' : ''}" id="sport" aria-pressed="${day.sport}">🏃 ${day.sport ? 'Giorno di sport' : 'Fai sport oggi?'}</button>
    </div>

    ${missing ? '<p class="hint">Menu non ancora generato per questo giorno: vedi le opzioni del piano. Puoi generarlo da <a href="#/menu">Menu</a>.</p>' : ''}

    <section class="meals">
      ${mealsWithWorkout(day)}
    </section>

    ${day.tips.length ? `
      <section class="tips">
        <h2>Consigli del giorno</h2>
        ${day.tips.map((t) => `<p class="tip">${esc(t)}</p>`).join('')}
      </section>` : ''}

    <section class="card note">
      <label for="note">Note del giorno</label>
      <textarea id="note" rows="2" placeholder="Es. cena da amici, poca fame, allenamento spostato…">${esc(day.note)}</textarea>
    </section>`;

  const saveEvents = async (patch) => {
    const outNow = Object.fromEntries(day.meals.filter((m) => ['pranzo', 'cena'].includes(m.slot)).map((m) => [m.slot, m.out || 'casa']));
    const body = { sport: day.sport, out: outNow, note: day.note, ...patch };
    try { renderDay(await api(`/day/${day.date}/events`, { method: 'PUT', body })); } catch (e) { toast(e.message, 'error'); }
  };
  document.getElementById('sport').onclick = () => saveEvents({ sport: !day.sport });
  $app.querySelectorAll('[data-out]').forEach((b) => b.onclick = () => {
    const out = Object.fromEntries(day.meals.filter((m) => ['pranzo', 'cena'].includes(m.slot)).map((m) => [m.slot, m.out || 'casa']));
    saveEvents({ out: { ...out, [b.dataset.out]: b.dataset.kind } });
  });
  const note = document.getElementById('note');
  note.onchange = () => { day.note = note.value; saveEvents({ note: note.value }).then(() => toast('Nota salvata', 'ok')); };
  $app.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => editMeal(day, day.meals.find((m) => m.slot === b.dataset.edit)));
  $app.querySelectorAll('[data-like]').forEach((b) => b.onclick = () => toggleLike(day, day.meals.find((m) => m.slot === b.dataset.like)));
}

async function toggleLike(day, m) {
  try {
    const fav = m.favorites.find((f) => f.title.toLowerCase() === m.title.toLowerCase());
    if (m.liked && fav) await api(`/favorites/${fav.id}`, { method: 'DELETE' });
    else await api('/favorites', { method: 'POST', body: { date: m.sourceDate, slot: m.slot, title: m.title, items: m.items } });
    renderDay(await api(`/day/${day.date}`));
    toast(m.liked ? 'Tolto dai preferiti' : 'Salvato tra i preferiti: lo riproporrò nei prossimi menu', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

const DETAIL_SEP = ' · ';
const words = (s) => new Set(s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 3));
const overlap = (a, b) => { const B = words(b); return [...words(a)].filter((w) => B.has(w)).length; };

/** Best guess of which plan option each current menu item corresponds to, so the sheet opens on what's on the plate. */
function preselect(items, current) {
  return items.map((it) => {
    for (const c of current) {
      const o = it.options.find((opt) => c === opt || c.startsWith(opt + DETAIL_SEP));
      if (o) return { value: o, detail: c.slice(o.length + DETAIL_SEP.length), score: 10 };
    }
    const scored = it.options.map((o) => ({ o, s: Math.max(0, ...current.map((c) => overlap(o, c))) })).sort((a, b) => b.s - a.s);
    return { value: scored[0].s > 0 ? scored[0].o : it.optional ? '' : it.options[0], detail: '', score: scored[0].s };
  });
}

function pickRows(items, picks, excluded) {
  const isExcluded = (o) => excluded.some((x) => o.toLowerCase().includes(x));
  return items.map((it, k) => {
    const p = picks[k];
    const field = it.options.length === 1 && !it.optional
      ? `<p class="fixed">${esc(it.options[0])}</p><input type="hidden" name="opt${k}" value="${esc(it.options[0])}">`
      : `<select name="opt${k}" aria-label="Alimento ${k + 1}">${it.optional ? `<option value="" ${p.value ? '' : 'selected'}>— Facoltativo: non lo prendo —</option>` : ''}${
        it.options.map((o) => isExcluded(o) ? `<option disabled>${esc(o)} (escluso)</option>`
          : `<option ${o === p.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    return `<div class="pick">${field}<input name="det${k}" value="${esc(p.detail)}" maxlength="80" placeholder="Dettaglio facoltativo, es. riso basmati" aria-label="Dettaglio alimento ${k + 1}"></div>`;
  }).join('');
}

function editMeal(day, m) {
  const groups = m.choices;
  if (!groups.length) return toast('Il piano non prevede alternative per questo pasto', 'error');
  const guesses = groups.map((g) => preselect(g.items, m.items));
  const scores = guesses.map((p) => p.reduce((sum, x) => sum + x.score, 0));
  let gi = scores.indexOf(Math.max(...scores));
  $sheet.innerHTML = `
    <form method="dialog" class="stack" id="ef">
      <h2>Modifica ${esc(m.label.toLowerCase())}</h2>
      ${m.favorites.length ? `<div class="fav-pick"><span class="eyebrow">I tuoi preferiti · un tocco per sceglierlo</span><div>${m.favorites.map((f) =>
        `<button type="button" class="chip" data-fav="${f.id}">♥ ${esc(f.title)}</button>`).join('')}</div></div>` : ''}
      ${groups.length > 1 ? `<div class="seg" role="group" aria-label="Tipo di ${esc(m.label.toLowerCase())}">${groups.map((g, i) =>
        `<button type="button" data-group="${i}" aria-pressed="${i === gi}">${esc(g.name)}</button>`).join('')}</div>` : ''}
      <div class="picks" id="picks"></div>
      <label>Nome del piatto <span class="muted">(facoltativo)</span><input name="title" value="${esc(m.generated ? m.title : '')}" placeholder="Es. Riso con zucchine e pesto" maxlength="120"></label>
      <label class="check"><input type="checkbox" name="favorite" checked> Salva tra i preferiti e riproponilo nei prossimi menu</label>
      <div class="row">
        <button class="btn" value="cancel" formnovalidate>Annulla</button>
        <button class="btn primary" value="save">Salva</button>
      </div>
    </form>`;
  const form = document.getElementById('ef');
  const showGroup = () => {
    form.querySelector('#picks').innerHTML = pickRows(groups[gi].items, guesses[gi], day.excluded);
    form.querySelectorAll('[data-group]').forEach((b) => b.setAttribute('aria-pressed', Number(b.dataset.group) === gi));
  };
  form.querySelectorAll('[data-group]').forEach((b) => b.onclick = () => { gi = Number(b.dataset.group); showGroup(); });
  showGroup();
  $sheet.showModal();

  const save = async (body) => {
    try {
      await api(`/menu/${m.sourceDate}/${m.slot}`, { method: 'PUT', body });
      renderDay(await api(`/day/${day.date}`));
      toast('Pasto aggiornato', 'ok');
    } catch (e) { toast(e.message, 'error'); }
  };
  form.querySelectorAll('[data-fav]').forEach((b) => b.onclick = () => { $sheet.onclose = null; $sheet.close(); save({ favoriteId: Number(b.dataset.fav) }); });
  $sheet.onclose = () => {
    if ($sheet.returnValue !== 'save') return;
    const f = new FormData(form);
    const items = groups[gi].items.map((_, k) => {
      const value = f.get(`opt${k}`), detail = String(f.get(`det${k}`) || '').trim();
      return value && (detail ? value + DETAIL_SEP + detail : value);
    }).filter(Boolean);
    save({ title: f.get('title').trim() || m.title, items, favorite: f.has('favorite') });
  };
}

// ---------- menu (2 weeks)
async function menuPage() {
  if (!me.plan) return noPlan();
  loading();
  const from = today();
  const days = await api(`/week?from=${from}`);
  const next = me.lastMenuDate && me.lastMenuDate >= from ? addDays(me.lastMenuDate, 1) : from;
  const running = me.job?.status === 'running';
  $app.innerHTML = `
    <header class="page-head"><p class="eyebrow">Prossimi 14 giorni</p><h1>Menu</h1></header>
    <div class="row wrap">
      <button class="btn primary" id="gen" ${running ? 'disabled' : ''}>Genera 2 settimane dal ${fmtDate(next, { day: 'numeric', month: 'short' })}</button>
      <button class="btn" id="regen" ${running ? 'disabled' : ''}>Rigenera da oggi</button>
    </div>
    <section class="week">
      ${days.map((d) => `
        <a class="day-row card ${d.date === from ? 'is-today' : ''}" href="#/day/${d.date}">
          <div class="date-col"><span>${WD_SHORT[d.weekday]}</span><strong>${new Date(`${d.date}T12:00:00`).getDate()}</strong></div>
          <div class="meals-col">
            ${d.meals.filter((m) => ['pranzo', 'cena'].includes(m.slot)).map((m) => `
              <p><span class="dot slot-${m.slot}"></span><span class="muted">${esc(m.label)}</span> ${m.generated || m.free ? esc(m.title) : '<em class="muted">da definire</em>'}</p>`).join('')}
            <div class="badges">
              ${d.sport ? '<span class="badge sport">Sport</span>' : ''}
              ${d.meals.some((m) => m.free) ? '<span class="badge free">Pasto libero</span>' : ''}
              ${d.meals.some((m) => (m.generated && !m.verified) || m.excludedItems.length) ? '<span class="badge warn">⚠ Da verificare</span>' : ''}
              ${d.meals.filter((m) => m.out).map((m) => `<span class="badge out">${esc(m.label)} · ${OUT_LABEL[m.out]}</span>`).join('')}
            </div>
          </div>
        </a>`).join('')}
    </section>`;
  const gen = async (from) => {
    try { await api('/menu/generate', { method: 'POST', body: { from } }); me = await api('/me'); watchJob(me.job); menuPage(); } catch (e) { toast(e.message, 'error'); }
  };
  document.getElementById('gen').onclick = () => gen(next);
  document.getElementById('regen').onclick = () => confirm('Rigenero il menu da oggi? Le modifiche manuali dei prossimi giorni verranno sostituite.') && gen(from);
}

// ---------- ask
/** Minimal Markdown for model answers: escapes first, then bold/italic, headings and lists. */
function md(text) {
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  const out = [];
  let list = null;
  for (const line of text.trim().split('\n')) {
    const item = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
    if (item) {
      const tag = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (list !== tag) { if (list) out.push(`</${list}>`); out.push(`<${tag}>`); list = tag; }
      out.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    if (list) { out.push(`</${list}>`); list = null; }
    const h = line.match(/^#{1,6}\s+(.*)/);
    if (h) out.push(`<p><strong>${inline(h[1])}</strong></p>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join('');
}

const SUGGESTIONS = ['Posso sostituire il pesce di oggi con della carne?', 'L\'orata è un pesce magro o semigrasso?', 'Cosa ordino in pizzeria se non è il pasto libero?', 'Quanto pesa una porzione di frutta secca?'];
async function askPage() {
  if (!me.plan) return noPlan();
  const render = () => {
    $app.innerHTML = `
      <header class="page-head"><p class="eyebrow">Dubbi sul piano</p><h1>Chiedi</h1></header>
      <section class="chat" id="chat">
        ${chat.length ? chat.map((m) => `<div class="bubble ${m.role}">${m.role === 'bot' ? md(m.text) : esc(m.text)}</div>`).join('')
          : `<p class="muted">Fai una domanda sul tuo piano: sostituzioni, porzioni, cosa mangiare fuori…</p>
             <div class="suggest">${SUGGESTIONS.map((s) => `<button class="chip" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>`}
      </section>
      <form id="af" class="ask-bar">
        <input name="q" placeholder="Scrivi una domanda…" autocomplete="off" required maxlength="1000">
        <button class="btn primary" aria-label="Invia">↑</button>
      </form>`;
    const send = async (question) => {
      chat.push({ role: 'user', text: question }, { role: 'bot pending', text: 'Ci penso…' });
      render();
      try {
        const { answer } = await api('/ask', { method: 'POST', body: { question, date: today() } });
        chat.splice(-1, 1, { role: 'bot', text: answer });
      } catch (e) { chat.splice(-1, 1, { role: 'bot error', text: e.message }); }
      render();
    };
    document.getElementById('af').onsubmit = (e) => { e.preventDefault(); send(e.target.q.value.trim()); };
    $app.querySelectorAll('[data-q]').forEach((b) => b.onclick = () => send(b.dataset.q));
    document.getElementById('chat').lastElementChild?.scrollIntoView({ block: 'end' });
  };
  render();
}

// ---------- profile
async function profilePage() {
  loading();
  const [weights, plan, favorites] = await Promise.all([api('/weights'), me.plan ? api('/plan') : null, api('/favorites')]);
  const s = me.settings;
  const fm = s.free_meal || (plan?.free_meal?.weekday ? plan.free_meal : { weekday: 0, slot: 'cena' });
  const dayChips = (name, sel = []) => `<div class="daypick">${[1, 2, 3, 4, 5, 6, 7].map((d) =>
    `<label><input type="checkbox" name="${name}" value="${d}" ${sel.includes(d) ? 'checked' : ''}><span>${WD_SHORT[d]}</span></label>`).join('')}</div>`;
  $app.innerHTML = `
    <header class="page-head"><p class="eyebrow">@${esc(me.user.username)}</p><h1>${esc(me.user.name)}</h1></header>

    <section class="card stack">
      <h2>Piano alimentare</h2>
      ${me.plan ? `<p><strong>${esc(plan?.title || me.plan.filename)}</strong><br><span class="muted">${esc(plan?.author || '')} · caricato il ${fmtDate(me.plan.created_at.slice(0, 10))}</span></p>` : '<p class="muted">Nessun piano caricato.</p>'}
      <label class="btn ${me.plan ? '' : 'primary'} file-btn">${me.plan ? 'Carica un nuovo piano (PDF)' : 'Carica il piano (PDF)'}<input type="file" id="pdf" accept="application/pdf" hidden></label>
      <p class="hint">${AI_WHERE[me.ai] || ''}</p>
      ${plan ? `<details><summary>Cosa ho letto dal piano</summary>${planSummary(plan)}</details>` : ''}
    </section>

    <form class="card stack" id="sf">
      <h2>La mia settimana</h2>
      <fieldset><legend>Pasto libero</legend>
        <div class="row">
          <select name="fm_wd" aria-label="Giorno pasto libero"><option value="0">Come da piano</option>${[1, 2, 3, 4, 5, 6, 7].map((d) => `<option value="${d}" ${s.free_meal?.weekday === d ? 'selected' : ''}>${WD[d]}</option>`).join('')}</select>
          <select name="fm_slot" aria-label="Pasto">${['pranzo', 'cena'].map((x) => `<option ${fm.slot === x ? 'selected' : ''} value="${x}">${SLOT_LABEL[x]}</option>`).join('')}</select>
        </div>
        <p class="hint">Resta fisso finché non lo cambi. Se sposti il giorno, il menu di quel giorno viene scambiato con quello previsto dal piano.</p>
      </fieldset>
      <fieldset><legend>Giorni di sport</legend>${dayChips('sport', s.sport_days)}
        <p class="hint">In questi giorni compare lo spuntino pre/post allenamento. Puoi cambiare il singolo giorno dalla home.</p></fieldset>
      <fieldset><legend>Pranzo al lavoro</legend>${dayChips('work', s.work_lunch_days)}</fieldset>
      <fieldset><legend>Convivente</legend>
        <input name="household" value="${esc(s.household || '')}" placeholder="Username di chi vive con te" autocapitalize="none" autocomplete="off">
        <p class="hint">${!me.household ? 'I pranzi e le cene a casa verranno coordinati: ingredienti in comune quando i due piani lo permettono. Anche l’altra persona deve inserire il tuo username (' + esc(me.user.username) + ').'
          : me.household.linked ? '✓ Collegati: i prossimi menu useranno ingredienti in comune.'
          : '⏳ In attesa: ' + esc(me.household.username) + ' deve inserire il tuo username (' + esc(me.user.username) + ') nel suo profilo.'}</p></fieldset>
      <fieldset><legend>Intolleranze e alimenti da evitare</legend>
        <input name="excluded" value="${esc((s.excluded || []).join(', '))}" placeholder="Es. lattosio, ricotta, frutta secca, crostacei" autocomplete="off">
        <p class="hint">Separati da virgola. Il menu non li propone e nelle modifiche sono disattivati. Il controllo è sul nome: scrivi gli alimenti come compaiono nel piano (es. "latte", "formaggio").</p></fieldset>
      <button class="btn primary">Salva</button>
    </form>

    <section class="card stack">
      <h2>Preferiti</h2>
      ${favorites.length ? `<ul class="favs">${favorites.map((f) => `
        <li>
          <div><strong>${esc(f.title)}</strong><span class="muted">${SLOT_LABEL[f.slot]} · ${['colazione', 'merenda', 'spuntino'].includes(f.slot) ? 'qualsiasi giorno' : WD[f.weekday]}${f.uses > 1 ? ` · scelto ${f.uses} volte` : ''}</span></div>
          <button class="icon-btn" data-unfav="${f.id}" aria-label="Rimuovi ${esc(f.title)} dai preferiti">×</button>
        </li>`).join('')}</ul>`
        : '<p class="hint">Tocca ♡ su un pasto, oppure modificalo: lo salvo qui e lo ripropongo nei prossimi menu.</p>'}
    </section>

    <section class="card stack">
      <h2>Peso</h2>
      <p class="hint">Una volta a settimana, al mattino, a digiuno. Non il giorno dopo il pasto libero.</p>
      <form id="wf" class="row">
        <input type="date" name="date" value="${today()}" aria-label="Data" required>
        <input type="number" name="kg" step="0.1" min="20" max="400" placeholder="kg" inputmode="decimal" aria-label="Peso in kg" required>
        <button class="btn primary">Aggiungi</button>
      </form>
      ${weightChart(weights)}
      <ul class="weights">${weights.slice(0, 8).map((w) => `<li><span>${fmtDate(w.date, { day: 'numeric', month: 'short', year: 'numeric' })}</span><strong>${w.kg} kg</strong><button class="icon-btn" data-del="${w.date}" aria-label="Elimina">×</button></li>`).join('')}</ul>
    </section>

    <button class="btn ghost" id="logout">Esci</button>`;

  document.getElementById('pdf').onchange = (e) => uploadPlan(e.target.files[0]);
  document.getElementById('sf').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = {
      sport_days: f.getAll('sport').map(Number),
      work_lunch_days: f.getAll('work').map(Number),
      household: String(f.get('household') || '').trim(),
      excluded: String(f.get('excluded') || '').split(',').map((x) => x.trim()).filter(Boolean),
      free_meal: Number(f.get('fm_wd')) ? { weekday: Number(f.get('fm_wd')), slot: f.get('fm_slot') } : null,
    };
    try {
      const before = (me.settings.excluded || []).join(',');
      me.settings = await api('/settings', { method: 'PUT', body });
      toast(me.settings.excluded.join(',') !== before ? 'Salvato. Rigenera il menu da "Menu" per applicare le esclusioni ai giorni già creati' : 'Impostazioni salvate', 'ok');
      if ((me.household?.username || null) !== me.settings.household) { me = await api('/me'); profilePage(); }
    } catch (err) { toast(err.message, 'error'); }
  };
  document.getElementById('wf').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/weights', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); profilePage(); } catch (err) { toast(err.message, 'error'); }
  };
  $app.querySelectorAll('[data-unfav]').forEach((b) => b.onclick = async () => { await api(`/favorites/${b.dataset.unfav}`, { method: 'DELETE' }); profilePage(); });
  $app.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { await api(`/weights/${b.dataset.del}`, { method: 'DELETE' }); profilePage(); });
  document.getElementById('logout').onclick = async () => { await api('/logout', { method: 'POST' }); me = null; location.hash = '#/login'; };
}

function planSummary(p) {
  const list = (arr) => `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  return `
    <p class="muted">${p.days.length} giorni, ${p.shared_meals.length} pasti comuni${p.free_meal?.weekday ? `, pasto libero: ${WD[p.free_meal.weekday]} ${p.free_meal.slot}` : ''}.</p>
    ${p.glossary.length ? `<h3>Glossario</h3><dl>${p.glossary.map((g) => `<dt>${esc(g.term)}</dt><dd>${esc(g.definition)}</dd>`).join('')}</dl>` : ''}
    ${p.tips.length ? `<h3>Consigli</h3>${list(p.tips)}` : ''}`;
}

function weightChart(ws) {
  if (ws.length < 2) return '';
  const pts = [...ws].reverse().slice(-20);
  const min = Math.min(...pts.map((p) => p.kg)) - 0.5, max = Math.max(...pts.map((p) => p.kg)) + 0.5;
  const W = 300, H = 80;
  const xy = pts.map((p, i) => [(i / (pts.length - 1)) * W, H - ((p.kg - min) / (max - min)) * H]);
  const delta = (pts.at(-1).kg - pts[0].kg).toFixed(1);
  return `
    <figure class="chart">
      <svg viewBox="-4 -6 ${W + 8} ${H + 12}" role="img" aria-label="Andamento del peso: ${delta > 0 ? '+' : ''}${delta} kg">
        <polyline points="${xy.map((p) => p.join(',')).join(' ')}" />
        ${xy.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3"/>`).join('')}
      </svg>
      <figcaption>${delta > 0 ? '+' : ''}${delta} kg dal ${fmtDate(pts[0].date, { day: 'numeric', month: 'short' })}</figcaption>
    </figure>`;
}

async function uploadPlan(file) {
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) return toast('PDF troppo grande (max 10 MB)', 'error');
  if (me.plan && !confirm('Caricando un nuovo piano il menu da oggi in poi verrà rigenerato. Continuo?')) return;
  const data = await new Promise((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(r.result.split(',')[1]);
    r.onerror = ko;
    r.readAsDataURL(file);
  });
  try {
    await api('/plan', { method: 'POST', body: { filename: file.name, data, start: today() } });
    me = await api('/me');
    watchJob(me.job);
    toast('Piano ricevuto, lo sto analizzando', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

route();
