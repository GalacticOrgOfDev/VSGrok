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
export function parseRelease(j: any): ReleaseInfo | undefined {
  if (!j || j.draft || j.prerelease || typeof j.tag_name !== 'string') { return undefined; }
  const assets: { name?: string; browser_download_url?: string }[] = Array.isArray(j.assets) ? j.assets : [];
  const a = assets.find(x => typeof x.name === 'string' && x.name.toLowerCase().endsWith('.vsix') && typeof x.browser_download_url === 'string'
    && /^https:\/\/github\.com\/GalacticOrgOfDev\/VSGrok\/releases\/download\//i.test(x.browser_download_url));
  if (!a) { return undefined; }
  return { version: j.tag_name.replace(/^v/, ''), tag: j.tag_name, url: String(j.html_url ?? ''), notes: String(j.body ?? '').slice(0, 2000), assetUrl: a.browser_download_url!, assetName: a.name! };
}
