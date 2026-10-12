import { reportError } from './errors';
import * as vscode from 'vscode';
import { streamChat } from './xai/client';
import { requestOptions, apiMode } from './config';
import { streamResponse } from './xai/responses';
import { COMMIT_FORMAT, renderCommitMessage } from './xai/commit';
import { stripFences } from './xai/sse';
import { proposeRangeEdit } from './proposals';
import { setBusy } from './status';

export type CodeAction = 'explain' | 'fix' | 'comment' | 'test';

export function buildCommandPrompt(action: CodeAction, code: string, language: string, path?: string): string {
  const where = path ? ` from \`${path}\`` : '';
  const fence = `\`\`\`${language}\n${code}\n\`\`\``;
  switch (action) {
    case 'explain': return `Explain this ${language} code${where}: what it does, edge cases, and possible improvements.\n\n${fence}`;
    case 'fix': return `Find and fix bugs or anti-patterns in this ${language} code${where}. Briefly list the problems, then give the corrected code in one fenced block.\n\n${fence}`;
    case 'comment': return `Add clear, useful comments to this ${language} code${where}. Return the full commented code in one fenced block.\n\n${fence}`;
    case 'test': return `Write thorough unit tests for this ${language} code${where} using the most common test framework for ${language}. Cover edge cases.\n\n${fence}`;
  }
}

/** Ask Grok for a one-shot answer with progress + cancel; return text or undefined. Uses the Responses API unless vsgrok.api = "chat". */
async function oneShot(ctx: vscode.ExtensionContext, title: string, system: string, user: string, textFormat?: Record<string, unknown>): Promise<string | undefined> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_p, token) => {
    const abort = new AbortController();
    const sub = token.onCancellationRequested(() => abort.abort());
    setBusy(true);
    try {
      const o = await requestOptions(ctx, { signal: abort.signal, temperature: 0.2 });
      if (apiMode() === 'chat') {
        const res = await streamChat([{ role: 'system', content: system }, { role: 'user', content: user }], o);
        return res.content;
      }
      const res = await streamResponse({
        ...o, input: [{ role: 'system', content: system }, { role: 'user', content: user }],
        tools: undefined, maxOutputTokens: o.maxTokens, store: false, textFormat,
      });
      return res.content;
    } catch (e) {
      reportError(e, title);
      return undefined;
    } finally { sub.dispose(); setBusy(false); }
  });
}

interface GitRepo { rootUri: vscode.Uri; diff(cached?: boolean): Promise<string>; inputBox: { value: string } }

export async function generateCommitMessage(ctx: vscode.ExtensionContext, arg?: { rootUri?: vscode.Uri }) {
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext) { void vscode.window.showErrorMessage('The built-in Git extension is not available.'); return; }
  const api = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
  const repos: GitRepo[] = api.repositories;
  const repo = (arg?.rootUri && repos.find(r => r.rootUri.toString() === arg.rootUri!.toString())) || repos[0];
  if (!repo) { void vscode.window.showWarningMessage('No Git repository found.'); return; }
  let diff = await repo.diff(true);
  if (!diff.trim()) { void vscode.window.showWarningMessage('No staged changes. Stage files first.'); return; }
  if (diff.length > 400000) { diff = diff.slice(0, 400000) + '\n…[diff truncated]'; }
  const out = await oneShot(ctx, 'Grok: writing commit message…',
    apiMode() === 'chat'
      ? 'Write a git commit message for the staged diff. Conventional style: a concise imperative subject line under 72 chars, blank line, then short bullet body if useful. Output only the message, no fences.'
      : 'Write a git commit message for the staged diff. subject: conventional-commit style, imperative, under 72 chars. body: short bullet points only if they add information.',
    diff, apiMode() === 'chat' ? undefined : COMMIT_FORMAT);
  if (out) { repo.inputBox.value = renderCommitMessage(out); }
}

export async function fixDiagnostic(ctx: vscode.ExtensionContext, uri: vscode.Uri, range: vscode.Range, message: string) {
  const doc = await vscode.workspace.openTextDocument(uri);
  const start = Math.max(0, range.start.line - 3);
  const end = Math.min(doc.lineCount - 1, range.end.line + 3);
  const span = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
  const code = doc.getText(span);
  const out = await oneShot(ctx, 'Grok: fixing problem…',
    'You fix a code problem. Return ONLY the corrected replacement for the given lines, in one fenced code block, preserving indentation. Change only what is needed.',
    `File: ${vscode.workspace.asRelativePath(uri)} (${doc.languageId})\nProblem on line ${range.start.line + 1}: ${message}\n\nLines ${start + 1}-${end + 1}:\n\`\`\`${doc.languageId}\n${code}\n\`\`\``);
  if (!out) { return; }
  const r = await proposeRangeEdit(doc, span, stripFences(out), 'Grok fix');
  if (!r.ok) { void vscode.window.setStatusBarMessage(`VSGrok: ${r.msg}`, 4000); }
}

export class GrokQuickFixProvider implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];
  provideCodeActions(doc: vscode.TextDocument, _r: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    return context.diagnostics.slice(0, 3).map(d => {
      const a = new vscode.CodeAction(`Fix with Grok: ${d.message.slice(0, 60)}`, vscode.CodeActionKind.QuickFix);
      a.diagnostics = [d];
      a.command = { command: 'vsgrok.fixDiagnostic', title: 'Fix with Grok', arguments: [doc.uri, d.range, d.message] };
      return a;
    });
  }
}
