// Proposed edits: shown via a vsgrok-proposed: virtual document in vscode.diff; applied only after the user accepts.
import * as vscode from 'vscode';

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
export async function proposeEdit(target: vscode.Uri, newContent: string, reason = 'Grok proposed edit'): Promise<{ ok: boolean; msg: string }> {
  let exists = true;
  try { await vscode.workspace.fs.stat(target); } catch { exists = false; }
  const id = ++counter;
  const proposed = vscode.Uri.from({ scheme: SCHEME, path: target.path, query: `id=${id}` });
  provider.contents.set(proposed.toString(), newContent);
  const left = exists ? target : vscode.Uri.from({ scheme: SCHEME, path: target.path, query: `empty=${id}` });
  if (!exists) { provider.contents.set(left.toString(), ''); }
  const rel = vscode.workspace.asRelativePath(target);
  await vscode.commands.executeCommand('vscode.diff', left, proposed, `${rel} ↔ Grok proposal${exists ? '' : ' (new file)'}`, { preview: true });
  const choice = await vscode.window.showInformationMessage(`${reason}: ${rel}`, { modal: false }, 'Accept', 'Reject');
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
export async function proposeRangeEdit(doc: vscode.TextDocument, range: vscode.Range, replacement: string, reason?: string) {
  const full = doc.getText();
  const next = full.slice(0, doc.offsetAt(range.start)) + replacement + full.slice(doc.offsetAt(range.end));
  return proposeEdit(doc.uri, next, reason);
}
