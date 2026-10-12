// Pure multi-file edit plan helpers (validation, normalization). No vscode import.
import { isSecretPath } from '../index/lexical';

export type PlanOp = 'create' | 'modify' | 'delete' | 'rename';
export interface PlanChange { op: PlanOp; path: string; newPath?: string; content?: string }
export interface PlanInput { summary?: string; changes: PlanChange[] }

export const MAX_PLAN_FILES = 50;
export const MAX_PLAN_CONTENT = 1_000_000;

export function normPath(p: unknown): string | undefined {
  if (typeof p !== 'string') { return undefined; }
  const s = p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/').trim();
  if (!s || s.startsWith('/') || /^[a-zA-Z]:/.test(s) || s.split('/').some(seg => seg === '..' || seg === '.' || seg === '')) { return undefined; }
  if (/(^|\/)\.git(\/|$)/.test(s)) { return undefined; }
  return s;
}

/** Validate a propose_plan tool call. Returns normalized changes and human-readable errors (refused items are dropped). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function validatePlan(args: any): { plan: PlanInput; errors: string[] } {
  const errors: string[] = [];
  const raw: unknown[] = Array.isArray(args?.changes) ? args.changes : [];
  if (!raw.length) { errors.push('Plan has no changes.'); }
  if (raw.length > MAX_PLAN_FILES) { errors.push(`Plan has ${raw.length} changes; max is ${MAX_PLAN_FILES}. Split it.`); }
  const out: PlanChange[] = [];
  const touched = new Set<string>();
  for (const [i, c0] of raw.slice(0, MAX_PLAN_FILES).entries()) {
    const c = (c0 ?? {}) as Record<string, unknown>;
    const op = c.op as PlanOp;
    const where = `change ${i + 1}`;
    if (!['create', 'modify', 'delete', 'rename'].includes(op)) { errors.push(`${where}: unknown op "${String(c.op)}"`); continue; }
    const path = normPath(c.path);
    if (!path) { errors.push(`${where}: invalid path "${String(c.path)}" (must be workspace-relative, no ..)`); continue; }
    if (isSecretPath(path)) { errors.push(`${where}: refused ${path} (secrets/credentials file)`); continue; }
    let newPath: string | undefined;
    if (op === 'rename') {
      newPath = normPath(c.newPath);
      if (!newPath) { errors.push(`${where}: rename needs a valid newPath`); continue; }
      if (isSecretPath(newPath)) { errors.push(`${where}: refused rename to ${newPath} (secrets/credentials name)`); continue; }
      if (newPath === path) { errors.push(`${where}: rename to the same path`); continue; }
    }
    const content = typeof c.content === 'string' ? c.content : undefined;
    if ((op === 'create' || op === 'modify') && content === undefined) { errors.push(`${where}: ${op} needs content`); continue; }
    if (content !== undefined && content.length > MAX_PLAN_CONTENT) { errors.push(`${where}: content too large`); continue; }
    const keys = [path, ...(newPath ? [newPath] : [])].map(k => k.toLowerCase());
    if (keys.some(k => touched.has(k))) { errors.push(`${where}: ${path} is touched by more than one change`); continue; }
    keys.forEach(k => touched.add(k));
    out.push({ op, path, newPath, content: op === 'delete' ? undefined : content });
  }
  return { plan: { summary: typeof args?.summary === 'string' ? args.summary.slice(0, 500) : undefined, changes: out }, errors };
}

/** Indices the user approved, intersected with what exists. undefined → all. */
export function selectedIndices(n: number, selected?: number[]): number[] {
  const all = [...Array(n).keys()];
  if (!selected) { return all; }
  return [...new Set(selected)].filter(i => i >= 0 && i < n).sort((a, b) => a - b);
}

/** Simple stable hash for "changed since apply?" checks. */
export function hashText(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16) + ':' + s.length;
}
