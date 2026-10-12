// Sidebar chat webview provider: streaming, context chips, code actions, agent mode, stop.
import * as vscode from 'vscode';
import { streamChat, ChatMessage, GrokApiError, TextPart, ImagePart } from './xai/client';
import { requestOptions, cfg, clampNum } from './config';
import { TOOL_SPECS, executeTool } from './agent/tools';
import { proposeEdit, proposeRangeEdit } from './proposals';
import { setBusy } from './status';

const MAX_FILE_CHARS = 100_000;
const MAX_HISTORY = 40;

export const SYSTEM_PROMPT =
  'You are Grok, built by xAI, running inside the VS Code extension VSGrok as a coding assistant. ' +
  'Be accurate and concise. Always use fenced code blocks with a language tag. ' +
  'When you give a full replacement for a file, put `path=<workspace-relative path>` after the language in the fence, e.g. ```ts path=src/a.ts. ' +
  'Never claim to have changed files unless a tool result says the edit was applied.';

const AGENT_PROMPT =
  ' Agent mode is on: you can call tools to read files, list and search the workspace, propose edits ' +
  '(the user reviews a diff and must accept) and run terminal commands (the user must confirm). ' +
  'Inspect before editing. Prefer small, correct changes. Summarise what you did at the end.';

interface ContextItem {
  id: string;
  kind: 'file' | 'selection' | 'folder';
  uri: vscode.Uri;
  range?: vscode.Range;
  implicit?: boolean;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'VSGrokView';
  private view?: vscode.WebviewView;
  private ready = false;
  private readyWaiters: (() => void)[] = [];
  private history: ChatMessage[] = [];
  private contexts: ContextItem[] = [];
  private implicitSel?: ContextItem;
  private abort?: AbortController;
  private cts?: vscode.CancellationTokenSource;
  private busy = false;
  private lastUser?: { text: string; images?: string[] };
  private seq = 0;
  private agentMode = false;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.agentMode = cfg().get<boolean>('agent.enabledByDefault') ?? false;
    ctx.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.pushEditorState()),
      vscode.window.onDidChangeTextEditorSelection(() => this.pushEditorState()),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const webRoot = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'webview');
    view.webview.options = { enableScripts: true, localResourceRoots: [webRoot] };
    view.webview.html = this.html(view.webview, webRoot);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m).catch(e => this.post({ type: 'toast', msg: String(e?.message ?? e) })));
    view.onDidDispose(() => { this.view = undefined; this.ready = false; });
  }

  private html(webview: vscode.Webview, root: vscode.Uri): string {
    const nonce = [...Array(32)].map(() => Math.floor(Math.random() * 36).toString(36)).join('');
    const u = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${u('style.css')}"><title>VSGrok</title></head>
<body>
<div id="header"><div class="header-left"><span class="dot" aria-hidden="true"></span><span class="brand">VSGrok</span></div>
<div class="header-right">
<label class="agent-toggle" title="Agent mode: Grok may read/search files, propose diffs and request commands"><input type="checkbox" id="agent"> Agent</label>
<input id="model" class="h-input" aria-label="Model" spellcheck="false">
<button id="settings-btn" class="h-btn" aria-label="Settings" aria-expanded="false">⚙</button>
<button id="clear-btn" class="h-btn" aria-label="New chat">New</button></div></div>
<div id="settings-panel">
<div class="slider-row"><label for="temperature">Temperature</label><input type="range" id="temperature" min="0" max="2" step="0.05"><span class="val" id="temperature-val"></span></div>
<div class="slider-row"><label for="maxTokens">Max tokens</label><input type="range" id="maxTokens" min="256" max="32768" step="256"><span class="val" id="maxTokens-val"></span></div>
<button id="setkey-btn" class="h-btn">Set API Key</button></div>
<div id="messages-wrap"><div id="messages" role="log" aria-live="polite"></div><button id="new-output" class="pill" hidden>↓ New output</button><div id="sr-announce" class="sr-only" aria-live="polite"></div></div>
<div id="chips"></div>
<div id="composer"><button id="add-ctx" class="h-btn" aria-label="Add context">+ Context</button>
<textarea id="input" rows="1" placeholder="Ask Grok… (Enter to send, Shift+Enter for newline)" aria-label="Message"></textarea>
<button id="send" class="send" aria-label="Send">➤</button></div>
<script nonce="${nonce}" src="${u('marked.min.js')}"></script>
<script nonce="${nonce}" src="${u('purify.min.js')}"></script>
<script nonce="${nonce}" src="${u('main.js')}"></script>
</body></html>`;
  }

  private post(msg: unknown) { void this.view?.webview.postMessage(msg); }

  private waitReady(): Promise<void> {
    if (this.ready) { return Promise.resolve(); }
    return new Promise(res => this.readyWaiters.push(res));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async onMessage(m: any) {
    switch (m?.type) {
      case 'ready': {
        this.ready = true;
        this.pushSettings(); this.pushEditorState(); this.pushContexts();
        this.readyWaiters.splice(0).forEach(r => r());
        break;
      }
      case 'query': if (typeof m.text === 'string') { await this.send(m.text, Array.isArray(m.images) ? m.images.filter((s: unknown) => typeof s === 'string' && /^data:image\/(png|jpe?g);base64,/.test(s as string)) : undefined); } break;
      case 'stop': this.stop(); break;
      case 'regenerate': if (this.lastUser && !this.busy) {
        while (this.history.length && this.history[this.history.length - 1].role !== 'user') { this.history.pop(); }
        this.history.pop();
        await this.send(this.lastUser.text, this.lastUser.images);
      } break;
      case 'clearChat': this.stop(); this.history = []; this.post({ type: 'chatCleared' }); break;
      case 'updateSettings': await this.updateSettings(m); break;
      case 'setApiKey': await vscode.commands.executeCommand('vsgrok.setApiKey'); break;
      case 'insertCode': await this.insertCode(String(m.code ?? '')); break;
      case 'applyDiff': {
        const r = await this.applyDiff(String(m.code ?? ''), typeof m.targetPath === 'string' ? m.targetPath : undefined);
        this.post({ type: 'applyResult', blockId: m.blockId, ...r });
        break;
      }
      case 'pickContext': await this.pickContext(); break;
      case 'dropFiles': if (Array.isArray(m.uris)) { for (const s of m.uris) { try { await this.addFileContext(vscode.Uri.parse(String(s))); } catch { /* ignore */ } } } break;
      case 'openContext': {
        const c = this.findContext(String(m.id));
        if (c) { const ed = await vscode.window.showTextDocument(c.uri, { preview: true }); if (c.range) { ed.selection = new vscode.Selection(c.range.start, c.range.end); ed.revealRange(c.range); } }
        break;
      }
      case 'pinContext': if (this.implicitSel && this.implicitSel.id === m.id) { this.contexts.push({ ...this.implicitSel, implicit: false, id: `c${++this.seq}` }); this.pushContexts(); } break;
      case 'removeContext': this.contexts = this.contexts.filter(c => c.id !== m.id); this.pushContexts(); break;
      case 'setAgent': this.agentMode = !!m.enabled; break;
      case 'copyMessage': break;
    }
  }

  private findContext(id: string) { return this.contexts.find(c => c.id === id) ?? (this.implicitSel?.id === id ? this.implicitSel : undefined); }

  private async updateSettings(m: { model?: unknown; temperature?: unknown; maxTokens?: unknown }) {
    const c = cfg();
    const target = vscode.ConfigurationTarget.Global;
    if (typeof m.model === 'string' && /^[\w.:-]{1,80}$/.test(m.model.trim())) { await c.update('model', m.model.trim(), target); }
    if (m.temperature !== undefined) { await c.update('temperature', clampNum(m.temperature, 0, 2, 0.3), target); }
    if (m.maxTokens !== undefined) { await c.update('maxTokens', Math.round(clampNum(m.maxTokens, 1, 131072, 8192)), target); }
  }

  pushSettings() {
    const c = cfg();
    this.post({ type: 'settings', model: c.get('model'), temperature: c.get('temperature'), maxTokens: c.get('maxTokens'), agent: this.agentMode });
  }

  private pushEditorState() {
    const ed = vscode.window.activeTextEditor;
    const prevId = this.implicitSel?.id;
    if (ed && !ed.selection.isEmpty && ed.document.uri.scheme === 'file') {
      this.implicitSel = { id: prevId ?? `sel${++this.seq}`, kind: 'selection', uri: ed.document.uri, range: new vscode.Range(ed.selection.start, ed.selection.end), implicit: true };
    } else { this.implicitSel = undefined; }
    this.post({ type: 'editorState', hasEditor: !!ed && ed.document.uri.scheme === 'file', path: ed ? vscode.workspace.asRelativePath(ed.document.uri) : undefined });
    this.pushContexts();
  }

  private chipOf(c: ContextItem) {
    const rel = vscode.workspace.asRelativePath(c.uri);
    const name = rel.split('/').pop() || rel;
    const label = c.range ? `${name} · L${c.range.start.line + 1}–L${c.range.end.line + 1}` : name;
    return { id: c.id, kind: c.kind, label, path: rel, implicit: !!c.implicit };
  }

  private pushContexts() {
    const chips = this.contexts.map(c => this.chipOf(c));
    if (this.implicitSel) { chips.push(this.chipOf(this.implicitSel)); }
    this.post({ type: 'contextUpdate', chips });
  }

  async addFileContext(uri: vscode.Uri, range?: vscode.Range) {
    let kind: ContextItem['kind'] = range ? 'selection' : 'file';
    try { const st = await vscode.workspace.fs.stat(uri); if (st.type & vscode.FileType.Directory) { kind = 'folder'; } } catch { return; }
    if (this.contexts.some(c => c.uri.toString() === uri.toString() && !c.range && !range)) { return; }
    this.contexts.push({ id: `c${++this.seq}`, kind, uri, range });
    this.pushContexts();
  }

  private async pickContext() {
    const items: (vscode.QuickPickItem & { action: string; uri?: vscode.Uri })[] = [];
    const ed = vscode.window.activeTextEditor;
    if (ed) { items.push({ label: '$(file) Current file', description: vscode.workspace.asRelativePath(ed.document.uri), action: 'file', uri: ed.document.uri }); }
    if (ed && !ed.selection.isEmpty) { items.push({ label: '$(selection) Current selection', action: 'selection' }); }
    items.push({ label: '$(files) Workspace files…', action: 'browse' });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Attach context to the next message' });
    if (!pick) { return; }
    if (pick.action === 'file' && pick.uri) { await this.addFileContext(pick.uri); }
    else if (pick.action === 'selection' && ed) { await this.addFileContext(ed.document.uri, new vscode.Range(ed.selection.start, ed.selection.end)); }
    else if (pick.action === 'browse') {
      const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,out}/**', 5000);
      const chosen = await vscode.window.showQuickPick(files.map(f => ({ label: vscode.workspace.asRelativePath(f), uri: f })), { canPickMany: true, matchOnDescription: true, placeHolder: 'Pick files' });
      for (const c of chosen ?? []) { await this.addFileContext(c.uri); }
    }
  }

  private async renderContext(items: ContextItem[]): Promise<string> {
    const parts: string[] = [];
    for (const c of items) {
      const rel = vscode.workspace.asRelativePath(c.uri);
      try {
        if (c.kind === 'folder') {
          const files = await vscode.workspace.findFiles(new vscode.RelativePattern(c.uri, '**/*'), '**/{node_modules,.git}/**', 300);
          parts.push(`[Folder: ${rel}]\n` + files.map(f => '- ' + vscode.workspace.asRelativePath(f)).join('\n'));
          continue;
        }
        const doc = await vscode.workspace.openTextDocument(c.uri);
        let text = c.range ? doc.getText(c.range) : doc.getText();
        if (text.length > MAX_FILE_CHARS) { text = text.slice(0, MAX_FILE_CHARS) + `\n…[truncated at ${MAX_FILE_CHARS} chars]`; }
        const where = c.range ? ` lines ${c.range.start.line + 1}-${c.range.end.line + 1}` : '';
        parts.push(`[${c.kind === 'selection' ? 'Selection' : 'File'}: ${rel}${where}]\n\`\`\`${doc.languageId}\n${text}\n\`\`\``);
      } catch (e) { parts.push(`[Could not read ${rel}: ${(e as Error).message}]`); }
    }
    return parts.join('\n\n');
  }

  /** Legacy @file / @workspace tags. */
  private async resolveTags(text: string): Promise<string> {
    let out = text;
    if (out.includes('@file')) {
      const ed = vscode.window.activeTextEditor;
      out = out.replace(/@file\b/g, ed ? `(see attached ${vscode.workspace.asRelativePath(ed.document.uri)})` : '(no file open)');
      if (ed) { out += '\n\n' + await this.renderContext([{ id: 'x', kind: 'file', uri: ed.document.uri }]); }
    }
    if (out.includes('@workspace')) {
      const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,out}/**', 300);
      out = out.replace(/@workspace\b/g, '(workspace listing attached)') + '\n\n[Workspace files]\n' + files.map(f => '- ' + vscode.workspace.asRelativePath(f)).sort().join('\n');
    }
    return out;
  }

  /** Called by commands: focus the view, wait for the webview handshake, then send. */
  async injectQuery(text: string, opts: { agent?: boolean } = {}) {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    await Promise.race([this.waitReady(), new Promise(r => setTimeout(r, 10000))]);
    if (opts.agent !== undefined) { this.agentMode = opts.agent; this.pushSettings(); }
    await this.send(text);
  }

  stop() { this.abort?.abort(); this.cts?.cancel(); }

  private async send(text: string, images?: string[]) {
    if (this.busy) { this.post({ type: 'toast', msg: 'Grok is still answering — press Stop first.' }); return; }
    if (!text.trim() && !images?.length) { return; }
    this.busy = true;
    const id = `m${++this.seq}`;
    const attached = [...this.contexts, ...(this.implicitSel ? [this.implicitSel] : [])];
    this.post({ type: 'userMessage', id, text, chips: attached.map(c => this.chipOf(c)) });
    this.contexts = []; this.pushContexts();
    this.lastUser = { text, images };
    let full = await this.resolveTags(text);
    const ctxText = await this.renderContext(attached);
    if (ctxText) { full += '\n\n--- Attached context ---\n' + ctxText; }
    const content: ChatMessage['content'] = images?.length
      ? [{ type: 'text', text: full } as TextPart, ...images.map(u => ({ type: 'image_url', image_url: { url: u } } as ImagePart))]
      : full;
    this.history.push({ role: 'user', content });

    this.abort = new AbortController();
    this.cts = new vscode.CancellationTokenSource();
    const aid = `a${this.seq}`;
    this.post({ type: 'streamStart', id: aid });
    setBusy(true);
    const t0 = Date.now();
    let tokens = 0;
    try {
      const sys: ChatMessage = { role: 'system', content: SYSTEM_PROMPT + (this.agentMode ? AGENT_PROMPT : '') };
      const maxSteps = clampNum(cfg().get('agent.maxSteps'), 1, 50, 15);
      for (let step = 0; ; step++) {
        const opts = await requestOptions(this.ctx, {
          signal: this.abort.signal,
          tools: this.agentMode ? TOOL_SPECS : undefined,
          onContent: (delta) => this.post({ type: 'streamChunk', id: aid, delta }),
        });
        const res = await streamChat([sys, ...this.history], opts);
        tokens += res.usage?.completion_tokens ?? 0;
        this.history.push({ role: 'assistant', content: res.content || null, ...(res.toolCalls.length ? { tool_calls: res.toolCalls } : {}) });
        if (!this.agentMode || !res.toolCalls.length) { break; }
        if (step + 1 >= maxSteps) { this.post({ type: 'streamChunk', id: aid, delta: `\n\n_Stopped after ${maxSteps} agent steps._` }); break; }
        for (const call of res.toolCalls) {
          if (this.cts.token.isCancellationRequested) { throw new GrokApiError('Request cancelled.', 'aborted'); }
          let args: unknown = {};
          try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* keep {} */ }
          this.post({ type: 'toolEvent', id: aid, text: `🔧 ${call.function.name} ${summarizeArgs(args)}` });
          const out = await executeTool(call.function.name, args, this.cts.token);
          this.history.push({ role: 'tool', tool_call_id: call.id, content: out });
        }
        this.post({ type: 'streamChunk', id: aid, delta: '\n\n' });
      }
      this.post({ type: 'streamDone', id: aid, meta: { latencyMs: Date.now() - t0, completionTokens: tokens || undefined, model: cfg().get('model') } });
    } catch (e) {
      const err = e as GrokApiError;
      if (err.kind === 'aborted') { this.post({ type: 'streamStopped', id: aid }); }
      else { this.post({ type: 'streamError', id: aid, msg: err.message || String(e), kind: err.kind ?? 'generic' }); }
      // drop dangling assistant tool_calls without results
      const last = this.history[this.history.length - 1];
      if (last?.role === 'assistant' && last.tool_calls?.length) { this.history.pop(); }
    } finally {
      while (this.history.length > MAX_HISTORY) { this.history.shift(); }
      while (this.history.length && this.history[0].role !== 'user') { this.history.shift(); }
      this.busy = false; this.abort = undefined; this.cts?.dispose(); this.cts = undefined;
      setBusy(false);
    }
  }

  private async insertCode(code: string) {
    const ed = vscode.window.activeTextEditor;
    if (!ed) { this.post({ type: 'toast', msg: 'No active editor to insert into.' }); return; }
    await ed.edit(b => { if (ed.selection.isEmpty) { b.insert(ed.selection.active, code); } else { b.replace(ed.selection, code); } });
  }

  private async applyDiff(code: string, targetPath?: string): Promise<{ ok: boolean; msg: string }> {
    try {
      if (targetPath) {
        const { resolveInWorkspace } = await import('./agent/tools');
        return await proposeEdit(resolveInWorkspace(targetPath), code, 'Apply Grok code');
      }
      const ed = vscode.window.activeTextEditor;
      if (!ed) { return { ok: false, msg: 'No target file: open a file or ask Grok to include path=…' }; }
      if (!ed.selection.isEmpty) { return await proposeRangeEdit(ed.document, ed.selection, code, 'Replace selection'); }
      return await proposeEdit(ed.document.uri, code, 'Replace file');
    } catch (e) { return { ok: false, msg: (e as Error).message }; }
  }
}

function summarizeArgs(a: unknown): string {
  if (!a || typeof a !== 'object') { return ''; }
  const o = a as Record<string, unknown>;
  const s = o.path ?? o.command ?? o.query ?? o.glob ?? '';
  return String(s).slice(0, 120);
}
