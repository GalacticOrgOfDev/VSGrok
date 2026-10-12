// Inline edit (Ctrl+I / Cmd+I): instruction in an inline comment-widget input at the cursor. The streamed replacement is
// rendered as an interleaved diff inside that widget (and on demand in a diff editor); the document itself is NOT
// touched until Accept (Tab / Ctrl/Cmd+Enter), which applies one undoable edit. Reject (Esc) only clears the UI.
// Reply in the same widget to refine. Secret-file and workspace rules come from checkReadable().
import * as vscode from 'vscode';
import { streamChat } from './xai/client';
import { requestOptions, cfg } from './config';
import { checkReadable } from './security';
import { buildInlineEditMessages, cleanPartial, cleanReplacement, diffStats, diffMarkdown, shiftRegion, InlineEditTurn, MAX_SELECTION_CHARS } from './inlineEditCore';

const CTX_ACTIVE = 'vsgrok.inlineEditActive';
const CTX_READY = 'vsgrok.inlineEditReady';
const SCHEME = 'vsgrok-inline';
const MOD = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';

interface Session {
  editor: vscode.TextEditor;
  doc: vscode.TextDocument;
  /** Region [start, end) as offsets, kept in sync with edits outside it. */
  start: number; end: number;
  original: string;
  history: InlineEditTurn[];
  thread?: vscode.CommentThread;
  abort?: AbortController;
  /** Generation: bumped on every submit; stale streams/flushes compare against it. */
  gen: number;
  timer?: NodeJS.Timeout;
  ready: boolean;
  /** Latest (partial or final) proposal text. */
  proposal: string;
  result?: string;
  applying: boolean;
  closing: boolean;
}

const author = { name: 'You' };
const grok = { name: 'Grok' };

class Note implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  constructor(public body: vscode.MarkdownString | string, public author: vscode.CommentAuthorInformation, public contextValue?: string) {}
}

class ProposalDocs implements vscode.TextDocumentContentProvider {
  readonly docs = new Map<string, string>();
  private readonly em = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.em.event;
  provideTextDocumentContent(u: vscode.Uri) { return this.docs.get(u.toString()) ?? ''; }
  set(u: vscode.Uri, t: string) { this.docs.set(u.toString(), t); this.em.fire(u); }
  dispose() { this.em.dispose(); }
}

