// Sidebar chat webview provider: streaming, context chips, code actions, agent mode, stop.
import * as vscode from 'vscode';
import { streamChat, ChatMessage, GrokApiError, TextPart, ImagePart } from './xai/client';
import { requestOptions, cfg, clampNum, SECRET_KEY, DEFAULT_MODEL, apiMode, serverTools } from './config';
import { streamResponse, compactInput, InputItem, ResponseTool } from './xai/responses';
import { runResponsesLoop, ConversationState } from './agent/responsesLoop';
import { READ_TOOL_SPECS, TOOL_SPECS, READ_ONLY_TOOL_NAMES, executeTool, toResponsesTools } from './agent/tools';
import { runToolLoop } from './agent/loop';
import { proposeEdit, proposeRangeEdit } from './proposals';
import { ApprovalBroker, setApprover } from './agent/approvals';
import { setErrorSink } from './errors';
import { diag } from './diagnostics';
import { checkReadable } from './security';
import { problemsContext } from './agent/checks';
import { onPlanApplied, undoPlan } from './planApply';
import { isSecretPath } from './index/lexical';
import { RulesWatcher, rulesPrompt } from './rules';
import { setBusy } from './status';
import { listModels, ModelInfo } from './xai/models';

/** Legacy Chat Completions path only: the Responses path keeps full history server-side and compacts instead. */
const MAX_HISTORY_CHAT = 200;

export const SYSTEM_PROMPT =
  'You are Grok, built by xAI, running inside VS Code through the VSGrok extension as a coding agent. ' +
  'You are connected to the user\'s open workspace through tools: find_relevant_files (ranked files from a local index), get_workspace_overview, list_files, read_file and search_workspace are always available and run instantly without asking the user. ' +
  'When a question involves the user\'s code, project, files or "the workspace", call these tools in this same turn and answer from what they return; get_problems shows current compiler/linter errors; for "where/how" questions start with find_relevant_files. Files like .env and credentials are never readable. ' +
  'Never announce an action ("I\'ll take a look", "Let me check") without making the tool call in the same response, and never end your turn promising to do something later. ' +
  'Either call a tool now or give your final answer. Keep going, calling tools as many times as needed, until you can answer. ' +
  'Be accurate and concise. Always use fenced code blocks with a language tag. ' +
  'When you give a full replacement for a file, put `path=<workspace-relative path>` after the language in the fence, e.g. ```ts path=src/a.ts. ' +
  'Never claim to have changed files unless a tool result says the edit was applied.';

const AGENT_PROMPT =
  ' Agent mode is on: you can also call propose_plan (preferred for changes to more than one file), propose_edit, run_tests and run_command; each shows an Approve/Deny card in the chat and only runs after the user approves. ' +
  'Inspect before editing. Prefer small, correct changes. Summarise what you did at the end.';

