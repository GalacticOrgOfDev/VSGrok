import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseModels, listModels, FALLBACK_MODELS } from '../xai/models';

test('parseModels keeps chat models, drops image/video/voice, newest first', () => {
  const r = parseModels({ object: 'list', data: [
    { id: 'grok-4.6', created: 10, context_length: 256000 },
    { id: 'grok-imagine-image', created: 30 },
    { id: 'grok-4.7', created: 20, capabilities: { reasoning_effort: ['low', 'high'] } },
    { id: 'bad id!', created: 40 }, { nope: 1 },
  ] });
  assert.deepEqual(r.map(m => m.id), ['grok-4.7', 'grok-4.6']);
  assert.equal(r[0].reasoning, true);
  assert.equal(r[1].contextLength, 256000);
});

test('parseModels tolerates garbage', () => { assert.deepEqual(parseModels(null), []); assert.deepEqual(parseModels({ data: 'x' }), []); });

function mem() { const m = new Map<string, unknown>(); return { get: <T>(k: string) => m.get(k) as T, update: async (k: string, v: unknown) => { m.set(k, v); } }; }

test('listModels without key returns fallback', async () => {
  const r = await listModels(mem(), 'https://api.x.ai/v1', '');
  assert.equal(r.source, 'fallback'); assert.equal(r.models, FALLBACK_MODELS);
});

test('listModels falls back when fetch fails, uses cache when present', async () => {
  const s = mem();
  const r = await listModels(s, 'http://127.0.0.1:9/v1', 'k', true);
  assert.equal(r.source, 'fallback'); assert.ok(r.error);
  await s.update('vsgrok.modelCache', { at: 0, baseUrl: 'http://127.0.0.1:9/v1', models: [{ id: 'grok-x' }] });
  const r2 = await listModels(s, 'http://127.0.0.1:9/v1', 'k', true);
  assert.equal(r2.source, 'cache'); assert.equal(r2.models[0].id, 'grok-x');
});
