import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { streamChat, GrokApiError } from '../xai/client';

function server(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  return new Promise((res) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => {
      res({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1`, close: () => { s.closeAllConnections(); s.close(); } });
    });
  });
}
const base = { apiKey: 'test', model: 'grok-4.7' };

test('streams content and tool calls from a mock server', async () => {
  const srv = await server((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t","function":{"name":"read_file","arguments":"{}"}}]}}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
  const chunks: string[] = [];
  const r = await streamChat([{ role: 'user', content: 'x' }], { ...base, baseUrl: srv.url, onContent: (d) => chunks.push(d) });
  srv.close();
  assert.equal(r.content, 'Hi');
  assert.deepEqual(chunks, ['Hi']);
  assert.equal(r.toolCalls[0].function.name, 'read_file');
});

test('maps 401 to auth error', async () => {
  const srv = await server((_q, res) => { res.writeHead(401); res.end('{"error":{"message":"bad key"}}'); });
  await assert.rejects(streamChat([], { ...base, baseUrl: srv.url }), (e: GrokApiError) => e.kind === 'auth');
  srv.close();
});

test('abort cancels an in-flight stream', async () => {
  const srv = await server((_q, res) => { res.writeHead(200); res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'); });
  const ac = new AbortController();
  const p = streamChat([], { ...base, baseUrl: srv.url, signal: ac.signal, onContent: () => ac.abort() });
  await assert.rejects(p, (e: GrokApiError) => e.kind === 'aborted');
  srv.close();
});

test('idle timeout fires', async () => {
  const srv = await server((_q, res) => { res.writeHead(200); });
  await assert.rejects(streamChat([], { ...base, baseUrl: srv.url, timeoutMs: 200 }), (e: GrokApiError) => e.kind === 'timeout');
  srv.close();
});

test('missing key rejects without a request', async () => {
  await assert.rejects(streamChat([], { ...base, apiKey: '', baseUrl: 'http://127.0.0.1:1/v1' }), (e: GrokApiError) => e.kind === 'missing_key');
});

test('sends reasoning_effort + x-grok-conv-id and surfaces reasoning_content and cached tokens', async () => {
  let body: any = null; let conv: unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
  const srv = await server((req, res) => {
    conv = req.headers['x-grok-conv-id'];
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      body = JSON.parse(b);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":7},"completion_tokens_details":{"reasoning_tokens":3}}}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  const thoughts: string[] = [];
  const r = await streamChat([{ role: 'user', content: 'x' }], { ...base, baseUrl: srv.url, reasoningEffort: 'low', convId: 'c1', onReasoning: (d) => thoughts.push(d) });
  srv.close();
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(conv, 'c1');
  assert.deepEqual(thoughts, ['hmm']);
  assert.equal(r.content, 'ok');
  assert.equal(r.usage?.prompt_tokens_details?.cached_tokens, 7);
  assert.equal(r.usage?.completion_tokens_details?.reasoning_tokens, 3);
});

test('omits reasoning_effort and conv header when unset', async () => {
  let body: any = null; let conv: unknown = 'x'; // eslint-disable-line @typescript-eslint/no-explicit-any
  const srv = await server((req, res) => {
    conv = req.headers['x-grok-conv-id'];
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { body = JSON.parse(b); res.writeHead(200); res.end('data: [DONE]\n\n'); });
  });
  await streamChat([], { ...base, baseUrl: srv.url });
  srv.close();
  assert.equal('reasoning_effort' in body, false);
  assert.equal(conv, undefined);
});
