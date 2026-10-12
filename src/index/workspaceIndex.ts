// Local workspace index: file list (respects .gitignore + vsgrok.index.exclude), BM25 over path/symbols/content,
// symbol outlines via vscode.executeDocumentSymbolProvider (lazy, cached), incremental updates, capped for big repos.
import * as vscode from 'vscode';
import { Bm25Index, makeDoc, makeMatcher, gitignoreToGlobs, isSecretPath, bestLines } from './lexical';
import { cfg } from '../config';
import { diag } from '../diagnostics';

const MAX_FILE_BYTES = 256_000;
/** Total content bytes read per full build; beyond this, files are indexed by path (and symbols) only. */
const BUILD_BYTE_BUDGET = 64_000_000;
const BUILTIN_EXCLUDE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**', '**/build/**', '**/.venv/**', '**/venv/**', '**/__pycache__/**', '**/*.min.js', '**/*.map', '**/*.lock', '**/pnpm-lock.yaml', '**/package-lock.json'];
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|svgz|pdf|zip|gz|tgz|7z|rar|jar|war|exe|dll|so|dylib|bin|o|a|class|pyc|wasm|mp[34]|mov|avi|woff2?|ttf|otf|eot|sqlite|db|vsix|psd)$/i;

interface Outline { mtime: number; lines: string[] }

export class WorkspaceIndex implements vscode.Disposable {
  private bm = new Bm25Index();
  private mtimes = new Map<string, number>();
  private outlines = new Map<string, Outline>();
  private building?: Promise<void>;
  private watcher?: vscode.FileSystemWatcher;
  private queue = new Set<string>();
  private timer?: NodeJS.Timeout;
  private excluded: (p: string) => boolean = () => false;
  truncated = false;
  private bytesRead = 0;
  builtAt = 0;

  constructor() {}

  get size() { return this.bm.size; }

  private root(): vscode.Uri | undefined { return vscode.workspace.workspaceFolders?.[0]?.uri; }
  private maxFiles(): number { return Math.max(100, Math.min(50_000, cfg().get<number>('index.maxFiles', 5000))); }

  /** Start watching; the first build happens lazily on first query (or now if eager). */
  start(eager = false) {
    if (!cfg().get<boolean>('index.enabled', true) || this.watcher) { return; }
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const on = (u: vscode.Uri) => this.enqueue(u);
    this.watcher.onDidCreate(on); this.watcher.onDidChange(on);
    this.watcher.onDidDelete((u) => { const r = this.rel(u); if (r) { this.bm.remove(r); this.mtimes.delete(r); this.outlines.delete(r); } });
    if (eager) { void this.ensure(); }
  }

  private rel(u: vscode.Uri): string | undefined {
    const r = this.root(); if (!r || u.scheme !== r.scheme) { return undefined; }
    const base = r.path.replace(/\/+$/, '') + '/';
    return u.path.startsWith(base) ? u.path.slice(base.length) : undefined;
  }

  private allowed(rel: string): boolean { return !isSecretPath(rel) && !BINARY_EXT.test(rel) && !this.excluded(rel); }

