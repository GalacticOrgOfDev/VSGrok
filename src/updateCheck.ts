// Pure helpers for the GitHub self-update (no vscode import; unit-tested).

export const RELEASES_LATEST_URL = 'https://api.github.com/repos/GalacticOrgOfDev/VSGrok/releases/latest';
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface Sem { core: number[]; pre: string[] }
function parse(v: string): Sem | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v).trim());
  if (!m) { return undefined; }
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** semver compare: <0 if a<b, 0 equal, >0 if a>b. Invalid versions sort lowest. Build metadata ignored. */
export function compareSemver(a: string, b: string): number {
  const x = parse(a), y = parse(b);
  if (!x || !y) { return x ? 1 : y ? -1 : 0; }
  for (let i = 0; i < 3; i++) { if (x.core[i] !== y.core[i]) { return x.core[i] - y.core[i]; } }
  if (!x.pre.length || !y.pre.length) { return y.pre.length - x.pre.length; } // release > prerelease
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) { return -1; }
    if (q === undefined) { return 1; }
    if (p === q) { continue; }
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) { return Number(p) - Number(q); }
    if (pn) { return -1; }
    if (qn) { return 1; }
    return p < q ? -1 : 1;
  }
  return 0;
}

export function isNewer(latest: string, current: string): boolean { return compareSemver(latest, current) > 0; }

export function shouldCheck(lastCheckMs: number | undefined, nowMs: number, intervalMs = CHECK_INTERVAL_MS): boolean {
  return !lastCheckMs || nowMs - lastCheckMs >= intervalMs || nowMs < lastCheckMs;
}

export interface ReleaseInfo { version: string; tag: string; url: string; notes: string; assetUrl: string; assetName: string }

/** Extract what we need from a GitHub "latest release" response; undefined if no .vsix asset or draft/prerelease. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseRelease(j: any, assetPrefix = 'https://github.com/GalacticOrgOfDev/VSGrok/releases/download/'): ReleaseInfo | undefined {
  if (!j || j.draft || j.prerelease || typeof j.tag_name !== 'string') { return undefined; }
  const assets: { name?: string; browser_download_url?: string }[] = Array.isArray(j.assets) ? j.assets : [];
  const a = assets.find(x => typeof x.name === 'string' && x.name.toLowerCase().endsWith('.vsix') && typeof x.browser_download_url === 'string'
    && x.browser_download_url.toLowerCase().startsWith(assetPrefix.toLowerCase()));
  if (!a) { return undefined; }
  return { version: j.tag_name.replace(/^v/, ''), tag: j.tag_name, url: String(j.html_url ?? ''), notes: String(j.body ?? '').slice(0, 2000), assetUrl: a.browser_download_url!, assetName: a.name! };
}

/** A different installed version (update, downgrade, first run) clears the 24h throttle. */
export function versionChanged(stored: string | undefined, current: string): boolean { return stored !== current; }

/** Human-readable message for anything thrown (Error, string, {message}, {code}, undefined). Never returns "undefined". */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function describeError(e: any): string {
  if (e === undefined || e === null) { return 'unknown error (no details)'; }
  if (typeof e === 'string') { return e || 'unknown error (empty message)'; }
  const parts: string[] = [];
  const msg = typeof e.message === 'string' && e.message ? e.message : '';
  if (msg) { parts.push(msg); }
  const cause = e.cause;
  if (cause) { const c = typeof cause === 'object' ? (cause.code ? `${cause.code}${cause.message ? ' ' + cause.message : ''}` : cause.message) : String(cause); if (c && !msg.includes(String(c))) { parts.push(`(${c})`); } }
  if (!msg && e.code) { parts.push(String(e.code)); }
  if (!parts.length) {
    if (e.name && e.name !== 'Error') { parts.push(String(e.name)); }
    else { try { const j = JSON.stringify(e); if (j && j !== '{}') { parts.push(j.slice(0, 300)); } } catch { /* circular */ } }
  }
  if (!parts.length) { const s = String(e); parts.push(s && s !== '[object Object]' ? s : 'unknown error (no details)'); }
  return parts.join(' ');
}

/** Hosts a release-asset download may land on after GitHub's redirect. The first URL must still pass parseRelease's allowlist. */
export const DOWNLOAD_REDIRECT_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com']);
export function isAllowedRedirect(url: string, testOrigin?: string): boolean {
  try {
    const u = new URL(url);
    if (testOrigin && u.origin === testOrigin) { return true; }
    return u.protocol === 'https:' && DOWNLOAD_REDIRECT_HOSTS.has(u.hostname.toLowerCase());
  } catch { return false; }
}

/** Steps of the self-update, named in error messages. */
export type UpdateStep = 'checking GitHub' | 'downloading' | 'verifying download' | 'saving to extension storage' | 'installing';
export function stepError(step: UpdateStep, e: unknown, status?: number): string {
  return `Update failed while ${step}${status ? ` (HTTP ${status})` : ''}: ${describeError(e)}`;
}
