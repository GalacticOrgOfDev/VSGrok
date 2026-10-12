import { stripFences } from './sse';

/** Normalise model output for ghost text: strip fences, drop echoed prefix, trim overlap with suffix. */
export function cleanCompletion(raw: string, prefix: string, suffix: string): string {
  let s = stripFences(raw).replace(/<CURSOR>/g, '');
  const lastLine = prefix.slice(prefix.lastIndexOf('\n') + 1);
  if (lastLine.trim() && s.startsWith(lastLine)) { s = s.slice(lastLine.length); }
  const firstSuffixLine = suffix.split('\n')[0];
  if (firstSuffixLine.trim() && s.endsWith(firstSuffixLine)) { s = s.slice(0, s.length - firstSuffixLine.length); }
  return s;
}
