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
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as AddressInfo).port;
  // Copy the fixture so the index/rules tests can't dirty the repo.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vsgrok-ws-'));
  fs.cpSync(path.join(root, 'test-int', 'fixture'), ws, { recursive: true });
  try {
    require('child_process').execFileSync('git', ['init', '-q'], { cwd: ws });
  } catch { /* git optional: index falls back to .gitignore parsing */ }
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite', 'index'),
      launchArgs: [ws, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
      extensionTestsEnv: { VSGROK_TEST: '1', VSGROK_TEST_RELEASES_URL: `http://127.0.0.1:${port}/latest` },
    });
  } catch (e) {
    console.error('Integration tests failed', e);
    process.exitCode = 1;
  } finally { srv.close(); fs.rmSync(ws, { recursive: true, force: true }); }
}
void main();
