// Pure workspace-index helpers: tokenizer, BM25, glob matching, secret-file and .gitignore filters. No vscode import.

/** Split identifiers (camelCase, snake_case, kebab, paths) into lowercase terms; drops 1-char terms and stopwords. */
const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'not', 'but', 'you', 'all', 'can', 'has', 'have', 'var', 'let', 'const', 'return', 'import', 'export', 'function', 'class', 'new', 'def', 'self', 'true', 'false', 'null', 'none', 'undefined', 'int', 'str']);
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const words = text.match(/[A-Za-z0-9_]+/g) ?? [];
  for (const w of words) {
    const parts = w.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[\s_]+/);
    for (const p of parts) {
      const t = p.toLowerCase();
      if (t.length > 1 && t.length < 40 && !STOP.has(t)) { out.push(t); }
    }
    const whole = w.toLowerCase();
    if (parts.length > 1 && whole.length < 60) { out.push(whole); }
  }
  return out;
}

export interface IndexDoc { path: string; terms: Map<string, number>; len: number }

export function makeDoc(path: string, content: string, symbols: string[] = [], pathWeight = 3, symbolWeight = 2): IndexDoc {
  const terms = new Map<string, number>();
  const add = (t: string, w: number) => terms.set(t, (terms.get(t) ?? 0) + w);
  for (const t of tokenize(path)) { add(t, pathWeight); }
  for (const s of symbols) { for (const t of tokenize(s)) { add(t, symbolWeight); } }
  for (const t of tokenize(content)) { add(t, 1); }
  let len = 0; for (const v of terms.values()) { len += v; }
  return { path, terms, len };
}

/** BM25 over IndexDocs. Incremental: upsert/remove keep df and total length in sync. */
export class Bm25Index {
  private docs = new Map<string, IndexDoc>();
  private df = new Map<string, number>();
  private totalLen = 0;
  constructor(private readonly k1 = 1.2, private readonly b = 0.75) {}

  get size(): number { return this.docs.size; }
  has(path: string): boolean { return this.docs.has(path); }
  paths(): string[] { return [...this.docs.keys()]; }

  upsert(doc: IndexDoc) {
    this.remove(doc.path);
    this.docs.set(doc.path, doc);
    this.totalLen += doc.len;
    for (const t of doc.terms.keys()) { this.df.set(t, (this.df.get(t) ?? 0) + 1); }
  }

  remove(path: string) {
    const d = this.docs.get(path);
    if (!d) { return; }
    this.docs.delete(path);
    this.totalLen -= d.len;
    for (const t of d.terms.keys()) { const n = (this.df.get(t) ?? 1) - 1; if (n <= 0) { this.df.delete(t); } else { this.df.set(t, n); } }
  }

  search(query: string, limit = 20): { path: string; score: number }[] {
    const q = [...new Set(tokenize(query))];
    if (!q.length || !this.docs.size) { return []; }
    const N = this.docs.size, avg = this.totalLen / N || 1;
    const scores: { path: string; score: number }[] = [];
    for (const d of this.docs.values()) {
      let s = 0;
      for (const t of q) {
        const f = d.terms.get(t); if (!f) { continue; }
        const n = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * d.len / avg));
      }
      if (s > 0) { scores.push({ path: d.path, score: s }); }
    }
    return scores.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
  }
}

/** Glob → RegExp for workspace-relative POSIX paths. Supports **, *, ?, {a,b}, character classes; pattern without "/" matches any basename. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, '/');
  if (g.startsWith('/')) { g = g.replace(/^\/+/, ''); } else if (!g.includes('/')) { g = '**/' + g; }
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else { re += '.*'; }
      } else { re += '[^/]*'; }
    } else if (c === '?') { re += '[^/]'; }
    else if (c === '{') { const j = g.indexOf('}', i); if (j < 0) { re += '\\{'; continue; } re += '(?:' + g.slice(i + 1, j).split(',').map(x => x.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')'; i = j; }
    else if (c === '[') { const j = g.indexOf(']', i); if (j < 0) { re += '\\['; continue; } re += g.slice(i, j + 1); i = j; }
    else { re += c.replace(/[.+^$()|\\]/g, '\\$&'); }
  }
  return new RegExp('^' + re + '(?:/.*)?$');
}

export function makeMatcher(globs: string[]): (path: string) => boolean {
  const res = globs.filter(g => g && g.trim()).map(globToRegExp);
  return (p) => res.some(r => r.test(p));
}

/** .gitignore lines → globs (negations dropped: best effort, used only when git is unavailable). */
export function gitignoreToGlobs(text: string): string[] {
  const out: string[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) { continue; }
    const anchored = line.startsWith('/') || line.replace(/\/$/, '').includes('/');
    line = line.replace(/^\//, '').replace(/\/$/, '');
    out.push(anchored ? '/' + line : '**/' + line);
  }
  return out;
}

const SECRET_BASENAME = /^(\.env(\..*)?|.*\.env|\.envrc|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.htpasswd|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json|\.ya?ml)?|secrets?\.(json|ya?ml|toml|txt|ini|cfg|conf)|.*secret.*\.(json|ya?ml|toml|txt)|service[-_]account.*\.json|.*\.(pem|key|p12|pfx|keystore|jks|kdbx|ovpn|asc|gpg))$/i;
const SECRET_DIR = /(^|\/)(\.ssh|\.aws|\.gnupg|\.docker|\.kube)(\/|$)/i;

/** True for .env files and anything that looks like credentials/keys. These are never read or indexed. */
export function isSecretPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/');
  const base = p.split('/').pop() ?? p;
  if (/^\.env\.(example|sample|template|dist)$/i.test(base)) { return false; }
  return SECRET_BASENAME.test(base) || SECRET_DIR.test(p);
}

/** Lines of `content` that contain the most query terms (for result snippets). */
export function bestLines(content: string, query: string, max = 3): { line: number; text: string }[] {
  const q = new Set(tokenize(query));
  if (!q.size) { return []; }
  const scored: { line: number; text: string; s: number }[] = [];
  content.split('\n').forEach((l, i) => {
    if (l.length > 400) { return; }
    let s = 0; for (const t of new Set(tokenize(l))) { if (q.has(t)) { s++; } }
    if (s) { scored.push({ line: i + 1, text: l.trim().slice(0, 160), s }); }
  });
  return scored.sort((a, b) => b.s - a.s || a.line - b.line).slice(0, max).map(({ line, text }) => ({ line, text }));
}
