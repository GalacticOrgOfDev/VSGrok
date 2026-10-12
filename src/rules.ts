// Per-project instructions: VSGrok.md (workspace root) and/or .vsgrok/rules.md, injected into the system prompt.
import * as vscode from 'vscode';
import { ProjectRules, formatRules } from './rulesFormat';
export { rulesPrompt } from './rulesFormat';
export type { ProjectRules } from './rulesFormat';

export const RULE_FILES = ['VSGrok.md', 'vsgrok.md', '.vsgrok/rules.md'];

export class RulesWatcher implements vscode.Disposable {
  current?: ProjectRules;
  private watchers: vscode.FileSystemWatcher[] = [];
  private emitter = new vscode.EventEmitter<ProjectRules | undefined>();
  readonly onDidChange = this.emitter.event;

  start() {
    for (const f of RULE_FILES) {
      const w = vscode.workspace.createFileSystemWatcher(`**/${f}`);
      const re = () => { void this.load(); };
      w.onDidCreate(re); w.onDidChange(re); w.onDidDelete(re);
      this.watchers.push(w);
    }
    void this.load();
  }

  async load(): Promise<ProjectRules | undefined> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const parts: { file: string; text: string }[] = [];
    const seen = new Set<string>();
    if (root) {
      for (const f of RULE_FILES) {
        try {
          const u = vscode.Uri.joinPath(root, f);
          const st = await vscode.workspace.fs.stat(u);
          const key = f.toLowerCase();
          if (seen.has(key) || st.size > 200_000) { continue; }
          seen.add(key);
          parts.push({ file: f, text: Buffer.from(await vscode.workspace.fs.readFile(u)).toString('utf8') });
        } catch { /* missing */ }
      }
    }
    const next = formatRules(parts);
    const changed = next?.hash !== this.current?.hash;
    this.current = next;
    if (changed) { this.emitter.fire(next); }
    return next;
  }

  dispose() { this.watchers.forEach(w => w.dispose()); this.emitter.dispose(); }
}
