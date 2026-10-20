// Menu without AI: favorites first, then meals already eaten, then fresh combinations of the plan's own options.
import { isoWeekday } from './ai.js';
import { planChoices, templateSlots, favoritesFor, isPlanItem, mentionsExcluded } from './day.js';
import { shortName } from './guard.js';

const MAX_USES_PER_RUN = 2; // the same dish at most twice in one generation…
const MIN_GAP_DAYS = 3; // …and never within 3 days of its last appearance
const FRESH_LOOKAHEAD = 12; // rotations considered when composing a new dish
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

/**
 * @param {{plan:object, dates:string[], favorites?:object[], history?:{date:string,meals:object[]}[], excluded?:string[]}} a
 * history: earlier menu days (oldest first), the "already eaten" pool.
 * @returns {{date:string, meals:{slot:string,title:string,items:string[],free:boolean}[]}[]}
 */
export function rotateMenu({ plan, dates, favorites = [], history = [], excluded = [] }) {
  const lastUse = new Map(); // dish key → last date
  const runUses = new Map(); // dish key → uses in this generation
  const key = (slot, title) => `${slot}|${title.toLowerCase()}`;
  for (const d of history) for (const m of d.meals) if (!m.free) lastUse.set(key(m.slot, m.title), d.date);

  return dates.map((date, di) => {
    const wd = isoWeekday(date);
    const meals = templateSlots(plan, wd).map((slot) => {
      const planMeal = plan.days.find((d) => d.weekday === wd)?.meals.find((m) => m.slot === slot);
      if (planMeal?.free) return { slot, title: 'Pasto libero', items: [], free: true };
      const groups = planChoices(plan, wd, slot);
      if (!groups.length) return null;
      // Only dishes that fit this day's plan and the user's exclusions.
      const fits = (items) => items.length && items.every((i) => isPlanItem(groups, i) && !mentionsExcluded(i, excluded));

      const seen = new Set();
      const candidates = [
        ...favoritesFor(plan, favorites, wd, slot).map((f) => ({ title: f.title, items: f.items })),
        ...[...history].reverse().flatMap((h) => h.meals.filter((m) => m.slot === slot && !m.free).map((m) => ({ title: m.title, items: m.items }))),
      ].filter((c) => fits(c.items) && !seen.has(c.title.toLowerCase()) && seen.add(c.title.toLowerCase()));

      const available = (title) => {
        const k = key(slot, title), last = lastUse.get(k);
        return (runUses.get(k) || 0) < MAX_USES_PER_RUN && (!last || daysBetween(last, date) >= MIN_GAP_DAYS);
      };
      const daysSince = (title) => { const last = lastUse.get(key(slot, title)); return last ? daysBetween(last, date) : Infinity; };
      const pick = candidates.find((c) => available(c.title)) || freshCombination(groups, di, excluded, daysSince);

      const k = key(slot, pick.title);
      lastUse.set(k, date);
      runUses.set(k, (runUses.get(k) || 0) + 1);
      return { slot, title: pick.title, items: pick.items, free: false };
    }).filter(Boolean);
    return { date, meals };
  });
}

/** Rotates through the plan's alternatives by day, skipping excluded foods; optional foods are left out. */
function freshCombination(groups, dayIndex, excluded, daysSince) {
  const combo = (n) => {
    const group = groups[n % groups.length];
    const items = group.items.filter((it) => !it.optional).map((it, k) => {
      const allowed = it.options.filter((o) => !mentionsExcluded(o, excluded));
      const pool = allowed.length ? allowed : it.options;
      // Shift each food's offset every full cycle so pairings change (pasta+fish, then pasta+chicken…).
      return pool[(n + k * Math.floor(n / pool.length)) % pool.length];
    });
    return { title: items.slice(0, 2).map(shortName).join(' e '), items };
  };
  // Least recently served among the next rotations: varied even when the plan offers only a few options.
  let best = combo(dayIndex);
  for (let n = dayIndex + 1; n < dayIndex + FRESH_LOOKAHEAD && daysSince(best.title) !== Infinity; n++) {
    const c = combo(n);
    if (daysSince(c.title) > daysSince(best.title)) best = c;
  }
  return best;
}
