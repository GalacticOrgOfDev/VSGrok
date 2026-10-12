// Inline edit (Ctrl+I / Cmd+I): instruction in an inline comment-widget input at the cursor, streamed replacement shown
// as an inline diff (old lines red, new lines green, inserted right below), Accept (Tab / Ctrl+Enter), Reject (Esc),
// reply in the same widget to refine. Secret-file and workspace rules come from checkReadable().
import * as vscode from 'vscode';
import { streamChat } from './xai/client';
import { requestOptions, cfg } from './config';
import { checkReadable } from './security';
import { buildInlineEditMessages, cleanPartial, cleanReplacement, diffStats, InlineEditTurn, MAX_SELECTION_CHARS } from './inlineEditCore';

const CTX_ACTIVE = 'vsgrok.inlineEditActive';
const CTX_READY = 'vsgrok.inlineEditReady';

interface Session {
  editor: vscode.TextEditor;
  doc: vscode.TextDocument;
  /** Offset of the region start, and the original text (whole lines, normally ending in \n). */
  start: number;
  original: string;
  /** Text currently inserted right after the original block ('' when none). */
  shown: string;
  /** A newline we had to add after the original (last line without \n). */
  sep: string;
  history: InlineEditTurn[];
  thread?: vscode.CommentThread;
  abort?: AbortController;
  ready: boolean;
  applying: number;
  result?: string;
}

const author = { name: 'You' };
const grok = { name: 'Grok' };

class Note implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  constructor(public body: vscode.MarkdownString | string, public author: vscode.CommentAuthorInformation, public contextValue?: string) {}
}

