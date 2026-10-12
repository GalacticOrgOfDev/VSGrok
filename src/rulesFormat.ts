// Pure helpers for project rules (VSGrok.md / .vsgrok/rules.md).
const MAX_RULES_CHARS = 20_000;

export interface ProjectRules { files: string[]; text: string; hash: string; truncated: boolean }

export function formatRules(parts: { file: string; text: string }[]): ProjectRules | undefined {
  const used = parts.filter(p => p.text.trim());
  if (!used.length) { return undefined; }
  let text = used.map(p => `--- ${p.file} ---\n${p.text.trim()}`).join('\n\n');
  const truncated = text.length > MAX_RULES_CHARS;
  if (truncated) { text = text.slice(0, MAX_RULES_CHARS) + '\n…[project rules truncated]'; }
  let h = 0; for (let i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; }
  return { files: used.map(p => p.file), text, hash: String(h >>> 0), truncated };
}

export function rulesPrompt(r: ProjectRules | undefined): string {
  return r ? `\n\nProject instructions from ${r.files.join(' and ')} (written by the user for this repository; follow them unless they conflict with safety or the user's latest message):\n${r.text}` : '';
}

