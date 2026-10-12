import * as path from 'path';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import { AddressInfo } from 'net';
import { runTests } from '@vscode/test-electron';

async function main() {
  const root = path.resolve(__dirname, '..', '..'); // out-int/test-int → repo
  // Mock GitHub "latest release" endpoint for the self-update test.
  const srv = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    if (req.url?.startsWith('/latest')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tag_name: 'v99.0.0', html_url: base + '/rel', body: 'mock', draft: false, prerelease: false,
        assets: [{ name: 'vsgrok-99.0.0.vsix', browser_download_url: base + '/dl/vsgrok-99.0.0.vsix' }] }));
    } else if (req.url === '/ghmcp/seen') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(ghSeen));
    } else if (req.url === '/ghmcp/') {
      void mockGh(req, res);
    } else if (req.url === '/mcp') {
      void mockMcp(req, res);
    } else if (req.url?.startsWith('/xai/')) {
      mockXai(req, res);
    } else { res.writeHead(404); res.end(); }
  });
  // Streamable-HTTP MCP server (stateless), same tools as test-int/mcp-echo-server.cjs.
  async function mockMcp(req: http.IncomingMessage, res: http.ServerResponse) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { build } = require(path.join(root, 'test-int', 'mcp-echo-server.cjs'));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    if (req.headers['x-test-auth'] !== 'ok') { res.writeHead(401); res.end(); return; }
    let body = ''; for await (const d of req) { body += d; }
    const server = build('http');
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  }
  const ghSeen = { auth: [] as string[], toolsets: [] as string[], calls: [] as string[] };
  async function mockGh(req: http.IncomingMessage, res: http.ServerResponse) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { build } = require(path.join(root, 'test-int', 'gh-mcp-mock.cjs'));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    ghSeen.auth.push(String(req.headers.authorization)); ghSeen.toolsets.push(String(req.headers['x-mcp-toolsets']));
    if (req.headers.authorization !== 'Bearer ghp_TESTTOKEN0123456789abcdef') { res.writeHead(401); res.end(); return; }
    let body = ''; for await (const d of req) { body += d; }
    const server = build(ghSeen);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  }
  // Mock xAI API for image input + cost meter tests. Records request bodies at /xai/requests.
  const xaiRequests: unknown[] = [];
  const chatRequests: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const responsesReplies: { output?: any[]; text?: string; usage?: any; status?: number; error?: string }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chatReplies: { text: string; toolCalls?: any[] }[] = [];
  function mockXai(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = req.url!.replace(/^\/xai\/v1/, '');
    if (req.url === '/xai/requests') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(xaiRequests)); return; }
    // Chat Completions mock: replies are queued by tests via POST /xai/chatReply {text}; requests recorded at /xai/chatRequests.
    if (req.url === '/xai/chatRequests') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(chatRequests)); return; }
    if (req.url === '/xai/chatReply' && req.method === 'POST') {
      let b = ''; req.on('data', d => (b += d)); req.on('end', () => { try { chatReplies.push(JSON.parse(b)); } catch { /* ignore */ } res.writeHead(204); res.end(); });
      return;
    }
    if (req.url === '/xai/responsesReply' && req.method === 'POST') {
      let b = ''; req.on('data', d => (b += d)); req.on('end', () => { try { responsesReplies.push(JSON.parse(b)); } catch { /* ignore */ } res.writeHead(204); res.end(); });
      return;
    }
    if (url === '/chat/completions' && req.method === 'POST') {
      let b = ''; req.on('data', d => (b += d)); req.on('end', () => {
        try { chatRequests.push(JSON.parse(b)); } catch { chatRequests.push(b); }
        const r = chatReplies.shift() ?? { text: 'mock reply' };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const parts = r.text.match(/[\s\S]{1,12}/g) ?? [''];
        for (const p of parts) { res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: p } }] })}\n\n`); }
        if (r.toolCalls) { res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: r.toolCalls } }] })}\n\n`); }
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: r.toolCalls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\n`);
        res.write('data: [DONE]\n\n'); res.end();
      });
      return;
    }
    if (url === '/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-vision', created: 2 }, { id: 'mock-text', created: 1 }] })); return; }
    if (url === '/language-models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ models: [{ id: 'mock-vision', input_modalities: ['text', 'image'] }, { id: 'mock-text', input_modalities: ['text'] }] })); return; }
    if (url === '/responses' && req.method === 'POST') {
      let body = ''; req.on('data', d => (body += d)); req.on('end', () => {
        let parsed: { store?: boolean; input?: { type?: string; encrypted_content?: string }[] } = {};
        try { parsed = JSON.parse(body); xaiRequests.push(parsed); } catch { xaiRequests.push(body); }
        const n = xaiRequests.length;
        // Like xAI (JGrok M1): stateless requests can't carry reasoning items that lack encrypted_content.
        if (parsed.store === false && Array.isArray(parsed.input) && parsed.input.some(i => i?.type === 'reasoning' && !i.encrypted_content)) {
          res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'reasoning item without encrypted_content cannot be resolved' } })); return;
        }
        const q = responsesReplies.shift();
        if (q?.status) { res.writeHead(q.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: q.error ?? 'mock failure' } })); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const txt = q?.text ?? (q?.output ? '' : 'A red square.');
        const msg = { type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: txt, annotations: [] }] };
        if (q?.output) {
          const out = [...q.output, ...(txt ? [msg] : [])];
          const u = q.usage ?? { input_tokens: 1000, output_tokens: 50, cost_in_usd_ticks: 10_000_000 };
          const e = { type: 'response.completed', response: { id: `resp_${n}`, status: 'completed', output: out, usage: u } };
          res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); res.end();
          return;
        }
        const ev = [
          { type: 'response.output_text.delta', item_id: msg.id, output_index: 0, content_index: 0, delta: txt },
          { type: 'response.completed', response: { id: `resp_${n}`, status: 'completed', output: parsed.store === false ? [msg] : [{ type: 'reasoning', id: `rs_${n}`, summary: [] }, msg], usage: { input_tokens: 1000 * n, output_tokens: 50, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 10 }, cost_in_usd_ticks: 123_000_000 } } },
        ];
        for (const e of ev) { res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); }
        res.end();
      });
      return;
    }
    res.writeHead(404); res.end();
  }
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as AddressInfo).port;
  // Copy the fixture so the index/rules tests can't dirty the repo.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vsgrok-ws-'));
  fs.cpSync(path.join(root, 'test-int', 'fixture'), ws, { recursive: true });
  // Headless Linux has no OS trash (gio); WorkspaceEdit deletes would fail. Desktop users keep the default.
  fs.mkdirSync(path.join(ws, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.vscode', 'settings.json'), JSON.stringify({ 'files.enableTrash': false }));
  // Symlinks: one escaping the workspace, one pointing at the fixture's .env.
  const outside = path.join(os.tmpdir(), `vsgrok-outside-${process.pid}.txt`);
  fs.writeFileSync(outside, 'outside-secret-kangaroo');
  try { fs.symlinkSync(outside, path.join(ws, 'src', 'link-out.ts')); fs.symlinkSync(path.join(ws, '.env'), path.join(ws, 'src', 'innocent.ts')); } catch { /* no symlink support */ }
  // A directory symlink escaping the workspace (plan create targets must not follow it).
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsgrok-outdir-'));
  try { fs.symlinkSync(outDir, path.join(ws, 'src', 'linkdir'), 'dir'); } catch { /* no symlink support */ }
  fs.writeFileSync(path.join(ws, 'logo.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0xff, 0xfe]));
  process.env.VSGROK_TEST_OUTDIR = outDir;
  try {
    require('child_process').execFileSync('git', ['init', '-q'], { cwd: ws });
  } catch { /* git optional: index falls back to .gitignore parsing */ }
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite', 'index'),
      launchArgs: [ws, ...(process.env.VSGROK_LIVE_UPDATE === '1' ? [] : ['--disable-extensions']), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
      extensionTestsEnv: { VSGROK_TEST: '1', VSGROK_TEST_OUTDIR: outDir, VSGROK_TEST_RELEASES_URL: `http://127.0.0.1:${port}/latest`, VSGROK_TEST_XAI: `http://127.0.0.1:${port}/xai`, VSGROK_LIVE_UPDATE: process.env.VSGROK_LIVE_UPDATE ?? '' },
    });
  } catch (e) {
    console.error('Integration tests failed', e);
    process.exitCode = 1;
  } finally { srv.close(); fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(outside, { force: true }); }
}
void main();
