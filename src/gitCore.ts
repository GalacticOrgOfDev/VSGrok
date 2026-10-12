// Git help (pure, unit-tested): secret-safe diff filtering, prompts, file/line link parsing.
import { isSecretPath } from './index/lexical';
import { redact } from './diagLog';

export const MAX_DIFF_CHARS = 120_000;
export const MAX_FILE_DIFF_CHARS = 20_000;

export interface FilteredDiff { text: string; files: string[]; dropped: string[]; truncated: string[] }

function sectionPath(header: string): string {
  // diff --git a/x b/y  (quotepath off) — prefer the b/ side; fall back to a/.
  const m = header.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/);
  return m ? m[2] : header.replace(/^diff --git /, '');
}

/** Drop sections for secret files (either side of a rename), cap each file and the total, and redact key-like strings. */
export function filterDiff(diff: string, maxTotal = MAX_DIFF_CHARS, maxFile = MAX_FILE_DIFF_CHARS): FilteredDiff {
  const out: string[] = []; const files: string[] = []; const dropped: string[] = []; const truncated: string[] = [];
  const parts = diff.split(/^(?=diff --git )/m).filter(p => p.trim());
  let total = 0;
  for (const part of parts) {
    const header = part.split('\n', 1)[0];
    if (!header.startsWith('diff --git ')) { continue; }
    const m = header.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/);
    const paths = m ? [m[1], m[2]] : [sectionPath(header)];
    const p = paths[paths.length - 1];
    if (paths.some(x => isSecretPath(x))) { dropped.push(p); continue; }
    let body = part;
    if (/^Binary files /m.test(body) || /^GIT binary patch/m.test(body)) { body = header + '\n(binary file changed)\n'; }
    if (body.length > maxFile) { body = body.slice(0, maxFile) + '\n…[file diff truncated]\n'; truncated.push(p); }
    if (total + body.length > maxTotal) { truncated.push(p); out.push(`${header}\n…[omitted: diff budget reached]\n`); files.push(p); continue; }
    total += body.length; out.push(body); files.push(p);
  }
  return { text: redact(out.join('')), files, dropped, truncated };
}

export function droppedNote(f: FilteredDiff): string {
  const n: string[] = [];
  if (f.dropped.length) { n.push(`Omitted (secret files, never sent): ${f.dropped.join(', ')}`); }
  if (f.truncated.length) { n.push(`Truncated: ${f.truncated.join(', ')}`); }
  return n.join('\n');
}

export const COMMIT_SYSTEM = 'Write a git commit message for the staged diff. subject: conventional-commit style (feat/fix/refactor/docs/test/chore/…, optional scope), imperative, under 72 characters, no trailing period. body: short bullet points explaining what changed and why, only if they add information beyond the subject. Match the style of the recent commits when they are given. If the user\'s draft is given, keep its intent. Never invent issue numbers.';
export const COMMIT_SYSTEM_CHAT = COMMIT_SYSTEM + ' Output only the message (subject, blank line, bullets), no fences.';

export function commitUserPrompt(o: { diff: FilteredDiff; recent: string[]; draft?: string; branch?: string }): string {
  const s: string[] = [];
  if (o.branch) { s.push(`Branch: ${o.branch}`); }
  if (o.recent.length) { s.push('Recent commit subjects (style reference):\n' + o.recent.slice(0, 10).map(r => '- ' + redact(r)).join('\n')); }
  if (o.draft?.trim()) { s.push('User\'s draft message:\n' + redact(o.draft.trim())); }
  const note = droppedNote(o.diff); if (note) { s.push(note); }
  s.push('Staged diff:\n' + o.diff.text);
  return s.join('\n\n');
}

export const LINK_RULE = 'When you refer to a place in the code, link it as a Markdown link whose target is the workspace-relative path plus #L<line>, e.g. [src/app.ts:42](src/app.ts#L42). Only link files that appear in the diff.';

