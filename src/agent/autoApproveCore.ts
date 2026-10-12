// Background task ("Run task") auto-approval policy. Pure; unit-tested.
// Levels (vsgrok.agent.autoApprove): none · safeEdits · editsAndCommands. Deletes, renames, flagged or refused files,
// files outside the workspace and non-allowlisted commands always ask in chat.
import type { ApprovalRequest } from './approvals';

export type AutoLevel = 'none' | 'safeEdits' | 'editsAndCommands';
export const AUTO_LEVELS: AutoLevel[] = ['none', 'safeEdits', 'editsAndCommands'];

export const DEFAULT_COMMAND_ALLOWLIST = [
  'npm test', 'npm run test', 'npm run lint', 'npm run build', 'pnpm test', 'pnpm run test', 'pnpm lint', 'pnpm run lint',
  'yarn test', 'yarn lint', 'pytest', 'python -m pytest', 'go test ./...', 'go vet ./...', 'cargo test', 'cargo check',
];

export function parseLevel(v: unknown): AutoLevel { return AUTO_LEVELS.includes(v as AutoLevel) ? v as AutoLevel : 'none'; }

/** Shell metacharacters that could chain or redirect: any of these means "ask". */
const SHELL_META = /[;&|`$<>(){}\n\r\\*?!~]/;

/** Exact match against the allowlist after collapsing whitespace. No metacharacters, no extra arguments. */
export function commandAllowed(cmd: string, allowlist: readonly string[]): boolean {
  const c = String(cmd).trim().replace(/[ \t]+/g, ' ');
  if (!c || c.length > 200 || SHELL_META.test(c)) { return false; }
  return allowlist.some(a => typeof a === 'string' && a.trim().replace(/[ \t]+/g, ' ') === c);
}

export interface AutoContext { level: AutoLevel; allowlist: readonly string[]; /** An auto-approved edit touched a file test runners execute since the user last saw a command card. */ execDirty?: boolean; /** For edit requests: the path is a writable workspace file (symlinks resolved). */ writable?: boolean }

/** Decide whether a request is auto-approved. `why` explains a "no" for the task log. */
export function autoDecision(req: ApprovalRequest, ctx: AutoContext): { auto: boolean; why: string } {
  if (ctx.level === 'none') { return { auto: false, why: 'auto-approve is off' }; }
  switch (req.kind) {
    case 'edit':
      if (!ctx.writable) { return { auto: false, why: 'not a writable workspace file' }; }
      return { auto: true, why: req.isNew ? 'new file in the workspace' : 'edit in the workspace' };
    case 'plan': {
      if (!req.files.length) { return { auto: false, why: 'empty plan' }; }
      for (const f of req.files) {
        if (f.refused) { return { auto: false, why: `${f.path} was refused` }; }
        if (f.op === 'delete') { return { auto: false, why: `deletes ${f.path}` }; }
        if (f.op === 'rename') { return { auto: false, why: `renames ${f.path}` }; }
        if (f.warn) { return { auto: false, why: `${f.path}: ${f.warn}` }; }
      }
      return { auto: true, why: `${req.files.length} file(s), creates/edits only` };
    }
    case 'command':
      if (ctx.level !== 'editsAndCommands') { return { auto: false, why: 'commands need approval at this level' }; }
      if (!commandAllowed(req.command, ctx.allowlist)) { return { auto: false, why: 'command not on the allowlist' }; }
      if (ctx.execDirty) { return { auto: false, why: 'first command after auto-approved edits to files the tests run' }; }
      return { auto: true, why: 'allowlisted command' };
  }
  return { auto: false, why: req.kind === 'mcp' ? 'MCP tools always ask (unless always-allowed)' : 'unknown request' };
}

/** Task budget check after each model step. Returns a stop reason, or undefined to continue. */
export function budgetExceeded(spent: { tokens: number; costUsd?: number }, limits: { maxTokens: number; maxCostUsd: number }): string | undefined {
  if (limits.maxTokens > 0 && spent.tokens >= limits.maxTokens) { return `token budget of ${limits.maxTokens.toLocaleString('en-US')} reached`; }
  if (limits.maxCostUsd > 0 && spent.costUsd !== undefined && spent.costUsd >= limits.maxCostUsd) { return `cost budget of $${limits.maxCostUsd.toFixed(2)} reached`; }
  return undefined;
}
