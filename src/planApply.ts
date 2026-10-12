// Multi-file edit plans: one in-chat approval card, atomic WorkspaceEdit, one-click undo.
import * as vscode from 'vscode';
import { requestDecision } from './agent/approvals';
import { validatePlan, selectedIndices, hashText, PlanChange } from './agent/planCore';
import { lineDelta } from './agent/approvals';
import { checkReadable } from './security';
import { showVirtualDiff } from './proposals';
import { diag } from './diagnostics';

interface UndoStep { op: 'restore' | 'delete' | 'recreate'; uri: vscode.Uri; content?: string; expectHash?: string; expectAbsent?: boolean }
interface AppliedPlan { id: string; steps: UndoStep[]; paths: string[] }

const applied = new Map<string, AppliedPlan>();
let seq = 0;
type PlanListener = (e: { planId: string; paths: string[]; summary?: string }) => void;
let listener: PlanListener | undefined;
export function onPlanApplied(l: PlanListener | undefined) { listener = l; }

function root(): vscode.Uri {
  const f = vscode.workspace.workspaceFolders?.[0];
  if (!f) { throw new Error('No workspace folder open.'); }
  return f.uri;
}
async function exists(u: vscode.Uri): Promise<boolean> { try { await vscode.workspace.fs.stat(u); return true; } catch { return false; } }
async function readText(u: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === u.toString());
  return open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(u)).toString('utf8');
}

interface Prepared { c: PlanChange; uri: vscode.Uri; newUri?: vscode.Uri; old: string; next: string; refused?: string }

/** Tool entry point: validate, show the plan card, apply the approved subset atomically. Returns a message for the agent. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function proposePlan(args: any, signal?: AbortSignal): Promise<string> {
  const { plan, errors } = validatePlan(args);
  const r = root();
  const prepared: Prepared[] = [];
  for (const c of plan.changes) {
    const uri = vscode.Uri.joinPath(r, c.path);
    const newUri = c.newPath ? vscode.Uri.joinPath(r, c.newPath) : undefined;
    const p: Prepared = { c, uri, newUri, old: '', next: c.content ?? '' };
    const has = await exists(uri);
    if (c.op === 'create' && has) { p.refused = 'already exists (use modify)'; }
    else if (c.op !== 'create' && !has) { p.refused = 'does not exist'; }
    else if (newUri && await exists(newUri)) { p.refused = `${c.newPath} already exists`; }
    else if (has) {
      const chk = await checkReadable(uri);
      if (!chk.ok) { p.refused = chk.reason; }
      else { try { p.old = await readText(uri); } catch (e) { p.refused = `unreadable: ${(e as Error).message}`; } }
    }
    if (c.op === 'rename' && c.content === undefined) { p.next = p.old; }
    if (c.op === 'delete') { p.next = ''; }
    prepared.push(p);
  }
  const usable = prepared.filter(p => !p.refused);
  if (!usable.length) { return `Plan not shown: ${[...errors, ...prepared.map(p => `${p.c.path}: ${p.refused}`)].join('; ') || 'nothing to do'}`; }

  const files = usable.map(p => {
    const d = lineDelta(p.old, p.next);
    return { path: p.c.path, op: p.c.op, newPath: p.c.newPath, added: d.added, removed: d.removed };
  });
  const decision = await requestDecision({ kind: 'plan', summary: plan.summary, files }, {
    signal,
    onViewDiff: (i) => {
      const p = i === undefined ? usable[0] : usable[i];
      if (p) { void showVirtualDiff(p.c.newPath ?? p.c.path, p.old, p.next, p.c.op); }
    },
  });
  const notes = [...errors, ...prepared.filter(p => p.refused).map(p => `${p.c.path}: ${p.refused}`)];
  if (!decision.ok) { return `User denied the plan (${usable.length} files). Nothing was changed.${notes.length ? ' Not offered: ' + notes.join('; ') : ''}`; }
  const chosen = selectedIndices(usable.length, decision.selected).map(i => usable[i]);
  const res = await applyPrepared(chosen, plan.summary);
  const skipped = usable.filter(p => !chosen.includes(p)).map(p => p.c.path);
  return `${res.msg}${skipped.length ? ` User unchecked: ${skipped.join(', ')}.` : ''}${notes.length ? ` Not offered: ${notes.join('; ')}.` : ''}`;
}

async function applyPrepared(items: Prepared[], summary?: string): Promise<{ ok: boolean; msg: string; planId?: string }> {
  const edit = new vscode.WorkspaceEdit();
  const undo: UndoStep[] = [];
  for (const p of items) {
    const meta = { label: 'VSGrok plan', needsConfirmation: false };
    switch (p.c.op) {
      case 'create':
        edit.createFile(p.uri, { overwrite: false, contents: Buffer.from(p.next, 'utf8') }, meta);
        undo.push({ op: 'delete', uri: p.uri, expectHash: hashText(p.next) });
        break;
      case 'modify': {
        const doc = await vscode.workspace.openTextDocument(p.uri);
        edit.replace(p.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), p.next, meta);
        undo.push({ op: 'restore', uri: p.uri, content: p.old, expectHash: hashText(p.next) });
        break;
      }
      case 'delete':
        edit.deleteFile(p.uri, { recursive: false, ignoreIfNotExists: false }, meta);
        undo.push({ op: 'recreate', uri: p.uri, content: p.old, expectAbsent: true });
        break;
      case 'rename':
        // delete + create keeps the edit atomic even when the content also changes.
        edit.deleteFile(p.uri, { ignoreIfNotExists: false }, meta);
        edit.createFile(p.newUri!, { overwrite: false, contents: Buffer.from(p.next, 'utf8') }, meta);
        undo.push({ op: 'delete', uri: p.newUri!, expectHash: hashText(p.next) }, { op: 'recreate', uri: p.uri, content: p.old, expectAbsent: true });
        break;
    }
  }
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) { return { ok: false, msg: 'Applying the plan failed; nothing was changed (the edit is atomic).' + trashHint(items.some(p => p.c.op === 'delete' || p.c.op === 'rename')) }; }
  for (const p of items) {
    if (p.c.op === 'modify') { const d = vscode.workspace.textDocuments.find(x => x.uri.toString() === p.uri.toString()); if (d?.isDirty) { await d.save(); } }
  }
  const id = `plan${++seq}-${Date.now().toString(36)}`;
  const paths = items.map(p => p.c.newPath ? `${p.c.path} → ${p.c.newPath}` : p.c.path);
  applied.set(id, { id, steps: undo, paths });
  diag('plan.applied', { files: items.length });
  listener?.({ planId: id, paths, summary });
  return { ok: true, planId: id, msg: `Applied plan ${id} to ${items.length} file(s): ${paths.join(', ')}. The user can undo it from the chat.` };
}

/** Undo a whole plan, refusing if any file changed since it was applied. */
function trashHint(hasDelete: boolean): string {
  return hasDelete && vscode.workspace.getConfiguration('files').get<boolean>('enableTrash', true)
    ? ' Deletes go to the OS trash; if the trash is unavailable here, set "files.enableTrash" to false and try again.' : '';
}

