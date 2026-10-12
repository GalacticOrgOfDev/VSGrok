import * as vscode from 'vscode';
let item: vscode.StatusBarItem | undefined;
let count = 0;
export function initStatus(ctx: vscode.ExtensionContext) {
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'VSGrokView.focus';
  ctx.subscriptions.push(item);
  render();
  item.show();
}
export function setBusy(b: boolean) { count = Math.max(0, count + (b ? 1 : -1)); render(); }
function render() {
  if (!item) { return; }
  const inline = vscode.workspace.getConfiguration('vsgrok').get<boolean>('inlineCompletions.enabled');
  item.text = count ? '$(sync~spin) Grok' : `$(hubot) Grok${inline ? '' : ' (inline off)'}`;
  item.tooltip = count ? 'Grok is working…' : 'VSGrok — click to open chat';
}
export function refreshStatus() { render(); }