export function reviewPrompt(o: { files: string[]; note: string; untracked: string[] }): string {
  return [
    'Review my uncommitted changes (the diff is attached below). Look for bugs, regressions, security problems, missing error handling, missing tests and unclear code. Group findings by severity (high / medium / low), each with a file/line link and a concrete suggested fix. Be brief about things that are fine. Do not edit files unless I ask.',
    LINK_RULE,
    `Changed files: ${o.files.join(', ') || '(none)'}${o.untracked.length ? `\nNew untracked files: ${o.untracked.join(', ')}` : ''}`,
    o.note,
  ].filter(Boolean).join('\n\n');
}

export const PR_SYSTEM = 'Write a pull request description in GitHub Markdown for the given branch diff and commits. Sections: a one-line title as "# <title>", "## Summary" (2-4 sentences), "## Changes" (bullets grouped by area), "## Testing" (how it was or should be tested, based on the diff), and "## Notes" only for risks, migrations or follow-ups. Do not invent issue numbers or results. Output only the Markdown.';

export function prUserPrompt(o: { base: string; branch: string; commits: string[]; diff: FilteredDiff; stat: string }): string {
  return [
    `Branch ${o.branch} → ${o.base}`,
    o.commits.length ? 'Commits:\n' + o.commits.map(c => '- ' + redact(c)).join('\n') : 'Commits: (none yet — describe the working-tree changes)',
    o.stat ? 'Diffstat:\n' + redact(o.stat) : '',
    droppedNote(o.diff),
    'Diff:\n' + o.diff.text,
  ].filter(Boolean).join('\n\n');
}

/** A link target from chat markdown that points at a workspace file: "src/a.ts#L12", "src/a.ts#L12-L20", "src/a.ts:12". */
export function parseFileLink(href: string): { path: string; line?: number; endLine?: number } | undefined {
  const h = href.trim();
  if (!h || /^[a-z][a-z0-9+.-]*:\/\//i.test(h) || /^(mailto|javascript|data|vbscript|command):/i.test(h) || h.startsWith('#')) { return undefined; }
  let m = h.match(/^(.+?)#L(\d+)(?:-L?(\d+))?$/);
  if (!m) { m = h.match(/^(.+?):(\d+)(?:-(\d+))?$/); }
  const raw = (m ? m[1] : h).replace(/^\.\//, '');
  let path: string; try { path = decodeURIComponent(raw); } catch { path = raw; }
  if (!path || path.startsWith('/') || /^[a-z]:[\\/]/i.test(path) || path.split(/[\\/]/).includes('..')) { return undefined; }
  const line = m ? Number(m[2]) : undefined; const endLine = m?.[3] ? Number(m[3]) : undefined;
  return { path, line: line && line > 0 ? line : undefined, endLine: endLine && line && endLine >= line ? endLine : undefined };
}

/** FM7: repo-local filter/diff drivers run commands during working-tree diffs. Given
 *  `git config --local --get-regexp` output, return -c overrides that blank every such command. */
export const DRIVER_CONFIG_RE = '^(filter|diff)\\..*\\.(clean|smudge|process|textconv|command)$';
export function driverOverrides(configOut: string): string[] {
  const keys = new Set<string>();
  for (const line of configOut.split('\n')) {
    const m = line.split(/\s/, 1)[0].match(/^(filter|diff)\.(.+)\.(clean|smudge|process|textconv|command)$/i);
    if (!m) { continue; }
    keys.add(`${m[1]}.${m[2]}.${m[3]}=`);
    if (m[1].toLowerCase() === 'filter') { keys.add(`filter.${m[2]}.required=false`); }
  }
  return [...keys].flatMap(k => ['-c', k]);
}

export function diffLineStats(diff: string): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const l of diff.split('\n')) { if (l.startsWith('+') && !l.startsWith('+++')) { added++; } else if (l.startsWith('-') && !l.startsWith('---')) { removed++; } }
  return { added, removed };
}
