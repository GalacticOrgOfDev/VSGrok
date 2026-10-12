// VSGrok diagnostics: opt-in (vsgrok.diagnostics.enabled, off by default), local only.
import * as vscode from 'vscode';
import { DiagFields, RingLog, formatEntry, redact } from './diagLog';
import { setRetryListener } from './xai/client';
import { cfg, SECRET_KEY } from './config';

const ring = new RingLog(500);
let file: vscode.Uri | undefined;
const pending: string[] = [];
let flushing = false;

export function diagEnabled(): boolean { return !!cfg().get<boolean>('diagnostics.enabled', false); }

/** Record an event (metadata only). No-op unless diagnostics are enabled. */
export function diag(event: string, fields?: DiagFields) {
  if (!diagEnabled()) { return; }
  const line = formatEntry(new Date(), event, fields);
  ring.push(line);
  if (file) { pending.push(line); void flush(); }
}

async function flush() {
  if (flushing || !file) { return; }
  flushing = true;
  try {
    while (pending.length) {
      const batch = pending.splice(0).join('\n') + '\n';
      let prev: Uint8Array = new Uint8Array();
      try { prev = await vscode.workspace.fs.readFile(file); } catch { /* new */ }
      const keep = prev.length > 1_000_000 ? prev.slice(prev.length - 500_000) : prev;
      await vscode.workspace.fs.writeFile(file, Buffer.concat([Buffer.from(keep), Buffer.from(batch)]));
    }
  } catch { /* diagnostics must never break the extension */ } finally { flushing = false; }
}

export function initDiagnostics(ctx: vscode.ExtensionContext) {
  file = vscode.Uri.joinPath(ctx.logUri, 'vsgrok-diagnostics.log');
  void vscode.workspace.fs.createDirectory(ctx.logUri).then(undefined, () => undefined);
  setRetryListener((i) => diag('xai.retry', { path: i.path, attempt: i.attempt, delayMs: i.delayMs, kind: i.kind, status: i.status }));
  diag('activate', { version: String(ctx.extension.packageJSON.version), vscode: vscode.version });
}

/** Text for 'VSGrok: Copy Diagnostics'. Settings are listed by name/value except anything key-like. */
export async function diagnosticsReport(ctx: vscode.ExtensionContext): Promise<string> {
  const c = cfg();
  const keys = ['model', 'api', 'baseUrl', 'responses.store', 'tools.webSearch', 'tools.xSearch', 'tools.codeExecution', 'reasoningEffort',
    'requestTimeoutSeconds', 'agent.enabledByDefault', 'agent.maxSteps', 'inlineCompletions.enabled', 'theme', 'checkForUpdates', 'diagnostics.enabled', 'index.enabled', 'index.maxFiles'];
  const hasKey = !!(await ctx.secrets.get(SECRET_KEY));
  const lines = [
    '# VSGrok diagnostics',
    `VSGrok ${ctx.extension.packageJSON.version} · VS Code ${vscode.version} · ${process.platform}-${process.arch} · ${vscode.env.appName} · remote: ${vscode.env.remoteName ?? 'none'}`,
    `API key set: ${hasKey ? 'yes' : 'no'}`,
    '',
    '## Settings',
    ...keys.map(k => `${k}: ${JSON.stringify(c.get(k))}`),
    '',
    `## Log (${diagEnabled() ? 'last ' + ring.all().length + ' events' : 'disabled; enable vsgrok.diagnostics.enabled to record events'})`,
    ...ring.all(),
  ];
  return redact(lines.join('\n'));
}
