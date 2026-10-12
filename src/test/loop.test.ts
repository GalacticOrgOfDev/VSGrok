import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { streamChat, ChatMessage, ToolSpec } from '../xai/client';
import { runToolLoop } from '../agent/loop';

const TOOLS: ToolSpec[] = [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];

function fake(): Promise<{ url: string; bodies: any[]; close: () => void }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bodies: any[] = [];
  return new Promise((res) => {
    const s = http.createServer((req, r) => {
      let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
        const body = JSON.parse(b); bodies.push(body);
        r.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (bodies.length === 1) {
          // xAI returns the whole function call in one chunk; also test split args across chunks.
          r.write('data: {"choices":[{"delta":{"content":"Checking."}}]}\n\n');
          r.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n');
          r.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"src/a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');
        } else {
          r.write('data: {"choices":[{"delta":{"content":"a.ts exports foo."},"finish_reason":"stop"}],"usage":{"completion_tokens":5}}\n\n');
        }
        r.end('data: [DONE]\n\n');
      });
    }).listen(0, '127.0.0.1', () => res({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1`, bodies, close: () => { s.closeAllConnections(); s.close(); } }));
  });
}

test('tool loop: tool_call → tool result posted back → final answer', async () => {
  const srv = await fake();
  const history: ChatMessage[] = [{ role: 'user', content: 'what does a.ts do?' }];
  const executed: unknown[] = [];
  const events: string[] = [];
  const r = await runToolLoop({
    system: { role: 'system', content: 'sys' }, history, tools: TOOLS, maxSteps: 5,
    request: (msgs, tools) => streamChat(msgs, { apiKey: 'k', baseUrl: srv.url, model: 'grok-4.7', tools: tools.length ? tools : undefined }),
    execute: async (name, args) => { executed.push({ name, args }); return 'export const foo = 1;'; },
    onToolStart: (c) => events.push('start:' + c.function.name),
    onToolEnd: (c) => events.push('end:' + c.function.name),
  });
  srv.close();
  assert.deepEqual(executed, [{ name: 'read_file', args: { path: 'src/a.ts' } }]);
  assert.deepEqual(events, ['start:read_file', 'end:read_file']);
  assert.equal(srv.bodies.length, 2);
  assert.equal(srv.bodies[0].tools[0].function.name, 'read_file');
  const second = srv.bodies[1].messages;
  assert.equal(second[0].role, 'system');
  assert.equal(second[2].role, 'assistant');
  assert.equal(second[2].tool_calls[0].id, 'call_1');
  assert.equal(second[2].tool_calls[0].function.arguments, '{"path":"src/a.ts"}');
  assert.deepEqual(second[3], { role: 'tool', tool_call_id: 'call_1', content: 'export const foo = 1;' });
  assert.equal(r.finalText, 'a.ts exports foo.');
  assert.equal(r.steps, 2); assert.equal(r.toolCalls, 1); assert.equal(r.hitStepCap, false);
  assert.equal(history[history.length - 1].content, 'a.ts exports foo.');
});

test('tool loop: step cap forces a final tool-free answer', async () => {
  let n = 0;
  const history: ChatMessage[] = [{ role: 'user', content: 'loop' }];
  const r = await runToolLoop({
    system: { role: 'system', content: 's' }, history, tools: TOOLS, maxSteps: 2,
    request: async (_m, tools) => {
      n++;
      return tools.length
        ? { content: '', toolCalls: [{ id: `c${n}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }], latencyMs: 0 }
        : { content: 'summary', toolCalls: [], latencyMs: 0 };
    },
    execute: async () => 'x',
  });
  assert.equal(n, 3); assert.equal(r.hitStepCap, true); assert.equal(r.finalText, 'summary');
});