export async function undoPlan(planId: string): Promise<{ ok: boolean; msg: string }> {
  const p = applied.get(planId);
  if (!p) { return { ok: false, msg: 'This plan can no longer be undone (unknown or already undone).' }; }
  for (const s of p.steps) {
    const has = await exists(s.uri);
    if (s.expectAbsent && has && !p.steps.some(o => o.op === 'delete' && o.uri.toString() === s.uri.toString())) {
      return { ok: false, msg: `Can't undo: ${vscode.workspace.asRelativePath(s.uri)} was re-created since the plan was applied.` };
    }
    if (s.expectHash) {
      if (!has) { return { ok: false, msg: `Can't undo: ${vscode.workspace.asRelativePath(s.uri)} was deleted since the plan was applied.` }; }
      if (hashText(await readText(s.uri)) !== s.expectHash) { return { ok: false, msg: `Can't undo: ${vscode.workspace.asRelativePath(s.uri)} changed since the plan was applied.` }; }
    }
  }
  const edit = new vscode.WorkspaceEdit();
  for (const s of p.steps) {
    if (s.op === 'delete') { edit.deleteFile(s.uri, { ignoreIfNotExists: true }); }
    else if (s.op === 'recreate') { edit.createFile(s.uri, { overwrite: false, contents: Buffer.from(s.content ?? '', 'utf8') }); }
    else {
      const doc = await vscode.workspace.openTextDocument(s.uri);
      edit.replace(s.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), s.content ?? '');
    }
  }
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) { return { ok: false, msg: 'Undo failed; nothing was changed.' + trashHint(p.steps.some(x => x.op === 'delete')) }; }
  for (const s of p.steps) { if (s.op === 'restore') { const d = vscode.workspace.textDocuments.find(x => x.uri.toString() === s.uri.toString()); if (d?.isDirty) { await d.save(); } } }
  applied.delete(planId);
  diag('plan.undone', { files: p.paths.length });
  return { ok: true, msg: `Undid plan: ${p.paths.join(', ')}` };
}
