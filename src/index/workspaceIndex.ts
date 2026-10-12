// Local workspace index: file list per workspace folder (git ls-files in trusted workspaces, else findFiles + nested
// .gitignore parsing), vsgrok.index.exclude, BM25 over path/symbols/content, symbol outlines via
// vscode.executeDocumentSymbolProvider (lazy, cached), incremental updates, capped for big repos.
// Security: secret-looking paths and symlinks are never read; git runs only in trusted workspaces with fsmonitor off.
import * as vscode from 'vscode';
import { Bm25Index, makeDoc, makeMatcher, gitignoreMatcher, isSecretPath, bestLines, GIT_LS_ARGS } from './lexical';
import { cfg } from '../config';
import { diag } from '../diagnostics';

const MAX_FILE_BYTES = 256_000;
/** Total content bytes read per full build; beyond this, files are indexed by path (and symbols) only. */
const BUILD_BYTE_BUDGET = 64_000_000;
const BUILTIN_EXCLUDE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**', '**/build/**', '**/.venv/**', '**/venv/**', '**/__pycache__/**', '**/*.min.js', '**/*.map', '**/*.lock', '**/pnpm-lock.yaml', '**/package-lock.json'];
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|svgz|pdf|zip|gz|tgz|7z|rar|jar|war|exe|dll|so|dylib|bin|o|a|class|pyc|wasm|mp[34]|mov|avi|woff2?|ttf|otf|eot|sqlite|db|vsix|psd)$/i;


interface Outline { mtime: number; lines: string[] }
interface Entry { folder: vscode.Uri; rel: string }

export class WorkspaceIndex implements vscode.Disposable {
  private bm = new Bm25Index();
  private entries = new Map<string, Entry>();
  private mtimes = new Map<string, number>();
  private outlines = new Map<string, Outline>();
  private building?: Promise<void>;
  private generation = 0;
  private watchers: vscode.Disposable[] = [];
  private queue = new Set<string>();
  private deletes = new Set<string>();
  private timer?: NodeJS.Timeout;
  private excluded = new Map<string, (p: string) => boolean>();
  truncated = false;
  builtAt = 0;

  get size() { return this.bm.size; }

  private folders(): readonly vscode.WorkspaceFolder[] { return vscode.workspace.workspaceFolders ?? []; }
  private multi(): boolean { return this.folders().length > 1; }
  private maxFiles(): number { return Math.max(100, Math.min(50_000, cfg().get<number>('index.maxFiles', 5000))); }
  /** Display key: workspace-relative path as asRelativePath would show it. */
  private key(folder: vscode.WorkspaceFolder | vscode.Uri, rel: string): string {
    const f = folder instanceof vscode.Uri ? this.folders().find(x => x.uri.toString() === folder.toString()) : folder;
    return this.multi() && f ? `${f.name}/${rel}` : rel;
  }

