import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPlan } from './ai.js';

const it = (...options) => ({ options, optional: false });
const plan = {
  days: [{ weekday: 1, meals: [
    { slot: 'colazione', free: false, items: [it('COLAZIONE DOLCE (vedi pagina 6)', 'COLAZIONE SALATA (vedi pagina 6)')] },
    { slot: 'pranzo', free: false, items: [it('100g di cereali')] },
    { slot: 'merenda', free: false, items: [it('MERENDA (vedi pagina 6)')] },
  ] }],
  shared_meals: [
    { name: 'COLAZIONE DOLCE', slot: 'colazione', items: [it('4 fette biscottate')] },
    { name: 'MERENDA', slot: 'merenda', items: [it('25g crackers')] },
    { name: 'SPUNTINO PRE O POST WORKOUT', slot: 'spuntino', items: [it('2 fette di pane')] },
  ],
  workout_snack: [it('2 fette di pane')],
};

test('cleanPlan empties pointers to shared meals and drops the duplicated workout snack', () => {
  const p = cleanPlan(plan);
  const [col, pranzo, mer] = p.days[0].meals;
  assert.deepEqual(col.items, []);
  assert.deepEqual(mer.items, []);
  assert.equal(pranzo.items.length, 1);
  assert.deepEqual(p.shared_meals.map((m) => m.slot), ['colazione', 'merenda']);
});
