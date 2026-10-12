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