  start(eager = false) {
    if (!cfg().get<boolean>('index.enabled', true) || this.watchers.length) { return; }
    const watchFolders = () => {
      this.watchers.forEach(w => w.dispose()); this.watchers = [];
      for (const f of this.folders()) {
        const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, '**/*'));
        w.onDidCreate(u => this.enqueue(u)); w.onDidChange(u => this.enqueue(u));
        w.onDidDelete(u => this.onDelete(u));
        this.watchers.push(w);
      }
    };
    watchFolders();
    this.watchers.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { watchFolders(); this.invalidate(); }));
    this.watchers.push(vscode.workspace.onDidGrantWorkspaceTrust(() => this.invalidate()));
    if (eager) { void this.ensure(); }
  }

  private invalidate() { this.builtAt = 0; this.building = undefined; this.generation++; }

  private locate(u: vscode.Uri): { folder: vscode.WorkspaceFolder; rel: string } | undefined {
    const f = vscode.workspace.getWorkspaceFolder(u);
    if (!f || u.scheme !== f.uri.scheme) { return undefined; }
    const base = f.uri.path.replace(/\/+$/, '') + '/';
    return u.path.startsWith(base) ? { folder: f, rel: u.path.slice(base.length) } : undefined;
  }

  private allowed(folder: vscode.Uri, rel: string): boolean {
    return !isSecretPath(rel) && !BINARY_EXT.test(rel) && !(this.excluded.get(folder.toString())?.(rel));
  }

  /** Remove a file or every indexed path under a deleted/renamed folder. */
  private removeKey(k: string) { this.bm.remove(k); this.entries.delete(k); this.mtimes.delete(k); this.outlines.delete(k); }
  private onDelete(u: vscode.Uri) {
    const loc = this.locate(u); if (!loc) { return; }
    const k = this.key(loc.folder, loc.rel);
    this.removeKey(k);
    const prefix = k.replace(/\/+$/, '') + '/';
    for (const p of [...this.entries.keys()]) { if (p.startsWith(prefix)) { this.removeKey(p); } }
  }

  private enqueue(u: vscode.Uri) {
    if (!this.builtAt) { return; }
    const loc = this.locate(u); if (!loc) { return; }
    if (/(^|\/)\.gitignore$/.test(loc.rel)) { this.invalidate(); return; } // full rebuild on next query
    if (!this.allowed(loc.folder.uri, loc.rel)) { return; }
    this.queue.add(u.toString());
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => { void this.drain(); }, 500);
  }

  private async drain() {
    const gen = this.generation;
    const items = [...this.queue]; this.queue.clear();
    for (const s of items) {
      if (gen !== this.generation) { return; }
      const u = vscode.Uri.parse(s); const loc = this.locate(u); if (!loc) { continue; }
      const k = this.key(loc.folder, loc.rel);
      try {
        const st = await vscode.workspace.fs.stat(u);
        if (st.type & vscode.FileType.Directory) {
          // A folder appeared (create or rename target): index its files.
          for (const f of await vscode.workspace.findFiles(new vscode.RelativePattern(u, '**/*'), '{' + BUILTIN_EXCLUDE.join(',') + '}', 2000)) {
            const l = this.locate(f); if (l && this.allowed(l.folder.uri, l.rel)) { await this.indexFile(this.bm, l.folder.uri, l.rel, gen); }
          }
          continue;
        }
      } catch { this.onDelete(u); continue; }
      if (!this.bm.has(k) && this.bm.size >= this.maxFiles()) { this.truncated = true; continue; }
      await this.indexFile(this.bm, loc.folder.uri, loc.rel, gen);
    }
    diag('index.update', { files: items.length, size: this.bm.size });
  }

  ensure(): Promise<void> {
    if (!this.builtAt && !this.building) {
      const gen = ++this.generation;
      const p = this.build(gen).finally(() => { if (this.building === p) { this.building = undefined; } });
      this.building = p;
    }
    return this.building ?? Promise.resolve();
  }

  private async gitList(folder: vscode.Uri): Promise<string[] | undefined> {
    // .git/config can set core.fsmonitor or other commands; never run git in an untrusted workspace.
    if (folder.scheme !== 'file' || !vscode.workspace.isTrusted) { return undefined; }
    return new Promise((res) => {
      import('child_process').then(cp => cp.execFile('git', GIT_LS_ARGS, { cwd: folder.fsPath, maxBuffer: 64_000_000, timeout: 15000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
        (e, so) => res(e ? undefined : String(so).split('\0').filter(Boolean))));
    });
  }

  private async listFiles(folder: vscode.Uri): Promise<string[]> {
    const userEx = cfg().get<string[]>('index.exclude', []) ?? [];
    const base = makeMatcher([...BUILTIN_EXCLUDE, ...userEx]);
    const git = await this.gitList(folder);
    if (git) { this.excluded.set(folder.toString(), base); return git; }
    // Fallback: every .gitignore in the folder (nested), with negation/dir-only/anchoring semantics.
    const giFiles = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/.gitignore'), '**/node_modules/**', 500);
    const prefix = folder.path.replace(/\/+$/, '') + '/';
    const gi: { dir: string; text: string }[] = [];
    for (const g of giFiles) {
      try { gi.push({ dir: g.path.slice(prefix.length).replace(/\/?\.gitignore$/, ''), text: Buffer.from(await vscode.workspace.fs.readFile(g)).toString('utf8') }); } catch { /* skip */ }
    }
    const ign = gitignoreMatcher(gi);
    const ex = (p: string) => base(p) || ign(p);
    this.excluded.set(folder.toString(), ex);
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), '{' + BUILTIN_EXCLUDE.join(',') + '}', this.maxFiles() * 4);
    return found.map(u => u.path.startsWith(prefix) ? u.path.slice(prefix.length) : '').filter(Boolean);
  }

  /** Builds into a fresh index and swaps it in only if no newer build/invalidate happened meanwhile. */
  private async build(gen: number) {
    const folders = this.folders(); if (!folders.length) { return; }
    const t0 = Date.now();
    const next = new Bm25Index();
    const nextEntries = new Map<string, Entry>(); const nextM = new Map<string, number>();
    const all: { folder: vscode.Uri; rel: string; key: string }[] = [];
    for (const f of folders) {
      for (const rel of await this.listFiles(f.uri)) { if (this.allowed(f.uri, rel)) { all.push({ folder: f.uri, rel, key: this.key(f, rel) }); } }
    }
    all.sort((a, b) => a.rel.split('/').length - b.rel.split('/').length || a.key.localeCompare(b.key));
    const cap = this.maxFiles();
    const truncated = all.length > cap;
    const take = all.slice(0, cap);
    const budget = { bytes: 0 };
    for (let i = 0; i < take.length; i += 32) {
      if (gen !== this.generation) { return; }
      await Promise.all(take.slice(i, i + 32).map(e => this.indexFile(next, e.folder, e.rel, gen, budget, nextEntries, nextM)));
    }
    if (gen !== this.generation) { return; } // superseded: discard
    this.bm = next; this.entries = nextEntries; this.mtimes = nextM; this.truncated = truncated;
    this.builtAt = Date.now();
    diag('index.build', { files: this.bm.size, truncated, ms: Date.now() - t0, folders: folders.length, git: vscode.workspace.isTrusted });
  }

  private async indexFile(ix: Bm25Index, folder: vscode.Uri, rel: string, gen: number, budget?: { bytes: number },
    entries = this.entries, mtimes = this.mtimes) {
    const k = this.key(folder, rel);
    if (!this.allowed(folder, rel)) { ix.remove(k); return; }
    const u = vscode.Uri.joinPath(folder, rel);
    try {
      const st = await vscode.workspace.fs.stat(u);
      // Symlinks are never followed (could point at ~/.ssh or a secret elsewhere).
      if (st.type & vscode.FileType.SymbolicLink || st.type & vscode.FileType.Directory) { ix.remove(k); return; }
      if (mtimes.get(k) === st.mtime && ix.has(k)) { return; }
      let content = '';
      if (st.size <= MAX_FILE_BYTES && (!budget || budget.bytes + st.size <= BUILD_BYTE_BUDGET)) {
        if (budget) { budget.bytes += st.size; }
        const b = await vscode.workspace.fs.readFile(u);
        if (!b.subarray(0, 8000).includes(0)) { content = Buffer.from(b).toString('utf8'); }
      }
      if (gen !== this.generation) { return; }
      const syms = this.outlines.get(k)?.lines.map(l => l.replace(/^\s*\S+\s+/, '')) ?? [];
      ix.upsert(makeDoc(k, content, syms));
      entries.set(k, { folder, rel }); mtimes.set(k, st.mtime);
    } catch { ix.remove(k); entries.delete(k); mtimes.delete(k); }
  }

  async outline(k: string, max = 40): Promise<string[]> {
    const e = this.entries.get(k); if (!e || !this.allowed(e.folder, e.rel)) { return []; }
    const mt = this.mtimes.get(k) ?? 0;
    const c = this.outlines.get(k);
    if (c && c.mtime === mt) { return c.lines.slice(0, max); }
    const lines: string[] = [];
    try {
      const syms = await Promise.race([
        vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', vscode.Uri.joinPath(e.folder, e.rel)),
        new Promise<undefined>(res => setTimeout(() => res(undefined), 3000)),
      ]) ?? [];
      const walk = (s: vscode.DocumentSymbol | vscode.SymbolInformation, depth: number) => {
        if (lines.length >= 200) { return; }
        const line = 'range' in s ? s.range.start.line + 1 : s.location.range.start.line + 1;
        lines.push(`${'  '.repeat(depth)}${vscode.SymbolKind[s.kind]} ${s.name} :${line}`);
        if ('children' in s && depth < 2) { for (const ch of s.children) { walk(ch, depth + 1); } }
      };
      for (const s of syms) { walk(s, 0); }
    } catch { /* no provider */ }
    this.outlines.set(k, { mtime: mt, lines });
    if (lines.length) { await this.indexFile(this.bm, e.folder, e.rel, this.generation).catch(() => undefined); }
    return lines.slice(0, max);
  }

  async findRelevant(query: string, max = 10, token?: vscode.CancellationToken): Promise<string> {
    if (!cfg().get<boolean>('index.enabled', true)) { return 'The workspace index is disabled (vsgrok.index.enabled). Use search_workspace instead.'; }
    if (!this.folders().length) { return 'No workspace folder is open.'; }
    await this.ensure();
    const hits = this.bm.search(query, Math.max(1, Math.min(30, max)));
    diag('index.query', { hits: hits.length, size: this.bm.size });
    if (!hits.length) { return `No indexed files match "${query}" (${this.bm.size} files indexed). Try search_workspace with a specific identifier.`; }
    const out: string[] = [`${hits.length} relevant files (BM25 over paths, symbols and contents; ${this.bm.size} files indexed${this.truncated ? `, capped at ${this.maxFiles()}` : ''}):`];
    for (const [i, h] of hits.entries()) {
      if (token?.isCancellationRequested) { break; }
      out.push(`\n${i + 1}. ${h.path}  (score ${h.score.toFixed(2)})`);
      const e = this.entries.get(h.path);
      if (e) {
        try {
          const u = vscode.Uri.joinPath(e.folder, e.rel);
          const st = await vscode.workspace.fs.stat(u);
          if (!(st.type & vscode.FileType.SymbolicLink) && st.size <= MAX_FILE_BYTES) {
            for (const l of bestLines(Buffer.from(await vscode.workspace.fs.readFile(u)).toString('utf8'), query)) { out.push(`   L${l.line}: ${l.text}`); }
          }
        } catch { /* deleted */ }
      }
      if (i < 5) { const o = await this.outline(h.path, 15); if (o.length) { out.push('   symbols: ' + o.map(s => s.trim()).join(' | ')); } }
    }
    return out.join('\n');
  }

  async rebuild() { this.invalidate(); this.outlines.clear(); await this.ensure(); }

  dispose() { this.watchers.forEach(w => w.dispose()); if (this.timer) { clearTimeout(this.timer); } }
}

export const workspaceIndex = new WorkspaceIndex();
