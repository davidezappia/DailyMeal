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
  eating_out: [],
};

test('cleanPlan empties pointers to shared meals and drops the duplicated workout snack', () => {
  const p = cleanPlan(plan);
  const [col, pranzo, mer] = p.days[0].meals;
  assert.deepEqual(col.items, []);
  assert.deepEqual(mer.items, []);
  assert.equal(pranzo.items.length, 1);
  assert.deepEqual(p.shared_meals.map((m) => m.slot), ['colazione', 'merenda']);
});

test('cleanPlan moves the work lunch out of shared meals and classifies eating-out options', () => {
  const p = cleanPlan({
    ...plan,
    shared_meals: [...plan.shared_meals, { name: 'Pranzo in settimana al lavoro/ mensa', slot: 'pranzo', items: [it('Secondo + verdure')] }],
    eating_out: [{ name: 'Sushi', items: [it('max 20 pezzi')] }, { name: 'Opzione 1', items: [it('primo semplice')] }],
  });
  assert.equal(p.shared_meals.some((m) => m.slot === 'pranzo'), false);
  assert.deepEqual(p.eating_out.map((o) => [o.name, o.kind]), [['Pranzo in settimana al lavoro/ mensa', 'lavoro'], ['Sushi', 'ristorante'], ['Opzione 1', 'entrambi']]);
  assert.deepEqual(cleanPlan(p), p, 'idempotent');
});

test('cleanPlan ignores a sample menu without quantities when the shared meals carry the real portions', () => {
  const p = cleanPlan({
    days: [{ weekday: 1, meals: [
      { slot: 'pranzo', free: false, items: [it('Quinoa', 'Bulgur'), it('Bocconcini di pollo'), it('Verdure a piacere')] },
      { slot: 'cena', free: false, items: [it('80g Riso'), it('2 Uova')] }, // a real day-specific portion stays
    ] }],
    shared_meals: [{ name: 'Pranzo', slot: 'pranzo', items: [it('100g Cereali', '100g Pasta'), it('160g Carne bianca', '2 Uova'), it('Verdure a piacere')] }],
    workout_snack: [], eating_out: [],
  });
  assert.deepEqual(p.days[0].meals[0].items, []);
  assert.equal(p.days[0].meals[1].items.length, 2);
});
