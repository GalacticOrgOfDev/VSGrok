// VSGrok entry point.
import * as vscode from 'vscode';
import { ChatViewProvider } from './chat';
import { GrokInlineProvider } from './inline';
import { registerProposals } from './proposals';
import { initStatus, refreshStatus } from './status';
import { SECRET_KEY, cfg } from './config';
import { buildCommandPrompt, CodeAction, generateCommitMessage, fixDiagnostic, GrokQuickFixProvider } from './commands';

export function activate(context: vscode.ExtensionContext) {
  initStatus(context);
  registerProposals(context);
  const chat = new ChatViewProvider(context);
  const reg = (id: string, fn: (...a: never[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, new GrokInlineProvider(context)),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new GrokQuickFixProvider(), { providedCodeActionKinds: GrokQuickFixProvider.kinds }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('vsgrok')) { refreshStatus(); chat.pushSettings(); } }),
  );

  reg('vsgrok.setApiKey', async () => {
    const key = await vscode.window.showInputBox({ prompt: 'Enter your xAI API key (stored in VS Code SecretStorage)', password: true, ignoreFocusOut: true });
    if (key?.trim()) { await context.secrets.store(SECRET_KEY, key.trim()); void vscode.window.showInformationMessage('xAI API key saved.'); }
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
}

export function deactivate() { /* disposables handled by context */ }