const NO_AGENT_PROMPT =
  ' Agent mode is off: you cannot edit files or run commands. Show changes as code blocks with path=… so the user can click Apply, ' +
  'or tell them to switch on Agent in the chat header.';

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
  /** Responses API conversation: verbatim local items + previous_response_id. */
  private conv: ConversationState = { items: [] };
  /** System prompt variant the current Responses chain was started with ('agent' | 'ask'). */
  private convMode?: string;
  private lastInputTokens = 0;
  private contexts: ContextItem[] = [];
  private implicitSel?: ContextItem;
  private abort?: AbortController;
  private cts?: vscode.CancellationTokenSource;
  private busy = false;
  private lastUser?: { text: string; images?: string[] };
  private seq = 0;
  private agentMode = false;
  /** Per-chat id sent as x-grok-conv-id so follow-up turns hit xAI's prompt cache. */
  private convId = newConvId();
  /** In-chat Approve/Deny cards for commands and edits. */
  private approvals = new ApprovalBroker((m) => this.post(m));
  readonly rules = new RulesWatcher();
  /** Include Problems for the active + attached files in each message (chip toggle). */
  private problemsEnabled = true;
  private problemsTimer?: NodeJS.Timeout;
  private editedThisTurn = false;
  private planAppliedThisTurn = false;
  /** Hash of the project rules the current Responses chain was started/updated with. */
  private rulesHash?: string;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.agentMode = cfg().get<boolean>('agent.enabledByDefault') ?? true;
    ctx.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.pushEditorState()),
      vscode.window.onDidChangeTextEditorSelection(() => this.pushEditorState()),
      { dispose: () => { this.approvals.cancelAll('cancelled'); setApprover(undefined); setErrorSink(undefined); } },
      this.rules,
      this.rules.onDidChange(() => this.pushRules()),
      vscode.languages.onDidChangeDiagnostics(() => this.schedulePushProblems()),
      vscode.window.onDidChangeActiveTextEditor(() => this.schedulePushProblems()),
      { dispose: () => onPlanApplied(undefined) },
    );
    this.rules.start();
    onPlanApplied((e) => { this.editedThisTurn = true; this.planAppliedThisTurn = true; this.post({ type: 'planApplied', planId: e.planId, paths: e.paths, summary: e.summary }); });
    setErrorSink((c) => { void this.showCard('errorCard', c); });
    setApprover(async (req, opts) => {
      if (!this.view) { await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`); }
      else if (!this.view.visible) { this.view.show(true); }
      await Promise.race([this.waitReady(), new Promise(r => setTimeout(r, 10000))]);
      if (!this.ready) { return { ok: false }; }
      return this.approvals.requestDecision(req, opts);
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const webRoot = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'webview');
    view.webview.options = { enableScripts: true, localResourceRoots: [webRoot] };
    view.webview.html = this.html(view.webview, webRoot);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m).catch(e => this.post({ type: 'toast', msg: String(e?.message ?? e) })));
    view.onDidDispose(() => { this.view = undefined; this.ready = false; this.approvals.cancelAll('panel closed'); });
  }

  private html(webview: vscode.Webview, root: vscode.Uri): string {
    const nonce = [...Array(32)].map(() => Math.floor(Math.random() * 36).toString(36)).join('');
    const u = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${u('style.css')}"><title>VSGrok</title></head>
<body class="theme-${cfg().get<string>('theme') === 'vscode' ? 'vscode' : 'galactic'}">
<div id="stars" aria-hidden="true"><i class="s1"></i><i class="s2"></i><i class="s3"></i></div>
<header id="header"><div class="header-left"><img class="logo" src="${u('grok-icon.png')}" alt="" width="20" height="20"><span class="brand">Grok</span><span class="brand-sub">for VS Code</span></div>
<div class="header-right">
<select id="model" class="h-select" aria-label="Grok model" title="Grok model"></select>
<button id="web-toggle" type="button" class="h-btn tool-toggle" aria-pressed="false" title="Web Search: let Grok search the web on xAI's servers (billed by xAI per call). Responses API only.">Web</button>
<button id="x-toggle" type="button" class="h-btn tool-toggle" aria-pressed="false" title="X Search: let Grok search posts on X on xAI's servers (billed by xAI per fetched item). Responses API only.">𝕏</button>
<label class="agent-toggle" title="Agent: let Grok propose edits and request terminal commands; each one waits for your Approve in this chat. Reading and searching the workspace is always on."><input type="checkbox" id="agent"> Agent</label>
<button id="rules-chip" type="button" class="rules-chip" hidden aria-label="Project rules"></button>
<button id="settings-btn" type="button" class="h-btn icon" aria-label="Settings" aria-controls="settings-panel" aria-expanded="false">⚙</button>
<button id="clear-btn" type="button" class="h-btn" aria-label="New chat">New</button></div></header>
<section id="welcome" hidden aria-labelledby="welcome-title"><img class="welcome-logo" src="${u('grok-icon.png')}" alt="" width="56" height="56">
<h2 id="welcome-title">Connect Grok</h2>
<p>VSGrok talks to the official xAI API with your own API key. Usage is billed by xAI to your account, per token.</p>
<ol><li>Open the xAI Console and sign in with your X or xAI account.</li><li>Create an API key (API Keys → Create).</li><li>Paste it here. It is stored in VS Code SecretStorage, never in settings.</li></ol>
<div class="welcome-actions"><button id="get-key-btn" class="primary">Get an API key ↗</button><button id="paste-key-btn" class="h-btn">Paste API key</button></div>
<p class="note">About SuperGrok: xAI&#39;s subscription sign-in is currently limited to partner apps xAI has approved (such as OpenCode) and is not open to other extensions, so VSGrok uses an API key. API usage is billed separately from SuperGrok in the xAI Console.</p></section>
<div id="settings-panel">
<div class="slider-row"><label for="temperature">Temperature</label><input type="range" id="temperature" min="0" max="2" step="0.05"><span class="val" id="temperature-val"></span></div>
<div class="slider-row"><label for="maxTokens">Max tokens</label><input type="range" id="maxTokens" min="256" max="32768" step="256"><span class="val" id="maxTokens-val"></span></div>
<div class="slider-row"><button id="refresh-models-btn" class="h-btn">Refresh models</button><button id="setkey-btn" class="h-btn">Change API key</button></div></div>
<div id="messages-wrap"><div id="messages" role="log" aria-live="polite"></div><button id="new-output" class="pill" hidden>↓ New output</button><div id="sr-announce" class="sr-only" aria-live="polite"></div></div>
<div id="chips"></div>
<div id="composer"><button id="add-ctx" class="h-btn" aria-label="Add context">+ Context</button>
<textarea id="input" rows="1" placeholder="Ask Grok… (Enter to send, Shift+Enter for newline)" aria-label="Message"></textarea>
<button id="send" class="send" aria-label="Send">➤</button></div>
<script nonce="${nonce}" src="${u('marked.min.js')}"></script>
<script nonce="${nonce}" src="${u('purify.min.js')}"></script>
<script nonce="${nonce}" src="${u('cards.js')}"></script>
<script nonce="${nonce}" src="${u('main.js')}"></script>
</body></html>`;
  }

  onUpdateAction?: (action: string) => void;
  /** Called each time the chat webview finishes loading (user opened/reloaded the panel). */
  onViewReady?: () => void;
  /** Show (or refresh) the in-chat update card; opens the chat view if needed. */
  async showUpdateCard(card: unknown): Promise<void> { await this.showCard('updateCard', card); }
  private async showCard(type: string, card: unknown): Promise<void> {
    if (!this.view) { await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`); }
    await Promise.race([this.waitReady(), new Promise(r => setTimeout(r, 10000))]);
    this.post({ type, card });
  }

  /** Open the active rule file; with several, let the user pick one. */
  async openRules(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri; const files = this.rules.current?.files ?? [];
    if (!root || !files.length) { return; }
    const f = files.length === 1 ? files[0] : (await vscode.window.showQuickPick(files.map(label => ({ label, description: label.startsWith('.vsgrok') ? 'folder rules' : 'root rules' })), { placeHolder: 'Open which project rules file?' }))?.label;
    if (f) { await vscode.window.showTextDocument(vscode.Uri.joinPath(root, f), { preview: true }); }
  }

  /** After agent edits, offer to re-run problems/tests (one card per turn). */
  private offerChecks(force = false) {
    const plan = this.planAppliedThisTurn;
    if (!this.editedThisTurn && !force) { return; }
    this.editedThisTurn = false; this.planAppliedThisTurn = false;
    // The Plan applied card already has Re-run checks; the setting turns the offer off.
    if (!force && plan) { return; }
    if (!vscode.workspace.getConfiguration('vsgrok').get<boolean>('checks.offerAfterEdits', true)) { return; }
    this.post({ type: 'checksOffer' });
  }

  private pushRules() {
    const r = this.rules.current;
    this.post({ type: 'rules', files: r?.files ?? [], truncated: !!r?.truncated });
  }

  /** Integration-test hooks (VSGROK_TEST=1 only). */
  readonly testPosts: unknown[] = [];
  testReceive(m: unknown) { return this.onMessage(m); }
  get isReady() { return this.ready; }

  private post(msg: unknown) {
    if ((__VSGROK_TEST__ && process.env.VSGROK_TEST === '1')) { this.testPosts.push(msg); } void this.view?.webview.postMessage(msg); }

  private waitReady(): Promise<void> {
    if (this.ready) { return Promise.resolve(); }
    return new Promise(res => this.readyWaiters.push(res));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async onMessage(m: any) {
    if (this.approvals.handle(m)) { return; }
    if (m?.type === 'updateAction' && typeof m.action === 'string') { this.onUpdateAction?.(m.action); return; }
    switch (m?.type) {
      case 'ready': {
        this.ready = true;
        this.approvals.cancelAll('panel reloaded');
        this.pushSettings(); this.pushEditorState(); this.pushContexts(); this.pushRules(); this.pushProblems(); void this.pushKeyState(); void this.pushModels();
        this.readyWaiters.splice(0).forEach(r => r());
        this.onViewReady?.();
        break;
      }
      case 'query': if (typeof m.text === 'string') { await this.send(m.text, Array.isArray(m.images) ? m.images.filter((s: unknown) => typeof s === 'string' && /^data:image\/(png|jpe?g);base64,/.test(s as string)) : undefined); } break;
      case 'stop': this.stop(); break;
      case 'regenerate': if (this.lastUser && !this.busy) {
        if (this.preTurn) { this.conv = { items: this.conv.items.slice(0, this.preTurn.len), previousResponseId: this.preTurn.prev }; this.convMode = this.preTurn.mode; }
        while (this.history.length && this.history[this.history.length - 1].role !== 'user') { this.history.pop(); }
        this.history.pop();
        await this.send(this.lastUser.text, this.lastUser.images);
      } break;
      case 'clearChat': this.stop(); this.history = []; this.resetConv(); this.convId = newConvId(); this.post({ type: 'chatCleared' }); break;
      case 'updateSettings': await this.updateSettings(m); break;
      case 'setApiKey': await vscode.commands.executeCommand('vsgrok.setApiKey'); break;
      case 'getApiKey': await vscode.commands.executeCommand('vsgrok.signIn'); break;
      case 'refreshModels': await this.pushModels(true); break;
      case 'insertCode': await this.insertCode(String(m.code ?? '')); break;
      case 'applyDiff': {
        const r = await this.applyDiff(String(m.code ?? ''), typeof m.targetPath === 'string' ? m.targetPath : undefined);
        this.post({ type: 'applyResult', blockId: m.blockId, ...r });
        break;
      }
      case 'pickContext': await this.pickContext(); break;
      case 'dropFiles': if (Array.isArray(m.uris)) { for (const s of m.uris.slice(0, 50)) { try { await this.addFileContext(vscode.Uri.parse(String(s), true)); } catch { /* ignore */ } } } break;
      case 'openContext': {
        const c = this.findContext(String(m.id));
        if (c) { const ed = await vscode.window.showTextDocument(c.uri, { preview: true }); if (c.range) { ed.selection = new vscode.Selection(c.range.start, c.range.end); ed.revealRange(c.range); } }
        break;
      }
      case 'pinContext': if (this.implicitSel && this.implicitSel.id === m.id) { this.contexts.push({ ...this.implicitSel, implicit: false, id: `c${++this.seq}` }); this.pushContexts(); } break;
      case 'removeContext': this.contexts = this.contexts.filter(c => c.id !== m.id); this.pushContexts(); break;
      case 'setAgent': this.agentMode = !!m.enabled; break;
      case 'setServerTool': {
        const key = ({ web: 'tools.webSearch', x: 'tools.xSearch', code: 'tools.codeExecution' } as Record<string, string>)[String(m.tool)];
        if (key) { await cfg().update(key, !!m.enabled, vscode.ConfigurationTarget.Global); this.pushSettings(); }
        break;
      }
      case 'copyMessage': break;
      case 'toggleProblems': this.problemsEnabled = !this.problemsEnabled; this.pushProblems(); break;
      case 'undoPlan': if (typeof m.planId === 'string') { const r = await undoPlan(m.planId); this.post({ type: 'planUndone', planId: m.planId, ...r }); if (r.ok) { this.offerChecks(true); } } break;
      case 'rerunChecks': await this.injectQuery('Re-run the checks for the files you just changed: call get_problems for them and run_tests, then fix anything that broke (use propose_plan for multi-file fixes).', { agent: true }); break;
      case 'copyDiagnostics': await vscode.commands.executeCommand('vsgrok.copyDiagnostics'); break;
      case 'openRules': await this.openRules(); break;
      case 'openSettings': {
        const key = typeof m.key === 'string' && /^vsgrok\.[\w.]+$/.test(m.key) ? m.key : 'vsgrok';
        await vscode.commands.executeCommand('workbench.action.openSettings', key);
        break;
      }
      case 'openLink': if (typeof m.url === 'string' && /^https?:\/\//i.test(m.url)) { await vscode.env.openExternal(vscode.Uri.parse(m.url)); } break;
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
    this.post({ type: 'settings', model: c.get('model') || DEFAULT_MODEL, temperature: c.get('temperature'), maxTokens: c.get('maxTokens'), agent: this.agentMode, api: apiMode(), webSearch: !!c.get('tools.webSearch'), xSearch: !!c.get('tools.xSearch'), codeExecution: !!c.get('tools.codeExecution'), theme: c.get('theme') === 'vscode' ? 'vscode' : 'galactic' });
  }

  async pushKeyState() { this.post({ type: 'keyState', hasKey: !!(await this.ctx.secrets.get(SECRET_KEY)) }); }

  /** Fetch (or reuse cached) model list and send it to the dropdown. */
  async getModels(force = false): Promise<{ models: ModelInfo[]; source: string; error?: string }> {
    const key = (await this.ctx.secrets.get(SECRET_KEY)) ?? '';
    return listModels(this.ctx.globalState, cfg().get<string>('baseUrl') || 'https://api.x.ai/v1', key, force);
  }

  async pushModels(force = false) {
    const r = await this.getModels(force);
    this.post({ type: 'models', models: r.models, source: r.source, error: r.error, current: cfg().get<string>('model') || DEFAULT_MODEL });
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
    this.schedulePushProblems();
  }

  private problemUris(attached?: ContextItem[]): vscode.Uri[] {
    const list = (attached ?? [...this.contexts, ...(this.implicitSel ? [this.implicitSel] : [])]).filter(c => c.kind !== 'folder').map(c => c.uri);
    const ed = vscode.window.activeTextEditor;
    if (ed && vscode.workspace.getWorkspaceFolder(ed.document.uri)) { list.push(ed.document.uri); }
    return list;
  }
  private schedulePushProblems() {
    if (this.problemsTimer) { clearTimeout(this.problemsTimer); }
    this.problemsTimer = setTimeout(() => this.pushProblems(), 300);
  }
  private pushProblems() {
    const { count } = problemsContext(this.problemUris());
    this.post({ type: 'problemsState', count, enabled: this.problemsEnabled });
  }

  async addFileContext(uri: vscode.Uri, range?: vscode.Range) {
    const chk = await checkReadable(uri);
    if (!chk.ok) {
      diag('context.refused', { reason: chk.reason });
      this.post({ type: 'contextRefused', path: chk.rel, reason: chk.reason });
      return;
    }
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
      const chosen = await vscode.window.showQuickPick(files.filter(f => !isSecretPath(vscode.workspace.asRelativePath(f, false))).map(f => ({ label: vscode.workspace.asRelativePath(f), uri: f })), { canPickMany: true, matchOnDescription: true, placeHolder: 'Pick files' });
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
          parts.push(`[Folder: ${rel}]\n` + files.map(f => vscode.workspace.asRelativePath(f, false)).filter(p => !isSecretPath(p)).map(p => '- ' + p).join('\n'));
          continue;
        }
        const chk = await checkReadable(c.uri);
        if (!chk.ok) { parts.push(`[Refused ${chk.rel}: ${chk.reason}]`); continue; }
        const doc = await vscode.workspace.openTextDocument(c.uri);
        let text = c.range ? doc.getText(c.range) : doc.getText();
        const cap = clampNum(cfg().get('context.maxFileChars'), 10_000, 2_000_000, 1_000_000);
        if (text.length > cap) { text = text.slice(0, cap) + `\n…[truncated at ${cap} chars]`; }
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
      out = out.replace(/@workspace\b/g, '(workspace listing attached)') + '\n\n[Workspace files]\n' + files.map(f => vscode.workspace.asRelativePath(f, false)).filter(p => !isSecretPath(p)).sort().map(p => '- ' + p).join('\n');
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

  stop() { this.abort?.abort(); this.cts?.cancel(); this.approvals.cancelAll('cancelled'); }

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
    let ctxText = await this.renderContext(attached);
    if (this.problemsEnabled) { const pc = problemsContext(this.problemUris(attached)); if (pc.text) { ctxText = (ctxText ? ctxText + '\n\n' : '') + pc.text; } }
    if (ctxText) { full += '\n\n--- Attached context ---\n' + ctxText; }
    this.editedThisTurn = false; this.planAppliedThisTurn = false;

    this.abort = new AbortController();
    this.cts = new vscode.CancellationTokenSource();
    const aid = `a${this.seq}`;
    this.post({ type: 'streamStart', id: aid });
    setBusy(true);
    try {
      if (apiMode() === 'chat') { await this.sendChat(aid, full, images); }
      else { await this.sendResponses(aid, full, images); }
    } finally {
      this.busy = false; this.abort = undefined; this.cts?.dispose(); this.cts = undefined;
      setBusy(false);
    }
  }

  private resetConv() { this.conv = { items: [] }; this.convMode = undefined; this.lastInputTokens = 0; this.preTurn = undefined; }
  private preTurn?: { len: number; prev?: string; mode?: string };

  /** Responses API turn: previous_response_id chaining, encrypted reasoning passed back, server-side tools, citations. */
  private async sendResponses(aid: string, full: string, images?: string[]) {
    const t0 = Date.now();
    const agent = this.agentMode;
    const mode = agent ? 'agent' : 'ask';
    const c = cfg();
    const store = c.get<boolean>('responses.store') ?? true;
    const maxSteps = clampNum(c.get('agent.maxSteps'), 1, 50, 15);
    const cts = this.cts!;
    const signal = this.abort!.signal;
    const base = await requestOptions(this.ctx, { signal, convId: this.convId });

    // Compact long chats before the next turn (POST /v1/responses/compact), then continue from the compaction item.
    const compactAt = clampNum(c.get('responses.compactAtTokens'), 0, 10_000_000, 300_000);
    if (compactAt && this.lastInputTokens >= compactAt && this.conv.items.length > 2) {
      this.post({ type: 'toolEvent', id: aid, toolId: 'compact', state: 'running', label: 'Compacting long conversation…' });
      try {
        const r = await compactInput({ ...base, model: base.model }, this.conv.items);
        this.conv = { items: r.output };
        this.lastInputTokens = 0;
        this.post({ type: 'toolEvent', id: aid, toolId: 'compact', state: 'done', label: `Compacted conversation${r.dropped ? ` (${r.dropped} messages folded)` : ''}` });
      } catch (e) {
        this.post({ type: 'toolEvent', id: aid, toolId: 'compact', state: 'error', label: 'Compaction failed; continuing with full history', detail: (e as Error).message });
      }
    }

    const content: InputItem['content'] = images?.length
      ? [{ type: 'input_text', text: full }, ...images.map(u => ({ type: 'input_image', image_url: u }))]
      : full;
    const rules = this.rules.current;
    const sysText = SYSTEM_PROMPT + (agent ? AGENT_PROMPT : NO_AGENT_PROMPT) + rulesPrompt(rules);
    const newInput: InputItem[] = [];
    // `instructions` cannot be combined with previous_response_id, so the system prompt is a system message in input.
    // On a fresh chain it opens the conversation; when Agent is toggled mid-chat a new system message states the change.
    if (!this.conv.items.length) { newInput.push({ role: 'system', content: sysText }); }
    else if (this.convMode !== mode) { newInput.push({ role: 'system', content: agent ? 'Update:' + AGENT_PROMPT : 'Update:' + NO_AGENT_PROMPT }); }
    if (this.conv.items.length && rules?.hash !== this.rulesHash) {
      newInput.push({ role: 'system', content: rules ? 'Update: the project instructions changed.' + rulesPrompt(rules) : 'Update: the project instruction file was removed; ignore earlier project instructions.' });
    }
    this.rulesHash = rules?.hash;
    newInput.push({ role: 'user', content });
    this.preTurn = { len: this.conv.items.length, prev: this.conv.previousResponseId, mode: this.convMode };
    this.convMode = mode;

    const fnTools = toResponsesTools(agent ? TOOL_SPECS : READ_TOOL_SPECS);
    const tools: ResponseTool[] = [...fnTools, ...serverTools()];
    let tid = 0; let thinking = '';
    const ids = new Map<string, string>();
    const showThought = (state: 'running' | 'done') => this.post({ type: 'toolEvent', id: aid, toolId: 'think', state, label: state === 'running' ? 'Thinking…' : 'Thought', detail: thinking.length > 8000 ? '…' + thinking.slice(-8000) : thinking });
    try {
      const r = await runResponsesLoop({
        state: this.conv,
        newInput,
        tools,
        maxSteps,
        useChain: store,
        isCancelled: () => cts.token.isCancellationRequested || signal.aborted,
        request: (input, prev, ts) => streamResponse({
          ...base,
          input,
          previousResponseId: prev,
          tools: ts,
          maxOutputTokens: base.maxTokens,
          store,
          // With store=false the encrypted reasoning must come back to us so it can be resent (docs: reasoning#encrypted-reasoning-content).
          include: store ? undefined : ['reasoning.encrypted_content'],
          onContent: (delta) => this.post({ type: 'streamChunk', id: aid, delta }),
          onReasoning: (delta) => { thinking += delta; showThought('running'); },
          onServerTool: (item, st) => {
            const key = 'srv-' + String(item.id ?? item.type).replace(/[^\w-]/g, '').slice(0, 60);
            this.post({ type: 'toolEvent', id: aid, toolId: key, state: st === 'running' ? 'running' : (item.status === 'failed' ? 'error' : 'done'), label: serverToolLabel(item, st === 'done') });
          },
        }).then(res => { if (thinking) { showThought('done'); } return res; }),
        execute: (name, args) => {
          if (!agent && !READ_ONLY_TOOL_NAMES.has(name)) {
            return Promise.resolve(`Tool ${name} is not available: Agent mode is off. Ask the user to enable Agent in the chat header, or show the change as a code block.`);
          }
          return executeTool(name, args, cts.token).then(r => { if (name === 'propose_edit' && /^Applied/.test(r)) { this.editedThisTurn = true; } return r; });
        },
        onToolStart: (call, args) => {
          const t = `t${++tid}`; ids.set(call.call_id, t);
          this.post({ type: 'toolEvent', id: aid, toolId: t, state: 'running', label: toolLabel(call.name, args) });
        },
        onToolEnd: (call, args, out) => {
          const failed = /^(Error:|Unknown tool|Tool .* is not available)/.test(out);
          this.post({ type: 'toolEvent', id: aid, toolId: ids.get(call.call_id), state: failed ? 'error' : 'done', label: toolLabel(call.name, args, true), detail: out.length > 4000 ? out.slice(0, 4000) + '\n…' : out });
        },
        onStepEnd: (_s, res) => { if (res.functionCalls.length && res.content) { this.post({ type: 'streamChunk', id: aid, delta: '\n\n' }); } },
      });
      this.lastInputTokens = r.lastInputTokens;
      if (r.hitStepCap) { this.post({ type: 'streamChunk', id: aid, delta: `\n\n_Reached the limit of ${maxSteps} tool rounds (vsgrok.agent.maxSteps)._` }); }
      this.offerChecks();
      this.post({ type: 'streamDone', id: aid, meta: {
        latencyMs: Date.now() - t0, completionTokens: r.outputTokens || undefined, cachedTokens: r.cachedTokens || undefined,
        reasoningTokens: r.reasoningTokens || undefined, inputTokens: r.lastInputTokens || undefined,
        costUsd: r.costTicks ? r.costTicks / 1e10 : undefined, model: base.model, api: 'responses',
      }, citations: r.citations.slice(0, 50) });
    } catch (e) {
      const err = e as GrokApiError;
      diag('chat.error', { kind: err.kind ?? 'generic', status: err.statusCode, attempts: err.attempts });
      if (err.kind === 'aborted') { this.post({ type: 'streamStopped', id: aid }); }
      else { this.post({ type: 'streamError', id: aid, msg: err.message || String(e), kind: err.kind ?? 'generic', attempts: err.attempts }); }
      // Roll back to the last consistent state so no function_call is left without its output.
      this.conv = { items: this.conv.items.slice(0, this.preTurn.len), previousResponseId: this.preTurn.prev };
      this.convMode = this.preTurn.mode;
    }
  }

  /** Legacy Chat Completions turn (vsgrok.api = "chat"). */
  private async sendChat(aid: string, full: string, images?: string[]) {
    const content: ChatMessage['content'] = images?.length
      ? [{ type: 'text', text: full } as TextPart, ...images.map(u => ({ type: 'image_url', image_url: { url: u } } as ImagePart))]
      : full;
    this.history.push({ role: 'user', content });
    const t0 = Date.now();
    try {
      const agent = this.agentMode;
      const sys: ChatMessage = { role: 'system', content: SYSTEM_PROMPT + (agent ? AGENT_PROMPT : NO_AGENT_PROMPT) + rulesPrompt(this.rules.current) };
      const maxSteps = clampNum(cfg().get('agent.maxSteps'), 1, 50, 15);
      const cts = this.cts!;
      const signal = this.abort!.signal;
      let tid = 0; let cached = 0; let reasoningTok = 0; let thinking = '';
      const ids = new Map<string, string>();
      const r = await runToolLoop({
        system: sys,
        history: this.history,
        tools: agent ? TOOL_SPECS : READ_TOOL_SPECS,
        maxSteps,
        isCancelled: () => cts.token.isCancellationRequested || signal.aborted,
        request: async (msgs, tools) => streamChat(msgs, await requestOptions(this.ctx, {
          signal,
          tools: tools.length ? tools : undefined,
          convId: this.convId,
          onContent: (delta) => this.post({ type: 'streamChunk', id: aid, delta }),
          onReasoning: (delta) => {
            thinking += delta;
            this.post({ type: 'toolEvent', id: aid, toolId: 'think', state: 'running', label: 'Thinking…', detail: thinking.length > 8000 ? '…' + thinking.slice(-8000) : thinking });
          },
        })).then(res => {
          cached += res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
          reasoningTok += res.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
          if (thinking) { this.post({ type: 'toolEvent', id: aid, toolId: 'think', state: 'done', label: 'Thought', detail: thinking.length > 8000 ? '…' + thinking.slice(-8000) : thinking }); }
          return res;
        }),
        execute: (name, args) => {
          if (!agent && !READ_ONLY_TOOL_NAMES.has(name)) {
            return Promise.resolve(`Tool ${name} is not available: Agent mode is off. Ask the user to enable Agent in the chat header, or show the change as a code block.`);
          }
          return executeTool(name, args, cts.token).then(r => { if (name === 'propose_edit' && /^Applied/.test(r)) { this.editedThisTurn = true; } return r; });
        },
        onToolStart: (call, args) => {
          const t = `t${++tid}`; ids.set(call.id, t);
          this.post({ type: 'toolEvent', id: aid, toolId: t, state: 'running', label: toolLabel(call.function.name, args) });
        },
        onToolEnd: (call, args, out) => {
          const failed = /^(Error:|Unknown tool|Tool .* is not available)/.test(out);
          this.post({ type: 'toolEvent', id: aid, toolId: ids.get(call.id), state: failed ? 'error' : 'done', label: toolLabel(call.function.name, args, true), detail: out.length > 4000 ? out.slice(0, 4000) + '\n…' : out });
        },
        onStepEnd: (_s, res) => { if (res.toolCalls.length && res.content) { this.post({ type: 'streamChunk', id: aid, delta: '\n\n' }); } },
      });
      if (r.hitStepCap) { this.post({ type: 'streamChunk', id: aid, delta: `\n\n_Reached the limit of ${maxSteps} tool rounds (vsgrok.agent.maxSteps)._` }); }
      this.offerChecks();
      this.post({ type: 'streamDone', id: aid, meta: { latencyMs: Date.now() - t0, completionTokens: r.completionTokens || undefined, cachedTokens: cached || undefined, reasoningTokens: reasoningTok || undefined, model: cfg().get('model') } });
    } catch (e) {
      const err = e as GrokApiError;
      diag('chat.error', { kind: err.kind ?? 'generic', status: err.statusCode, attempts: err.attempts });
      if (err.kind === 'aborted') { this.post({ type: 'streamStopped', id: aid }); }
      else { this.post({ type: 'streamError', id: aid, msg: err.message || String(e), kind: err.kind ?? 'generic', attempts: err.attempts }); }
      // drop dangling assistant tool_calls without results
      const last = this.history[this.history.length - 1];
      if (last?.role === 'assistant' && last.tool_calls?.length) { this.history.pop(); }
    } finally {
      while (this.history.length > MAX_HISTORY_CHAT) { this.history.shift(); }
      while (this.history.length && this.history[0].role !== 'user') { this.history.shift(); }
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

/** Human label for a tool call, e.g. "Read src/foo.ts" / "Reading src/foo.ts…". */
export function toolLabel(name: string, a: unknown, done = false): string {
  const o = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
  const s = (v: unknown) => String(v ?? '').slice(0, 120);
  switch (name) {
    case 'get_workspace_overview': return done ? 'Looked at the workspace' : 'Looking at the workspace…';
    case 'read_file': return `${done ? 'Read' : 'Reading'} ${s(o.path)}`;
    case 'list_files': return `${done ? 'Listed' : 'Listing'} files ${o.glob ? s(o.glob) : ''}`.trim();
    case 'search_workspace': return `${done ? 'Searched' : 'Searching'} for "${s(o.query)}"`;
    case 'propose_edit': return `${done ? 'Proposed edit to' : 'Proposing edit to'} ${s(o.path)}`;
    case 'run_command': return `${done ? 'Ran' : 'Running'} \`${s(o.command)}\``;
    case 'get_problems': return `${done ? 'Checked' : 'Checking'} problems${o.path ? ' in ' + s(o.path) : ''}`;
    case 'run_tests': return done ? 'Ran the tests' : 'Running the tests…';
    case 'propose_plan': return `${done ? 'Proposed' : 'Proposing'} a plan (${Array.isArray(o.changes) ? o.changes.length : '?'} files)`;
    default: return `${name}`;
  }
}

/** Label for a server-side tool item (web_search_call, x_search_call, code_interpreter_call, …). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serverToolLabel(item: any, done = false): string {
  const q = typeof item?.action?.query === 'string' ? ` "${item.action.query.slice(0, 100)}"` : '';
  switch (item?.type) {
    case 'web_search_call': return (done ? 'Searched the web' : 'Searching the web…') + q;
    case 'x_search_call': return (done ? 'Searched X' : 'Searching X…') + q;
    case 'code_interpreter_call': return done ? 'Ran code in xAI sandbox' : 'Running code in xAI sandbox…';
    default: return `${String(item?.type ?? 'server tool').replace(/_call$/, '').replace(/_/g, ' ')}${done ? '' : '…'}`;
  }
}

function newConvId(): string { return 'vsgrok-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