  private enqueue(u: vscode.Uri) {
    if (!this.builtAt) { return; }
    const r = this.rel(u); if (!r || !this.allowed(r)) { return; }
    if (r === '.gitignore') { this.builtAt = 0; this.building = undefined; return; } // full rebuild on next query
    this.queue.add(r);
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => { void this.drain(); }, 500);
  }

  private async drain() {
    const items = [...this.queue]; this.queue.clear();
    const r = this.root(); if (!r) { return; }
    for (const rel of items) {
      if (!this.bm.has(rel) && this.bm.size >= this.maxFiles()) { this.truncated = true; continue; }
      await this.indexFile(r, rel);
    }
    diag('index.update', { files: items.length, size: this.bm.size });
  }

  ensure(): Promise<void> {
    if (!this.builtAt && !this.building) { this.building = this.build().finally(() => { this.building = undefined; }); }
    return this.building ?? Promise.resolve();
  }

  private async listFiles(r: vscode.Uri): Promise<string[]> {
    const userEx = cfg().get<string[]>('index.exclude', []) ?? [];
    let gi: string[] = [];
    // Prefer git (exact .gitignore semantics incl. nested files and negations).
    if (r.scheme === 'file') {
      const out = await new Promise<string | undefined>((res) => {
        import('child_process').then(cp => cp.execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: r.fsPath, maxBuffer: 64_000_000, timeout: 15000 }, (e, so) => res(e ? undefined : String(so))));
      });
      if (out !== undefined) {
        this.excluded = makeMatcher([...BUILTIN_EXCLUDE, ...userEx]);
        return out.split('\0').filter(Boolean);
      }
    }
    try { gi = gitignoreToGlobs(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(r, '.gitignore'))).toString('utf8')); } catch { /* none */ }
    this.excluded = makeMatcher([...BUILTIN_EXCLUDE, ...userEx, ...gi]);
    const found = await vscode.workspace.findFiles('**/*', '{' + BUILTIN_EXCLUDE.join(',') + '}', this.maxFiles() * 4);
    return found.map(u => this.rel(u)).filter((x): x is string => !!x);
  }

  private async build() {
    const r = this.root(); if (!r) { return; }
    const t0 = Date.now();
    this.bm = new Bm25Index(); this.mtimes.clear(); this.bytesRead = 0;
    const files = (await this.listFiles(r)).filter(p => this.allowed(p)).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    const cap = this.maxFiles();
    this.truncated = files.length > cap;
    const take = files.slice(0, cap);
    for (let i = 0; i < take.length; i += 32) {
      await Promise.all(take.slice(i, i + 32).map(p => this.indexFile(r, p)));
    }
    this.builtAt = Date.now();
    diag('index.build', { files: this.bm.size, truncated: this.truncated, ms: Date.now() - t0 });
  }

  private async indexFile(r: vscode.Uri, rel: string) {
    if (!this.allowed(rel)) { this.bm.remove(rel); return; }
    const u = vscode.Uri.joinPath(r, rel);
    try {
      const st = await vscode.workspace.fs.stat(u);
      if (st.type & vscode.FileType.Directory) { return; }
      if (this.mtimes.get(rel) === st.mtime && this.bm.has(rel)) { return; }
      let content = '';
      if (st.size <= MAX_FILE_BYTES && (this.builtAt || this.bytesRead + st.size <= BUILD_BYTE_BUDGET)) {
        this.bytesRead += st.size;
        const b = await vscode.workspace.fs.readFile(u);
        if (!b.subarray(0, 8000).includes(0)) { content = Buffer.from(b).toString('utf8'); }
      }
      const syms = this.outlines.get(rel)?.lines.map(l => l.replace(/^\s*\S+\s+/, '')) ?? [];
      this.bm.upsert(makeDoc(rel, content, syms));
      this.mtimes.set(rel, st.mtime);
    } catch { this.bm.remove(rel); this.mtimes.delete(rel); }
  }

  /** Symbol outline via the language's DocumentSymbolProvider (cached per mtime). */
  async outline(rel: string, max = 40): Promise<string[]> {
    const r = this.root(); if (!r || !this.allowed(rel)) { return []; }
    const mt = this.mtimes.get(rel) ?? 0;
    const c = this.outlines.get(rel);
    if (c && c.mtime === mt) { return c.lines.slice(0, max); }
    const lines: string[] = [];
    try {
      const syms = await Promise.race([
        vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', vscode.Uri.joinPath(r, rel)),
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
    this.outlines.set(rel, { mtime: mt, lines });
    if (lines.length) { await this.indexFile(r, rel).catch(() => undefined); }
    return lines.slice(0, max);
  }

  /** Ranked files for a natural-language/code query, with best-matching lines and symbol outlines for the top hits. */
  async findRelevant(query: string, max = 10, token?: vscode.CancellationToken): Promise<string> {
    if (!cfg().get<boolean>('index.enabled', true)) { return 'The workspace index is disabled (vsgrok.index.enabled). Use search_workspace instead.'; }
    const r = this.root(); if (!r) { return 'No workspace folder is open.'; }
    await this.ensure();
    const hits = this.bm.search(query, Math.max(1, Math.min(30, max)));
    diag('index.query', { hits: hits.length, size: this.bm.size });
    if (!hits.length) { return `No indexed files match "${query}" (${this.bm.size} files indexed). Try search_workspace with a specific identifier.`; }
    const out: string[] = [`${hits.length} relevant files (BM25 over paths, symbols and contents; ${this.bm.size} files indexed${this.truncated ? `, capped at ${this.maxFiles()}` : ''}):`];
    for (const [i, h] of hits.entries()) {
      if (token?.isCancellationRequested) { break; }
      out.push(`\n${i + 1}. ${h.path}  (score ${h.score.toFixed(2)})`);
      try {
        const b = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(r, h.path));
        if (b.length <= MAX_FILE_BYTES) { for (const l of bestLines(Buffer.from(b).toString('utf8'), query)) { out.push(`   L${l.line}: ${l.text}`); } }
      } catch { /* deleted */ }
      if (i < 5) { const o = await this.outline(h.path, 15); if (o.length) { out.push('   symbols: ' + o.map(s => s.trim()).join(' | ')); } }
    }
    return out.join('\n');
  }

  async rebuild() { this.builtAt = 0; this.outlines.clear(); await this.ensure(); }

  dispose() { this.watcher?.dispose(); if (this.timer) { clearTimeout(this.timer); } }
}

export const workspaceIndex = new WorkspaceIndex();
