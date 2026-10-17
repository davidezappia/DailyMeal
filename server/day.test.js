import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeDay, addDays } from './day.js';

const it = (s) => ({ options: [s], optional: false });
const plan = {
  days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    meals: [
      { slot: 'colazione', free: false, items: [] },
      { slot: 'pranzo', free: false, items: [it(`pranzo ${weekday}`)] },
      { slot: 'cena', free: weekday === 6, items: weekday === 6 ? [] : [it(`cena ${weekday}`)] },
    ],
  })),
  shared_meals: [{ name: 'Colazione dolce', slot: 'colazione', items: [it('fette biscottate')] }],
  workout_snack: [it('pane e marmellata')],
  eating_out: [{ name: 'Opzione 1', items: [it('primo semplice')] }],
  free_meal: { weekday: 6, slot: 'cena', rule: 'con buonsenso' },
  glossary: [],
  tips: ['bevi acqua', 'mastica lentamente'],
  sport_tips: [],
};
// 2026-10-16 is a Friday, 2026-10-17 a Saturday.
const FRI = '2026-10-16', SAT = '2026-10-17';
const menu = {
  [FRI]: [{ slot: 'pranzo', title: 'Uova e verdure', items: ['2 uova'] }, { slot: 'cena', title: 'Riso e merluzzo', items: [] }],
  [SAT]: [{ slot: 'pranzo', title: 'Pesce e legumi', items: [] }, { slot: 'cena', title: 'Pasto libero', items: [], free: true }],
};
const day = (date, settings = {}, events = {}) => composeDay({ date, plan, settings, events, menuFor: (d) => menu[d] || null });
const meal = (d, slot) => d.meals.find((m) => m.slot === slot);

test('addDays crosses month boundaries', () => assert.equal(addDays('2026-10-31', 1), '2026-11-01'));

test('plan free meal shows on its day', () => {
  const d = day(SAT);
  assert.equal(meal(d, 'cena').free, true);
  assert.equal(meal(d, 'pranzo').title, 'Pesce e legumi');
});

test('moving free meal to Friday swaps Friday and Saturday', () => {
  const s = { free_meal: { weekday: 5, slot: 'cena' } };
  const fri = day(FRI, s), sat = day(SAT, s);
  assert.equal(meal(fri, 'cena').free, true);
  assert.equal(meal(fri, 'pranzo').title, 'Pesce e legumi');
  assert.equal(meal(sat, 'cena').free, false);
  assert.equal(meal(sat, 'cena').title, 'Riso e merluzzo');
  assert.equal(meal(sat, 'cena').sourceDate, FRI);
});

test('moving free slot to lunch moves lunch to dinner', () => {
  const d = day(SAT, { free_meal: { weekday: 6, slot: 'pranzo' } });
  assert.equal(meal(d, 'pranzo').free, true);
  assert.equal(meal(d, 'cena').title, 'Pesce e legumi');
  assert.equal(meal(d, 'cena').free, false);
});

test('sport day from settings adds workout snack, event overrides it', () => {
  assert.deepEqual(day(FRI, { sport_days: [5] }).workoutSnack, ['pane e marmellata']);
  assert.equal(day(FRI, { sport_days: [5] }, { sport: false }).sport, false);
});

test('work lunch default and per-day override', () => {
  assert.equal(meal(day(FRI, { work_lunch_days: [5] }), 'pranzo').out, 'lavoro');
  assert.equal(meal(day(FRI, { work_lunch_days: [5] }, { out: { pranzo: 'casa' } }), 'pranzo').out, null);
});

test('favorites: lunch only on the same plan day, breakfast on any day, liked flag', () => {
  const favorites = [
    { id: 1, slot: 'pranzo', weekday: 5, title: 'uova e verdure', items: [] },
    { id: 2, slot: 'pranzo', weekday: 1, title: 'Pasta e fagioli', items: [] },
    { id: 3, slot: 'colazione', weekday: 3, title: 'Porridge', items: [] },
  ];
  const d = composeDay({ date: FRI, plan, settings: {}, events: {}, menuFor: (x) => menu[x] || null, favorites });
  assert.deepEqual(meal(d, 'pranzo').favorites.map((f) => f.id), [1]);
  assert.equal(meal(d, 'pranzo').liked, true);
  assert.deepEqual(meal(d, 'colazione').favorites.map((f) => f.id), [3]);
});

test('missing menu falls back to plan options, shared meals for breakfast', () => {
  const d = day('2026-10-19');
  assert.equal(meal(d, 'pranzo').generated, false);
  assert.deepEqual(meal(d, 'colazione').planOptions, ['▸ Colazione dolce', 'fette biscottate']);
});
