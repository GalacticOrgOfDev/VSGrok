import { reportError } from './errors';
import * as vscode from 'vscode';
import { streamChat } from './xai/client';
import { requestOptions, apiMode } from './config';
import { streamResponse } from './xai/responses';
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
export async function oneShot(ctx: vscode.ExtensionContext, title: string, system: string, user: string, textFormat?: Record<string, unknown>, location: vscode.ProgressLocation = vscode.ProgressLocation.Notification): Promise<string | undefined> {
  return vscode.window.withProgress({ location, title, cancellable: location === vscode.ProgressLocation.Notification }, async (_p, token) => {
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
