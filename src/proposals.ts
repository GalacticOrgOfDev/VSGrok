// Proposed edits: approved or denied on an in-chat card (View diff opens vscode.diff on a vsgrok-proposed: doc); applied only after Approve.
import * as vscode from 'vscode';
import { requestApproval, lineDelta } from './agent/approvals';

export const SCHEME = 'vsgrok-proposed';

class ProposalProvider implements vscode.TextDocumentContentProvider {
  readonly contents = new Map<string, string>();
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  provideTextDocumentContent(uri: vscode.Uri): string { return this.contents.get(uri.toString()) ?? ''; }
}

const provider = new ProposalProvider();
let counter = 0;

export function registerProposals(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider));
}

/**
 * Show current file vs proposed content and ask the user. Returns true only if the user accepted
 * and the WorkspaceEdit applied. Nothing is written otherwise.
 */
export async function proposeEdit(target: vscode.Uri, newContent: string, reason = 'Grok proposed edit', signal?: AbortSignal): Promise<{ ok: boolean; msg: string }> {
  let exists = true;
  try { await vscode.workspace.fs.stat(target); } catch { exists = false; }
  const id = ++counter;
  const proposed = vscode.Uri.from({ scheme: SCHEME, path: target.path, query: `id=${id}` });
  provider.contents.set(proposed.toString(), newContent);
  const left = exists ? target : vscode.Uri.from({ scheme: SCHEME, path: target.path, query: `empty=${id}` });
  if (!exists) { provider.contents.set(left.toString(), ''); }
  const rel = vscode.workspace.asRelativePath(target);
  const title = `${rel} ↔ Grok proposal${exists ? '' : ' (new file)'}`;
  const showDiff = async () => { await vscode.commands.executeCommand('vscode.diff', left, proposed, title, { preview: true, preserveFocus: true }); };
  let oldText = '';
  if (exists) { try { oldText = (await vscode.workspace.openTextDocument(target)).getText(); } catch { /* binary/unreadable */ } }
  const { added, removed } = lineDelta(oldText, newContent);
  const accepted = await requestApproval({ kind: 'edit', path: rel, reason, isNew: !exists, added, removed }, { signal, onViewDiff: showDiff });
  const choice = accepted ? 'Accept' : 'Reject';
  provider.contents.delete(proposed.toString());
  provider.contents.delete(left.toString());
  if (choice !== 'Accept') { return { ok: false, msg: `Rejected edit to ${rel}` }; }
  const edit = new vscode.WorkspaceEdit();
  if (!exists) {
    edit.createFile(target, { ignoreIfExists: true, contents: Buffer.from(newContent, 'utf8') });
  } else {
    const doc = await vscode.workspace.openTextDocument(target);
    edit.replace(target, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), newContent);
  }
  const applied = await vscode.workspace.applyEdit(edit);
  if (applied && exists) { await (await vscode.workspace.openTextDocument(target)).save(); }
  return applied ? { ok: true, msg: `Applied edit to ${rel}` } : { ok: false, msg: `Failed to apply edit to ${rel}` };
}

/** Replace only a range (e.g. a selection) with new text, via the same diff + accept flow. */
export async function proposeRangeEdit(doc: vscode.TextDocument, range: vscode.Range, replacement: string, reason?: string, signal?: AbortSignal) {
  const full = doc.getText();
  const next = full.slice(0, doc.offsetAt(range.start)) + replacement + full.slice(doc.offsetAt(range.end));
  return proposeEdit(doc.uri, next, reason, signal);
}
