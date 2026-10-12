import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { postXai, parseRetryAfter, backoffMs, isRetryable, GrokApiError } from '../xai/client';

function server(handler: (n: number, req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string; count: () => number; close: () => void }> {
  let n = 0;
  return new Promise((ok) => {
    const s = http.createServer((req, res) => { req.resume(); req.on('end', () => handler(++n, req, res)); })
      .listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1`, count: () => n, close: () => { s.closeAllConnections(); s.close(); } }));
  });
}

test('retry: 429 with Retry-After then success', async () => {
  const s = await server((n, _q, r) => {
    if (n === 1) { r.writeHead(429, { 'Retry-After': '0' }); r.end('{"error":"slow down"}'); return; }
    r.writeHead(200, { 'Content-Type': 'application/json' }); r.end('{"ok":true}');
  });
  const retries: number[] = [];
  const out = await postXai('/x', {}, { apiKey: 'k', baseUrl: s.url, retryBaseMs: 1, onRetry: (i) => retries.push(i.status ?? 0) });
  assert.deepEqual(out, { ok: true });
  assert.deepEqual(retries, [429]);
  s.close();
});

test('retry: 5xx exhausts retries and reports attempts', async () => {
  const s = await server((_n, _q, r) => { r.writeHead(503); r.end('busy'); });
  await assert.rejects(postXai('/x', {}, { apiKey: 'k', baseUrl: s.url, retryBaseMs: 1, maxRetries: 2 }), (e: GrokApiError) => e.kind === 'server' && e.attempts === 3);
  assert.equal(s.count(), 3);
  s.close();
});

test('retry: 401 is not retried', async () => {
  const s = await server((_n, _q, r) => { r.writeHead(401); r.end('bad key'); });
  await assert.rejects(postXai('/x', {}, { apiKey: 'k', baseUrl: s.url, retryBaseMs: 1 }), (e: GrokApiError) => e.kind === 'auth');
  assert.equal(s.count(), 1);
  s.close();
});

test('retry: never retries once the stream has started', async () => {
  const s = await server((_n, _q, r) => { r.writeHead(200, { 'Content-Type': 'text/event-stream' }); r.write('data: {"a":1}\n\n'); setTimeout(() => r.destroy(), 20); });
  const evts: unknown[] = [];
  await assert.rejects(postXai('/x', {}, { apiKey: 'k', baseUrl: s.url, retryBaseMs: 1 }, (e) => evts.push(e)));
  assert.equal(s.count(), 1);
  assert.equal(evts.length, 1);
  s.close();
});

test('offline: connection refused is classified offline', async () => {
  const s = await server(() => undefined); const url = s.url; s.close();
  await new Promise(r => setTimeout(r, 20));
  await assert.rejects(postXai('/x', {}, { apiKey: 'k', baseUrl: url, retryBaseMs: 1, maxRetries: 1 }), (e: GrokApiError) => e.kind === 'offline');
});

test('cancel: abort during backoff rejects as aborted promptly', async () => {
  const s = await server((_n, _q, r) => { r.writeHead(429, { 'Retry-After': '30' }); r.end('x'); });
  const ac = new AbortController();
  const t0 = Date.now();
  const p = postXai('/x', {}, { apiKey: 'k', baseUrl: s.url, signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(p, (e: GrokApiError) => e.kind === 'aborted');
  assert.ok(Date.now() - t0 < 2000);
  s.close();
});

test('timeout: idle request times out', async () => {
  const s = await server(() => undefined); // never responds
  await assert.rejects(postXai('/x', {}, { apiKey: 'k', baseUrl: s.url, timeoutMs: 100, maxRetries: 0 }), (e: GrokApiError) => e.kind === 'timeout');
  s.close();
});

test('parseRetryAfter / backoffMs / isRetryable', () => {
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter('999'), 60000);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 5_000), 5000);
  assert.equal(parseRetryAfter('nonsense'), undefined);
  assert.equal(backoffMs(0, 1000, undefined, () => 0), 500);
  assert.equal(backoffMs(3, 1000, undefined, () => 1), 8000);
  assert.equal(backoffMs(10, 1000, undefined, () => 1), 30000);
  assert.equal(backoffMs(1, 1000, 1234), 1234);
  assert.equal(isRetryable(new GrokApiError('x', 'rate_limit')), true);
  assert.equal(isRetryable(new GrokApiError('x', 'auth')), false);
});
