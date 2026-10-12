// Multi-file edit plans: one in-chat approval card, atomic WorkspaceEdit, one-click undo.
import * as vscode from 'vscode';
import { requestDecision, ApprovalRequest } from './agent/approvals';
import { validatePlan, selectedIndices, hashBytes, PlanChange, sensitivePath, decodeText } from './agent/planCore';
import { lineDelta } from './agent/approvals';
import { checkReadable, checkWritable } from './security';
import { showVirtualDiff, disposeVirtualDiffs } from './proposals';
import { diag } from './diagnostics';

// Undo = checks (verified immediately before the edit) + file operations with byte snapshots.
type Check = { uri: vscode.Uri; hash: string } | { uri: vscode.Uri; absent: true };
type UndoOp = { kind: 'delete'; uri: vscode.Uri } | { kind: 'write'; uri: vscode.Uri; bytes: Uint8Array; overwrite: boolean } | { kind: 'rename'; from: vscode.Uri; to: vscode.Uri };
interface AppliedPlan { id: string; checks: Check[]; ops: UndoOp[]; paths: string[] }

export const MAX_UNDO_PLANS = 10;
const applied = new Map<string, AppliedPlan>();
let seq = 0;
type PlanListener = (e: { planId: string; paths: string[]; summary?: string }) => void;
let listener: PlanListener | undefined;
export function onPlanApplied(l: PlanListener | undefined) { listener = l; }
let expiredListener: ((planId: string) => void) | undefined;
/** Called when an old plan's undo snapshot is evicted (only the last MAX_UNDO_PLANS are kept). */
export function onPlanUndoExpired(l: ((planId: string) => void) | undefined) { expiredListener = l; }

function root(): vscode.Uri {
  const f = vscode.workspace.workspaceFolders?.[0];
  if (!f) { throw new Error('No workspace folder open.'); }
  return f.uri;
}
async function exists(u: vscode.Uri): Promise<boolean> { try { await vscode.workspace.fs.stat(u); return true; } catch { return false; } }
const openDoc = (u: vscode.Uri) => vscode.workspace.textDocuments.find(d => d.uri.toString() === u.toString());
const rel = (u: vscode.Uri) => vscode.workspace.asRelativePath(u, false);

interface Prepared { c: PlanChange; uri: vscode.Uri; newUri?: vscode.Uri; oldBytes?: Uint8Array; old: string; next: string; binary?: boolean; refused?: string; warn?: string }

type PlanFileRow = Extract<ApprovalRequest, { kind: 'plan' }>['files'][number];

async function prepare(c: PlanChange, r: vscode.Uri): Promise<Prepared> {
  const uri = vscode.Uri.joinPath(r, c.path);
  const newUri = c.newPath ? vscode.Uri.joinPath(r, c.newPath) : undefined;
  const p: Prepared = { c, uri, newUri, old: '', next: c.content ?? '', warn: sensitivePath(c.path) ?? (c.newPath ? sensitivePath(c.newPath) : undefined) };
  const has = await exists(uri);
  if (c.op === 'create') {
    if (has) { p.refused = 'already exists (use modify)'; return p; }
    const w = await checkWritable(uri); if (!w.ok) { p.refused = w.reason; }
    return p;
  }
  if (!has) { p.refused = 'does not exist'; return p; }
  const chk = await checkReadable(uri); if (!chk.ok) { p.refused = chk.reason; return p; }
  const w = await checkWritable(uri); if (!w.ok) { p.refused = w.reason; return p; }
  if (newUri) {
    if (await exists(newUri)) { p.refused = `${c.newPath} already exists`; return p; }
    const wn = await checkWritable(newUri); if (!wn.ok) { p.refused = `${c.newPath}: ${wn.reason}`; return p; }
  }
  if (openDoc(uri)?.isDirty) { p.refused = 'has unsaved changes in the editor; save or revert it first'; return p; }
  try { p.oldBytes = await vscode.workspace.fs.readFile(uri); } catch (e) { p.refused = `unreadable: ${(e as Error).message}`; return p; }
  const text = decodeText(p.oldBytes);
  if (text === undefined) {
    p.binary = true;
    // Binary / non-UTF-8 files can be deleted or renamed as-is (bytes are kept), never rewritten as text.
    if (c.op === 'modify' || (c.op === 'rename' && c.content !== undefined)) { p.refused = 'binary or non-UTF-8 file; can\'t be edited as text'; return p; }
  } else { p.old = text; }
  if (c.op === 'rename' && c.content === undefined) { p.next = p.old; }
  if (c.op === 'delete') { p.next = ''; }
  return p;
}

