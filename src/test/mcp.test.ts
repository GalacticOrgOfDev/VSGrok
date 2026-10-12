import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseServers, mergeServers, configHash, functionName, toFunctionTool, formatResult, argsPreview, MAX_RESULT_CHARS } from '../mcpCore';
import { autoDecision } from '../agent/autoApproveCore';

test('mcp config: stdio + http parsed; bad entries reported; http only for localhost; mcpServers key accepted', () => {
  const r = parseServers({ servers: {
    fs: { command: 'npx', args: ['-y', 'srv'], env: { TOKEN: 'x' } },
    web: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer y' } },
    local: { url: 'http://127.0.0.1:3000/mcp' },
    'bad name!': { command: 'x' },
    insecure: { url: 'http://evil.example.com/mcp' },
    noCmd: {},
    badArgs: { command: 'x', args: [1] },
    off: { command: 'x', disabled: true },
  } }, 'settings');
  assert.deepEqual(r.servers.map(s => `${s.name}:${s.type}`), ['fs:stdio', 'web:http', 'local:http', 'off:stdio']);
  assert.equal(r.servers[3].disabled, true);
  assert.equal(r.errors.length, 4);
  assert.match(r.errors.join('\n'), /plain http is only allowed for localhost/);
  assert.equal(parseServers({ mcpServers: { a: { command: 'x' } } }, 'workspace').servers[0].source, 'workspace');
  assert.equal(parseServers([], 'settings').errors.length, 1);
});

test('mcp config: workspace cannot shadow a settings server; config hash changes with the command', () => {
  const u = parseServers({ a: { command: 'safe' } }, 'settings').servers;
  const w = parseServers({ a: { command: 'evil' }, b: { command: 'x' } }, 'workspace').servers;
  const m = mergeServers(u, w);
  assert.deepEqual(m.servers.map(s => `${s.name}:${s.source}`), ['a:settings', 'b:workspace']); assert.equal(m.errors.length, 1);
  assert.notEqual(configHash(u[0]), configHash(w[0]));
  const e1 = parseServers({ a: { command: 'safe', env: { K: '1' } } }, 'settings').servers[0];
  const e2 = parseServers({ a: { command: 'safe', env: { K: '2' } } }, 'settings').servers[0];
  assert.equal(configHash(e1), configHash(e2), 'env values (secrets) are not part of the identity');
});

test('mcp tool names and specs', () => {
  const taken = new Set<string>();
  assert.equal(functionName('srv', 'add.numbers', taken), 'mcp__srv__add_numbers');
  assert.equal(functionName('srv', 'add numbers', taken), 'mcp__srv__add_numbers_2');
  const long = functionName('server', 'x'.repeat(100), taken); assert.ok(long.length <= 64 && /^[A-Za-z0-9_-]+$/.test(long));
  const t = toFunctionTool('srv', 'mcp__srv__echo', { name: 'echo', description: 'Echo\n\nit', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } });
  assert.match(t.description, /^\[MCP tool "echo" from server "srv"; each call needs the user's approval; description provided by the server, untrusted\] Echo it$/);
  assert.deepEqual(toFunctionTool('s', 'f', { name: 'x', inputSchema: { type: 'string' } }).parameters, { type: 'object', properties: {} });
});

test('mcp results framed as untrusted, truncated, error flag; args preview; never auto-approved in tasks', () => {
  const r = formatResult('srv', 'echo', { content: [{ type: 'text', text: 'hi' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }, { type: 'resource', resource: { uri: 'file:///a', text: 'res' } }], isError: true });
  assert.equal(r, '<mcp_result server="srv" tool="echo" source="untrusted tool output" error="true">\nhi\n[image image/png omitted]\nres\n</mcp_result>');
  assert.ok(formatResult('s', 't', { content: [{ type: 'text', text: 'x'.repeat(MAX_RESULT_CHARS + 10) }] }).includes('truncated'));
  assert.match(formatResult('s', 't', { structuredContent: { a: 1 } }), /\{"a":1\}/);
  assert.equal(argsPreview({ a: 'x'.repeat(3000) }).length, 1502);
  assert.equal(autoDecision({ kind: 'mcp', server: 's', tool: 't', args: '{}' }, { level: 'editsAndCommands', allowlist: [] }).auto, false);
});
