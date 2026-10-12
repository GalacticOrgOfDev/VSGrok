import * as path from 'path';
import * as assert from 'assert';
import * as vscode from 'vscode';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Api = { chat: any; updater: any; workspaceIndex: any; [k: string]: any };
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

  test('header markup: <header>, Rules chip right before the gear, cards.js loaded with nonce', async () => {
    const html: string = api.chat['view'].webview.html;
    assert.match(html, /<header id="header">[\s\S]*<\/header>/);
    assert.match(html, /<button id="rules-chip"[^>]*><\/button>\s*<button id="task-pill"[^>]*><\/button>\s*<button id="mcp-btn"[^>]*><\/button>\s*<button id="history-btn"[^>]*aria-controls="history-panel"[^>]*>🕘<\/button>\s*<button id="settings-btn"[^>]*aria-controls="settings-panel"/);
    assert.match(html, /<script nonce="[^"]+" src="[^"]*cards\.js"><\/script>\s*<script nonce="[^"]+" src="[^"]*main\.js">/);
  });

  test('Rules chip click opens the rules file; openSettings opens the Settings editor', async () => {
    await api.chat.testReceive({ type: 'openRules' });
    await until(() => vscode.window.activeTextEditor?.document.uri.path.endsWith('/VSGrok.md'));
    await api.chat.testReceive({ type: 'openSettings', key: 'vsgrok.requestTimeoutSeconds' });
    await until(() => vscode.window.tabGroups.activeTabGroup.activeTab?.label === 'Settings');
    await api.chat.testReceive({ type: 'openSettings', key: 'evil; rm -rf' }); // invalid key falls back to the vsgrok section
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
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

  test('attaching or dropping a .env (or a non-workspace / non-file URI) is refused', async () => {
    const root = vscode.workspace.workspaceFolders![0].uri;
    const n0 = posts('contextRefused').length;
    await vscode.commands.executeCommand('vsgrok.addFileToChat', vscode.Uri.joinPath(root, '.env'));
    await api.chat.testReceive({ type: 'dropFiles', uris: [vscode.Uri.joinPath(root, '.env').toString(), 'https://evil.example/x', 'file:///etc/hostname'] });
    const refused = posts('contextRefused').slice(n0);
    assert.strictEqual(refused.length, 4, JSON.stringify(refused));
    assert.ok(refused.every(r => r.reason));
    const chips = posts('contextUpdate').at(-1)?.chips ?? [];
    assert.ok(!chips.some((c: { path?: string }) => /\.env|hostname/.test(String(c.path))));
  });

  test('symlinks out of the workspace or onto a secret are never read or indexed', async function () {
    const root = vscode.workspace.workspaceFolders![0].uri;
    try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, 'src/link-out.ts')); } catch { this.skip(); }
    const a = String(await vscode.commands.executeCommand('vsgrok.__testRunTool', 'read_file', { path: 'src/link-out.ts' }));
    const b = String(await vscode.commands.executeCommand('vsgrok.__testRunTool', 'read_file', { path: 'src/innocent.ts' }));
    assert.match(a, /^Refused/); assert.doesNotMatch(a, /kangaroo/);
    assert.match(b, /^Refused/); assert.doesNotMatch(b, /should-never/);
    await vscode.commands.executeCommand('vsgrok.reindex');
    const f = String(await vscode.commands.executeCommand('vsgrok.__testRunTool', 'find_relevant_files', { query: 'kangaroo should never read' }));
    assert.match(f, /^No indexed files match/);
    const g = String(await vscode.commands.executeCommand('vsgrok.__testRunTool', 'find_relevant_files', { query: 'innocent link out' }));
    assert.doesNotMatch(g.split('\n').slice(1).join('\n'), /link-out|innocent\.ts/);
    const s2 = String(await vscode.commands.executeCommand('vsgrok.__testRunTool', 'search_workspace', { query: 'kangaroo' }));
    assert.doesNotMatch(s2, /kangaroo/);
  });

  test('restricted-mode support is declared (git and project rules are trust-gated)', () => {
    const ext = vscode.extensions.all.find(e => e.packageJSON.name === 'vsgrok')!;
    assert.strictEqual(ext.packageJSON.capabilities?.untrustedWorkspaces?.supported, 'limited');
    assert.strictEqual(vscode.workspace.isTrusted, true); // this run is trusted, so rules were injected above
  });

  test('check for updates against a mocked release shows an in-chat card', async () => {
    const n0 = posts('updateCard').length;
    await vscode.commands.executeCommand('vsgrok.checkForUpdates');
    const c = await until(() => posts('updateCard')[n0]);
    assert.strictEqual(c.card.state, 'available');
    assert.strictEqual(c.card.latest, '99.0.0');
  });

  test('LIVE (opt-in VSGROK_LIVE_UPDATE=1): download the real GitHub release vsix through the redirect and install it', async function () {
    if (process.env.VSGROK_LIVE_UPDATE !== '1') { this.skip(); }
    this.timeout(180000);
    const r = await fetch('https://api.github.com/repos/GalacticOrgOfDev/VSGrok/releases/latest', { headers: { 'User-Agent': 'VSGrok-test', Accept: 'application/vnd.github+json' } });
    assert.strictEqual(r.status, 200);
    const j = await r.json() as { tag_name: string; html_url: string; assets: { name: string; browser_download_url: string }[] };
    const a = j.assets.find(x => x.name.endsWith('.vsix'))!;
    const n0 = posts('updateCard').length;
    await api.updater.testInstall({ version: j.tag_name.slice(1), tag: j.tag_name, url: j.html_url, notes: '', assetUrl: a.browser_download_url, assetName: a.name });
    const last = posts('updateCard').slice(n0).at(-1);
    assert.strictEqual(last.card.state, 'installed', JSON.stringify(last.card));
  });

  test('update errors always carry a real message and step (mock: 404 asset)', async () => {
    const base = process.env.VSGROK_TEST_RELEASES_URL!.replace(/\/latest$/, '');
    const n0 = posts('updateCard').length;
    await api.updater.testInstall({ version: '99.0.0', tag: 'v99.0.0', url: base + '/rel', notes: '', assetUrl: base + '/dl/missing.vsix', assetName: 'missing.vsix' });
    const last = posts('updateCard').slice(n0).at(-1);
    assert.strictEqual(last.card.state, 'error');
    assert.match(last.card.msg, /^Update failed while downloading \(HTTP 404\): download returned HTTP 404$/);
    assert.doesNotMatch(last.card.msg, /undefined/);
  });

  test('copy diagnostics puts a report without the API key on the clipboard', async () => {
    await vscode.commands.executeCommand('vsgrok.copyDiagnostics');
    const t = await vscode.env.clipboard.readText();
    assert.match(t, /# VSGrok diagnostics/);
    assert.match(t, /API key set: (yes|no)/);
  });

  // ---------- 0.7.0: plans, problems, tests, editor actions ----------
  const root = () => vscode.workspace.workspaceFolders![0].uri;
  const rd = async (p: string) => Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root(), p))).toString('utf8');
  const exists = async (p: string) => { try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(root(), p)); return true; } catch { return false; } };
  const idle = () => until(() => !api.chat['busy'], 30000);

  test('plan card: approve a subset applies atomically, secret refused, one Undo reverts the plan', async () => {
    const before = await rd('src/billing.ts');
    const n0 = posts('approvalRequest').length; const a0 = posts('planApplied').length;
    const p = vscode.commands.executeCommand('vsgrok.__testRunTool', 'propose_plan', { summary: 'test plan', changes: [
      { op: 'create', path: 'src/p1.ts', content: 'export const p1 = 1;\n' },
      { op: 'create', path: 'src/p2.ts', content: 'export const p2 = 2;\n' },
      { op: 'modify', path: 'src/billing.ts', content: before + '// planned\n' },
      { op: 'create', path: '.env.local', content: 'TOKEN=x' },
    ] });
    const card = await until(() => posts('approvalRequest')[n0]);
    assert.strictEqual(card.request.kind, 'plan');
    const files = card.request.files as { path: string; refused?: string }[];
    assert.match(String(files.find(f => f.path === '.env.local')?.refused), /secret/, 'secret file shown as a refused row');
    assert.strictEqual(files.findIndex(f => f.refused), files.length - 1, 'refused rows come after usable rows');
    const idx = (path: string) => files.findIndex(f => f.path === path);
    await api.chat.testReceive({ type: 'approvalViewDiff', reqId: card.reqId, index: idx('src/billing.ts') });
    await api.chat.testReceive({ type: 'approvalResponse', reqId: card.reqId, decision: 'approve', selected: [idx('src/p1.ts'), idx('src/billing.ts')] });
    const out = String(await p);
    assert.ok(await exists('src/p1.ts')); assert.ok(!(await exists('src/p2.ts'))); assert.ok(!(await exists('.env.local')));
    assert.match(await rd('src/billing.ts'), /\/\/ planned/);
    assert.match(out, /\.env\.local/, 'result reports the refused secret');
    const applied = await until(() => posts('planApplied')[a0]);
    await api.chat.testReceive({ type: 'undoPlan', planId: applied.planId });
    const undone = await until(() => posts('planUndone').find(m => m.planId === applied.planId));
    assert.ok(undone.ok, JSON.stringify(undone));
    assert.ok(!(await exists('src/p1.ts')));
    assert.strictEqual(await rd('src/billing.ts'), before);
  });

  test('plan undo refuses when a file changed after the plan was applied', async () => {
    const n0 = posts('approvalRequest').length; const a0 = posts('planApplied').length;
    const p = vscode.commands.executeCommand('vsgrok.__testRunTool', 'propose_plan', { changes: [{ op: 'create', path: 'src/p3.ts', content: 'a\n' }] });
    const card = await until(() => posts('approvalRequest')[n0]);
    await api.chat.testReceive({ type: 'approvalResponse', reqId: card.reqId, decision: 'approve', selected: [0] });
    await p;
    const applied = await until(() => posts('planApplied')[a0]);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root(), 'src/p3.ts'), Buffer.from('user edit\n'));
    await api.chat.testReceive({ type: 'undoPlan', planId: applied.planId });
    const undone = await until(() => posts('planUndone').find(m => m.planId === applied.planId));
    assert.strictEqual(undone.ok, false);
    assert.ok(!undone.retryable, 'a changed-file refusal is not retryable');
    assert.strictEqual(await rd('src/p3.ts'), 'user edit\n');
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(root(), 'src/p3.ts'));
  });

  test('get_problems reads real diagnostics; Problems chip reflects the active file and toggles', async () => {
    const uri = vscode.Uri.joinPath(root(), 'src/billing.ts');
    const dc = vscode.languages.createDiagnosticCollection('vsgrok-test');
    dc.set(uri, [new vscode.Diagnostic(new vscode.Range(1, 2, 1, 8), 'quokka type mismatch', vscode.DiagnosticSeverity.Error)]);
    try {
      const out = String(await vscode.commands.executeCommand('vsgrok.__testRunTool', 'get_problems', { path: 'src/billing.ts' }));
      assert.match(out, /src\/billing\.ts:2/); assert.match(out, /quokka type mismatch/);
      await vscode.window.showTextDocument(uri);
      const st = await until(() => { const l = posts('problemsState').at(-1); return l && l.count > 0 && l; });
      const was = st.enabled;
      await api.chat.testReceive({ type: 'toggleProblems' });
      await until(() => posts('problemsState').at(-1)?.enabled === !was);
      await api.chat.testReceive({ type: 'toggleProblems' });
    } finally { dc.dispose(); }
  });

  test('run_tests detects npm test from package.json, goes through the approval card and parses failures', async () => {
    const n0 = posts('approvalRequest').length;
    const p1 = vscode.commands.executeCommand('vsgrok.__testRunTool', 'run_tests', {});
    const c1 = await until(() => posts('approvalRequest')[n0]);
    assert.strictEqual(c1.request.kind, 'command'); assert.strictEqual(c1.request.command, 'npm test');
    await api.chat.testReceive({ type: 'approvalResponse', reqId: c1.reqId, decision: 'deny' });
    assert.match(String(await p1), /declined/);
    const p2 = vscode.commands.executeCommand('vsgrok.__testRunTool', 'run_tests', {});
    const c2 = await until(() => posts('approvalRequest')[n0 + 1]);
    await api.chat.testReceive({ type: 'approvalResponse', reqId: c2.reqId, decision: 'approve' });
    const out = String(await p2);
    assert.match(out, /exit code 1/); assert.match(out, /src\/billing\.ts:3/); assert.match(out, /adds numbers/);
  });

  test('editor actions send the selection / enclosing symbol to the chat with context attached', async () => {
    const uri = vscode.Uri.joinPath(root(), 'src/billing.ts');
    const ed = await vscode.window.showTextDocument(uri);
    ed.selection = new vscode.Selection(0, 0, 2, 1);
    await idle();
    let u0 = posts('userMessage').length;
    await vscode.commands.executeCommand('vsgrok.explainThis');
    let msg = await until(() => posts('userMessage')[u0]);
    assert.match(msg.text, /^Explain the selected code \(lines 1-3\) in src\/billing\.ts/);
    assert.ok(msg.chips.some((c: { kind?: string; path?: string; label?: string }) => /billing\.ts/.test(JSON.stringify(c))));
    await idle();

    const dc = vscode.languages.createDiagnosticCollection('vsgrok-test2');
    dc.set(uri, [new vscode.Diagnostic(new vscode.Range(1, 2, 1, 8), 'wombat overflow', vscode.DiagnosticSeverity.Error)]);
    try {
      ed.selection = new vscode.Selection(1, 3, 1, 3);
      u0 = posts('userMessage').length;
      await vscode.commands.executeCommand('vsgrok.fixProblemsHere');
      msg = await until(() => posts('userMessage')[u0]);
      assert.match(msg.text, /^Fix the problems in/); assert.match(msg.text, /wombat overflow/);
      await idle();
    } finally { dc.dispose(); }

    u0 = posts('userMessage').length;
    await vscode.commands.executeCommand('vsgrok.writeTestsForThis');
    msg = await until(() => posts('userMessage')[u0]);
    assert.match(msg.text, /^Write tests for/); assert.match(msg.text, /propose_plan/); assert.match(msg.text, /npm test/);
    await idle();

    u0 = posts('userMessage').length;
    await vscode.commands.executeCommand('vsgrok.refactor', 'Extract smaller functions');
    msg = await until(() => posts('userMessage')[u0]);
    assert.match(msg.text, /^Refactor .*: Extract smaller functions/);
    await idle();
    const ext = vscode.extensions.all.find(e => e.packageJSON.name === 'vsgrok')!;
    const menus = ext.packageJSON.contributes.menus;
    assert.deepStrictEqual(menus['editor/context'].map((m: { submenu?: string }) => m.submenu), ['vsgrok.editorSubmenu']);
    assert.strictEqual(ext.packageJSON.contributes.submenus[0].label, 'Grok');
    const menu = (menus['vsgrok.editorSubmenu'] as { command: string }[]).map(m => m.command);
    assert.deepStrictEqual(menu, ['vsgrok.inlineEdit', 'vsgrok.explainThis', 'vsgrok.writeTestsForThis', 'vsgrok.fixProblemsHere', 'vsgrok.refactor', 'vsgrok.addComments']);

    ed.selection = new vscode.Selection(3, 0, 3, 0); // no selection: enclosing class symbol or fallback
    u0 = posts('userMessage').length;
    await vscode.commands.executeCommand('vsgrok.addComments');
    msg = await until(() => posts('userMessage')[u0]);
    assert.match(msg.text, /^Add clear, concise comments .* in src\/billing\.ts/);
    await idle();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  // ---------- 0.7.1: JGrok review ----------
  async function runPlan(changes: unknown[], select?: (files: { path: string; refused?: string }[]) => number[] | 'deny', between?: () => Promise<void>) {
    const n0 = posts('approvalRequest').length;
    const p = vscode.commands.executeCommand('vsgrok.__testRunTool', 'propose_plan', { changes });
    const card = await until(() => posts('approvalRequest')[n0]);
    const files = card.request.files as { path: string; refused?: string }[];
    if (between) { await between(); }
    const sel = select ? select(files) : files.map((f, i) => f.refused ? -1 : i).filter(i => i >= 0);
    await api.chat.testReceive(sel === 'deny' ? { type: 'approvalResponse', reqId: card.reqId, decision: 'deny' } : { type: 'approvalResponse', reqId: card.reqId, decision: 'approve', selected: sel });
    return { out: String(await p), card, files };
  }
  const bytes = async (p: string) => Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root(), p)));
  const lastApplied = () => posts('planApplied').at(-1);
  async function undoLast() {
    const a = lastApplied();
    await api.chat.testReceive({ type: 'undoPlan', planId: a.planId });
    return until(() => posts('planUndone').find(m => m.planId === a.planId));
  }

  test('H1: plan create/rename through a symlinked directory out of the workspace is refused', async function () {
    if (!(await exists('src/linkdir'))) { this.skip(); }
    const n0 = posts('approvalRequest').length;
    const out = String(await vscode.commands.executeCommand('vsgrok.__testRunTool', 'propose_plan', { changes: [
      { op: 'create', path: 'src/linkdir/escape.ts', content: 'x' },
    ] }));
    assert.match(out, /^Plan not shown: .*outside the workspace/);
    assert.strictEqual(posts('approvalRequest').length, n0, 'no card for an all-refused plan');
    const fs = await import('fs');
    assert.ok(!fs.existsSync(require('path').join(process.env.VSGROK_TEST_OUTDIR!, 'escape.ts')));
    const r = await runPlan([{ op: 'create', path: 'src/ok1.ts', content: 'ok\n' }, { op: 'rename', path: 'src/auth.ts', newPath: 'src/linkdir/auth.ts' }]);
    assert.match(String(r.files.find(f => f.path === 'src/auth.ts')?.refused), /outside the workspace/);
    assert.ok(await exists('src/ok1.ts')); assert.ok(await exists('src/auth.ts'));
    assert.ok((await undoLast()).ok);
  });

  test('H2: a file edited while the card is open is not overwritten', async () => {
    const before = await rd('src/billing.ts');
    const r = await runPlan([{ op: 'modify', path: 'src/billing.ts', content: 'export const replaced = 1;\n' }], undefined, async () => {
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root(), 'src/billing.ts'), Buffer.from(before + '// user edit\n'));
    });
    assert.match(r.out, /not applied: src\/billing\.ts changed since the plan was proposed/);
    assert.strictEqual(await rd('src/billing.ts'), before + '// user edit\n');
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root(), 'src/billing.ts'), Buffer.from(before));
  });

  test('M3: binary rename keeps the bytes; delete + undo restores them; binary modify refused; rename with content + undo', async () => {
    const orig = await bytes('logo.bin');
    await runPlan([{ op: 'rename', path: 'logo.bin', newPath: 'assets-logo.bin' }]);
    assert.deepStrictEqual(await bytes('assets-logo.bin'), orig);
    assert.ok((await undoLast()).ok);
    assert.deepStrictEqual(await bytes('logo.bin'), orig);
    await runPlan([{ op: 'delete', path: 'logo.bin' }]);
    assert.ok(!(await exists('logo.bin')));
    assert.ok((await undoLast()).ok);
    assert.deepStrictEqual(await bytes('logo.bin'), orig);
    const out = String(await vscode.commands.executeCommand('vsgrok.__testRunTool', 'propose_plan', { changes: [{ op: 'modify', path: 'logo.bin', content: 'text' }] }));
    assert.match(out, /binary or non-UTF-8/);
    const auth = await rd('src/auth.ts');
    await runPlan([{ op: 'rename', path: 'src/auth.ts', newPath: 'src/auth2.ts', content: auth + '// moved\n' }]);
    assert.ok(!(await exists('src/auth.ts'))); assert.match(await rd('src/auth2.ts'), /\/\/ moved/);
    assert.ok((await undoLast()).ok);
    assert.strictEqual(await rd('src/auth.ts'), auth); assert.ok(!(await exists('src/auth2.ts')));
  });

  test('M1: View diff contents are reused per row and freed when the card is decided', async () => {
    const c0 = Number(await vscode.commands.executeCommand('vsgrok.__testVirtualDiffCount'));
    const n0 = posts('approvalRequest').length;
    const p = vscode.commands.executeCommand('vsgrok.__testRunTool', 'propose_plan', { changes: [{ op: 'create', path: 'src/vd.ts', content: 'a\n' }] });
    const card = await until(() => posts('approvalRequest')[n0]);
    for (let i = 0; i < 3; i++) { await api.chat.testReceive({ type: 'approvalViewDiff', reqId: card.reqId, index: 0 }); }
    await sleep(200);
    assert.strictEqual(Number(await vscode.commands.executeCommand('vsgrok.__testVirtualDiffCount')), c0 + 2);
    await api.chat.testReceive({ type: 'approvalResponse', reqId: card.reqId, decision: 'deny' });
    await p;
    assert.strictEqual(Number(await vscode.commands.executeCommand('vsgrok.__testVirtualDiffCount')), c0);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('M2: only the last 10 plans keep undo; older cards are told it expired', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) { await runPlan([{ op: 'create', path: `src/m2-${i}.ts`, content: `${i}\n` }]); ids.push(lastApplied().planId); }
    const exp = await until(() => posts('planUndone').find(m => m.planId === ids[0]));
    assert.strictEqual(exp.ok, false); assert.match(exp.msg, /expired/);
    await api.chat.testReceive({ type: 'undoPlan', planId: ids[0] });
    for (const id of ids.slice(1).reverse()) { await api.chat.testReceive({ type: 'undoPlan', planId: id }); }
    assert.ok(await exists('src/m2-0.ts')); assert.ok(!(await exists('src/m2-10.ts'))); assert.ok(!(await exists('src/m2-1.ts')));
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(root(), 'src/m2-0.ts'));
  });

  test('M4: approve with only out-of-range indices is a deny; nothing is applied', async () => {
    const r = await runPlan([{ op: 'create', path: 'src/m4.ts', content: 'x' }], () => [999]);
    assert.match(r.out, /denied/); assert.ok(!(await exists('src/m4.ts')));
  });

  test('L1: behavior-changing files are flagged on the card', async () => {
    const r = await runPlan([{ op: 'create', path: 'VSGrok2.md', content: 'x' }, { op: 'create', path: '.vscode/tasks.json', content: '{}' }], () => 'deny');
    assert.match(String((r.files as { path: string; warn?: string }[]).find(f => f.path === '.vscode/tasks.json')?.warn), /tasks/);
  });

  test('H3/H4: run_tests card shows the script body that runs; testCommand is restricted and machine-overridable', async () => {
    const n0 = posts('approvalRequest').length;
    const p = vscode.commands.executeCommand('vsgrok.__testRunTool', 'run_tests', {});
    const c = await until(() => posts('approvalRequest')[n0]);
    assert.deepStrictEqual(c.request.runs, ['test: node fail-test.js']);
    assert.strictEqual(c.request.repoControlled, true); assert.match(c.request.source, /package\.json/);
    await api.chat.testReceive({ type: 'approvalResponse', reqId: c.reqId, decision: 'deny' }); await p;
    const pj = vscode.extensions.all.find(e => e.packageJSON.name === 'vsgrok')!.packageJSON;
    assert.deepStrictEqual(pj.capabilities.untrustedWorkspaces.restrictedConfigurations, ['vsgrok.testCommand', 'vsgrok.agent.autoApprove', 'vsgrok.agent.commandAllowlist', 'vsgrok.mcp.servers']);
    assert.strictEqual(pj.contributes.configuration.properties['vsgrok.testCommand'].scope, 'machine-overridable');
  });

  test('L5/M5: diagnostics on a symlink to a secret are hidden; get_problems output is framed as untrusted', async function () {
    if (!(await exists('src/innocent.ts'))) { this.skip(); }
    const dc = vscode.languages.createDiagnosticCollection('vsgrok-l5');
    dc.set(vscode.Uri.joinPath(root(), 'src/innocent.ts'), [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'SECRET=should-never-show', vscode.DiagnosticSeverity.Error)]);
    dc.set(vscode.Uri.joinPath(root(), 'src/billing.ts'), [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'visible one', vscode.DiagnosticSeverity.Error)]);
    try {
      const out = String(await vscode.commands.executeCommand('vsgrok.__testRunTool', 'get_problems', {}));
      assert.doesNotMatch(out, /should-never-show/); assert.match(out, /visible one/); assert.match(out, /^<diagnostics source="untrusted tool output"/);
    } finally { dc.dispose(); }
  });

  // ---------- 0.8.0: images + cost meter (mock xAI) ----------
  test('images: sent as input_image data URLs, store=false for image chats, vision gate, Explorer drop rules, cost meter', async () => {
    const xai = process.env.VSGROK_TEST_XAI!;
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const c = vscode.workspace.getConfiguration('vsgrok');
    await c.update('baseUrl', xai + '/v1', vscode.ConfigurationTarget.Global);
    await c.update('model', 'mock-text', vscode.ConfigurationTarget.Global);
    await api.chat['ctx'].secrets.store('vsgrok.apiKey', 'test-key');
    try {
      await api.chat.testReceive({ type: 'clearChat' });
      await idle();
      // Text-only model: vision note offers mock-vision, nothing is sent.
      const v0 = posts('visionNote').length;
      await api.chat.testReceive({ type: 'query', text: 'what is this?', images: [PNG] });
      const note = await until(() => posts('visionNote')[v0]);
      assert.strictEqual(note.model, 'mock-text'); assert.strictEqual(note.suggest, 'mock-vision');
      const reqs0 = await (await fetch(xai + '/requests')).json() as unknown[];
      assert.strictEqual(reqs0.length, 0);
      // Unknown model in a resend is refused; a real one switches and resends (bad image dropped first).
      const t0 = posts('toast').length;
      await api.chat.testReceive({ type: 'switchModelAndResend', model: 'evil-model', text: 'x', images: [PNG] });
      assert.match(posts('toast')[t0].msg, /Unknown model/);
      const r0 = posts('imagesRefused').length; const u0 = posts('userMessage').length;
      await api.chat.testReceive({ type: 'switchModelAndResend', model: 'mock-vision', text: 'what is this?', images: ['data:image/svg+xml;base64,PHN2Zz4=', PNG], imageNames: ['bad.svg', 'shot.png'] });
      await idle();
      assert.strictEqual(vscode.workspace.getConfiguration('vsgrok').get('model'), 'mock-vision');
      assert.match(posts('imagesRefused')[r0].reasons[0], /PNG or JPEG/);
      assert.deepStrictEqual(posts('userMessage')[u0].imageNames, ['shot.png']);
      const reqs = await (await fetch(xai + '/requests')).json() as { model: string; store: boolean; input: { role: string; content: unknown }[] }[];
      assert.strictEqual(reqs[0].model, 'mock-vision');
      assert.strictEqual(reqs.length, 1);
      const user = reqs[0].input.find(i => i.role === 'user')!;
      assert.deepStrictEqual(user.content, [{ type: 'input_text', text: 'what is this?' }, { type: 'input_image', image_url: PNG }]);
      assert.strictEqual(reqs[0].store, false, 'image chats are not stored server-side');
      // Follow-up text turn in the same chat stays store=false and resends the history (incl. the image).
      await api.chat.testReceive({ type: 'query', text: 'and the color?' });
      await idle();
      const reqs2 = await (await fetch(xai + '/requests')).json() as { store: boolean; previous_response_id?: string; input: unknown[] }[];
      assert.strictEqual(reqs2[1].store, false); assert.strictEqual(reqs2[1].previous_response_id, undefined);
      assert.match(JSON.stringify(reqs2[1].input), /input_image/);
      // Cost meter: API-reported cost (2 × 123,000,000 ticks = $0.0246) and tokens.
      const meter = posts('costMeter').at(-1);
      assert.strictEqual(meter.hidden, false); assert.strictEqual(meter.text, '3.1k tok · $0.025');
      assert.match(meter.tooltip, /Cost reported by xAI: \$0\.025/);
      await api.chat.testReceive({ type: 'clearChat' });
      assert.strictEqual(posts('costMeter').at(-1).hidden, true);
      // Explorer drops: workspace image → handed to the webview; secret-looking or outside → refused.
      const root = vscode.workspace.workspaceFolders![0].uri;
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'shot.png'), Buffer.from(PNG.split(',')[1], 'base64'));
      const i0 = posts('imageFile').length; const f0 = posts('contextRefused').length;
      await api.chat.testReceive({ type: 'dropFiles', uris: [vscode.Uri.joinPath(root, 'shot.png').toString(), 'file:///etc/hidden.png', vscode.Uri.joinPath(root, 'id_rsa.png').toString()] });
      const img = await until(() => posts('imageFile')[i0]);
      assert.strictEqual(img.name, 'shot.png'); assert.strictEqual(img.dataUrl, PNG);
      assert.strictEqual(posts('imageFile').length, i0 + 1);
      assert.strictEqual(posts('contextRefused').length - f0, 2);
      const html: string = api.chat['view'].webview.html;
      assert.match(html, /img-src [^;]* data:;/); assert.doesNotMatch(html, /blob:/);
      assert.match(html, /id="attach-image"/); assert.match(html, /<button id="cost-meter" type="button"/); assert.doesNotMatch(html, /id="cost-meter"[^>]*role="status"/);
      assert.match(html, /<dialog id="img-preview"/); assert.match(html, /id="image-tray" role="list"/);
    } finally {
      await api.chat['ctx'].secrets.delete('vsgrok.apiKey');
      await c.update('baseUrl', undefined, vscode.ConfigurationTarget.Global);
      await c.update('model', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('0.8.1 (JGrok): stored reasoning dropped on switch to stateless, old images stripped, Explorer image MIME sniffed', async () => {
    const xai = process.env.VSGROK_TEST_XAI!;
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const c = vscode.workspace.getConfiguration('vsgrok');
    await c.update('baseUrl', xai + '/v1', vscode.ConfigurationTarget.Global);
    await c.update('model', 'mock-vision', vscode.ConfigurationTarget.Global);
    await api.chat['ctx'].secrets.store('vsgrok.apiKey', 'test-key');
    type Req = { store?: boolean; input: { type?: string; role?: string; content?: { type: string; text?: string }[] }[] };
    const reqs = async () => await (await fetch(xai + '/requests')).json() as Req[];
    try {
      await api.chat.testReceive({ type: 'clearChat' }); await idle();
      const start = (await reqs()).length;
      await api.chat.testReceive({ type: 'query', text: 'hello' }); await idle();          // stored turn → reasoning item
      const e0 = posts('streamError').length;
      await api.chat.testReceive({ type: 'query', text: 'look', images: [PNG] }); await idle(); // switch to stateless
      await api.chat.testReceive({ type: 'query', text: 'and this', images: [PNG] }); await idle();
      assert.strictEqual(posts('streamError').length, e0, 'no API error after the switch (M1)');
      const r = (await reqs()).slice(start);
      assert.strictEqual(r.length, 3);
      assert.ok(!r[1].input.some(i => i.type === 'reasoning'), 'reasoning without encrypted_content dropped');
      const users = r[2].input.filter(i => i.role === 'user' && Array.isArray(i.content));
      const imgs = JSON.stringify(r[2].input).match(/input_image/g) ?? [];
      assert.strictEqual(imgs.length, 1, 'only the newest image is resent (H1)');
      assert.match(JSON.stringify(users), /image 1 from an earlier message omitted/);
      // M3: a GIF named .png is labelled by its magic bytes; non-images refused early.
      const root = vscode.workspace.workspaceFolders![0].uri;
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'fake.png'), Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'));
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'text.png'), Buffer.from('not an image at all'));
      const i0 = posts('imageFile').length; const x0 = posts('imagesRefused').length;
      await api.chat.testReceive({ type: 'dropFiles', uris: [vscode.Uri.joinPath(root, 'fake.png').toString(), vscode.Uri.joinPath(root, 'text.png').toString()] });
      const img = await until(() => posts('imageFile')[i0]);
      assert.match(img.dataUrl, /^data:image\/gif;base64,/);
      const ref = await until(() => posts('imagesRefused')[x0]);
      assert.match(ref.reasons[0], /text\.png: not a PNG, JPEG, GIF, WebP or BMP image/);
    } finally {
      await api.chat.testReceive({ type: 'clearChat' });
      await api.chat['ctx'].secrets.delete('vsgrok.apiKey');
      await c.update('baseUrl', undefined, vscode.ConfigurationTarget.Global);
      await c.update('model', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  // ---------- 0.9.0: inline edit ----------
  async function withMock<T>(model: string, fn: (xai: string) => Promise<T>): Promise<T> {
    const xai = process.env.VSGROK_TEST_XAI!;
    const c = vscode.workspace.getConfiguration('vsgrok');
    await c.update('baseUrl', xai + '/v1', vscode.ConfigurationTarget.Global);
    await c.update('model', model, vscode.ConfigurationTarget.Global);
    await api.chat['ctx'].secrets.store('vsgrok.apiKey', 'test-key');
    try { return await fn(xai); } finally {
      await api.chat['ctx'].secrets.delete('vsgrok.apiKey');
      await c.update('baseUrl', undefined, vscode.ConfigurationTarget.Global);
      await c.update('model', undefined, vscode.ConfigurationTarget.Global);
    }
  }
  const reply = (xai: string, text: string, toolCalls?: unknown[]) => fetch(xai + '/chatReply', { method: 'POST', body: JSON.stringify({ text, toolCalls }) });

  test('inline edit: proposal in the widget (buffer untouched), region tracks edits, accept is one undo, reject is a no-op, refine resends history, secrets refused in-widget', async () => {
    await withMock('mock-text', async (xai) => {
      const root = vscode.workspace.workspaceFolders![0].uri;
      const f = vscode.Uri.joinPath(root, 'inline-target.ts');
      await vscode.workspace.fs.writeFile(f, Buffer.from('const a = 1;\nfunction add(x, y) {\n  return x + y;\n}\nconst z = 3;\n'));
      const doc = await vscode.workspace.openTextDocument(f);
      const ed = await vscode.window.showTextDocument(doc);
      ed.selection = new vscode.Selection(1, 0, 4, 0);
      const ie = api.inlineEdit;
      const c0 = ((await (await fetch(xai + '/chatRequests')).json()) as unknown[]).length;
      await reply(xai, '```ts\nfunction add(x: number, y: number): number {\n  return x + y;\n}\n```');
      await vscode.commands.executeCommand('vsgrok.inlineEdit', 'add types');
      await until(() => ie.state?.ready);
      // FH2: the proposal is rendered in the widget; the document is untouched (not dirty) until Accept.
      assert.strictEqual(doc.getText(), 'const a = 1;\nfunction add(x, y) {\n  return x + y;\n}\nconst z = 3;\n');
      assert.strictEqual(doc.isDirty, false);
      assert.match(ie.lastStatus, /\+1 −1/); assert.match(ie.lastStatus, /```diff\n- function add\(x, y\) \{\n\+ function add\(x: number/); assert.match(ie.lastStatus, /(Ctrl|Cmd)\+Enter/);
      // FH1: typing above the region shifts it; the result still lands in the right place.
      const we0 = new vscode.WorkspaceEdit(); we0.insert(f, new vscode.Position(0, 0), '// top\n'); await vscode.workspace.applyEdit(we0);
      assert.strictEqual(ie.active, true); assert.strictEqual(ie.state.start, 'const a = 1;\n// top\n'.length);
      const reqs = (await (await fetch(xai + '/chatRequests')).json()) as { messages: { role: string; content: string }[] }[];
      const sent = reqs[c0].messages.at(-1)!.content;
      assert.match(sent, /<REGION>function add\(x, y\) \{\n  return x \+ y;\n\}\n<\/REGION>const z/); assert.match(sent, /Instruction: add types/);
      // Refine: history goes along; the new result replaces the shown block.
      await reply(xai, 'function add(x: number, y: number) {\n  return x + y; // sum\n}\n');
      await vscode.commands.executeCommand('vsgrok.inlineEdit.submit', 'add a comment');
      await until(() => ie.state?.ready && /sum/.test(ie.state.result ?? ''));
      const reqs2 = (await (await fetch(xai + '/chatRequests')).json()) as { messages: { role: string; content: string }[] }[];
      const m2 = reqs2[c0 + 1].messages;
      assert.strictEqual(m2[2].role, 'assistant'); assert.match(m2.at(-1)!.content, /Refine your last replacement: add a comment/);
      await vscode.commands.executeCommand('vsgrok.inlineEdit.accept');
      assert.strictEqual(doc.getText(), '// top\nconst a = 1;\nfunction add(x: number, y: number) {\n  return x + y; // sum\n}\nconst z = 3;\n');
      assert.strictEqual(ie.active, false);
      // FL1: one undo reverts exactly the accepted edit.
      await vscode.window.showTextDocument(doc); await vscode.commands.executeCommand('undo');
      assert.strictEqual(doc.getText(), '// top\nconst a = 1;\nfunction add(x, y) {\n  return x + y;\n}\nconst z = 3;\n');
      // FH1: an edit inside the region cancels and keeps the user's text; nothing is deleted.
      ed.selection = new vscode.Selection(2, 0, 2, 0);
      await reply(xai, 'X\n');
      await vscode.commands.executeCommand('vsgrok.inlineEdit', 'x');
      await until(() => ie.state?.ready);
      const weIn = new vscode.WorkspaceEdit(); weIn.insert(f, new vscode.Position(2, 3), 'MINE'); await vscode.workspace.applyEdit(weIn);
      assert.strictEqual(ie.active, false); assert.match(doc.getText(), /funMINEction add\(x, y\)/); assert.doesNotMatch(doc.getText(), /^X$/m);
      // Reject restores the original exactly (cursor line only; last line without a newline).
      const we = new vscode.WorkspaceEdit();
      we.replace(f, new vscode.Range(0, 0, doc.lineCount, 0), 'let q = 1;\nlet r = 2');
      await vscode.workspace.applyEdit(we);
      assert.strictEqual(doc.getText(), 'let q = 1;\nlet r = 2');
      ed.selection = new vscode.Selection(1, 3, 1, 3);
      await reply(xai, 'const r = 2;');
      await vscode.commands.executeCommand('vsgrok.inlineEdit', 'make const');
      await until(() => ie.state?.ready);
      assert.strictEqual(doc.getText(), 'let q = 1;\nlet r = 2');
      await vscode.commands.executeCommand('vsgrok.inlineEdit.reject');
      assert.strictEqual(doc.getText(), 'let q = 1;\nlet r = 2');
      // Accept on the last line keeps no stray newline.
      await reply(xai, 'const r = 2;');
      await vscode.commands.executeCommand('vsgrok.inlineEdit', 'make const');
      await until(() => ie.state?.ready);
      await vscode.commands.executeCommand('vsgrok.inlineEdit.accept');
      assert.strictEqual(doc.getText(), 'let q = 1;\nconst r = 2;');
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      // Secret files: refused before anything is sent.
      const sec = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, '.env'));
      await vscode.window.showTextDocument(sec);
      const n0 = ((await (await fetch(xai + '/chatRequests')).json()) as unknown[]).length;
      await vscode.commands.executeCommand('vsgrok.inlineEdit', 'anything');
      assert.strictEqual(ie.active, false);
      assert.match(ie.lastStatus, /isn't available here: looks like a secrets/);
      await vscode.commands.executeCommand('vsgrok.inlineEdit.reject');
      assert.strictEqual(((await (await fetch(xai + '/chatRequests')).json()) as unknown[]).length, n0);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      // Keybinding contributions: Ctrl+I yields to other inline-chat providers; Tab only while a result is ready.
      const pkg = vscode.extensions.all.find(e => e.packageJSON?.name === 'vsgrok')!.packageJSON;
      const kb = pkg.contributes.keybindings.find((k: { command: string }) => k.command === 'vsgrok.inlineEdit');
      assert.strictEqual(kb.key, 'ctrl+i'); assert.strictEqual(kb.mac, 'cmd+i'); assert.match(kb.when, /!inlineChatHasProvider/);
      assert.match(pkg.contributes.keybindings.find((k: { key: string }) => k.key === 'tab').when, /vsgrok\.inlineEditReady.*!suggestWidgetVisible.*!inlineSuggestionVisible/);
    });
  });

  // ---------- 0.10.0: background task ----------
  const fcall = (i: number, name: string, args: unknown) => ({ type: 'function_call', id: `fc_t${i}`, call_id: `call_t${i}`, name, arguments: JSON.stringify(args), status: 'completed' });
  const rreply = (xai: string, body: unknown) => fetch(xai + '/responsesReply', { method: 'POST', body: JSON.stringify(body) });

  test('run task: auto-approves workspace creates and allowlisted commands, asks for deletes/other commands, progress + summary + Undo all', async () => {
    const c = vscode.workspace.getConfiguration('vsgrok');
    await c.update('agent.autoApprove', 'editsAndCommands', vscode.ConfigurationTarget.Global);
    await c.update('agent.commandAllowlist', ['node --version'], vscode.ConfigurationTarget.Global);
    try {
      await withMock('mock-text', async (xai) => {
        await api.chat.testReceive({ type: 'clearChat' }); await idle();
        const root = vscode.workspace.workspaceFolders![0].uri;
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'keep-me.txt'), Buffer.from('keep'));
        await rreply(xai, { output: [fcall(1, 'propose_plan', { summary: 's', changes: [{ op: 'create', path: 'task-out.txt', content: 'hello' }, { op: 'modify', path: 'keep-me.txt', content: 'kept and changed' }] })] });
        await rreply(xai, { output: [fcall(2, 'run_command', { command: 'node --version' })] });
        await rreply(xai, { output: [fcall(3, 'run_command', { command: 'echo hi' })] });
        await rreply(xai, { output: [fcall(4, 'propose_plan', { changes: [{ op: 'delete', path: 'keep-me.txt' }] })] });
        await rreply(xai, { text: 'Done: created task-out.txt.' });
        const a0 = posts('approvalRequest').length; const r0 = (await (await fetch(xai + '/requests')).json() as unknown[]).length;
        const p = api.chat.runTask('make task-out.txt');
        // The two risky steps show cards; deny both.
        const card1 = await until(() => posts('approvalRequest')[a0]);
        assert.strictEqual(card1.request.kind, 'command'); assert.strictEqual(card1.request.command, 'echo hi');
        await api.chat.testReceive({ type: 'approvalResponse', reqId: card1.reqId, decision: 'deny' });
        const card2 = await until(() => posts('approvalRequest')[a0 + 1]);
        assert.strictEqual(card2.request.kind, 'plan'); assert.strictEqual(card2.request.files[0].op, 'delete');
        await api.chat.testReceive({ type: 'approvalResponse', reqId: card2.reqId, decision: 'deny' });
        await p;
        assert.strictEqual(posts('approvalRequest').length, a0 + 2, 'only the risky steps asked');
        assert.strictEqual(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, 'task-out.txt'))).toString(), 'hello');
        const start = posts('taskStart').at(-1); assert.strictEqual(start.level, 'editsAndCommands'); assert.strictEqual(start.maxSteps, 40);
        const logs = posts('taskLog').filter((l: { id: string }) => l.id === start.id).map((l: { text: string }) => l.text);
        assert.match(logs[0], /Auto-approved plan \(2 files\)/); assert.match(logs[1], /Auto-approved `node --version`/);
        assert.match(logs[2], /Asking you: `echo hi` \(command not on the allowlist\)/); assert.match(logs[3], /deletes keep-me\.txt/);
        assert.ok(posts('taskProgress').some((x: { id: string; label?: string }) => x.id === start.id && /Ran|Running/.test(x.label ?? '')));
        const end = posts('taskEnd').at(-1);
        assert.strictEqual(end.outcome, 'done'); assert.deepStrictEqual([...end.files].sort(), ['keep-me.txt', 'task-out.txt']);
        assert.strictEqual(end.autoApproved, 2); assert.strictEqual(end.asked, 2);
        const reqs = (await (await fetch(xai + '/requests')).json() as { input: { role?: string; content?: string }[] }[]).slice(r0);
        assert.ok(reqs[0].input.some(x => x.role === 'system' && /background task mode/.test(String(x.content))));
        const outs = JSON.stringify(reqs);
        assert.match(outs, /exit code 0/); assert.match(outs, /User declined to run the command/);
        // Undo all restores the modified file and removes the created one.
        await api.chat.testReceive({ type: 'undoTask', id: end.id });
        const u = posts('taskUndone').at(-1);
        assert.strictEqual(u.ok, true, u.msg);
        assert.strictEqual(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, 'keep-me.txt'))).toString(), 'keep');
        await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.joinPath(root, 'task-out.txt'))));
        await api.chat.testReceive({ type: 'undoTask', id: end.id });
        assert.strictEqual(posts('taskUndone').at(-1).ok, false);
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, 'keep-me.txt'));
      });
    } finally {
      await c.update('agent.autoApprove', undefined, vscode.ConfigurationTarget.Global);
      await c.update('agent.commandAllowlist', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('run task: default level asks for every edit; token budget stops with a no-tools summary; workspace settings cannot enable auto-approve', async () => {
    const c = vscode.workspace.getConfiguration('vsgrok');
    await c.update('agent.task.maxTokens', 1500, vscode.ConfigurationTarget.Global);
    await c.update('agent.autoApprove', 'editsAndCommands', vscode.ConfigurationTarget.Workspace);
    try {
      await withMock('mock-text', async (xai) => {
        await api.chat.testReceive({ type: 'clearChat' }); await idle();
        await rreply(xai, { output: [fcall(5, 'propose_edit', { path: 'budget.txt', content: 'x' })], usage: { input_tokens: 1000, output_tokens: 600 } });
        await rreply(xai, { text: 'Summary: stopped at budget.' });
        const a0 = posts('approvalRequest').length; const r0 = (await (await fetch(xai + '/requests')).json() as unknown[]).length;
        const p = api.chat.runTask('budget test');
        const card = await until(() => posts('approvalRequest')[a0]);
        assert.strictEqual(card.request.kind, 'edit', 'workspace-level autoApprove is ignored');
        await api.chat.testReceive({ type: 'approvalResponse', reqId: card.reqId, decision: 'deny' });
        await p;
        assert.strictEqual(posts('taskStart').at(-1).level, 'none');
        const end = posts('taskEnd').at(-1);
        assert.strictEqual(end.outcome, 'budget'); assert.deepStrictEqual(end.files, []);
        const reqs = (await (await fetch(xai + '/requests')).json() as { tools?: unknown[] }[]).slice(r0);
        assert.strictEqual(reqs.length, 2); assert.ok(!reqs[1].tools || reqs[1].tools.length === 0);
      });
    } finally {
      await c.update('agent.task.maxTokens', undefined, vscode.ConfigurationTarget.Global);
      await c.update('agent.autoApprove', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  // ---------- 0.11.0: chat history + tabs ----------
  test('0.14.3: run_tests with path detects the nearest package.json and runs there (node --test, TAP parsed)', async () => {
    const root = vscode.workspace.workspaceFolders![0].uri;
    const dir = vscode.Uri.joinPath(root, 'palette-int');
    const w = (p: string, c: string) => vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, p), Buffer.from(c));
    await w('package.json', JSON.stringify({ name: 'palette', scripts: { test: 'node --test' } }));
    await w('test/a.test.js', "const test = require('node:test'); const assert = require('node:assert/strict');\ntest('ok', () => {});\ntest('wrong on purpose', () => { assert.equal('#00ffff', '#00ff00'); });\n");
    try {
      const n0 = posts('approvalRequest').length;
      const p = vscode.commands.executeCommand('vsgrok.__testRunTool', 'run_tests', { path: 'palette-int/test' });
      const card = await until(() => posts('approvalRequest')[n0]);
      assert.strictEqual(card.request.command, 'npm test');
      assert.match(card.request.source, /^palette-int\/package\.json scripts\.test · runs in palette-int\//);
      await api.chat.testReceive({ type: 'approvalResponse', reqId: card.reqId, decision: 'approve' });
      const out = String(await p);
      assert.match(out, /^Ran `npm test` in palette-int\/ \(node:test, from palette-int\/package\.json scripts\.test\): exit code 1/);
      assert.match(out, /1 failure\(s\):\n- test\/a\.test\.js:3 \[wrong on purpose\]/);
      assert.match(String(await vscode.commands.executeCommand('vsgrok.__testRunTool', 'run_tests', { path: '../outside' })), /^Refused: .*outside the workspace/);
    } finally { await vscode.workspace.fs.delete(dir, { recursive: true }); }
  });

  test('0.14.3: demo cap applies only while the demo runs; Continue raises it; later turns are never blocked', async () => {
    await withMock('mock-text', async (xai) => {
      const chat = api.chat;
      const fc = (i: number) => ({ type: 'function_call', id: `fcd${i}`, call_id: `cd${i}`, name: 'get_workspace_overview', arguments: '{}', status: 'completed' });
      const big = { input_tokens: 10_000, output_tokens: 100, cost_in_usd_ticks: 6_000_000_000 }; // $0.60 per step
      await chat.testReceive({ type: 'clearChat' }); await idle();
      await rreply(xai, { output: [fc(1)], usage: big });
      await rreply(xai, { output: [fc(2)], usage: big });
      await rreply(xai, { text: 'Paused summary.', usage: { input_tokens: 10, output_tokens: 10, cost_in_usd_ticks: 1 } });
      const n0 = posts('demoBudget').length;
      await chat.testReceive({ type: 'query', text: 'run the demo' }); await idle();
      const card = await until(() => posts('demoBudget')[n0]);
      assert.strictEqual(card.limit, 1); assert.strictEqual(card.step, 0.5);
      // Continue: the same demo continues with a $1.50 cap.
      await rreply(xai, { text: 'Continuing.', usage: big });
      await chat.testReceive({ type: 'demoContinue' }); await idle();
      assert.strictEqual(chat['demo'], undefined, 'demo ended when the continued turn finished');
      // A normal turn afterwards: expensive tool steps are not capped.
      await rreply(xai, { output: [fc(3)], usage: big }); await rreply(xai, { output: [fc(4)], usage: big }); await rreply(xai, { text: 'normal done' });
      await chat.testReceive({ type: 'query', text: 'what files are here?' }); await idle();
      assert.strictEqual(posts('demoBudget').length, n0 + 1);
      assert.ok(!JSON.stringify((await (await fetch(xai + '/requests')).json() as unknown[]).at(-1)).includes('demo budget'));
    });
  });

  test('0.14.2: Run Demo sends the trigger; read_extension_doc reads only bundled DEMO.md; hint in system prompt', async () => {
    const doc = await vscode.commands.executeCommand<string>('vsgrok.__testRunTool', 'read_extension_doc', { name: 'DEMO.md' });
    assert.match(doc, /instructions for Grok/);
    const bad = await vscode.commands.executeCommand<string>('vsgrok.__testRunTool', 'read_extension_doc', { name: '../package.json' });
    assert.match(bad, /^Refused/);
    await withMock('mock-text', async (xai) => {
      await api.chat.testReceive({ type: 'clearChat' }); await idle();
      await vscode.commands.executeCommand('vsgrok.runDemo'); await idle();
      const last = (await (await fetch(xai + '/requests')).json() as { input: unknown[]; tools?: { name?: string }[] }[]).at(-1)!;
      assert.match(JSON.stringify(last.input), /execute the demo/);
      assert.match(JSON.stringify(last.input), /read_extension_doc with name \\"DEMO.md\\"/);
      assert.ok(last.tools?.some(t => t.name === 'read_extension_doc'));
    });
  });

  test('0.14.2 bug: a failed or stopped first turn stays in model context (store on, chained)', async () => {
    await withMock('mock-text', async (xai) => {
      const chat = api.chat;
      type Req = { previous_response_id?: string; input: unknown[] };
      const reqs = async () => await (await fetch(xai + '/requests')).json() as Req[];
      await vscode.workspace.getConfiguration('vsgrok').update('responses.store', true, vscode.ConfigurationTarget.Global);
      await chat.testReceive({ type: 'clearChat' }); await idle();
      // Turn 1 fails (non-retryable error).
      await rreply(xai, { status: 400, error: 'boom' });
      await chat.testReceive({ type: 'query', text: 'wanna see something cool? run git pull' }); await idle();
      assert.ok(posts('streamError').length);
      await chat.testReceive({ type: 'query', text: 'we are going to try that again' }); await idle();
      const t2 = (await reqs()).at(-1)!;
      const t1id = `resp_${(await reqs()).length - 1}`;
      assert.ok(t2.previous_response_id === t1id || /wanna see something cool[\s\S]*try that again/.test(JSON.stringify(t2.input)),
        'turn 2 must chain to turn 1 or include its text: ' + JSON.stringify(t2).slice(0, 400));
      // Turn 3 chains normally on turn 2's response.
      await chat.testReceive({ type: 'query', text: 'third' }); await idle();
      assert.strictEqual((await reqs()).at(-1)!.previous_response_id, `resp_${(await reqs()).length - 1}`);
      // Guard: even if the local context loses a shown message, it is rebuilt from the transcript.
      chat['conv'] = { items: [], previousResponseId: 'resp_bogus' };
      await chat.testReceive({ type: 'query', text: 'fourth' }); await idle();
      const t4 = (await reqs()).at(-1)!;
      assert.strictEqual(t4.previous_response_id, undefined);
      assert.match(JSON.stringify(t4.input), /wanna see something cool[\s\S]*try that again[\s\S]*third[\s\S]*fourth/);
    });
  });

  test('history: chats saved (redacted), tabs, reopen resumes via previous_response_id or local items, rename, export .md, delete', async () => {
    await withMock('mock-text', async (xai) => {
      const chat = api.chat;
      type Req = { previous_response_id?: string; store?: boolean; input: { role?: string; content?: unknown }[] };
      const reqs = async () => await (await fetch(xai + '/requests')).json() as Req[];
      await chat.testReceive({ type: 'clearChat' }); await idle();
      await chat.testReceive({ type: 'query', text: 'remember xai-ABCDEFGHIJKLMNOP for the parser' }); await idle();
      await chat.saveNow();
      const firstId: string = chat['chatId'];
      // FM5: by default only the transcript is saved (no model context).
      const raw0 = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(chat['ctx'].globalStorageUri, 'chats', `${firstId}.json`))).toString());
      assert.strictEqual(raw0.conv, undefined); assert.strictEqual(raw0.messages.length, 2);
      await vscode.workspace.getConfiguration('vsgrok').update('history.saveContext', true, vscode.ConfigurationTarget.Global);
      await chat.saveNow();
      chat['contexts'] = [{ id: 'cx1', kind: 'file', label: 'only-in-tab-1.ts' }];
      const hits = await chat.store.list('parser');
      assert.strictEqual(hits[0].id, firstId); assert.strictEqual(hits[0].title, 'remember [redacted] for the parser');
      const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(chat['ctx'].globalStorageUri, 'chats', `${firstId}.json`))).toString();
      assert.doesNotMatch(raw, /xai-ABCDEFGH/); assert.doesNotMatch(raw, /test-key/);
      const lastResp = JSON.parse(raw).conv.previousResponseId as string; assert.match(lastResp, /^resp_/);
      // Second tab.
      await chat.testReceive({ type: 'newTab' });
      assert.deepStrictEqual(chat['contexts'], [], 'FM6: context chips stay with their tab');
      assert.deepStrictEqual(posts('transcript').at(-1).messages, []);
      assert.strictEqual(posts('tabs').at(-1).tabs.length, 2);
      await chat.testReceive({ type: 'query', text: 'second chat about docker' }); await idle();
      // Switch back: transcript re-rendered; the chain isn't trusted after a tab switch, so the full local list is sent.
      await chat.testReceive({ type: 'switchTab', id: firstId });
      assert.strictEqual((chat['contexts'] as { label?: string }[])[0]?.label, 'only-in-tab-1.ts'); chat['contexts'] = []; chat['pushContexts']();
      assert.strictEqual(posts('transcript').at(-1).messages.length, 2);
      assert.strictEqual(posts('tabs').at(-1).active, firstId);
      await chat.testReceive({ type: 'query', text: 'follow up' }); await idle();
      { const l = (await reqs()).at(-1)!; assert.ok(lastResp); assert.strictEqual(l.previous_response_id, undefined); assert.match(JSON.stringify(l.input), /remember[\s\S]*follow up/); }
      { await chat.testReceive({ type: 'query', text: 'chained again' }); await idle(); const r = await reqs(); assert.match(r.at(-1)!.previous_response_id ?? '', /^resp_/, 'chaining resumes after a full send'); }
      // Close and reopen from disk: the saved local items are resent in full.
      await chat.saveNow();
      const resp2 = (await chat.store.load(firstId)).conv.previousResponseId;
      await chat.testReceive({ type: 'closeTab', id: firstId });
      assert.strictEqual(posts('tabs').at(-1).tabs.length, 1);
      await chat.testReceive({ type: 'historyList', query: '' });
      assert.ok(posts('historyItems').at(-1).items.some((x: { id: string; open: boolean }) => x.id === firstId && !x.open));
      await chat.testReceive({ type: 'openChat', id: firstId });
      assert.strictEqual(posts('transcript').at(-1).messages.length, 6);
      await chat.testReceive({ type: 'query', text: 'after reopen' }); await idle();
      { const l = (await reqs()).at(-1)!; assert.ok(resp2); assert.strictEqual(l.previous_response_id, undefined); assert.match(JSON.stringify(l.input), /remember[\s\S]*follow up[\s\S]*after reopen/); }
      // Without server-side storage: the saved local items are resent.
      const c = vscode.workspace.getConfiguration('vsgrok');
      await c.update('responses.store', false, vscode.ConfigurationTarget.Global);
      try {
        await chat.testReceive({ type: 'newTab' });
        await chat.testReceive({ type: 'query', text: 'stateless chat alpha' }); await idle();
        const sid: string = chat['chatId'];
        await chat.saveNow();
        await chat.testReceive({ type: 'closeTab', id: sid });
        await chat.testReceive({ type: 'openChat', id: sid });
        await chat.testReceive({ type: 'query', text: 'stateless follow up' }); await idle();
        const last = (await reqs()).at(-1)!;
        assert.strictEqual(last.previous_response_id, undefined); assert.strictEqual(last.store, false);
        assert.match(JSON.stringify(last.input), /stateless chat alpha[\s\S]*A red square[\s\S]*stateless follow up/);
        // Rename, export, delete.
        await chat.testReceive({ type: 'renameChat', id: sid, title: 'Alpha notes' });
        assert.strictEqual((await chat.store.list('alpha'))[0].title, 'Alpha notes');
        assert.strictEqual(posts('tabs').at(-1).tabs.find((t: { id: string }) => t.id === sid).title, 'Alpha notes');
        const out = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'alpha-export.md');
        await chat.exportChat(sid, out);
        const md = Buffer.from(await vscode.workspace.fs.readFile(out)).toString();
        assert.match(md, /^# Alpha notes\n/); assert.match(md, /## You\n\nstateless chat alpha/); assert.match(md, /## Grok\n\nA red square\./);
        await vscode.workspace.fs.delete(out);
        await chat.testReceive({ type: 'deleteChat', id: sid });
        assert.deepStrictEqual(await chat.store.list('alpha'), []);
        await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.joinPath(chat['ctx'].globalStorageUri, 'chats', `${sid}.json`))));
      } finally { await c.update('responses.store', undefined, vscode.ConfigurationTarget.Global); }
      // Switching is refused while busy.
      chat['busy'] = true; const t0 = posts('toast').length;
      await chat.testReceive({ type: 'newTab' });
      assert.match(posts('toast')[t0].msg, /Wait for Grok to finish/);
      chat['busy'] = false;
      await vscode.workspace.getConfiguration('vsgrok').update('history.saveContext', undefined, vscode.ConfigurationTarget.Global);
    });
  });

  // ---------- 0.12.0: MCP ----------
  test('MCP: stdio + streamable HTTP servers, tools offered to Grok, approval card with Always allow, workspace file merge', async () => {
    const xai = process.env.VSGROK_TEST_XAI!;
    const base = xai.replace(/\/xai$/, '');
    const serverJs = path.resolve(__dirname, '..', '..', '..', 'test-int', 'mcp-echo-server.cjs');
    const c = vscode.workspace.getConfiguration('vsgrok');
    const root = vscode.workspace.workspaceFolders![0].uri;
    const wsFile = vscode.Uri.joinPath(root, '.vscode', 'vsgrok-mcp.json');
    await c.update('mcp.servers', {
      echo: { command: 'node', args: [serverJs], env: { ECHO_LABEL: 'stdio' } },
      web: { url: `${base}/mcp`, headers: { 'x-test-auth': 'ok' } },
      down: { url: 'http://127.0.0.1:1/mcp' },
    }, vscode.ConfigurationTarget.Global);
    await vscode.workspace.fs.writeFile(wsFile, Buffer.from(JSON.stringify({ servers: { wsecho: { command: 'node', args: [serverJs], env: { ECHO_LABEL: 'ws' } }, echo: { command: 'evil' } } })));
    try {
      api.mcp.reload(); await api.mcp.ready();
      const st = api.mcp.status();
      const by = (n: string) => st.servers.find((x: { name: string }) => x.name === n);
      assert.strictEqual(by('echo').status, 'ready', JSON.stringify(st)); assert.deepStrictEqual(by('echo').tools, ['echo', 'add.numbers']);
      assert.strictEqual(by('web').status, 'ready', JSON.stringify(st)); assert.strictEqual(by('web').type, 'http');
      assert.strictEqual(by('down').status, 'error');
      assert.strictEqual(by('wsecho').source, 'workspace'); assert.strictEqual(by('wsecho').status, 'needsConsent', 'repo servers never start silently');
      assert.deepStrictEqual(api.mcp.pendingConsent().map((p: { name: string }) => p.name), ['wsecho']);
      assert.match(api.mcp.pendingConsent()[0].launch, /^node .*mcp-echo-server\.cjs/);
      await api.mcp.grantConsent();
      const st2 = api.mcp.status(); const by2 = (n: string) => st2.servers.find((x: { name: string }) => x.name === n);
      assert.strictEqual(by2('wsecho').status, 'ready'); assert.strictEqual(by2('echo').status, 'ready');
      assert.match(st.errors.join('\n'), /echo: defined in settings and this repo; the settings one is used/);
      const names = api.mcp.functionTools().map((t: { name: string }) => t.name);
      assert.ok(names.includes('mcp__echo__echo') && names.includes('mcp__web__add_numbers') && names.includes('mcp__wsecho__echo'), names.join());
      await withMock('mock-text', async () => {
        await api.chat.testReceive({ type: 'clearChat' }); await idle();
        await api.chat.testReceive({ type: 'setAgent', enabled: true });
        await rreply(xai, { output: [fcall(11, 'mcp__echo__echo', { text: 'hi' })] });
        await rreply(xai, { output: [fcall(12, 'mcp__echo__echo', { text: 'again' })] });
        await rreply(xai, { output: [fcall(13, 'mcp__web__add_numbers', { a: 2, b: 3 })] });
        await rreply(xai, { output: [fcall(14, 'mcp__wsecho__echo', { text: 'w' })] });
        await rreply(xai, { text: 'done' });
        const a0 = posts('approvalRequest').length; const r0 = (await (await fetch(xai + '/requests')).json() as unknown[]).length;
        const q = api.chat.testReceive({ type: 'query', text: 'use the tools' });
        const c1 = await until(() => posts('approvalRequest')[a0]);
        assert.deepStrictEqual({ kind: c1.request.kind, server: c1.request.server, tool: c1.request.tool, source: c1.request.source }, { kind: 'mcp', server: 'echo', tool: 'echo', source: 'settings' });
        assert.match(c1.request.args, /"text": "hi"/);
        await api.chat.testReceive({ type: 'approvalResponse', reqId: c1.reqId, decision: 'approve', always: true });
        // Second echo call is always-allowed; next card is the HTTP server's tool.
        const c2 = await until(() => posts('approvalRequest')[a0 + 1]);
        assert.strictEqual(c2.request.server, 'web');
        await api.chat.testReceive({ type: 'approvalResponse', reqId: c2.reqId, decision: 'approve' });
        const c3 = await until(() => posts('approvalRequest')[a0 + 2]);
        assert.strictEqual(c3.request.source, 'workspace');
        await api.chat.testReceive({ type: 'approvalResponse', reqId: c3.reqId, decision: 'deny' });
        await q; await idle();
        const reqs = (await (await fetch(xai + '/requests')).json() as { tools?: { name?: string }[] }[]).slice(r0);
        assert.ok(reqs[0].tools!.some(t => t.name === 'mcp__echo__echo'));
        const all = JSON.stringify(reqs);
        assert.match(all, /mcp_result server=\\"echo\\" tool=\\"echo\\" source=\\"untrusted tool output\\">\\nstdio echo: hi/);
        assert.match(all, /stdio echo: again/); assert.match(all, /server=\\"web\\" tool=\\"add.numbers\\" source=\\"untrusted tool output\\">\\n5\\n<\/mcp_result>/);
        assert.match(all, /User declined the MCP tool call wsecho\/echo/);
        assert.ok(posts('toolEvent').some((e: { label?: string }) => /Called MCP echo › echo/.test(e.label ?? '')));
      });
      // Agent off: MCP tools are not offered.
      await api.chat.testReceive({ type: 'setAgent', enabled: false });
      await withMock('mock-text', async (x2) => {
        const r0 = (await (await fetch(x2 + '/requests')).json() as unknown[]).length;
        await api.chat.testReceive({ type: 'query', text: 'no tools please' }); await idle();
        const req = (await (await fetch(x2 + '/requests')).json() as { tools?: { name?: string }[] }[])[r0];
        assert.ok(!req.tools?.some(t => String(t.name).startsWith('mcp__')));
      });
      await api.chat.testReceive({ type: 'setAgent', enabled: true });
      // H1: workspace-level settings values are repo servers (not "settings") and wait for consent.
      await c.update('mcp.servers', { wsset: { command: 'node', args: [serverJs] } }, vscode.ConfigurationTarget.Workspace);
      api.mcp.reload(); await api.mcp.ready();
      let s3 = api.mcp.status(); const ws3 = s3.servers.find((x: { name: string }) => x.name === 'wsset');
      assert.deepStrictEqual({ source: ws3.source, status: ws3.status }, { source: 'workspace', status: 'needsConsent' });
      assert.ok(s3.servers.find((x: { name: string }) => x.name === 'echo').source === 'settings');
      await c.update('mcp.servers', undefined, vscode.ConfigurationTarget.Workspace);
      // H2: changing a consented repo server's config (here: an env value) needs consent again.
      await vscode.workspace.fs.writeFile(wsFile, Buffer.from(JSON.stringify({ servers: { wsecho: { command: 'node', args: [serverJs], env: { ECHO_LABEL: 'changed' } } } })));
      api.mcp.reload(); await api.mcp.ready();
      s3 = api.mcp.status();
      assert.strictEqual(s3.servers.find((x: { name: string }) => x.name === 'wsecho').status, 'needsConsent');
      // H2: an agent edit of the MCP config is flagged on the card and never auto-approved.
      const n0 = posts('approvalRequest').length;
      const pe = vscode.commands.executeCommand('vsgrok.__testRunTool', 'propose_edit', { path: '.vscode/vsgrok-mcp.json', content: '{"servers":{}}' });
      const card = await until(() => posts('approvalRequest')[n0]);
      assert.match(card.request.warn, /MCP servers/);
      await api.chat.testReceive({ type: 'approvalResponse', reqId: card.reqId, decision: 'deny' }); await pe;
      await api.mcp.revokeRepoConsent();
    } finally {
      await api.mcp.resetAlwaysAllow();
      await vscode.workspace.fs.delete(wsFile);
      await c.update('mcp.servers', undefined, vscode.ConfigurationTarget.Global);
      api.mcp.reload(); await api.mcp.ready();
    }
  });

  test('git help: commit message into the SCM box (secrets left out, recent style, draft kept), review in chat with file links, PR description to a file', async function () {
    this.timeout(90000);
    const cp = await import('child_process');
    const root = vscode.workspace.workspaceFolders![0].uri;
    const cwd = root.fsPath;
    const g = (...a: string[]) => cp.execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
    g('add', '-A'); g('commit', '-q', '-m', 'chore: baseline');
    g('checkout', '-q', '-b', 'feature/git-help');
    const gitApi = (await vscode.extensions.getExtension('vscode.git')!.activate()).getAPI(1);
    const repo = await until(() => gitApi.repositories.find((r: { rootUri: vscode.Uri }) => r.rootUri.fsPath === cwd), 30000);
    const w = (p: string, t: string) => vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, p), Buffer.from(t));
    await w('gitdemo.ts', 'export const a = 1;\nexport const b = 2;\n');
    await w('.env', 'SHOULD_NOT_LEAK=1\n');
    g('add', 'gitdemo.ts', '.env');
    await withMock('mock-text', async (xai) => {
      const reqs = async () => (await (await fetch(xai + '/requests')).json()) as unknown[];
      // 1) commit message (structured output) → SCM input box; user draft passed as a hint.
      repo.inputBox.value = 'add demo';
      await rreply(xai, { text: JSON.stringify({ subject: 'feat: add git demo constants', body: ['export a and b'] }) });
      const n0 = (await reqs()).length;
      const msg = await vscode.commands.executeCommand('vsgrok.generateCommitMessage', { rootUri: root });
      assert.strictEqual(msg, 'feat: add git demo constants\n\n- export a and b');
      assert.strictEqual(repo.inputBox.value, msg);
      const body = JSON.stringify((await reqs()).slice(n0));
      assert.match(body, /gitdemo\.ts/); assert.match(body, /chore: baseline/); assert.match(body, /add demo/); assert.match(body, /commit_message/);
      assert.doesNotMatch(body, /SHOULD_NOT_LEAK/); assert.match(body, /never sent\): \.env/);
      g('commit', '-q', '-m', 'feat: demo');
      // FM7: a repo-local filter driver must not run during working-tree diffs.
      const marker = path.join(require('os').tmpdir(), `vsgrok-filter-ran-${Date.now()}`);
      g('config', 'filter.evil.clean', `touch ${marker}; cat`); g('config', 'diff.evil.textconv', `touch ${marker}; cat`);
      await w('.gitattributes', 'gitdemo.ts filter=evil diff=evil\n');
      // 2) review: unstaged edit + untracked file + secret change.
      await w('gitdemo.ts', 'export const a = 1;\nexport const b = 3;\n');
      await w('newfile.ts', 'export const fresh = true;\n');
      await w('.env', 'SHOULD_NOT_LEAK=2\n');
      await api.chat.testReceive({ type: 'clearChat' }); await idle();
      await rreply(xai, { text: '**medium** — [gitdemo.ts:2](gitdemo.ts#L2) changed b.' });
      const n1 = (await reqs()).length; const u0 = posts('userMessage').length;
      assert.strictEqual(await vscode.commands.executeCommand('vsgrok.reviewChanges', { rootUri: root }), true);
      await idle();
      assert.strictEqual(posts('userMessage')[u0].text, 'Review my uncommitted changes');
      const rb = JSON.stringify((await reqs()).slice(n1));
      assert.match(rb, /export const b = 3/); assert.match(rb, /newfile\.ts/); assert.match(rb, /#L42/); assert.doesNotMatch(rb, /SHOULD_NOT_LEAK/);
      assert.strictEqual(require('fs').existsSync(marker), false, 'filter/textconv driver did not run');
      assert.strictEqual(await api.chat.openFileLink('gitdemo.ts#L2'), true);
      const ed = vscode.window.activeTextEditor!;
      assert.ok(ed.document.uri.path.endsWith('/gitdemo.ts')); assert.strictEqual(ed.selection.start.line, 1);
      assert.strictEqual(await api.chat.openFileLink('.env'), false);
      assert.strictEqual(await api.chat.openFileLink('../outside.ts#L1'), false);
      // 3) PR description vs the base branch (merge-base with master/main), written to a .md file.
      await rreply(xai, { text: '```markdown\n# Add git demo\n\n## Summary\nDemo.\n```' });
      const n2 = (await reqs()).length;
      const target = vscode.Uri.joinPath(root, 'PR_DESCRIPTION.md');
      const md = await vscode.commands.executeCommand('vsgrok.draftPrDescription', { rootUri: root, target });
      assert.strictEqual(md, '# Add git demo\n\n## Summary\nDemo.\n');
      assert.strictEqual(Buffer.from(await vscode.workspace.fs.readFile(target)).toString(), md);
      const pb = JSON.stringify((await reqs()).slice(n2));
      assert.match(pb, /feature\/git-help/); assert.match(pb, /feat: demo/); assert.doesNotMatch(pb, /SHOULD_NOT_LEAK/);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
  });

  test('terminal helper: failed command shows the status bar item (no notification); click sends command, exit code and output tail with agent on; success hides; setting turns it off', async () => {
    const th = api.terminalHelper;
    th.clear();
    th.onEnd({ commandLine: 'npm run build', exitCode: 2, cwd: '/w', output: '\x1b[31merror TS2304\x1b[0m: Cannot find name foo\n' });
    assert.strictEqual(th.visible, true);
    th.onEnd({ commandLine: 'ls', exitCode: 0, output: '' }); assert.strictEqual(th.visible, false, 'a later success (any terminal) hides it');
    th.onEnd({ commandLine: 'sleep 9', exitCode: 130, output: '' }); assert.strictEqual(th.visible, false, 'Ctrl+C is ignored');
    th.onEnd({ commandLine: 'npm run build', exitCode: 2, cwd: '/w', output: 'error TS2304: Cannot find name foo\n' });
    await withMock('mock-text', async (xai) => {
      await api.chat.testReceive({ type: 'clearChat' }); await idle();
      await api.chat.testReceive({ type: 'setAgent', enabled: false });
      await rreply(xai, { text: 'foo is undefined; import it.' });
      const n0 = (await (await fetch(xai + '/requests')).json() as unknown[]).length; const u0 = posts('userMessage').length;
      assert.strictEqual(await vscode.commands.executeCommand('vsgrok.askAboutTerminalFailure'), true);
      await idle();
      assert.strictEqual(th.visible, false);
      assert.strictEqual(posts('userMessage')[u0].text, 'Why did `npm run build` fail (exit 2)?');
      assert.strictEqual(api.chat['agentMode'], true);
      const reqs = (await (await fetch(xai + '/requests')).json() as unknown[]).slice(n0);
      const body = JSON.stringify(reqs);
      assert.match(body, /Exit code: 2/); assert.match(body, /error TS2304: Cannot find name foo/); assert.doesNotMatch(body, /\\u001b\[31m/);
      assert.match(body, /run_command/);
    });
    assert.strictEqual(await vscode.commands.executeCommand('vsgrok.askAboutTerminalFailure'), false);
    const c = vscode.workspace.getConfiguration('vsgrok');
    await c.update('terminalHelper.enabled', false, vscode.ConfigurationTarget.Global);
    try { th.onEnd({ commandLine: 'make', exitCode: 1, output: '' }); assert.strictEqual(th.visible, false); }
    finally { await c.update('terminalHelper.enabled', undefined, vscode.ConfigurationTarget.Global); }
  });

  test('terminal helper: real shell integration (skipped when the shell does not report it)', async function () {
    this.timeout(40000);
    const th = api.terminalHelper; th.clear();
    const term = vscode.window.createTerminal({ name: 'vsgrok-th', shellPath: '/bin/bash' });
    try {
      const si = await Promise.race([
        new Promise<vscode.TerminalShellIntegration>(r => { const d = vscode.window.onDidChangeTerminalShellIntegration(e => { if (e.terminal === term) { d.dispose(); r(e.shellIntegration); } }); }),
        sleep(15000).then(() => undefined),
      ]);
      if (!si) { this.skip(); return; }
      si.executeCommand('echo vsgrok-oops-output; exit_code_test() { return 3; }; exit_code_test');
      await until(() => th.visible, 15000);
      assert.strictEqual(th.lastFailure.exitCode, 3);
      assert.match(th.lastFailure.output, /vsgrok-oops-output/);
    } finally { term.dispose(); th.clear(); }
  });
});