/** Tool entry point: validate, show the plan card, apply the approved subset atomically. Returns a message for the agent. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function proposePlan(args: any, signal?: AbortSignal): Promise<string> {
  const { plan, errors, refused: refusedRows } = validatePlan(args);
  const r = root();
  const prepared: Prepared[] = [];
  for (const c of plan.changes) { prepared.push(await prepare(c, r)); }
  const usable = prepared.filter(p => !p.refused);
  if (!usable.length) { return `Plan not shown: ${[...errors, ...prepared.map(p => `${p.c.path}: ${p.refused}`)].join('; ') || 'nothing to do'}`; }

  const files: PlanFileRow[] = usable.map(p => {
    const d = p.binary ? { added: 0, removed: 0 } : lineDelta(p.old, p.next);
    return { path: p.c.path, op: p.c.op, newPath: p.c.newPath, added: d.added, removed: d.removed, ...(p.warn ? { warn: p.warn } : {}) };
  });
  // Refused rows are shown (disabled, with the reason) after the usable ones; their indices are never applied.
  for (const x of refusedRows) { files.push({ path: x.path, op: x.op, newPath: x.newPath, added: 0, removed: 0, refused: x.reason }); }
  for (const p of prepared.filter(x => x.refused)) { files.push({ path: p.c.path, op: p.c.op, newPath: p.c.newPath, added: 0, removed: 0, refused: p.refused }); }
  const diffKey = `plan-${++seq}`;
  let decision;
  try {
    decision = await requestDecision({ kind: 'plan', summary: plan.summary, files }, {
      signal,
      onViewDiff: (i) => {
        const idx = i === undefined ? 0 : i; const p = usable[idx];
        if (p) { void showVirtualDiff(p.c.newPath ?? p.c.path, p.binary ? '(binary file)' : p.old, p.binary ? (p.c.op === 'delete' ? '' : '(binary file)') : p.next, p.c.op, `${diffKey}-${idx}`); }
      },
    });
  } finally { disposeVirtualDiffs(diffKey); }
  const notes = [...errors, ...prepared.filter(p => p.refused).map(p => `${p.c.path}: ${p.refused}`)];
  const chosen = decision.ok ? selectedIndices(usable.length, decision.selected).map(i => usable[i]) : [];
  if (!chosen.length) { return `User denied the plan (${usable.length} files). Nothing was changed.${notes.length ? ' Not offered: ' + notes.join('; ') : ''}`; }
  const res = await applyPrepared(chosen, plan.summary);
  const skipped = usable.filter(p => !chosen.includes(p)).map(p => p.c.path);
  return `${res.msg}${skipped.length ? ` User unchecked: ${skipped.join(', ')}.` : ''}${notes.length ? ` Not offered: ${notes.join('; ')}.` : ''}`;
}

/** Re-check every target right before applying: nothing may have changed since the card was shown. */
async function staleReasons(items: Prepared[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of items) {
    const has = await exists(p.uri);
    if (p.c.op === 'create') { if (has) { out.push(`${p.c.path} was created since the plan was proposed`); } continue; }
    if (!has) { out.push(`${p.c.path} was deleted since the plan was proposed`); continue; }
    if (openDoc(p.uri)?.isDirty) { out.push(`${p.c.path} has unsaved changes`); continue; }
    const now = await vscode.workspace.fs.readFile(p.uri);
    if (hashBytes(now) !== hashBytes(p.oldBytes!)) { out.push(`${p.c.path} changed since the plan was proposed`); continue; }
    if (p.newUri && await exists(p.newUri)) { out.push(`${p.c.newPath} was created since the plan was proposed`); }
  }
  return out;
}

async function verifyChecks(checks: Check[]): Promise<string | undefined> {
  for (const c of checks) {
    const has = await exists(c.uri);
    if ('absent' in c) { if (has) { return `${rel(c.uri)} was re-created since the plan was applied`; } continue; }
    if (!has) { return `${rel(c.uri)} was deleted since the plan was applied`; }
    if (openDoc(c.uri)?.isDirty) { return `${rel(c.uri)} has unsaved changes`; }
    if (hashBytes(await vscode.workspace.fs.readFile(c.uri)) !== c.hash) { return `${rel(c.uri)} changed since the plan was applied`; }
  }
  return undefined;
}