export class InlineEditController implements vscode.Disposable {
  private session?: Session;
  private readonly comments: vscode.CommentController;
  private readonly delDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'), isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'), overviewRulerLane: vscode.OverviewRulerLane.Left,
    opacity: '0.75',
  });
  private readonly addDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'), isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'), overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly subs: vscode.Disposable[] = [];
  /** Test hook: last status line shown. */
  lastStatus = '';

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.comments = vscode.comments.createCommentController('vsgrok-inline', 'Grok inline edit');
    this.comments.options = { prompt: 'Tell Grok how to change this code (Enter to send)…', placeHolder: 'e.g. "add error handling", "convert to async/await"' };
    this.subs.push(
      this.comments, this.delDeco, this.addDeco,
      vscode.workspace.onDidChangeTextDocument(e => {
        const s = this.session;
        if (s && e.document === s.doc && !s.applying && e.contentChanges.length) { this.end('Edited by you; inline edit cancelled.', true); }
      }),
      vscode.workspace.onDidCloseTextDocument(d => { if (this.session?.doc === d) { this.end(undefined, false); } }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
    );
  }

  dispose() { this.end(undefined, true); for (const d of this.subs) { d.dispose(); } }

  get active(): boolean { return !!this.session; }
  /** Test hook. */
  get state(): { ready: boolean; result?: string } | undefined { return this.session && { ready: this.session.ready, result: this.session.result }; }

  /** Ctrl+I. `instruction` skips the input (tests, or callers that already have it). */
  async start(instruction?: string): Promise<void> {
    if (!cfg().get<boolean>('inlineEdit.enabled', true)) { return; }
    const ed = vscode.window.activeTextEditor;
    if (!ed) { return; }
    if (this.session) { this.end(undefined, true); }
    const chk = await checkReadable(ed.document.uri);
    if (!chk.ok) { vscode.window.setStatusBarMessage(`$(circle-slash) Grok inline edit: ${chk.reason ?? 'not allowed for this file'}`, 6000); return; }
    const doc = ed.document;
    const sel = ed.selection;
    const firstLine = sel.start.line;
    let lastLine = sel.end.line;
    if (!sel.isEmpty && sel.end.character === 0 && lastLine > firstLine) { lastLine--; }
    const startPos = new vscode.Position(firstLine, 0);
    const endPos = lastLine + 1 < doc.lineCount ? new vscode.Position(lastLine + 1, 0) : doc.lineAt(lastLine).range.end;
    const original = doc.getText(new vscode.Range(startPos, endPos));
    if (original.length > MAX_SELECTION_CHARS) { vscode.window.setStatusBarMessage('$(circle-slash) Selection too large for an inline edit; ask in the chat instead.', 6000); return; }
    const s: Session = { editor: ed, doc, start: doc.offsetAt(startPos), original, shown: '', sep: original.endsWith('\n') ? '' : '\n', history: [], ready: false, applying: 0 };
    this.session = s;
    void vscode.commands.executeCommand('setContext', CTX_ACTIVE, true);
    const thread = this.comments.createCommentThread(doc.uri, new vscode.Range(lastLine, 0, lastLine, 0), []);
    thread.canReply = true; thread.label = 'Grok inline edit'; thread.contextValue = 'vsgrok-inline';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    s.thread = thread;
    this.decorate();
    if (instruction) { await this.submit(instruction); }
  }

  /** Reply from the comment widget (first instruction or a refinement). */
  async submit(text: string): Promise<void> {
    const s = this.session;
    const instruction = text.trim();
    if (!s || !instruction) { return; }
    s.abort?.abort();
    s.ready = false; void vscode.commands.executeCommand('setContext', CTX_READY, false);
    s.history.push({ instruction });
    this.setComments([...s.history.flatMap(h => [new Note(h.instruction, author)]), new Note(new vscode.MarkdownString('$(loading~spin) Writing…', true), grok)]);
    const opts = await requestOptions(this.ctx);
    if (!opts.apiKey) { this.status('Set your xAI API key first (VSGrok: Set API Key).'); return; }
    const before = s.doc.getText(new vscode.Range(new vscode.Position(0, 0), s.doc.positionAt(s.start)));
    const after = s.doc.getText(new vscode.Range(s.doc.positionAt(s.start + s.original.length + s.sep.length + s.shown.length), s.doc.positionAt(s.doc.getText().length)));
    const messages = buildInlineEditMessages({
      instruction, region: s.original, before, after, languageId: s.doc.languageId,
      path: vscode.workspace.asRelativePath(s.doc.uri, false), history: s.history.slice(0, -1),
    });
    const abort = new AbortController(); s.abort = abort;
    let raw = ''; let timer: NodeJS.Timeout | undefined; let chain = Promise.resolve();
    const flush = () => { timer = undefined; const t = cleanPartial(raw); chain = chain.then(() => this.show(s, t)); };
    try {
      await streamChat(messages, {
        ...opts, temperature: 0.2, signal: abort.signal, maxRetries: 1,
        onContent: (d) => { raw += d; if (!timer) { timer = setTimeout(flush, 60); } },
      });
      if (timer) { clearTimeout(timer); timer = undefined; }
      await chain;
      if (this.session !== s || abort.signal.aborted) { return; }
      const result = cleanReplacement(raw, s.original);
      await this.show(s, result);
      s.result = result; s.history[s.history.length - 1].result = result; s.ready = true;
      void vscode.commands.executeCommand('setContext', CTX_READY, true);
      const st = diffStats(s.original, result);
      this.status(`+${st.added} −${st.removed} · **Tab** or **Ctrl+Enter** accept · **Esc** reject · reply below to refine`, true);
    } catch (e) {
      if (timer) { clearTimeout(timer); }
      if (this.session === s && !abort.signal.aborted) { this.status(`Failed: ${(e as Error).message}`); }
    }
  }

  async accept(): Promise<void> {
    const s = this.session;
    if (!s?.ready) { return; }
    // Remove the original block (and our separator), keeping the new text.
    await this.edit(s, eb => eb.delete(new vscode.Range(s.doc.positionAt(s.start), s.doc.positionAt(s.start + s.original.length + s.sep.length))));
    if (s.sep && s.shown.endsWith('\n')) { /* region was the last line: drop the trailing newline we kept */
      const endOff = s.start + s.shown.length;
      await this.edit(s, eb => eb.delete(new vscode.Range(s.doc.positionAt(endOff - 1), s.doc.positionAt(endOff))));
    }
    s.shown = '';
    this.end(undefined, false);
  }

  async reject(): Promise<void> {
    const s = this.session;
    if (!s) { return; }
    s.abort?.abort();
    await this.show(s, '');
    this.end(undefined, false);
  }

  /** Replace the inserted block with `text`. */
  private async show(s: Session, text: string): Promise<void> {
    if (this.session !== s) { return; }
    const ins = text && !text.endsWith('\n') && !s.sep ? text + '\n' : text;
    if (ins === s.shown) { return; }
    const a = s.start + s.original.length;
    const range = new vscode.Range(s.doc.positionAt(a), s.doc.positionAt(a + (s.shown ? s.sep.length + s.shown.length : 0)));
    await this.edit(s, eb => eb.replace(range, ins ? s.sep + ins : ''));
    s.shown = ins;
    this.decorate();
  }

  private async edit(s: Session, fn: (eb: vscode.TextEditorEdit) => void): Promise<void> {
    s.applying++;
    try {
      const ed = vscode.window.visibleTextEditors.find(e => e.document === s.doc) ?? s.editor;
      const ok = await ed.edit(fn, { undoStopBefore: false, undoStopAfter: false });
      if (!ok) {
        const we = new vscode.WorkspaceEdit();
        // Fallback when the editor is not visible: rebuild via a WorkspaceEdit on the whole range.
        const tmp: { r: vscode.Range; t: string }[] = [];
        fn({ replace: (r: vscode.Range, t: string) => tmp.push({ r, t }), delete: (r: vscode.Range) => tmp.push({ r, t: '' }), insert: (p: vscode.Position, t: string) => tmp.push({ r: new vscode.Range(p, p), t }), setEndOfLine: () => undefined } as unknown as vscode.TextEditorEdit);
        for (const x of tmp) { we.replace(s.doc.uri, x.r, x.t); }
        await vscode.workspace.applyEdit(we);
      }
    } finally { s.applying--; }
  }

  private decorate() {
    const s = this.session;
    for (const ed of vscode.window.visibleTextEditors) {
      if (!s || ed.document !== s.doc) { ed.setDecorations(this.delDeco, []); ed.setDecorations(this.addDeco, []); continue; }
      const lines = (off: number, len: number) => len <= 0 ? [] : [new vscode.Range(s.doc.positionAt(off), s.doc.positionAt(off + len - (s.doc.getText().charAt(off + len - 1) === '\n' ? 1 : 0)))];
      ed.setDecorations(this.delDeco, s.shown ? lines(s.start, s.original.length) : []);
      ed.setDecorations(this.addDeco, lines(s.start + s.original.length + s.sep.length, s.shown.length));
    }
  }

  private setComments(c: Note[]) { if (this.session?.thread) { this.session.thread.comments = c; } }

  private status(text: string, md = false) {
    const s = this.session;
    this.lastStatus = text;
    if (!s) { return; }
    const body = md ? new vscode.MarkdownString(text) : text;
    this.setComments([...s.history.map(h => new Note(h.instruction, author)), new Note(body, grok)]);
  }

  private end(msg: string | undefined, revert: boolean) {
    const s = this.session;
    if (!s) { return; }
    s.abort?.abort();
    if (revert && s.shown) { const t = s; void (async () => { t.applying++; try { await this.showForce(t); } finally { t.applying--; } })(); }
    s.thread?.dispose();
    this.session = undefined;
    this.decorate();
    void vscode.commands.executeCommand('setContext', CTX_ACTIVE, false);
    void vscode.commands.executeCommand('setContext', CTX_READY, false);
    if (msg) { vscode.window.setStatusBarMessage(`$(info) ${msg}`, 5000); }
  }

  /** Remove the inserted block after the session has ended (cancel paths). */
  private async showForce(s: Session) {
    const a = s.start + s.original.length;
    const we = new vscode.WorkspaceEdit();
    we.delete(s.doc.uri, new vscode.Range(s.doc.positionAt(a), s.doc.positionAt(a + s.sep.length + s.shown.length)));
    await vscode.workspace.applyEdit(we);
    s.shown = '';
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
  );
  return c;
}
