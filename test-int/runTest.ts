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
    } else if (req.url?.startsWith('/xai/')) {
      mockXai(req, res);
    } else { res.writeHead(404); res.end(); }
  });
  // Mock xAI API for image input + cost meter tests. Records request bodies at /xai/requests.
  const xaiRequests: unknown[] = [];
  function mockXai(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = req.url!.replace(/^\/xai\/v1/, '');
    if (req.url === '/xai/requests') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(xaiRequests)); return; }
    if (url === '/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-vision', created: 2 }, { id: 'mock-text', created: 1 }] })); return; }
    if (url === '/language-models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ models: [{ id: 'mock-vision', input_modalities: ['text', 'image'] }, { id: 'mock-text', input_modalities: ['text'] }] })); return; }
    if (url === '/responses' && req.method === 'POST') {
      let body = ''; req.on('data', d => (body += d)); req.on('end', () => {
        try { xaiRequests.push(JSON.parse(body)); } catch { xaiRequests.push(body); }
        const n = xaiRequests.length;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const msg = { type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'A red square.', annotations: [] }] };
        const ev = [
          { type: 'response.output_text.delta', item_id: msg.id, output_index: 0, content_index: 0, delta: 'A red square.' },
          { type: 'response.completed', response: { id: `resp_${n}`, status: 'completed', output: [msg], usage: { input_tokens: 1000 * n, output_tokens: 50, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 10 }, cost_in_usd_ticks: 123_000_000 } } },
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
