import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { SseParser, parseDelta, ToolCallAccumulator, stripFences } from '../xai/sse';
import { cleanCompletion } from '../xai/completion';

const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

test('SSE parser reassembles multi-byte UTF-8 split across chunks', () => {
  const out: string[] = [];
  const p = new SseParser((e) => { const d = parseDelta(e); if (d.content) { out.push(d.content); } });
  const buf = Buffer.from(ev({ choices: [{ delta: { content: 'héllo 🚀 世界' } }] }) + 'data: [DONE]\n\n', 'utf8');
  for (let i = 0; i < buf.length; i += 3) { p.push(buf.subarray(i, i + 3)); }
  p.end();
  assert.equal(out.join(''), 'héllo 🚀 世界');
  assert.equal(p.done, true);
});

test('SSE parser flushes final line without trailing newline and ignores junk', () => {
  const out: string[] = [];
  const p = new SseParser((e) => { const d = parseDelta(e); if (d.content) { out.push(d.content); } });
  p.push(': comment\ndata: {bad json\n');
  p.push('data: ' + JSON.stringify({ choices: [{ delta: { content: 'end' } }] }));
  p.end();
  assert.deepEqual(out, ['end']);
});

test('tool call fragments accumulate', () => {
  const acc = new ToolCallAccumulator();
  acc.add(parseDelta({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_', arguments: '{"pa' } }] } }] }).toolCalls!);
  acc.add(parseDelta({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a.ts"}' } }] } }] }).toolCalls!);
  const [c] = acc.result();
  assert.equal(c.id, 'c1');
  assert.equal(c.function.name, 'read_file');
  assert.deepEqual(JSON.parse(c.function.arguments), { path: 'a.ts' });
});

test('finish reason and usage parsed', () => {
  const d = parseDelta({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 5 } });
  assert.equal(d.finishReason, 'stop');
  assert.equal(d.usage?.completion_tokens, 5);
});

test('stripFences and cleanCompletion', () => {
  assert.equal(stripFences('```ts\nconst a = 1;\n```'), 'const a = 1;');
  assert.equal(stripFences('plain'), 'plain');
  assert.equal(cleanCompletion('```js\nconst x = 1;\n```', 'const x', ''), ' = 1;');
  assert.equal(cleanCompletion('foo();', '', 'bar'), 'foo();');
});