export class InlineEditController implements vscode.Disposable {
  private session?: Session;
  private readonly comments: vscode.CommentController;
  private readonly provider = new ProposalDocs();
  private readonly regionDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'), isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'), overviewRulerLane: vscode.OverviewRulerLane.Left,
    // Non-colour cue (HC themes often make diff backgrounds transparent).
    before: { contentText: '✎ ', color: new vscode.ThemeColor('editorLineNumber.activeForeground') },
    outlineColor: new vscode.ThemeColor('contrastActiveBorder'), outlineStyle: 'dashed', outlineWidth: '0px',
  });
  private readonly subs: vscode.Disposable[] = [];
  /** Test hook: last status line shown. */
  lastStatus = '';

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.comments = vscode.comments.createCommentController('vsgrok-inline', 'Grok inline edit');
    this.comments.options = { prompt: 'Tell Grok how to change this code (Enter to send)…', placeHolder: 'e.g. "add error handling", "convert to async/await"' };
    this.subs.push(
      this.comments, this.regionDeco, this.provider,
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this.provider),
      vscode.workspace.onDidChangeTextDocument(e => this.onDocChange(e)),
      vscode.workspace.onDidCloseTextDocument(d => { if (this.session?.doc === d) { this.end(); } }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
    );
  }

  dispose() { this.end(); for (const d of this.subs) { d.dispose(); } }

  get active(): boolean { return !!this.session; }
  /** Test hook. */
  get state(): { ready: boolean; result?: string; proposal: string; start: number; end: number } | undefined {
    const s = this.session; return s && { ready: s.ready, result: s.result, proposal: s.proposal, start: s.start, end: s.end };
  }

  /** Edits elsewhere in the file shift the region; an edit touching the region cancels (nothing to revert: the buffer was never changed). */
  private onDocChange(e: vscode.TextDocumentChangeEvent) {
    const s = this.session;
    if (!s || e.document !== s.doc || s.applying || !e.contentChanges.length) { return; }
    const r = shiftRegion({ start: s.start, end: s.end }, e.contentChanges.map(c => ({ offset: c.rangeOffset, length: c.rangeLength, text: c.text })));
    if (!r) { this.end('The code being edited changed; inline edit cancelled (your text is untouched).'); return; }
    s.start = r.start; s.end = r.end;
    this.decorate();
  }

  /** Ctrl+I. `instruction` skips the input (tests, or callers that already have it). */
  async start(instruction?: string): Promise<void> {
    if (!cfg().get<boolean>('inlineEdit.enabled', true)) { return; }
    const ed = vscode.window.activeTextEditor;
    if (!ed) { return; }
    if (this.session) { this.end(); }
    const doc = ed.document;
    const sel = ed.selection;
    const firstLine = sel.start.line;
    let lastLine = sel.end.line;
    if (!sel.isEmpty && sel.end.character === 0 && lastLine > firstLine) { lastLine--; }
    const chk = await checkReadable(doc.uri);
    if (!chk.ok) { this.refuse(doc, lastLine, `Inline edit isn't available here: ${chk.reason ?? 'not allowed for this file'}.`); return; }
    const startPos = new vscode.Position(firstLine, 0);
    const endPos = lastLine + 1 < doc.lineCount ? new vscode.Position(lastLine + 1, 0) : doc.lineAt(lastLine).range.end;
    const original = doc.getText(new vscode.Range(startPos, endPos));
    if (original.length > MAX_SELECTION_CHARS) { this.refuse(doc, lastLine, `The selection is too large for an inline edit (over ${MAX_SELECTION_CHARS.toLocaleString('en-US')} characters). Ask in the chat instead.`); return; }
    const s: Session = { editor: ed, doc, start: doc.offsetAt(startPos), end: doc.offsetAt(endPos), original, history: [], gen: 0, ready: false, proposal: '', applying: false, closing: false };
    this.session = s;
    void vscode.commands.executeCommand('setContext', CTX_ACTIVE, true);
    const thread = this.comments.createCommentThread(doc.uri, new vscode.Range(lastLine, 0, lastLine, 0), []);
    thread.canReply = true; thread.label = 'Grok inline edit'; thread.contextValue = 'vsgrok-inline';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    s.thread = thread;
    this.decorate();
    if (instruction) { await this.submit(instruction); }
  }

  /** Refusals are shown in the inline widget (discoverable, read by screen readers), not as a popup; Esc closes it. */
  private refuse(doc: vscode.TextDocument, line: number, msg: string) {
    this.lastStatus = msg;
    const t = this.comments.createCommentThread(doc.uri, new vscode.Range(line, 0, line, 0), [new Note(msg, grok)]);
    t.canReply = false; t.label = 'Grok inline edit'; t.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.refusal?.dispose(); this.refusal = t;
    void vscode.commands.executeCommand('setContext', CTX_ACTIVE, true);
  }
  private refusal?: vscode.CommentThread;

  /** Reply from the comment widget (first instruction or a refinement). */
  async submit(text: string): Promise<void> {
    const s = this.session;
    const instruction = text.trim();
    if (!s || !instruction || s.closing) { return; }
    // A refinement supersedes any running stream: abort it and invalidate its pending flushes.
    s.abort?.abort(); if (s.timer) { clearTimeout(s.timer); s.timer = undefined; }
    const gen = ++s.gen;
    s.ready = false; s.result = undefined; void vscode.commands.executeCommand('setContext', CTX_READY, false);
    s.history.push({ instruction });
    this.status('$(loading~spin) Writing…', true);
    const opts = await requestOptions(this.ctx);
    if (!opts.apiKey) { this.status('Set your xAI API key first (VSGrok: Set API Key).'); return; }
    const text0 = s.doc.getText();
    const messages = buildInlineEditMessages({
      instruction, region: s.original, before: text0.slice(0, s.start), after: text0.slice(s.end), languageId: s.doc.languageId,
      path: vscode.workspace.asRelativePath(s.doc.uri, false), history: s.history.slice(0, -1),
    });
    const abort = new AbortController(); s.abort = abort;
    const live = () => this.session === s && s.gen === gen && !abort.signal.aborted && !s.closing;
    let raw = '';
    const flush = () => { s.timer = undefined; if (live()) { this.render(s, cleanPartial(raw), false); } };
    try {
      await streamChat(messages, {
        ...opts, temperature: 0.2, signal: abort.signal, maxRetries: 1,
        onContent: (d) => { raw += d; if (!s.timer && live()) { s.timer = setTimeout(flush, 80); } },
      });
      if (s.timer) { clearTimeout(s.timer); s.timer = undefined; }
      if (!live()) { return; }
      const result = cleanReplacement(raw, s.original);
      s.result = result; s.history[s.history.length - 1].result = result; s.ready = true;
      this.render(s, result, true);
      void vscode.commands.executeCommand('setContext', CTX_READY, true);
    } catch (e) {
      if (s.timer) { clearTimeout(s.timer); s.timer = undefined; }
      if (live()) { this.status(`Failed: ${(e as Error).message}`); }
    }
  }

  private proposalUri(s: Session) { return vscode.Uri.from({ scheme: SCHEME, path: s.doc.uri.path, query: `p=${encodeURIComponent(s.doc.uri.toString())}` }); }

  /** Show the proposal as an interleaved diff in the widget; keep the side-by-side document current. */
  private render(s: Session, text: string, done: boolean) {
    s.proposal = text;
    const t = s.doc.getText();
    this.provider.set(this.proposalUri(s), t.slice(0, s.start) + text + t.slice(s.end));
    const md = diffMarkdown(s.original, text, s.doc.languageId);
    if (done) {
      const st = diffStats(s.original, text);
      this.status(`${md}\n\n+${st.added} −${st.removed} · **${MOD}+Enter** accept (or **Tab** in the editor) · **Esc** reject · [View diff](command:vsgrok.inlineEdit.viewDiff) · reply below to refine`, true);
    } else { this.status(`${md}\n\n$(loading~spin) Writing…`, true); }
  }

  async viewDiff(): Promise<void> {
    const s = this.session; if (!s) { return; }
    await vscode.commands.executeCommand('vscode.diff', s.doc.uri, this.proposalUri(s), `${vscode.workspace.asRelativePath(s.doc.uri, false)} ↔ Grok inline edit`, { preview: true, preserveFocus: true });
  }

  async accept(): Promise<void> {
    const s = this.session;
    if (!s?.ready || s.result === undefined || s.closing) { return; }
    s.closing = true;
    const range = new vscode.Range(s.doc.positionAt(s.start), s.doc.positionAt(s.end));
    if (s.doc.getText(range) !== s.original) { this.end('The code changed since Grok read it; nothing was applied.'); return; }
    s.applying = true;
    try {
      const ed = vscode.window.visibleTextEditors.find(e => e.document === s.doc);
      // One undo stop on each side: a single Ctrl+Z undoes exactly this edit.
      const ok = ed ? await ed.edit(eb => eb.replace(range, s.result!), { undoStopBefore: true, undoStopAfter: true }) : false;
      if (!ok) { const we = new vscode.WorkspaceEdit(); we.replace(s.doc.uri, range, s.result); await vscode.workspace.applyEdit(we); }
    } finally { s.applying = false; }
    this.end();
  }

  async reject(): Promise<void> {
    if (this.refusal && !this.session) { this.refusal.dispose(); this.refusal = undefined; void vscode.commands.executeCommand('setContext', CTX_ACTIVE, false); return; }
    this.end();
  }

  private decorate() {
    const s = this.session;
    for (const ed of vscode.window.visibleTextEditors) {
      if (!s || ed.document !== s.doc) { ed.setDecorations(this.regionDeco, []); continue; }
      const endPos = s.doc.positionAt(Math.max(s.start, s.end - (s.original.endsWith('\n') ? 1 : 0)));
      ed.setDecorations(this.regionDeco, [new vscode.Range(s.doc.positionAt(s.start), endPos)]);
    }
  }

  private status(text: string, md = false) {
    const s = this.session;
    this.lastStatus = text;
    if (!s?.thread) { return; }
    const body = md ? Object.assign(new vscode.MarkdownString(text, true), { isTrusted: { enabledCommands: ['vsgrok.inlineEdit.viewDiff'] } }) : text;
    s.thread.comments = [...s.history.map(h => new Note(h.instruction, author)), new Note(body, grok)];
  }

  /** End the session. The document was never modified by a proposal, so there is nothing to revert. */
  private end(msg?: string) {
    const s = this.session;
    if (this.refusal) { this.refusal.dispose(); this.refusal = undefined; }
    if (!s) { void vscode.commands.executeCommand('setContext', CTX_ACTIVE, false); return; }
    s.closing = true;
    s.abort?.abort(); if (s.timer) { clearTimeout(s.timer); s.timer = undefined; }
    s.thread?.dispose();
    this.provider.docs.delete(this.proposalUri(s).toString());
    this.session = undefined;
    this.decorate();
    void vscode.commands.executeCommand('setContext', CTX_ACTIVE, false);
    void vscode.commands.executeCommand('setContext', CTX_READY, false);
    if (msg) { this.lastStatus = msg; vscode.window.setStatusBarMessage(`$(info) ${msg}`, 8000); }
  }
}

export function registerInlineEdit(ctx: vscode.ExtensionContext): InlineEditController {
  const c = new InlineEditController(ctx);
  ctx.subscriptions.push(
    c,
    vscode.commands.registerCommand('vsgrok.inlineEdit', (instruction?: unknown) => c.start(typeof instruction === 'string' ? instruction : undefined)),
    vscode.commands.registerCommand('vsgrok.inlineEdit.submit', (reply?: vscode.CommentReply | string) => c.submit(typeof reply === 'string' ? reply : reply?.text ?? '')),
    vscode.commands.registerCommand('vsgrok.inlineEdit.accept', () => c.accept()),
    vscode.commands.registerCommand('vsgrok.inlineEdit.reject', () => c.reject()),
    vscode.commands.registerCommand('vsgrok.inlineEdit.viewDiff', () => c.viewDiff()),
  );
  return c;
}