async function applyPrepared(items: Prepared[], summary?: string): Promise<{ ok: boolean; msg: string; planId?: string }> {
  const meta = { label: 'VSGrok plan', needsConfirmation: false };
  const edit = new vscode.WorkspaceEdit();
  const enc = (t: string) => Buffer.from(t, 'utf8');
  for (const p of items) {
    switch (p.c.op) {
      case 'create': edit.createFile(p.uri, { overwrite: false, contents: enc(p.next) }, meta); break;
      case 'modify': {
        const doc = await vscode.workspace.openTextDocument(p.uri);
        edit.replace(p.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), p.next, meta);
        break;
      }
      case 'delete': edit.deleteFile(p.uri, { recursive: false, ignoreIfNotExists: false }, meta); break;
      case 'rename':
        // A real rename keeps the bytes and file mode; content changes are written onto the new path in the same edit.
        edit.renameFile(p.uri, p.newUri!, { overwrite: false }, meta);
        if (p.c.content !== undefined && p.next !== p.old) { edit.createFile(p.newUri!, { overwrite: true, contents: enc(p.next) }, meta); }
        break;
    }
  }
  // H2: verify right before applying (the card may have been open for minutes).
  const stale = await staleReasons(items);
  if (stale.length) { return { ok: false, msg: `Plan not applied: ${stale.join('; ')}. Nothing was changed; propose it again from the current files.` }; }
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) { return { ok: false, msg: 'Applying the plan failed; nothing was changed (the edit is atomic).' + trashHint(items.some(p => p.c.op === 'delete' || p.c.op === 'rename')) }; }
  for (const p of items) {
    if (p.c.op === 'modify') { const d = openDoc(p.uri); if (d?.isDirty) { await d.save(); } }
  }
  // Undo snapshot: hashes of what is on disk now, plus the original bytes.
  const checks: Check[] = []; const ops: UndoOp[] = [];
  const diskHash = async (u: vscode.Uri) => { try { return hashBytes(await vscode.workspace.fs.readFile(u)); } catch { return ''; } };
  for (const p of items) {
    switch (p.c.op) {
      case 'create': checks.push({ uri: p.uri, hash: await diskHash(p.uri) }); ops.push({ kind: 'delete', uri: p.uri }); break;
      case 'modify': checks.push({ uri: p.uri, hash: await diskHash(p.uri) }); ops.push({ kind: 'write', uri: p.uri, bytes: p.oldBytes!, overwrite: true }); break;
      case 'delete': checks.push({ uri: p.uri, absent: true }); ops.push({ kind: 'write', uri: p.uri, bytes: p.oldBytes!, overwrite: false }); break;
      case 'rename':
        checks.push({ uri: p.newUri!, hash: await diskHash(p.newUri!) }, { uri: p.uri, absent: true });
        if (p.c.content !== undefined && p.next !== p.old) { ops.push({ kind: 'write', uri: p.newUri!, bytes: p.oldBytes!, overwrite: true }); }
        ops.push({ kind: 'rename', from: p.newUri!, to: p.uri });
        break;
    }
  }
  const id = `plan${++seq}-${Date.now().toString(36)}`;
  const paths = items.map(p => p.c.newPath ? `${p.c.path} → ${p.c.newPath}` : p.c.path);
  applied.set(id, { id, checks, ops, paths });
  while (applied.size > MAX_UNDO_PLANS) { const oldest = applied.keys().next().value as string; applied.delete(oldest); expiredListener?.(oldest); }
  diag('plan.applied', { files: items.length });
  listener?.({ planId: id, paths, summary });
  return { ok: true, planId: id, msg: `Applied plan ${id} to ${items.length} file(s): ${paths.join(', ')}. The user can undo it from the chat.` };
}

/** Undo a whole plan, refusing if any file changed since it was applied. */
function trashHint(hasDelete: boolean): string {
  return hasDelete && vscode.workspace.getConfiguration('files').get<boolean>('enableTrash', true)
    ? ' Deletes go to the OS trash; if the trash is unavailable here, set "files.enableTrash" to false and try again.' : '';
}

export async function undoPlan(planId: string): Promise<{ ok: boolean; msg: string; retryable?: boolean }> {
  const p = applied.get(planId);
  if (!p) { return { ok: false, msg: `This plan can no longer be undone (only the last ${MAX_UNDO_PLANS} plans keep an undo snapshot, or it was already undone).` }; }
  // Build the edit first (no awaits), then verify and apply back to back (L4).
  const edit = new vscode.WorkspaceEdit();
  for (const o of p.ops) {
    if (o.kind === 'delete') { edit.deleteFile(o.uri, { ignoreIfNotExists: false }); }
    else if (o.kind === 'write') { edit.createFile(o.uri, { overwrite: o.overwrite, contents: o.bytes }); }
    else { edit.renameFile(o.from, o.to, { overwrite: false }); }
  }
  const bad = await verifyChecks(p.checks);
  if (bad) { return { ok: false, msg: `Can't undo: ${bad}.` }; }
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) { return { ok: false, msg: 'Undo failed; nothing was changed.' + trashHint(p.ops.some(x => x.kind === 'delete')), retryable: true }; }
  applied.delete(planId);
  diag('plan.undone', { files: p.paths.length });
  return { ok: true, msg: `Undid plan: ${p.paths.join(', ')}` };
}
