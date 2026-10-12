// Terminal helper: when a command fails (shell integration, non-zero exit), show a subtle status bar item
// "Ask Grok"; one click sends the command, exit code and output tail to chat. No notifications.
import * as vscode from 'vscode';
import { ChatViewProvider } from './chat';
import { TailBuffer, isHelpableFailure, failurePrompt, Failure, MAX_READ_CHARS } from './terminalCore';

const HIDE_AFTER_MS = 3 * 60_000;

export class TerminalHelper implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subs: vscode.Disposable[] = [];
  private readonly buffers = new WeakMap<vscode.TerminalShellExecution, TailBuffer>();
  private last?: Failure & { terminal?: vscode.Terminal };
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly chat: ChatViewProvider) {
    this.item = vscode.window.createStatusBarItem('vsgrok.terminalHelper', vscode.StatusBarAlignment.Left, -100);
    this.item.name = 'VSGrok: Ask Grok about a failed command';
    this.item.command = 'vsgrok.askAboutTerminalFailure';
    this.subs.push(this.item);
    const w = vscode.window;
    if (w.onDidStartTerminalShellExecution) {
      this.subs.push(w.onDidStartTerminalShellExecution(e => this.onStart(e)));
      this.subs.push(w.onDidEndTerminalShellExecution(e => this.onEnd({
        terminal: e.terminal, commandLine: e.execution.commandLine.value, exitCode: e.exitCode,
        cwd: e.execution.cwd?.fsPath, output: this.buffers.get(e.execution)?.text() ?? '', shell: e.terminal.state.shell,
      })));
    }
    this.subs.push(w.onDidCloseTerminal(t => { if (this.last?.terminal === t) { this.clear(); } }));
    this.subs.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('vsgrok.terminalHelper.enabled') && !this.enabled()) { this.clear(); } }));
  }

  private enabled(): boolean { return vscode.workspace.getConfiguration('vsgrok').get<boolean>('terminalHelper.enabled', true); }

  private onStart(e: vscode.TerminalShellExecutionStartEvent) {
    if (!this.enabled()) { return; }
    const buf = new TailBuffer(); this.buffers.set(e.execution, buf);
    // M5: stop when the setting is turned off or after MAX_READ_CHARS (the tail captured so far is kept).
    void (async () => { try { for await (const d of e.execution.read()) { if (!this.enabled() || buf.total > MAX_READ_CHARS) { break; } buf.push(d); } } catch { /* stream closed */ } })();
  }

  /** Public for tests: the end-of-command handler with the execution's details. */
  onEnd(x: { terminal?: vscode.Terminal; commandLine: string; exitCode: number | undefined; cwd?: string; output: string; shell?: string }) {
    if (!this.enabled()) { return; }
    if (!isHelpableFailure(x.exitCode)) {
      if (x.exitCode === 0) { this.clear(); } // a later success in any terminal hides it
      return;
    }
    if (!x.commandLine.trim()) { return; }
    this.last = { ...x, exitCode: x.exitCode, at: Date.now() };
    const short = x.commandLine.trim().length > 40 ? x.commandLine.trim().slice(0, 37) + '…' : x.commandLine.trim();
    this.item.text = `$(sparkle) Ask Grok (exit ${x.exitCode})`;
    this.item.tooltip = new vscode.MarkdownString(`\`${short.replace(/`/g, "'")}\` exited with code ${x.exitCode}.\n\nClick to send the command and the last lines of output to Grok for a diagnosis and a proposed fix (you approve any change).\n\nTurn off with \`vsgrok.terminalHelper.enabled\`.`);
    this.item.accessibilityInformation = { label: `Ask Grok why ${short} failed with exit code ${x.exitCode}`, role: 'button' };
    this.item.show();
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => this.clear(), HIDE_AFTER_MS);
  }

  get visible(): boolean { return !!this.last; }
  get lastFailure(): Failure | undefined { return this.last; }

  clear() { this.last = undefined; this.item.hide(); if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } }

  /** Status bar click: send the failure to chat (agent on, so a fix comes back through the approval card). */
  async ask(): Promise<boolean> {
    const f = this.last;
    if (!f) { vscode.window.setStatusBarMessage('VSGrok: no failed terminal command to ask about', 3000); return false; }
    this.clear();
    const p = failurePrompt(f);
    await this.chat.injectQuery(p.text, { agent: true, hidden: p.hidden, display: p.display, sent: { label: `terminal output · ${p.lines} line${p.lines === 1 ? '' : 's'}`, items: [p.preview] } });
    return true;
  }

  dispose() { this.clear(); for (const s of this.subs) { s.dispose(); } }
}
