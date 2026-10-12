// Opt-in diagnostics log (pure; unit-tested). Only metadata: never the API key, prompts or file contents.

const KEY_PATTERNS: RegExp[] = [
  /xai-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(api[_-]?key|token|secret|password)\s*[=:]\s*\S+/gi,
];

export function redact(s: string): string {
  let out = String(s);
  for (const re of KEY_PATTERNS) { out = out.replace(re, (m) => (/^(api|token|secret|password)/i.test(m) ? m.split(/[=:]/)[0] + '=[redacted]' : '[redacted]')); }
  return out;
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
