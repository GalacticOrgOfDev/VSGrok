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
      if (readsCredentials(req.command)) { return { auto: false, why: 'reads stored credentials' }; }
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

/**
 * Commands that read stored credentials (tokens, passwords, keys). Flagged in red on the command card and never
 * auto-approved. Returns a short description, or undefined. Heuristic; the card is still the user's decision.
 */
const CRED_PATTERNS: [RegExp, string][] = [
  [/\bgit(?:\.exe)?(?:\s+-[cC]\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+credential(?:-[\w-]+)?\s+(?:[^|;&\n]*\s)?(?:fill|get)\b/i, 'git credential helper (stored Git passwords/tokens)'],
  [/\bgit-credential-[\w-]+(?:\.exe)?\s+(?:get|fill)\b/i, 'git credential helper (stored Git passwords/tokens)'],
  [/\bgh(?:\.exe)?\s+auth\s+(?:token\b|status\b[^|;&\n]*(?:--show-token|-t\b))/i, 'GitHub CLI token'],
  [/\bsecurity\s+find-(?:generic|internet)-password\b/i, 'macOS Keychain password'],
  [/\b(?:cmdkey(?:\.exe)?\s+\/list|vaultcmd|Get-StoredCredential|PasswordVault|CredRead|Get-Secret\b)/i, 'Windows Credential Manager'],
  [/\bsecret-tool\s+lookup\b|\bkeyring\s+get\b|\bpass\s+show\b|\bop\s+(?:read|item\s+get)\b/i, 'system keyring / password manager'],
  [/\b(?:gcloud\s+auth\s+(?:print-access-token|application-default\s+print-access-token)|az\s+account\s+get-access-token|aws\s+(?:configure\s+get|sts\s+get-session-token|ecr\s+get-login-password)|npm\s+token\s+list)\b/i, 'cloud / registry access token'],
  [/(?:^|[\s"'(=])(?:~|\$HOME|%USERPROFILE%|\$env:USERPROFILE)?[\\/]?[^\s"']*(?:\.git-credentials|\.netrc|_netrc|\.npmrc|\.pypirc|\.aws[\\/]credentials|\.docker[\\/]config\.json|gh[\\/]hosts\.ya?ml|\.ssh[\\/]id_[\w-]+(?!\.pub\b))(?=$|[\s"')])/i, 'credential file'],
  [/\b(?:printenv|echo|Write-(?:Host|Output))\b[^|;&\n]*(?:\$\{?|%|\$env:)?\w*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|_PAT)\w*/i, 'environment secret'],
  [/\b(?:env|printenv|set|Get-ChildItem\s+env:|gci\s+env:|dir\s+env:)\s*(?:\|\s*(?:grep|findstr|Select-String|sls)\b[^|;&\n]*)(?:TOKEN|SECRET|PASSWORD|KEY|PAT)/i, 'environment secret'],
  [/process\.env\.\w*(?:TOKEN|SECRET|PASSWORD|API_?KEY|_PAT)\w*|os\.environ(?:\.get)?\W+\w*(?:TOKEN|SECRET|PASSWORD|API_?KEY)/i, 'environment secret read by a script'],
];
export function readsCredentials(command: string): string | undefined {
  const c = String(command ?? '');
  for (const [re, what] of CRED_PATTERNS) { if (re.test(c)) { return what; } }
  return undefined;
}
