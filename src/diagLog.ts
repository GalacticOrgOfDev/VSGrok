// Opt-in diagnostics log (pure; unit-tested). Only metadata: never the API key, prompts or file contents.

// Order matters: structured forms first, then bare tokens.
const RULES: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  // "api_key": "…", 'token': '…'  (JSON / JS object literals)
  [/(["']?(?:api[_-]?key|x-api-key|apikey|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|passwd|authorization)["']?\s*[:=]\s*)(["'])(?:\\.|(?!\2).)*\2/gi, (_m, k, q) => `${k}${q}[redacted]${q}`],
  // Authorization: Bearer|Basic|Token xxx
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{4,}/gi, '$1 [redacted]'],
  // x-api-key: xxx header
  [/\b(x-api-key|api-key)\s*:\s*\S+/gi, '$1: [redacted]'],
  // scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]*@/gi, '$1[redacted]@'],
  // ?key=…&token=… in URLs
  [/([?&](?:key|api[_-]?key|token|access_token|sig|signature|secret|password)=)[^&\s#"']+/gi, '$1[redacted]'],
  // key=value / key: value (unquoted)
  [/\b(api[_-]?key|token|secret|password|passwd)\s*[=:]\s*(?!\[redacted\])[^\s,;&"']+/gi, '$1=[redacted]'],
  // bare tokens
  [/xai-[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, '[redacted]'],
];

export function redact(s: string): string {
  let out = String(s);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const [re, rep] of RULES) { out = out.replace(re, rep as any); }
  return out;
}

/** Base URL for reports: origin + path only (no userinfo, query or fragment). */
export function sanitizeUrl(u: unknown): string {
  try { const x = new URL(String(u)); return `${x.protocol}//${x.host}${x.pathname}`; } catch { return '[invalid url]'; }
}

export type DiagFields = Record<string, string | number | boolean | undefined>;
/** Only short scalar fields are kept; long strings (possible content) are truncated. */
export function formatEntry(ts: Date, event: string, fields: DiagFields = {}): string {
  const parts = Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => {
    const t = typeof v === 'string' ? JSON.stringify(redact(v.length > 120 ? v.slice(0, 120) + '…' : v)) : String(v);
    return `${k}=${t}`;
  });
  return redact(`${ts.toISOString()} ${event}${parts.length ? ' ' + parts.join(' ') : ''}`);
}

export class RingLog {
  private lines: string[] = [];
  constructor(private readonly max = 500) {}
  push(line: string) { this.lines.push(line); if (this.lines.length > this.max) { this.lines.splice(0, this.lines.length - this.max); } }
  all(): string[] { return [...this.lines]; }
  clear() { this.lines = []; }
}
