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

function templateSlots(plan, wd) {
  const own = plan.days.find((d) => d.weekday === wd)?.meals.map((m) => m.slot) || [];
  const shared = plan.shared_meals.map((m) => m.slot);
  return SLOTS.filter((s) => own.includes(s) || shared.includes(s));
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
export function composeDay({ date, plan, settings, events, menuFor }) {
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
    return {
      slot,
      label: LABEL[slot],
      title: m?.title || LABEL[slot],
      items: m?.items || [],
      generated: !!m,
      free: false,
      sourceDate: srcDate,
      planOptions: planOptions(plan, srcWd, slot),
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
    workoutSnack: sport ? itemLines(plan.workout_snack) : [],
    eatingOut: plan.eating_out.map((o) => ({ name: o.name, lines: itemLines(o.items) })),
    tips: tipsFor({ date, plan, sport, meals, isFreeDay, chosen }),
  };
}

function tipsFor({ date, plan, sport, meals, isFreeDay, chosen }) {
  const tips = [];
  if (sport) tips.push(...(plan.sport_tips.length ? plan.sport_tips.slice(0, 2) : ['Giorno di sport: ricordati lo spuntino pre o post allenamento.']));
  if (meals.some((m) => m.out === 'lavoro')) tips.push('Pranzo al lavoro: l\'ideale è portare il pasto previsto da casa; altrimenti scegli una delle opzioni "fuori casa".');
  if (meals.some((m) => m.out === 'ristorante')) tips.push('Al ristorante: piatti semplici, condimenti leggeri, niente fritti. Guarda le opzioni del piano per i pasti fuori.');
  if (isFreeDay) tips.push('Oggi c\'è il pasto libero: goditelo con buonsenso sulle quantità.');
  if (chosen && isoWeekday(addDays(date, -1)) === chosen.weekday) tips.push('Ieri pasto libero: oggi meglio non pesarsi.');
  // Rotate the plan's general tips day by day.
  const n = Math.floor(Date.parse(date) / 864e5);
  const pool = plan.tips;
  for (let i = 0; i < Math.min(3, pool.length); i++) tips.push(pool[(n * 3 + i) % pool.length]);
  return tips;
}
