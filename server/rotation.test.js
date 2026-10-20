import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rotateMenu } from './rotation.js';
import { importPlan, planPrompt } from './plan-import.js';
import { addDays } from './day.js';

const it = (options, optional = false) => ({ options, optional });
const plan = {
  days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, meals: [
    { slot: 'pranzo', free: false, items: [it(['100g Pasta', '100g Riso']), it(['150g Pollo', '200g Merluzzo', '80g Ricotta']), it(['10 olive'], true)] },
    { slot: 'cena', free: weekday === 6, items: weekday === 6 ? [] : [it(['2 Uova', '150g Tacchino']), it(['200g Verdure'])] },
  ] })),
  shared_meals: [], workout_snack: [], eating_out: [], free_meal: { weekday: 6, slot: 'cena', rule: '' }, glossary: [], tips: [], sport_tips: [],
};
const dates = Array.from({ length: 14 }, (_, i) => addDays('2026-10-26', i)); // Monday → Sunday +1 week
const lunches = (menu) => menu.map((d) => d.meals.find((m) => m.slot === 'pranzo'));

test('favorites come first, at most twice per run and never within 3 days', () => {
  const fav = { id: 1, slot: 'pranzo', weekday: 1, title: 'Pasta al pollo', items: ['100g Pasta · fusilli', '150g Pollo'] };
  const menu = rotateMenu({ plan, dates, favorites: [fav] });
  const days = lunches(menu).map((m, i) => (m.title === 'Pasta al pollo' ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(days, [0, 7]); // only Mondays: favorites are tied to their plan weekday
});

test('meals already eaten are reused after favorites, then fresh combinations fill the gaps', () => {
  const history = [{ date: '2026-10-20', meals: [{ slot: 'pranzo', title: 'Riso e merluzzo', items: ['100g Riso', '200g Merluzzo'], free: false }] }];
  const menu = rotateMenu({ plan, dates, history });
  const titles = lunches(menu).map((m) => m.title);
  assert.equal(titles[0], 'Riso e merluzzo');
  assert.ok(titles.filter((t) => t.toLowerCase() === 'riso e merluzzo').length >= 2, 'the eaten meal comes back');
  // no dish within 3 days of itself
  titles.forEach((t, i) => assert.ok(!titles.slice(Math.max(0, i - 2), i).some((p) => p.toLowerCase() === t.toLowerCase()), `${t} repeated too soon`));
  assert.ok(new Set(titles).size >= 3, 'fresh combinations add variety');
});

test('every meal is made only of plan options, respects exclusions and the plan free meal', () => {
  const menu = rotateMenu({ plan, dates, excluded: ['ricotta'] });
  const options = new Set(plan.days.flatMap((d) => d.meals).flatMap((m) => m.items).flatMap((i) => i.options));
  for (const d of menu) for (const m of d.meals) {
    for (const i of m.items) assert.ok(options.has(i), `${i} not in plan`);
    assert.ok(!m.items.some((i) => /ricotta/i.test(i)));
  }
  assert.equal(menu[5].meals.find((m) => m.slot === 'cena').free, true); // Saturday
  const dinners = menu.map((d) => d.meals.find((m) => m.slot === 'cena')).filter((m) => !m.free).map((m) => m.title);
  dinners.forEach((t, i) => assert.notEqual(t, dinners[i - 1], `${t} two days in a row`));
  assert.ok(lunches(menu).every((m) => !m.items.includes('10 olive')), 'optional foods are skipped');
  const pairs = new Set(lunches(menu).map((m) => m.items.join('+')));
  assert.equal(pairs.size, 4, "2 cereals × 2 proteins (ricotta excluded): every pairing shows up");
});

test('importPlan accepts a fenced chatbot answer, fills missing lists and rejects bad data', () => {
  const answer = '```json\n' + JSON.stringify({ title: 'x', days: [{ weekday: 1, meals: [{ slot: 'pranzo', free: false, items: [{ options: ['100g Pasta'], optional: false }], extra: 1 }] }] }) + '\n```';
  const p = importPlan(answer);
  assert.equal(p.days[0].meals[0].items[0].options[0], '100g Pasta');
  assert.deepEqual(p.tips, []);
  assert.equal('extra' in p.days[0].meals[0], false);
  assert.throws(() => importPlan('ciao'), /JSON valido/);
  assert.equal(importPlan('Ecco il piano: ' + JSON.stringify({ days: [{ weekday: 2, meals: [] }] }) + ' Buon appetito!').days[0].weekday, 2);
  assert.throws(() => importPlan(JSON.stringify({ days: [{ weekday: 9, meals: [] }] })), /tra 1 e 7/);
  assert.throws(() => importPlan(JSON.stringify({ days: [{ weekday: 1, meals: [{ slot: 'brunch', free: false, items: [] }] }] })), /brunch/);
  assert.match(planPrompt(), /SCHEMA:[\s\S]*"weekday"/);
});
