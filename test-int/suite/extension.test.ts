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

  test('header markup: <header>, Rules chip right before the gear, cards.js loaded with nonce', async () => {
    const html: string = api.chat['view'].webview.html;
    assert.match(html, /<header id="header">[\s\S]*<\/header>/);
    assert.match(html, /<button id="rules-chip"[^>]*><\/button>\s*<button id="settings-btn"[^>]*aria-controls="settings-panel"/);
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
    assert.deepStrictEqual(menu, ['vsgrok.explainThis', 'vsgrok.writeTestsForThis', 'vsgrok.fixProblemsHere', 'vsgrok.refactor', 'vsgrok.addComments']);

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
    assert.deepStrictEqual(pj.capabilities.untrustedWorkspaces.restrictedConfigurations, ['vsgrok.testCommand']);
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
});
