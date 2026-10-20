import { test } from 'node:test';
import assert from 'node:assert/strict';

// Provider chain is read at import time (each test file runs in its own process).
process.env.AI_PROVIDER = 'azure, gemini';
process.env.AZURE_OPENAI_ENDPOINT = 'https://mia-risorsa.openai.azure.com/';
process.env.AZURE_OPENAI_API_KEY = 'azure-key';
process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-menu';
process.env.GEMINI_API_KEY = 'gemini-key';
process.env.GEMINI_MODEL = 'gemini-test';
const ai = await import('./ai.js');

const sse = (content) => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
  { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
);
const plan = { days: [], shared_meals: [], workout_snack: [], eating_out: [], free_meal: { weekday: 0, slot: '', rule: '' }, glossary: [], tips: [], sport_tips: [] };

test('Azure gets api-key header, deployment as model and max_completion_tokens without temperature', async () => {
  let req;
  globalThis.fetch = async (url, init) => { req = { url, headers: init.headers, body: JSON.parse(init.body) }; return sse('ok'); };
  assert.equal(await ai.ask(plan, {}, 'ciao'), 'ok');
  assert.equal(req.url, 'https://mia-risorsa.openai.azure.com/openai/v1/chat/completions');
  assert.equal(req.headers['api-key'], 'azure-key');
  assert.equal(req.headers.Authorization, undefined);
  assert.equal(req.body.model, 'gpt-menu');
  assert.ok(req.body.max_completion_tokens > 0);
  assert.equal(req.body.max_tokens, undefined);
  assert.equal(req.body.temperature, undefined);
});

test('when Azure fails the next provider (Gemini) answers', async () => {
  const urls = [];
  globalThis.fetch = async (url, init) => {
    urls.push(url);
    if (url.includes('azure')) return new Response('{"error":"quota"}', { status: 500 });
    assert.equal(init.headers.Authorization, 'Bearer gemini-key');
    assert.equal(JSON.parse(init.body).model, 'gemini-test');
    return sse('da gemini');
  };
  assert.equal(await ai.ask(plan, {}, 'ciao'), 'da gemini');
  assert.deepEqual(urls.map((u) => new URL(u).host), ['mia-risorsa.openai.azure.com', 'generativelanguage.googleapis.com']);
  assert.equal(ai.PROVIDER, 'azure,gemini');
});
