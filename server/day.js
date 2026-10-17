import { SLOTS, isoWeekday } from './ai.js';

export const addDays = (date, n) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const LABEL = { colazione: 'Colazione', spuntino: 'Spuntino', pranzo: 'Pranzo', merenda: 'Merenda', cena: 'Cena' };
const itemLines = (items = []) => items.map((i) => (i.optional ? 'Facoltativo: ' : '') + i.options.join(' — oppure — '));

/** Plan options for a slot on a weekday, as readable lines (falls back to shared meals). */
function planOptions(plan, wd, slot) {
  const own = plan.days.find((d) => d.weekday === wd)?.meals.find((m) => m.slot === slot);
  if (own?.items.length) return itemLines(own.items);
  return plan.shared_meals.filter((m) => m.slot === slot).flatMap((m) => [`▸ ${m.name}`, ...itemLines(m.items)]);
}

/** Structured plan items for a slot, as groups to pick from (one group per shared meal, e.g. sweet/savory breakfast). */
export function planChoices(plan, wd, slot) {
  const own = plan.days.find((d) => d.weekday === wd)?.meals.find((m) => m.slot === slot);
  if (own?.items.length) return [{ name: '', items: own.items }];
  return plan.shared_meals.filter((m) => m.slot === slot).map(({ name, items }) => ({ name, items }));
}

export const DETAIL_SEP = ' · ';

/** An edited meal item must be one of the plan's options, optionally followed by a short detail ("100g cereali · riso basmati"). */
export function isPlanItem(choices, item) {
  const options = choices.flatMap((g) => g.items.flatMap((i) => i.options));
  return options.some((o) => item === o || (item.startsWith(o + DETAIL_SEP) && item.length - o.length <= 80));
}

/** Favorites usable for a slot: same plan day, or any day when the slot uses the shared meals (breakfast, snack). */
export function favoritesFor(plan, favorites, wd, slot) {
  const own = plan.days.find((d) => d.weekday === wd)?.meals.find((m) => m.slot === slot);
  const shared = !own?.items.length;
  return favorites.filter((f) => f.slot === slot && (shared || f.weekday === wd));
}

/** Meal slots of a day in the plan's own order (a "spuntino" may be mid-afternoon); shared-only slots go in their usual place. */
function templateSlots(plan, wd) {
  const order = [...new Set(plan.days.find((d) => d.weekday === wd)?.meals.map((m) => m.slot) || [])];
  for (const s of new Set(plan.shared_meals.map((m) => m.slot))) {
    if (order.includes(s)) continue;
    const next = order.findIndex((o) => SLOTS.indexOf(o) > SLOTS.indexOf(s));
    order.splice(next < 0 ? order.length : next, 0, s);
  }
  return order;
}

/** Free meal actually in force: user's choice, else the plan's. */
export function freeMeal(plan, settings) {
  const p = plan.free_meal?.weekday ? plan.free_meal : null;
  const s = settings.free_meal?.weekday ? settings.free_meal : null;
  return { plan: p, chosen: s || p };
}

/**
 * Builds the view of one day: menu (with free-meal swap), sport, meals out, tips.
 * @param {{date:string, plan:object, settings:object, events:object, menuFor:(date:string)=>any[]|null}} a
 */
export function composeDay({ date, plan, settings, events, menuFor, favorites = [] }) {
  const wd = isoWeekday(date);
  const { plan: pf, chosen } = freeMeal(plan, settings);

  // Plan rule: moving the free meal to another day swaps the two days' menus.
  let srcWd = wd;
  if (pf && chosen.weekday !== pf.weekday) {
    if (wd === chosen.weekday) srcWd = pf.weekday;
    else if (wd === pf.weekday) srcWd = chosen.weekday;
  }
  const srcDate = addDays(date, srcWd - wd);
  const stored = menuFor(srcDate);
  const isFreeDay = chosen && wd === chosen.weekday;

  let meals = templateSlots(plan, srcWd).map((slot) => {
    const m = stored?.find((x) => x.slot === slot);
    const favs = favoritesFor(plan, favorites, srcWd, slot);
    return {
      favorites: favs,
      liked: !!m && favs.some((f) => f.title.toLowerCase() === m.title.toLowerCase()),
      slot,
      label: LABEL[slot],
      title: m?.title || LABEL[slot],
      items: m?.items || [],
      generated: !!m,
      free: false,
      sourceDate: srcDate,
      planOptions: planOptions(plan, srcWd, slot),
      choices: planChoices(plan, srcWd, slot),
    };
  });
  if (isFreeDay) {
    // Free slot moved within the day: the meal that was there takes the plan's free slot.
    if (pf && chosen.slot !== pf.slot) {
      const a = meals.find((m) => m.slot === pf.slot), b = meals.find((m) => m.slot === chosen.slot);
      if (a && b) meals = meals.map((m) => (m === a ? { ...b, slot: a.slot, label: a.label } : m === b ? { ...a, slot: b.slot, label: b.label } : m));
    }
    meals = meals.map((m) => (m.slot === chosen.slot ? { ...m, free: true, title: 'Pasto libero', items: [], planOptions: [plan.free_meal?.rule].filter(Boolean) } : m));
  }

  const sport = events.sport ?? (settings.sport_days || []).includes(wd);
  const defaultOut = (settings.work_lunch_days || []).includes(wd) ? { pranzo: 'lavoro' } : {};
  const out = { ...defaultOut, ...(events.out || {}) };
  meals = meals.map((m) => ({ ...m, out: out[m.slot] && out[m.slot] !== 'casa' ? out[m.slot] : null }));

  return {
    date,
    weekday: wd,
    sport,
    note: events.note || '',
    meals,
    workoutSnack: sport ? plan.workout_snack : [],
    eatingOut: plan.eating_out.map(({ name, kind, items }) => ({ name, kind, items })),
    tips: tipsFor({ date, plan, sport, meals, isFreeDay, chosen }),
  };
}

function tipsFor({ date, plan, sport, meals, isFreeDay, chosen }) {
  const tips = [];
  if (sport) tips.push(...(plan.sport_tips.length ? plan.sport_tips.slice(0, 2) : ['Giorno di sport: ricordati lo spuntino pre o post allenamento.']));
  if (meals.some((m) => m.out === 'lavoro')) tips.push('Pasto al lavoro: preparalo la sera prima in un contenitore ermetico, con il condimento a parte da aggiungere al momento.');
  if (meals.some((m) => m.out === 'ristorante')) tips.push('Al ristorante: verdure all\'inizio, condimenti a parte, niente fritti e attenzione al pane in tavola.');
  if (isFreeDay) tips.push('Oggi c\'è il pasto libero: goditelo con buonsenso sulle quantità.');
  if (chosen && isoWeekday(addDays(date, -1)) === chosen.weekday) tips.push('Ieri pasto libero: oggi meglio non pesarsi.');
  // Rotate the plan's general tips day by day.
  const n = Math.floor(Date.parse(date) / 864e5);
  const pool = plan.tips;
  for (let i = 0; i < Math.min(3, pool.length); i++) tips.push(pool[(n * 3 + i) % pool.length]);
  return tips;
}
