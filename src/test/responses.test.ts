// Fake xAI Responses server. Event names follow docs.x.ai (response.reasoning_summary_text.delta, response.completed,
// response.incomplete) and the Open Responses streaming format xAI states it is compatible with.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { streamResponse, compactInput, buildResponsesPayload, extractCitations, ResponsesStreamState } from '../xai/responses';
import { runResponsesLoop, ConversationState } from '../agent/responsesLoop';
import { renderCommitMessage, COMMIT_FORMAT } from '../xai/commit';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Handler = (body: any, n: number, res: http.ServerResponse) => void;
function sse(res: http.ServerResponse, events: any[]) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) { res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); }
  res.end('data: [DONE]\n\n');
}
function fake(h: Handler): Promise<{ url: string; bodies: any[]; paths: string[]; close: () => void }> {
  const bodies: any[] = []; const paths: string[] = [];
  return new Promise((ok) => {
    const s = http.createServer((req, r) => {
      let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { bodies.push(JSON.parse(b)); paths.push(req.url ?? ''); h(bodies[bodies.length - 1], bodies.length, r); });
    }).listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1`, bodies, paths, close: () => { s.closeAllConnections(); s.close(); } }));
  });
}

const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Plan.' }], encrypted_content: 'ENC1', status: 'completed' };
const fnCall = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"src/a.ts"}', status: 'completed' };
const msg = (text: string, annotations: any[] = []) => ({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations }] });
const usage = (o: number) => ({ input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: o, output_tokens_details: { reasoning_tokens: 7 }, total_tokens: 1000 + o, cost_in_usd_ticks: 25_000_000 });

function turn1(): any[] {
  return [
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'Pl' },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'an.' },
    { type: 'response.output_item.done', output_index: 0, item: reasoningItem },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress' } },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'foo docs' } } },
    { type: 'response.output_item.done', output_index: 2, item: fnCall },
    { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [reasoningItem, { type: 'web_search_call', id: 'ws_1', status: 'completed' }, fnCall], usage: usage(3) } },
  ];
}
function turn2(): any[] {
  const m = msg('a.ts exports foo [[1]](https://example.com/foo).', [{ type: 'url_citation', url: 'https://example.com/foo', start_index: 18, end_index: 47, title: '1' }]);
  return [
    { type: 'response.created', response: { id: 'resp_2', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'a.ts exports foo ' },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: '[[1]](https://example.com/foo).' },
    { type: 'response.output_item.done', output_index: 0, item: m },
    { type: 'response.completed', response: { id: 'resp_2', status: 'completed', output: [m], usage: usage(9), citations: ['https://example.com/foo', 'https://example.com/bar'] } },
  ];
}

test('responses payload uses documented field names', () => {
  const p = buildResponsesPayload({ apiKey: 'k', baseUrl: 'x', model: 'grok-4.7', input: 'hi', previousResponseId: 'r', maxOutputTokens: 10, reasoningEffort: 'low', store: false, include: ['reasoning.encrypted_content'], textFormat: COMMIT_FORMAT, tools: [{ type: 'web_search' }] });
  assert.deepEqual(p, { model: 'grok-4.7', input: 'hi', stream: true, previous_response_id: 'r', tools: [{ type: 'web_search' }], tool_choice: 'auto', max_output_tokens: 10, reasoning: { effort: 'low' }, store: false, include: ['reasoning.encrypted_content'], text: { format: COMMIT_FORMAT } });
});

test('responses loop: function_call → function_call_output via previous_response_id, reasoning, server tool, citations, usage', async () => {
  const srv = await fake((_b, n, r) => sse(r, n === 1 ? turn1() : turn2()));
  const state: ConversationState = { items: [] };
  const text: string[] = []; const thoughts: string[] = []; const srvTools: string[] = []; const executed: any[] = [];
  const r = await runResponsesLoop({
    state, newInput: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'what does a.ts do?' }],
    tools: [{ type: 'function', name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }, { type: 'web_search' }],
    maxSteps: 5, useChain: true,
    request: (input, prev, tools) => streamResponse({ apiKey: 'k', baseUrl: srv.url, model: 'grok-4.7', input, previousResponseId: prev, tools, store: true,
      onContent: (d) => text.push(d), onReasoning: (d) => thoughts.push(d), onServerTool: (it, st) => srvTools.push(`${it.type}:${st}`) }),
    execute: async (name, args) => { executed.push({ name, args }); return 'export const foo = 1;'; },
  });
  srv.close();
  assert.deepEqual(srv.paths, ['/v1/responses', '/v1/responses']);
  assert.equal(srv.bodies[0].stream, true);
  assert.equal(srv.bodies[0].previous_response_id, undefined);
  assert.equal(srv.bodies[0].tools[0].name, 'read_file');
  assert.deepEqual(srv.bodies[0].tools[1], { type: 'web_search' });
  // second call: only the new function_call_output, chained to resp_1
  assert.equal(srv.bodies[1].previous_response_id, 'resp_1');
  assert.deepEqual(srv.bodies[1].input, [{ type: 'function_call_output', call_id: 'call_1', output: 'export const foo = 1;' }]);
  assert.deepEqual(executed, [{ name: 'read_file', args: { path: 'src/a.ts' } }]);
  assert.equal(thoughts.join(''), 'Plan.');
  assert.deepEqual(srvTools, ['web_search_call:running', 'web_search_call:done']);
  assert.equal(text.join(''), 'a.ts exports foo [[1]](https://example.com/foo).');
  assert.equal(r.finalText, text.join(''));
  assert.deepEqual(r.citations, [{ url: 'https://example.com/foo', title: '1' }, { url: 'https://example.com/bar' }]);
  assert.equal(r.outputTokens, 12); assert.equal(r.reasoningTokens, 14); assert.equal(r.cachedTokens, 1600); assert.equal(r.costTicks, 50_000_000);
  assert.equal(state.previousResponseId, 'resp_2');
  // local mirror keeps the encrypted reasoning item verbatim
  assert.equal(state.items.find(i => i.type === 'reasoning')?.encrypted_content, 'ENC1');
});

test('responses loop without chaining (store=false) resends full items incl. encrypted reasoning', async () => {
  const srv = await fake((_b, n, r) => sse(r, n === 1 ? turn1() : turn2()));
  const state: ConversationState = { items: [] };
  await runResponsesLoop({
    state, newInput: [{ role: 'user', content: 'q' }], tools: [{ type: 'function', name: 'read_file', description: 'r', parameters: {} }], maxSteps: 5, useChain: false,
    request: (input, prev, tools) => streamResponse({ apiKey: 'k', baseUrl: srv.url, model: 'm', input, previousResponseId: prev, tools, store: false, include: ['reasoning.encrypted_content'] }),
    execute: async () => 'x',
  });
  srv.close();
  assert.equal(srv.bodies[1].previous_response_id, undefined);
  assert.equal(srv.bodies[1].store, false);
  assert.deepEqual(srv.bodies[1].include, ['reasoning.encrypted_content']);
  const types = srv.bodies[1].input.map((i: any) => i.type ?? i.role);
  assert.deepEqual(types, ['user', 'reasoning', 'web_search_call', 'function_call', 'function_call_output']);
  assert.equal(srv.bodies[1].input[1].encrypted_content, 'ENC1');
  assert.equal(state.previousResponseId, undefined);
});

test('expired previous_response_id falls back to full local history', async () => {
  const srv = await fake((b, _n, r) => {
    if (b.previous_response_id) { r.writeHead(404, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ error: { message: 'previous_response_not_found' } })); return; }
    sse(r, turn2());
  });
  const state: ConversationState = { items: [{ role: 'user', content: 'old' }, msg('old answer')], previousResponseId: 'resp_old' };
  const r = await runResponsesLoop({
    state, newInput: [{ role: 'user', content: 'new' }], tools: [], maxSteps: 3, useChain: true,
    request: (input, prev, tools) => streamResponse({ apiKey: 'k', baseUrl: srv.url, model: 'm', input, previousResponseId: prev, tools }),
    execute: async () => '',
  });
  srv.close();
  assert.equal(srv.bodies.length, 2);
  assert.equal(srv.bodies[1].input.length, 3);
  assert.equal(r.finalText.startsWith('a.ts exports foo'), true);
  assert.equal(state.previousResponseId, 'resp_2');
});

test('step cap: final request without tools after function outputs', async () => {
  let n = 0;
  const state: ConversationState = { items: [] };
  const r = await runResponsesLoop({
    state, newInput: [{ role: 'user', content: 'loop' }], tools: [{ type: 'function', name: 'read_file', description: 'r', parameters: {} }], maxSteps: 2, useChain: true,
    request: async (input, _p, tools) => {
      n++;
      if (n === 3) { assert.equal(tools.length, 0); assert.equal(input[0].type, 'function_call_output'); assert.equal(input[1].role, 'user'); }
      return tools.length
        ? { id: `r${n}`, content: '', output: [{ ...fnCall, call_id: `c${n}` }], functionCalls: [{ call_id: `c${n}`, name: 'read_file', arguments: '{}' }], citations: [], latencyMs: 0 }
        : { id: `r${n}`, content: 'summary', output: [msg('summary')], functionCalls: [], citations: [], latencyMs: 0 };
    },
    execute: async () => 'x',
  });
  assert.equal(n, 3); assert.equal(r.hitStepCap, true); assert.equal(r.finalText, 'summary');
});

test('response.failed and error events surface as errors', async () => {
  const srv = await fake((_b, _n, r) => sse(r, [{ type: 'response.created', response: { id: 'x' } }, { type: 'response.failed', response: { id: 'x', status: 'failed', error: { message: 'boom' } } }]));
  await assert.rejects(streamResponse({ apiKey: 'k', baseUrl: srv.url, model: 'm', input: 'hi' }), /boom/);
  srv.close();
});

test('response.incomplete keeps partial text and usage', () => {
  const st = new ResponsesStreamState();
  st.handle({ type: 'response.output_text.delta', delta: 'part' });
  st.handle({ type: 'response.incomplete', response: { id: 'r', status: 'incomplete', output: [], usage: { output_tokens: 4 } } });
  const r = st.result(Date.now());
  assert.equal(r.content, 'part'); assert.equal(r.status, 'incomplete'); assert.equal(r.usage?.output_tokens, 4);
});

test('compact: POST /responses/compact returns the compaction item', async () => {
  const srv = await fake((_b, _n, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ id: 'cmp_1', object: 'response.compaction', output: [{ type: 'compaction', id: 'cmp_1', encrypted_content: 'BLOB' }], usage: { dropped_message_count: 4 } })); });
  const r = await compactInput({ apiKey: 'k', baseUrl: srv.url, model: 'grok-4.7' }, [{ role: 'user', content: 'a' }]);
  srv.close();
  assert.equal(srv.paths[0], '/v1/responses/compact');
  assert.deepEqual(srv.bodies[0], { model: 'grok-4.7', input: [{ role: 'user', content: 'a' }] });
  assert.deepEqual(r, { output: [{ type: 'compaction', id: 'cmp_1', encrypted_content: 'BLOB' }], dropped: 4 });
});

test('citations: only http(s), de-duplicated', () => {
  assert.deepEqual(extractCitations([msg('x', [{ type: 'url_citation', url: 'javascript:alert(1)' }, { type: 'url_citation', url: 'https://a.io', title: '1' }])], ['https://a.io', 'http://b.io']),
    [{ url: 'https://a.io', title: '1' }, { url: 'http://b.io' }]);
});

test('commit message structured output rendering', () => {
  assert.equal(renderCommitMessage('{"subject":"feat: add x","body":["adds x","- tests"]}'), 'feat: add x\n\n- adds x\n- tests');
  assert.equal(renderCommitMessage('{"subject":"fix: y","body":[]}'), 'fix: y');
  assert.equal(renderCommitMessage('plain message'), 'plain message');
});

test('0.14.2: resendFull ignores a stale chain id, sends the full local list once, then chains again', async () => {
  const srv = await fake((_b, n, r) => sse(r, n === 1 ? turn1() : turn2()));
  const state: ConversationState = { items: [{ role: 'user', content: 'first message' }, { role: 'assistant', content: '[interrupted]' }], previousResponseId: 'resp_old', resendFull: true };
  await runResponsesLoop({
    state, newInput: [{ role: 'user', content: 'try again' }], tools: [{ type: 'function', name: 'read_file', description: 'r', parameters: {} }], maxSteps: 5, useChain: true,
    request: (input, prev, tools) => streamResponse({ apiKey: 'k', baseUrl: srv.url, model: 'm', input, previousResponseId: prev, tools, store: true }),
    execute: async () => 'x',
  });
  srv.close();
  assert.equal(srv.bodies[0].previous_response_id, undefined);
  assert.match(JSON.stringify(srv.bodies[0].input), /first message[\s\S]*try again/);
  assert.equal(srv.bodies[1].previous_response_id, 'resp_1');
  assert.equal(state.resendFull, false);
});
