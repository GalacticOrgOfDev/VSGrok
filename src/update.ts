// GitHub self-update: checks the latest GitHub release and offers an in-chat card to install its .vsix.
import * as vscode from 'vscode';
import { RELEASES_LATEST_URL, ReleaseInfo, isNewer, parseRelease, shouldCheck, versionChanged, describeError, isAllowedRedirect, stepError, UpdateStep } from './updateCheck';
import { cfg } from './config';
import { diag } from './diagnostics';

const LAST_CHECK = 'vsgrok.update.lastCheck';
const LAST_VERSION = 'vsgrok.update.lastVersion';
/** Integration tests point the updater at a local mock (only when VSGROK_TEST=1). */
const TEST = (__VSGROK_TEST__ && process.env.VSGROK_TEST === '1') && process.env.VSGROK_TEST_RELEASES_URL;
const latestUrl = () => (TEST ? process.env.VSGROK_TEST_RELEASES_URL! : RELEASES_LATEST_URL);
const assetPrefix = () => (TEST ? new URL(process.env.VSGROK_TEST_RELEASES_URL!).origin + '/' : undefined);

export interface UpdateUi {
  showUpdateCard(card: { state: 'available' | 'downloading' | 'installed' | 'error' | 'uptodate'; current: string; latest?: string; url?: string; notes?: string; msg?: string }): Promise<void>;
  onUpdateAction?: (action: string) => void;
}

export class Updater {
  private latest?: ReleaseInfo;
  constructor(private readonly ctx: vscode.ExtensionContext, private readonly ui: UpdateUi) {
    ui.onUpdateAction = (a) => { void this.onAction(a); };
    if (versionChanged(ctx.globalState.get<string>(LAST_VERSION), this.current)) {
      void ctx.globalState.update(LAST_CHECK, undefined);
      void ctx.globalState.update(LAST_VERSION, this.current);
      diag('update.versionChanged', { current: this.current });
    }
  }

  private checking?: Promise<void>;

  get current(): string { return String(this.ctx.extension.packageJSON.version ?? '0.0.0'); }

  /** On activation: respects vsgrok.checkForUpdates and the 24h throttle. */
  async autoCheck() {
    if (!cfg().get<boolean>('checkForUpdates', true)) { return; }
    const now = Date.now();
    if (!shouldCheck(this.ctx.globalState.get<number>(LAST_CHECK), now)) { return; }
    if (this.checking) { return this.checking; }
    await this.ctx.globalState.update(LAST_CHECK, now);
    this.checking = this.check(false).catch(() => undefined).finally(() => { this.checking = undefined; });
    return this.checking;
  }

  /** VSGrok: Check for Updates. */
  async check(manual = true) {
    let info: ReleaseInfo | undefined;
    try {
      const r = await fetch(latestUrl(), { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `VSGrok/${this.current} (+https://github.com/GalacticOrgOfDev/VSGrok)`, 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(15000) });
      if (r.status === 404) { info = undefined; } else if (!r.ok) {
        const why = r.status === 403 || r.status === 429 ? ' (GitHub API rate limit; try again later)' : '';
        throw new Error(`GitHub returned HTTP ${r.status}${why}`);
      }
      else { info = parseRelease(await r.json(), assetPrefix()); }
    } catch (e) {
      if (manual) { await this.ui.showUpdateCard({ state: 'error', current: this.current, msg: `Update check failed: ${describeError(e)}` }); }
      return;
    }
    diag('update.check', { manual, latest: info?.version, current: this.current });
    if (manual) { await this.ctx.globalState.update(LAST_CHECK, Date.now()); }
    if (info && isNewer(info.version, this.current)) {
      this.latest = info;
      await this.ui.showUpdateCard({ state: 'available', current: this.current, latest: info.version, url: info.url, notes: info.notes });
    } else if (manual) {
      await this.ui.showUpdateCard({ state: 'uptodate', current: this.current, latest: info?.version });
    }
  }

  /** Test hook: install a specific release (VSGROK_TEST only). */
  async testInstall(info: ReleaseInfo) { if (__VSGROK_TEST__) { this.latest = info; await this.onAction('update'); } }

  private async onAction(a: string) {
    if (a === 'reload') { await vscode.commands.executeCommand('workbench.action.reloadWindow'); return; }
    if (a === 'notes' && this.latest?.url) { await vscode.env.openExternal(vscode.Uri.parse(this.latest.url)); return; }
    if (a !== 'update' || !this.latest) { return; }
    const info = this.latest;
    let step: UpdateStep = 'downloading';
    let status: number | undefined;
    try {
      await this.ui.showUpdateCard({ state: 'downloading', current: this.current, latest: info.version });
      const bytes = await this.download(info.assetUrl, (st) => { status = st; });
      status = undefined;
      step = 'verifying download';
      if (bytes.length < 1024 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) { throw new Error(`not a .vsix (got ${bytes.length} bytes)`); }
      step = 'saving to extension storage';
      const dir = await this.downloadDir();
      await vscode.workspace.fs.createDirectory(dir);
      const file = vscode.Uri.joinPath(dir, `vsgrok-${info.version.replace(/[^\w.-]/g, '')}.vsix`);
      await vscode.workspace.fs.writeFile(file, bytes);
      step = 'installing';
      diag('update.install', { version: info.version, bytes: bytes.length, scheme: file.scheme });
      await vscode.commands.executeCommand('workbench.extensions.installExtension', file);
      await this.ui.showUpdateCard({ state: 'installed', current: this.current, latest: info.version });
    } catch (e) {
      const msg = stepError(step, e, status);
      diag('update.failed', { step, status, error: describeError(e) });
      await this.ui.showUpdateCard({ state: 'error', current: this.current, latest: info.version, url: info.url, msg });
    }
  }

  /**
   * VS Code's VSIX installer only accepts file: (or vscode-remote:) URIs and rejects anything else with the bare string
   * "No Servers". globalStorageUri is vscode-userdata: on current desktop builds, so use it only when it is file:.
   */
  private async downloadDir(): Promise<vscode.Uri> {
    const g = this.ctx.globalStorageUri;
    if (g.scheme === 'file') { return vscode.Uri.joinPath(g, 'updates'); }
    const os = await import('os'); const path = await import('path');
    return vscode.Uri.file(path.join(os.tmpdir(), 'vsgrok-updates'));
  }

  /** Download with manual redirects: the first URL was allowlisted by parseRelease; each hop must be an allowed GitHub host. */
  private async download(url: string, onStatus: (s: number) => void): Promise<Uint8Array> {
    const testOrigin = TEST ? new URL(process.env.VSGROK_TEST_RELEASES_URL!).origin : undefined;
    let current = url;
    for (let hop = 0; hop < 5; hop++) {
      const r = await fetch(current, { headers: { 'User-Agent': `VSGrok/${this.current}`, Accept: 'application/octet-stream' }, redirect: 'manual', signal: AbortSignal.timeout(120000) });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc) { onStatus(r.status); throw new Error('redirect without a Location header'); }
        const next = new URL(loc, current).toString();
        if (!isAllowedRedirect(next, testOrigin)) { onStatus(r.status); throw new Error(`refused redirect to ${new URL(next).host}`); }
        current = next;
        continue;
      }
      if (!r.ok) { onStatus(r.status); throw new Error(`download returned HTTP ${r.status}`); }
      return new Uint8Array(await r.arrayBuffer());
    }
    throw new Error('too many redirects');
  }
}
