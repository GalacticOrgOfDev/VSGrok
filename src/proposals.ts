// Proposed edits: approved or denied on an in-chat card (View diff opens vscode.diff on a vsgrok-proposed: doc); applied only after Approve.
import * as vscode from 'vscode';
import { sensitivePath } from './agent/planCore';
import { trackBefore } from './agent/taskTracker';
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
  // Free a virtual diff's contents when its editor closes.
  ctx.subscriptions.push(vscode.workspace.onDidCloseTextDocument((d) => {
    if (d.uri.scheme !== SCHEME) { return; }
    const m = /^(?:old|new)=(.+)$/.exec(d.uri.query); if (m) { dropKey(decodeURIComponent(m[1])); }
  }));
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
  const accepted = await requestApproval({ kind: 'edit', path: rel, reason, isNew: !exists, added, removed, ...(sensitivePath(vscode.workspace.asRelativePath(target, false)) ? { warn: sensitivePath(vscode.workspace.asRelativePath(target, false)) } : {}) }, { signal, onViewDiff: showDiff });
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
  await trackBefore(target);
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

/** Open a read-only diff of two in-memory texts (plan cards' View diff). Entries are keyed so repeat clicks reuse them. */
const virtualKeys: string[] = []; // LRU of keys, newest last
export const MAX_VIRTUAL_DIFFS = 20;
const keyRel = new Map<string, string>();
const vUris = (key: string, rel: string) => ({
  left: vscode.Uri.from({ scheme: SCHEME, path: '/' + rel, query: `old=${encodeURIComponent(key)}` }),
  right: vscode.Uri.from({ scheme: SCHEME, path: '/' + rel, query: `new=${encodeURIComponent(key)}` }),
});
function dropKey(key: string) {
  const r = keyRel.get(key); if (r === undefined) { return; }
  const { left, right } = vUris(key, r); provider.contents.delete(left.toString()); provider.contents.delete(right.toString());
  keyRel.delete(key); const i = virtualKeys.indexOf(key); if (i >= 0) { virtualKeys.splice(i, 1); }
}
export async function showVirtualDiff(rel: string, oldText: string, newText: string, op = 'modify', key = `v${++counter}`) {
  if (keyRel.has(key) && keyRel.get(key) !== rel) { dropKey(key); }
  const { left, right } = vUris(key, rel);
  provider.contents.set(left.toString(), oldText);
  provider.contents.set(right.toString(), newText);
  keyRel.set(key, rel);
  const i = virtualKeys.indexOf(key); if (i >= 0) { virtualKeys.splice(i, 1); } virtualKeys.push(key);
  while (virtualKeys.length > MAX_VIRTUAL_DIFFS) { dropKey(virtualKeys[0]); }
  await vscode.commands.executeCommand('vscode.diff', left, right, `${rel} ↔ Grok plan (${op})`, { preview: true, preserveFocus: true });
}
/** Drop every virtual diff whose key is `prefix` or starts with `prefix-` (called when a plan card is decided). */
export function disposeVirtualDiffs(prefix: string) { for (const k of [...keyRel.keys()]) { if (k === prefix || k.startsWith(prefix + '-')) { dropKey(k); } } }
/** Number of stored in-memory documents (tests). */
export function virtualDiffCount(): number { return provider.contents.size; }
