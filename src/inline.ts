// Inline ghost-text completions with debounce and cancellation.
import * as vscode from 'vscode';
import { streamChat } from './xai/client';
import { requestOptions, cfg, clampNum } from './config';
import { cleanCompletion } from './xai/completion';

export class GrokInlineProvider implements vscode.InlineCompletionItemProvider {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  async provideInlineCompletionItems(doc: vscode.TextDocument, pos: vscode.Position, _c: vscode.InlineCompletionContext, token: vscode.CancellationToken) {
    const c = cfg();
    if (!c.get<boolean>('inlineCompletions.enabled')) { return; }
    const delay = clampNum(c.get('inlineCompletions.debounceMs'), 0, 2000, 275);
    await new Promise(r => setTimeout(r, delay));
    if (token.isCancellationRequested) { return; }
    const opts = await requestOptions(this.ctx);
    if (!opts.apiKey) { return; }

    const off = doc.offsetAt(pos);
    const text = doc.getText();
    const prefix = text.slice(Math.max(0, off - 6000), off);
    const suffix = text.slice(off, off + 2000);
    const abort = new AbortController();
    const sub = token.onCancellationRequested(() => abort.abort());
    try {
      const res = await streamChat([
        { role: 'system', content: 'You are a code completion engine. Output ONLY the exact text to insert at <CURSOR>. No explanations, no markdown fences, no repetition of existing code. If nothing sensible, output nothing.' },
        { role: 'user', content: `Language: ${doc.languageId}\nFile: ${vscode.workspace.asRelativePath(doc.uri)}\n\n${prefix}<CURSOR>${suffix}` },
      ], {
        ...opts,
        model: c.get<string>('inlineCompletions.model') || opts.model,
        temperature: 0.1,
        maxTokens: clampNum(c.get('inlineCompletions.maxTokens'), 16, 1024, 128),
        signal: abort.signal,
        timeoutMs: 20000,
      });
      if (token.isCancellationRequested) { return; }
      const insert = cleanCompletion(res.content, prefix, suffix);
      if (!insert) { return; }
      return [new vscode.InlineCompletionItem(insert, new vscode.Range(pos, pos))];
    } catch {
      return;
    } finally { sub.dispose(); }
  }
}
