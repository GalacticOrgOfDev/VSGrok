// GitHub self-update: checks the latest GitHub release and offers an in-chat card to install its .vsix.
import * as vscode from 'vscode';
import { RELEASES_LATEST_URL, ReleaseInfo, isNewer, parseRelease, shouldCheck } from './updateCheck';
import { cfg } from './config';

const LAST_CHECK = 'vsgrok.update.lastCheck';

export interface UpdateUi {
  showUpdateCard(card: { state: 'available' | 'downloading' | 'installed' | 'error' | 'uptodate'; current: string; latest?: string; url?: string; notes?: string; msg?: string }): Promise<void>;
  onUpdateAction?: (action: string) => void;
}

export class Updater {
  private latest?: ReleaseInfo;
  constructor(private readonly ctx: vscode.ExtensionContext, private readonly ui: UpdateUi) {
    ui.onUpdateAction = (a) => { void this.onAction(a); };
  }

  get current(): string { return String(this.ctx.extension.packageJSON.version ?? '0.0.0'); }

  /** On activation: respects vsgrok.checkForUpdates and the 24h throttle. */
  async autoCheck() {
    if (!cfg().get<boolean>('checkForUpdates', true)) { return; }
    const now = Date.now();
    if (!shouldCheck(this.ctx.globalState.get<number>(LAST_CHECK), now)) { return; }
    await this.ctx.globalState.update(LAST_CHECK, now);
    try { await this.check(false); } catch { /* silent on auto-check */ }
  }

  /** VSGrok: Check for Updates. */
  async check(manual = true) {
    let info: ReleaseInfo | undefined;
    try {
      const r = await fetch(RELEASES_LATEST_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'VSGrok' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) { throw new Error(`GitHub returned ${r.status}`); }
      info = parseRelease(await r.json());
    } catch (e) {
      if (manual) { await this.ui.showUpdateCard({ state: 'error', current: this.current, msg: `Update check failed: ${(e as Error).message}` }); }
      return;
    }
    if (manual) { await this.ctx.globalState.update(LAST_CHECK, Date.now()); }
    if (info && isNewer(info.version, this.current)) {
      this.latest = info;
      await this.ui.showUpdateCard({ state: 'available', current: this.current, latest: info.version, url: info.url, notes: info.notes });
    } else if (manual) {
      await this.ui.showUpdateCard({ state: 'uptodate', current: this.current, latest: info?.version });
    }
  }

  private async onAction(a: string) {
    if (a === 'reload') { await vscode.commands.executeCommand('workbench.action.reloadWindow'); return; }
    if (a === 'notes' && this.latest?.url) { await vscode.env.openExternal(vscode.Uri.parse(this.latest.url)); return; }
    if (a !== 'update' || !this.latest) { return; }
    const info = this.latest;
    try {
      await this.ui.showUpdateCard({ state: 'downloading', current: this.current, latest: info.version });
      const r = await fetch(info.assetUrl, { headers: { 'User-Agent': 'VSGrok' }, redirect: 'follow', signal: AbortSignal.timeout(120000) });
      if (!r.ok) { throw new Error(`download returned ${r.status}`); }
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) { throw new Error('downloaded file is not a .vsix'); }
      await vscode.workspace.fs.createDirectory(this.ctx.globalStorageUri);
      const file = vscode.Uri.joinPath(this.ctx.globalStorageUri, `vsgrok-${info.version.replace(/[^\w.-]/g, '')}.vsix`);
      await vscode.workspace.fs.writeFile(file, bytes);
      await vscode.commands.executeCommand('workbench.extensions.installExtension', file);
      await this.ui.showUpdateCard({ state: 'installed', current: this.current, latest: info.version });
    } catch (e) {
      await this.ui.showUpdateCard({ state: 'error', current: this.current, latest: info.version, url: info.url, msg: `Update failed: ${(e as Error).message}` });
    }
  }
}
