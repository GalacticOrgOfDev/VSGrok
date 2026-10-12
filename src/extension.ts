// VSGrok entry point.
import * as vscode from 'vscode';
import { ChatViewProvider } from './chat';
import { Updater } from './update';
import { initDiagnostics, diagnosticsReport } from './diagnostics';
import { workspaceIndex } from './index/workspaceIndex';
import { executeTool } from './agent/tools';
import { runEditorAction } from './editorActions';
import { virtualDiffCount } from './proposals';
import { GrokInlineProvider } from './inline';
import { registerInlineEdit } from './inlineEdit';
import { McpManager, setMcpManager, WORKSPACE_FILE } from './mcp';
import { registerProposals } from './proposals';
import { initStatus, refreshStatus } from './status';
import { SECRET_KEY, DEFAULT_MODEL, cfg } from './config';

export const XAI_CONSOLE_KEYS_URL = 'https://console.x.ai/team/default/api-keys';
import { buildCommandPrompt, CodeAction, fixDiagnostic, GrokQuickFixProvider } from './commands';
import { generateCommitMessage, reviewChanges, draftPrDescription } from './git';

export function activate(context: vscode.ExtensionContext) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let testApi: any;
  initDiagnostics(context);
  initStatus(context);
  registerProposals(context);
  const chat = new ChatViewProvider(context);
  context.subscriptions.push({ dispose: () => chat.dispose() });
  const reg = (id: string, fn: (...a: never[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, new GrokInlineProvider(context)),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new GrokQuickFixProvider(), { providedCodeActionKinds: GrokQuickFixProvider.kinds }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('vsgrok')) { refreshStatus(); chat.pushSettings(); }
      if (e.affectsConfiguration('vsgrok.baseUrl')) { void chat.pushModels(); }
    }),
    context.secrets.onDidChange(e => { if (e.key === SECRET_KEY) { void chat.pushKeyState(); void chat.pushModels(true); } }),
  );

  workspaceIndex.start(false);
  context.subscriptions.push(workspaceIndex);
  reg('vsgrok.copyDiagnostics', async () => {
    await vscode.env.clipboard.writeText(await diagnosticsReport(context));
    vscode.window.setStatusBarMessage('$(check) VSGrok diagnostics copied to clipboard (no API key or file contents).', 4000);
  });
  reg('vsgrok.reindex', async () => { await workspaceIndex.rebuild(); vscode.window.setStatusBarMessage(`$(check) VSGrok indexed ${workspaceIndex.size} files`, 4000); });
  reg('vsgrok.explainThis', () => runEditorAction(chat, 'explain'));
  reg('vsgrok.writeTestsForThis', () => runEditorAction(chat, 'tests'));
  reg('vsgrok.fixProblemsHere', () => runEditorAction(chat, 'fix'));
  reg('vsgrok.refactor', (instruction?: string) => runEditorAction(chat, 'refactor', typeof instruction === 'string' ? instruction : undefined));
  const inlineEdit = registerInlineEdit(context);
  const mcpManager = new McpManager(context);
  setMcpManager(mcpManager);
  context.subscriptions.push(mcpManager, { dispose: () => setMcpManager(undefined) });
  void mcpManager.ready();
  reg('vsgrok.mcpServers', async () => {
    await mcpManager.ready();
    const st = mcpManager.status();
    type It = vscode.QuickPickItem & { act?: string };
    const icon: Record<string, string> = { ready: '$(pass)', error: '$(error)', connecting: '$(loading~spin)', disabled: '$(circle-slash)' };
    const items: It[] = st.servers.map(s => ({ label: `${icon[s.status]} ${s.name}`, description: `${s.type} · ${s.source}${s.status === 'ready' ? ` · ${s.tools.length} tools` : ''}`, detail: s.status === 'error' ? s.error : s.tools.join(', ').slice(0, 300) || undefined }));
    if (!items.length) { items.push({ label: 'No MCP servers configured', description: 'vsgrok.mcp.servers or ' + WORKSPACE_FILE }); }
    for (const e of st.errors) { items.push({ label: `$(warning) ${e}` }); }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(refresh) Reconnect all', act: 'reload' }, { label: '$(settings-gear) Edit user MCP servers', act: 'settings' }, { label: `$(json) Edit ${WORKSPACE_FILE}`, act: 'ws' }, { label: '$(trash) Forget all "Always allow" choices', act: 'reset' });
    const pick = await vscode.window.showQuickPick(items, { title: 'VSGrok MCP servers', placeHolder: 'Tools from ready servers are offered to Grok when Agent is on; each call asks first.' });
    if (pick?.act === 'reload') { mcpManager.reload(); }
    if (pick?.act === 'settings') { await vscode.commands.executeCommand('workbench.action.openSettingsJson', { revealSetting: { key: 'vsgrok.mcp.servers' } }); }
    if (pick?.act === 'reset') { await mcpManager.resetAlwaysAllow(); vscode.window.setStatusBarMessage('$(check) MCP "Always allow" choices cleared', 4000); }
    if (pick?.act === 'ws') {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri; if (!root) { return; }
      const f = vscode.Uri.joinPath(root, WORKSPACE_FILE);
      try { await vscode.workspace.fs.stat(f); } catch { await vscode.workspace.fs.writeFile(f, Buffer.from(JSON.stringify({ servers: { example: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], disabled: true } } }, null, 2) + '\n')); }
      await vscode.window.showTextDocument(f);
    }
  });
  const updater = new Updater(context, chat);
  if ((__VSGROK_TEST__ && process.env.VSGROK_TEST === '1')) {
    testApi = { chat, updater, workspaceIndex, inlineEdit, mcp: mcpManager };
    reg('vsgrok.__testVirtualDiffCount', () => virtualDiffCount());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reg('vsgrok.__testRunTool', async (name: string, args: any) => {
      const cts = new vscode.CancellationTokenSource();
      try { return await executeTool(name, args, cts.token); } finally { cts.dispose(); }
    });
  }
  reg('vsgrok.checkForUpdates', () => updater.check(true));
  // First check when the user opens the chat panel (card shows right there); also once shortly after startup.
  chat.onViewReady = () => { void updater.autoCheck(); };
  setTimeout(() => { void updater.autoCheck(); }, 5000);

  reg('vsgrok.setApiKey', async () => {
    const key = await vscode.window.showInputBox({ prompt: 'Enter your xAI API key (stored in VS Code SecretStorage)', password: true, ignoreFocusOut: true });
    if (key?.trim()) { await context.secrets.store(SECRET_KEY, key.trim()); void vscode.window.showInformationMessage('xAI API key saved.'); }
  });
  reg('vsgrok.signIn', async () => {
    const pick = await vscode.window.showInformationMessage(
      'VSGrok uses an xAI API key from the xAI Console (sign in there with your X or xAI account, then create a key). xAI\'s SuperGrok / X Premium sign-in is limited to partner apps xAI has approved and is not available to VSGrok; API usage is billed separately by xAI.',
      { modal: true }, 'Open xAI Console', 'I have a key');
    if (pick === 'Open xAI Console') { await vscode.env.openExternal(vscode.Uri.parse(XAI_CONSOLE_KEYS_URL)); }
    if (pick) { await vscode.commands.executeCommand('vsgrok.setApiKey'); }
  });
  reg('vsgrok.selectModel', async () => {
    const current = cfg().get<string>('model') || DEFAULT_MODEL;
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { id?: string }>();
    qp.title = 'Select Grok model'; qp.placeholder = 'Loading models from xAI…'; qp.busy = true; qp.show();
    const r = await chat.getModels();
    const items: (vscode.QuickPickItem & { id?: string })[] = r.models.map(m => ({
      id: m.id, label: (m.id === current ? '$(check) ' : '') + m.id,
      description: [m.reasoning ? 'reasoning' : '', m.contextLength ? `${Math.round(m.contextLength / 1000)}k ctx` : ''].filter(Boolean).join(' · '),
    }));
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(refresh) Refresh list from xAI', id: '__refresh' }, { label: '$(edit) Enter a model id…', id: '__custom' });
    qp.items = items; qp.busy = false;
    qp.placeholder = r.source === 'fallback' ? `Built-in list (${r.error ?? 'offline'}). Current: ${current}` : `Current: ${current}`;
    const chosen = await new Promise<string | undefined>(res => { qp.onDidAccept(() => { res(qp.selectedItems[0]?.id); qp.hide(); }); qp.onDidHide(() => res(undefined)); });
    qp.dispose();
    let id = chosen;
    if (id === '__refresh') { await chat.pushModels(true); await vscode.commands.executeCommand('vsgrok.selectModel'); return; }
    if (id === '__custom') { id = await vscode.window.showInputBox({ prompt: 'xAI model id', value: current, validateInput: v => /^[\w.:-]{1,80}$/.test(v.trim()) ? undefined : 'Invalid model id' }); }
    if (id?.trim()) { await cfg().update('model', id.trim(), vscode.ConfigurationTarget.Global); }
  });
  reg('vsgrok.clearApiKey', async () => { await context.secrets.delete(SECRET_KEY); void vscode.window.showInformationMessage('xAI API key removed.'); });
  reg('vsgrok.query', async () => {
    const q = await vscode.window.showInputBox({ prompt: 'Ask Grok…', ignoreFocusOut: true });
    if (q?.trim()) { await chat.injectQuery(q.trim()); }
  });
  reg('vsgrok.agentTask', async () => {
    const q = await vscode.window.showInputBox({ prompt: 'Agent task for Grok (it will ask before editing or running anything)', ignoreFocusOut: true });
    if (q?.trim()) { await chat.injectQuery(q.trim(), { agent: true }); }
  });
  reg('vsgrok.runTask', async (goal?: unknown) => {
    const q = typeof goal === 'string' ? goal : await vscode.window.showInputBox({ prompt: 'Task for Grok to run on its own (plan, edit, test, fix). Risky steps still ask in the chat.', ignoreFocusOut: true });
    if (q?.trim()) { await chat.runTask(q.trim()); }
  });
  reg('vsgrok.showHistory', async () => { await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`); chat.openHistoryPanel(); });
  reg('vsgrok.exportChat', () => chat.exportChat());
  reg('vsgrok.newChatTab', async () => { await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`); await chat.newTab(); });
  reg('vsgrok.stop', () => chat.stop());
  reg('vsgrok.toggleInline', async () => {
    const c = cfg();
    const next = !c.get<boolean>('inlineCompletions.enabled');
    await c.update('inlineCompletions.enabled', next, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`Grok inline completions ${next ? 'enabled' : 'disabled'}.`);
  });
  reg('vsgrok.addFileToChat', async (uri?: vscode.Uri) => {
    const u = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (u) { await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`); await chat.addFileContext(u); }
  });
  reg('vsgrok.generateCommitMessage', (arg?: { rootUri?: vscode.Uri }) => generateCommitMessage(context, arg));
  reg('vsgrok.reviewChanges', (arg?: { rootUri?: vscode.Uri }) => reviewChanges(chat, arg));
  reg('vsgrok.draftPrDescription', (arg?: { rootUri?: vscode.Uri; target?: 'clipboard' | vscode.Uri }) => draftPrDescription(context, arg));
  reg('vsgrok.fixDiagnostic', (uri: vscode.Uri, range: vscode.Range, message: string) => fixDiagnostic(context, uri, range, message));

  const code = (id: string, action: CodeAction) => reg(id, async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) { void vscode.window.showWarningMessage('No active editor.'); return; }
    const sel = ed.document.getText(ed.selection);
    if (!sel.trim()) { void vscode.window.showWarningMessage('Select some code first.'); return; }
    await chat.injectQuery(buildCommandPrompt(action, sel, ed.document.languageId, vscode.workspace.asRelativePath(ed.document.uri)));
  });
  code('vsgrok.explainCode', 'explain');
  code('vsgrok.fixCode', 'fix');
  reg('vsgrok.addComments', () => runEditorAction(chat, 'comment'));
  code('vsgrok.writeTests', 'test');
  return testApi;
}

export function deactivate() { /* disposables handled by context */ }
