import { test } from 'node:test';
import assert from 'node:assert/strict';

// Provider is chosen at import time: set env before loading ai.js (each test file runs in its own process).
process.env.AI_PROVIDER = 'openrouter';
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.OPENROUTER_MODEL = 'some/model:free';
const ai = await import('./ai.js');

const sse = (...events) => new Response(
  [': OPENROUTER PROCESSING', ...events.map((e) => `data: ${JSON.stringify(e)}`), 'data: [DONE]', ''].join('\n\n'),
  { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
);
const chunk = (content, finish_reason = null) => ({ choices: [{ delta: { content }, finish_reason }] });

const plan = {
  title: 'Piano di Mario Rossi', author: 'Dott.ssa Bianchi', valid_from: '2026-01-01',
  days: [{ weekday: 1, meals: [{ slot: 'pranzo', free: false, items: [{ options: ['100g riso'], optional: false }] }] }],
  shared_meals: [], workout_snack: [], eating_out: [], free_meal: { weekday: 0, slot: '', rule: '' }, glossary: [], tips: [], sport_tips: [],
};

test('menu request goes to OpenRouter with key, model, JSON schema and no personal names', async () => {
  let req;
  globalThis.fetch = async (url, init) => {
    req = { url, init, body: JSON.parse(init.body) };
    return sse(chunk('{"days":[{"date":"2026-10-19","meals":'), chunk('[]}]}', 'stop'));
  };
  const days = await ai.generateMenu(plan, ['2026-10-19']);
  assert.deepEqual(days, [{ date: '2026-10-19', meals: [] }]);
  assert.equal(req.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(req.init.headers.Authorization, 'Bearer test-key');
  assert.equal(req.body.model, 'some/model:free');
  assert.equal(req.body.provider.require_parameters, true);
  assert.equal(req.body.response_format.type, 'json_schema');
  assert.equal(req.body.chat_template_kwargs, undefined);
  assert.doesNotMatch(JSON.stringify(req.body.messages), /Mario Rossi|Bianchi/);
});

test('rate limits and mid-stream errors become readable messages', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 429 });
  await assert.rejects(ai.ask(plan, {}, 'ciao'), /limite di richieste/);
  globalThis.fetch = async () => sse({ error: { message: 'Provider returned error' } });
  await assert.rejects(ai.ask(plan, {}, 'ciao'), /OpenRouter: Provider returned error/);
});
