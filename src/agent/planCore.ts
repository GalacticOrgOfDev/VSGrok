// Pure multi-file edit plan helpers (validation, normalization). No vscode import.
import { createHash } from 'crypto';
import { isSecretPath } from '../index/lexical';

export type PlanOp = 'create' | 'modify' | 'delete' | 'rename';
export interface PlanChange { op: PlanOp; path: string; newPath?: string; content?: string }
export interface PlanInput { summary?: string; changes: PlanChange[] }

export const MAX_PLAN_FILES = 50;
export const MAX_PLAN_CONTENT = 1_000_000; // bytes per file (UTF-8)
export const MAX_PLAN_TOTAL = 5_000_000; // bytes across the plan
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Paths that change how the agent, editor or automation behaves: allowed, but flagged on the card. */
export function sensitivePath(p: string): string | undefined {
  const l = p.toLowerCase();
  if (/^\.vscode\/(tasks|launch|settings|extensions)\.json$/.test(l)) { return 'changes VS Code tasks/launch/settings'; }
  if (l === 'vsgrok.md' || l.startsWith('.vsgrok/')) { return 'changes Grok\'s project rules'; }
  if (l.startsWith('.github/workflows/') || l === 'package.json' || /(^|\/)\.husky\//.test(l) || l === 'makefile') { return 'changes scripts or CI that run commands'; }
  return undefined;
}

export function normPath(p: unknown): string | undefined {
  if (typeof p !== 'string') { return undefined; }
  const s = p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/').trim();
  if (!s || s.startsWith('/') || /^[a-zA-Z]:/.test(s) || s.split('/').some(seg => seg === '..' || seg === '.' || seg === '')) { return undefined; }
  if (/(^|\/)\.git(\/|$)/i.test(s)) { return undefined; }
  // Windows: alternate data streams, reserved device names, trailing dot/space.
  if (s.includes(':') || s.split('/').some(seg => WIN_RESERVED.test(seg) || /[. ]$/.test(seg))) { return undefined; }
  return s;
}

/** Validate a propose_plan tool call. Returns normalized changes and human-readable errors (refused items are dropped). */
export interface RefusedChange { op: PlanOp; path: string; newPath?: string; reason: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function validatePlan(args: any): { plan: PlanInput; errors: string[]; refused: RefusedChange[] } {
  const errors: string[] = [];
  const refused: RefusedChange[] = [];
  const raw: unknown[] = Array.isArray(args?.changes) ? args.changes : [];
  if (!raw.length) { errors.push('Plan has no changes.'); }
  if (raw.length > MAX_PLAN_FILES) { errors.push(`Plan has ${raw.length} changes; max is ${MAX_PLAN_FILES}. Split it.`); }
  const out: PlanChange[] = [];
  const touched = new Set<string>();
  let total = 0;
  for (const [i, c0] of raw.slice(0, MAX_PLAN_FILES).entries()) {
    const c = (c0 ?? {}) as Record<string, unknown>;
    const op = c.op as PlanOp;
    const where = `change ${i + 1}`;
    if (!['create', 'modify', 'delete', 'rename'].includes(op)) { errors.push(`${where}: unknown op "${String(c.op)}"`); continue; }
    const path = normPath(c.path);
    if (!path) { errors.push(`${where}: invalid path "${String(c.path)}" (must be workspace-relative, no ..)`); continue; }
    if (isSecretPath(path)) { errors.push(`${where}: refused ${path} (secrets/credentials file)`); refused.push({ op, path, reason: 'secrets/credentials file' }); continue; }
    let newPath: string | undefined;
    if (op === 'rename') {
      newPath = normPath(c.newPath);
      if (!newPath) { errors.push(`${where}: rename needs a valid newPath`); continue; }
      if (isSecretPath(newPath)) { errors.push(`${where}: refused rename to ${newPath} (secrets/credentials name)`); refused.push({ op, path, newPath, reason: 'rename target looks like a secrets/credentials file' }); continue; }
      if (newPath === path) { errors.push(`${where}: rename to the same path`); continue; }
    }
    const content = typeof c.content === 'string' ? c.content : undefined;
    if ((op === 'create' || op === 'modify') && content === undefined) { errors.push(`${where}: ${op} needs content`); continue; }
    const bytes = content === undefined ? 0 : Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_PLAN_CONTENT) { errors.push(`${where}: content too large (${bytes} bytes; max ${MAX_PLAN_CONTENT})`); continue; }
    if (total + bytes > MAX_PLAN_TOTAL) { errors.push(`${where}: plan exceeds ${MAX_PLAN_TOTAL} bytes in total; split it`); continue; }
    total += bytes;
    const keys = [path, ...(newPath ? [newPath] : [])].map(k => k.toLowerCase());
    if (keys.some(k => touched.has(k))) { errors.push(`${where}: ${path} is touched by more than one change`); continue; }
    keys.forEach(k => touched.add(k));
    out.push({ op, path, newPath, content: op === 'delete' ? undefined : content });
  }
  return { plan: { summary: typeof args?.summary === 'string' ? args.summary.slice(0, 500) : undefined, changes: out }, errors, refused };
}

/** Indices the user approved, intersected with what exists. undefined → all. */
export function selectedIndices(n: number, selected?: number[]): number[] {
  const all = [...Array(n).keys()];
  if (!selected) { return all; }
  return [...new Set(selected)].filter(i => i >= 0 && i < n).sort((a, b) => a - b);
}

/** Simple stable hash for "changed since apply?" checks. */
export function hashText(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
export function hashBytes(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}

/** Decode strictly as UTF-8 text; undefined for binary (NUL) or invalid UTF-8. */
export function decodeText(b: Uint8Array): string | undefined {
  if (b.includes(0)) { return undefined; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return undefined; }
}
