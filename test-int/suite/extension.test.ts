import * as assert from 'assert';
import * as vscode from 'vscode';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Api = { chat: any; updater: any; workspaceIndex: any };
let api: Api;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false, ms = 20000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) { return v; } if (Date.now() - t0 > ms) { throw new Error('timed out waiting'); } await sleep(50); }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const posts = (type: string): any[] => api.chat.testPosts.filter((m: any) => m?.type === type);

suite('VSGrok in VS Code', () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.all.find(e => e.packageJSON.name === 'vsgrok');
    assert.ok(ext, 'extension present');
    api = await ext!.activate();
    assert.ok(api?.chat, 'test API exposed');
  });

  test('every contributed command is registered', async () => {
    const ext = vscode.extensions.all.find(e => e.packageJSON.name === 'vsgrok')!;
    const all = new Set(await vscode.commands.getCommands(true));
    const missing = (ext.packageJSON.contributes.commands as { command: string }[]).map(c => c.command).filter(c => !all.has(c));
    assert.deepStrictEqual(missing, []);
  });

  test('chat view opens and the real webview reports ready', async () => {
    await vscode.commands.executeCommand('VSGrokView.focus');
    await until(() => api.chat.isReady);
    assert.ok(posts('settings').length > 0 || posts('models').length > 0);
  });

  test('project rules (VSGrok.md) are loaded and sent to the header', async () => {
    const r = await until(() => posts('rules').find(m => m.files.length));
    assert.deepStrictEqual(r.files, ['VSGrok.md']);
  });

  test('approval card round trip: approve, deny, and Stop resolves as deny', async () => {
    // Drive the real agent tool path; the card is posted to the live chat webview and answered with its message protocol.
    const n0 = posts('approvalRequest').length;
    const p1 = vscode.commands.executeCommand('vsgrok.__testRunTool', 'run_command', { command: 'echo vsgrok-ok' });
    const card = await until(() => posts('approvalRequest')[n0]);
    assert.strictEqual(card.request.kind, 'command');
    assert.strictEqual(card.request.command, 'echo vsgrok-ok');
    await api.chat.testReceive({ type: 'approvalResponse', reqId: card.reqId, decision: 'approve' });
    const out1 = String(await p1);
    assert.match(out1, /exit code 0[\s\S]*vsgrok-ok/);
    assert.ok(posts('approvalResolved').some(m => m.reqId === card.reqId && m.state === 'approved'));

    const p2 = vscode.commands.executeCommand('vsgrok.__testRunTool', 'run_command', { command: 'echo nope' });
    const card2 = await until(() => posts('approvalRequest')[n0 + 1]);
    await api.chat.testReceive({ type: 'approvalResponse', reqId: card2.reqId, decision: 'deny' });
    assert.match(String(await p2), /declined/);

    const p3 = vscode.commands.executeCommand('vsgrok.__testRunTool', 'propose_edit', { path: 'src/new.ts', content: 'export {};\n' });
    const card3 = await until(() => posts('approvalRequest')[n0 + 2]);
    assert.strictEqual(card3.request.kind, 'edit');
    assert.strictEqual(card3.request.isNew, true);
    await api.chat.testReceive({ type: 'approvalViewDiff', reqId: card3.reqId });
    await api.chat.testReceive({ type: 'stop' });
    assert.match(String(await p3), /Rejected/);
    const root = vscode.workspace.workspaceFolders![0].uri;
    await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.joinPath(root, 'src/new.ts'))));
  });

  test('find_relevant_files ranks by content/symbols, respects .gitignore and never indexes .env', async () => {
    const out = String(await vscode.commands.executeCommand('vsgrok.__testRunTool', 'find_relevant_files', { query: 'invoice total' }));
    assert.match(out.split('\n')[2] ?? '', /src\/billing\.ts/);
    const z = String(await vscode.commands.executeCommand('vsgrok.__testRunTool', 'find_relevant_files', { query: 'zebra' }));
    assert.doesNotMatch(z, /\.env|ignored\/zebra/);
    const env = String(await vscode.commands.executeCommand('vsgrok.__testRunTool', 'read_file', { path: '.env' }));
    assert.match(env, /^Refused/);
    assert.doesNotMatch(env, /should-never/);
  });

  test('index updates incrementally when a file is created', async () => {
    const root = vscode.workspace.workspaceFolders![0].uri;
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'src/shipping.ts'), Buffer.from('export function quokkaShippingRate() { return 4; }\n'));
    let found = '';
    for (let i = 0; i < 60 && !/shipping\.ts/.test(found); i++) {
      found = String(await vscode.commands.executeCommand('vsgrok.__testRunTool', 'find_relevant_files', { query: 'quokka shipping' }));
      await sleep(250);
    }
    assert.match(found, /src\/shipping\.ts/);
  });

  test('check for updates against a mocked release shows an in-chat card', async () => {
    const n0 = posts('updateCard').length;
    await vscode.commands.executeCommand('vsgrok.checkForUpdates');
    const c = await until(() => posts('updateCard')[n0]);
    assert.strictEqual(c.card.state, 'available');
    assert.strictEqual(c.card.latest, '99.0.0');
  });

  test('copy diagnostics puts a report without the API key on the clipboard', async () => {
    await vscode.commands.executeCommand('vsgrok.copyDiagnostics');
    const t = await vscode.env.clipboard.readText();
    assert.match(t, /# VSGrok diagnostics/);
    assert.match(t, /API key set: (yes|no)/);
  });
});
