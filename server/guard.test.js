import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeMeal, vocabulary } from './guard.js';

const it = (options, optional = false) => ({ options, optional });
const plan = {
  days: [
    { weekday: 3, meals: [{ slot: 'pranzo', free: false, items: [
      it(['100g Pasta (bianca, integrale)', '100g Cereali (riso, farro, orzo)']),
      it(['160g Carne bianca (pollo, tacchino)', '80g Formaggio fresco (ricotta, feta)']),
      it(['Verdure a piacere']),
      it(['10 olive'], true),
    ] }] },
    { weekday: 6, meals: [{ slot: 'cena', free: true, items: [] }] },
  ],
  shared_meals: [],
  tips: [],
};
const vocab = vocabulary(plan);
const pick = (option, detail = '') => ({ option, detail });

test('keeps plan options and short known details', () => {
  const m = sanitizeMeal(plan, 3, { slot: 'pranzo', title: 'Riso con pollo e zucchine', items: [
    pick('100g Cereali (riso, farro, orzo)', 'riso basmati'), pick('160g Carne bianca (pollo, tacchino)'), pick('Verdure a piacere', 'zucchine grigliate'),
  ] }, vocab);
  assert.equal(m.title, 'Riso con pollo e zucchine');
  assert.deepEqual(m.items, ['100g Cereali (riso, farro, orzo) · riso basmati', '160g Carne bianca (pollo, tacchino)', 'Verdure a piacere · zucchine grigliate']);
});

test('drops invented ingredients, fills missing required items, rewrites an off-plan title', () => {
  const m = sanitizeMeal(plan, 3, { slot: 'pranzo', title: 'Pasta ripiena al forno con besciamella', items: [
    pick('100g Pasta (bianca, integrale)', 'con besciamella e burro'), pick('Panna da cucina'),
  ] }, vocab);
  assert.deepEqual(m.items, ['100g Pasta (bianca, integrale)', '160g Carne bianca (pollo, tacchino)', 'Verdure a piacere']);
  assert.doesNotMatch(m.title, /besciamella/i);
});

test('excluded foods are swapped for another plan alternative', () => {
  const m = sanitizeMeal(plan, 3, { slot: 'pranzo', title: 'Pasta con ricotta', items: [
    pick('100g Pasta (bianca, integrale)'), pick('80g Formaggio fresco (ricotta, feta)'), pick('Verdure a piacere'),
  ] }, vocab, ['ricotta']);
  assert.ok(m.items.includes('160g Carne bianca (pollo, tacchino)'));
  assert.ok(!m.items.some((i) => /ricotta/i.test(i)));
  assert.doesNotMatch(m.title, /ricotta/i);
});

test('the title cannot name a food that is not in the meal', () => {
  const m = sanitizeMeal(plan, 3, { slot: 'pranzo', title: 'Riso con lenticchie e zucchine', items: [
    pick('100g Cereali (riso, farro, orzo)', 'riso'), pick('160g Carne bianca (pollo, tacchino)', 'pollo'), pick('Verdure a piacere', 'zucchine'),
  ] }, vocab);
  assert.doesNotMatch(m.title, /lenticchie/i);
});

test('only the plan decides the free meal; slots missing from the plan are dropped', () => {
  assert.equal(sanitizeMeal(plan, 6, { slot: 'cena', title: 'x', items: [] }, vocab).free, true);
  assert.equal(sanitizeMeal(plan, 3, { slot: 'pranzo', title: 'Libero', free: true, items: [] }, vocab).free, false);
  assert.equal(sanitizeMeal(plan, 3, { slot: 'merenda', title: 'x', items: [] }, vocab), null);
});

test('alignPicks moves a housemate meal into this plan with this plan quantities and details', async () => {
  const { alignPicks } = await import('./guard.js');
  const { planChoices } = await import('./day.js');
  const herPlan = {
    days: [{ weekday: 3, meals: [{ slot: 'pranzo', free: false, items: [] }] }],
    shared_meals: [{ name: 'Pranzo', slot: 'pranzo', items: [
      it(['80g Cereali (riso, farro, orzo)', '80g Pasta (bianca, integrale)', '300g Patate']),
      it(['130g Carne bianca (pollo, tacchino)', '150g Pesce (merluzzo, orata)', '2 Uova']),
      it(['Verdure a piacere']),
      it(['1 cucchiaio Olio EVO']),
    ] }],
    tips: [],
  };
  const myMeal = ['100g Pasta (bianca, integrale) · fusilli', '160g Carne bianca (pollo, tacchino) · pollo', 'Verdure a piacere · zucchine'];
  const picks = alignPicks(planChoices(herPlan, 3, 'pranzo'), myMeal);
  const m = sanitizeMeal(herPlan, 3, { slot: 'pranzo', title: 'Fusilli con pollo e zucchine', items: picks }, vocabulary(herPlan));
  assert.deepEqual(m.items, ['80g Pasta (bianca, integrale) · fusilli', '130g Carne bianca (pollo, tacchino) · pollo', 'Verdure a piacere · zucchine', '1 cucchiaio Olio EVO']);
  assert.equal(m.title, 'Fusilli con pollo e zucchine');
});
