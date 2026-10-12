// VSGrok entry point.
import * as vscode from 'vscode';
import { ChatViewProvider } from './chat';
import { Updater } from './update';
import { initDiagnostics, diagnosticsReport } from './diagnostics';
import { workspaceIndex } from './index/workspaceIndex';
import { executeTool } from './agent/tools';
import { GrokInlineProvider } from './inline';
import { registerProposals } from './proposals';
import { initStatus, refreshStatus } from './status';
import { SECRET_KEY, DEFAULT_MODEL, cfg } from './config';

export const XAI_CONSOLE_KEYS_URL = 'https://console.x.ai/team/default/api-keys';
import { buildCommandPrompt, CodeAction, generateCommitMessage, fixDiagnostic, GrokQuickFixProvider } from './commands';

export function activate(context: vscode.ExtensionContext) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let testApi: any;
  initDiagnostics(context);
  initStatus(context);
  registerProposals(context);
  const chat = new ChatViewProvider(context);
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
  const updater = new Updater(context, chat);
  if ((__VSGROK_TEST__ && process.env.VSGROK_TEST === '1')) {
    testApi = { chat, updater, workspaceIndex };
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
  code('vsgrok.addComments', 'comment');
  code('vsgrok.writeTests', 'test');
  return testApi;
}

export function deactivate() { /* disposables handled by context */ }
