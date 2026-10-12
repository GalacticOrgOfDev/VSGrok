// Records the original bytes of every file a background task touches, so "Undo all" can restore them.
import * as vscode from 'vscode';
import { hashBytes } from './planCore';

interface Snap { uri: vscode.Uri; before: Uint8Array | null; afterHash?: string | null }

export class TaskTracker {
  private snaps = new Map<string, Snap>();
  /** Call before a file is created/modified/deleted/renamed-onto. Only the first call per file records. */
  async before(uri: vscode.Uri): Promise<void> {
    const k = uri.toString();
    if (this.snaps.has(k)) { return; }
    let before: Uint8Array | null;
    try { before = await vscode.workspace.fs.readFile(uri); } catch { before = null; }
    this.snaps.set(k, { uri, before });
  }
  /** Files whose content differs from before the task (in touch order). */
  async finish(): Promise<string[]> {
    const changed: string[] = [];
    for (const [k, s] of this.snaps) {
      let now: Uint8Array | null;
      try { now = await vscode.workspace.fs.readFile(s.uri); } catch { now = null; }
      s.afterHash = now ? hashBytes(now) : null;
      const same = (now === null && s.before === null) || (!!now && !!s.before && hashBytes(now) === hashBytes(s.before));
      if (same) { this.snaps.delete(k); } else { changed.push(vscode.workspace.asRelativePath(s.uri, false)); }
    }
    return changed;
  }
  get size() { return this.snaps.size; }
  /** Restore every file to its pre-task bytes, skipping any the user changed after the task ended. */
  async undoAll(): Promise<{ restored: string[]; skipped: string[] }> {
    const restored: string[] = []; const skipped: string[] = [];
    for (const s of [...this.snaps.values()].reverse()) {
      const rel = vscode.workspace.asRelativePath(s.uri, false);
      let now: Uint8Array | null;
      try { now = await vscode.workspace.fs.readFile(s.uri); } catch { now = null; }
      const nowHash = now ? hashBytes(now) : null;
      const dirty = vscode.workspace.textDocuments.find(d => d.uri.toString() === s.uri.toString())?.isDirty;
      if (nowHash !== s.afterHash || dirty) { skipped.push(`${rel} (changed since the task ended)`); continue; }
      try {
        if (s.before === null) { await vscode.workspace.fs.delete(s.uri, { useTrash: false }); }
        else { await vscode.workspace.fs.writeFile(s.uri, s.before); }
        restored.push(rel);
      } catch (e) { skipped.push(`${rel} (${(e as Error).message})`); }
    }
    this.snaps.clear();
    return { restored, skipped };
  }
}

let active: TaskTracker | undefined;
export function setTaskTracker(t: TaskTracker | undefined) { active = t; }
export async function trackBefore(...uris: (vscode.Uri | undefined)[]): Promise<void> {
  if (!active) { return; }
  for (const u of uris) { if (u) { await active.before(u); } }
}
