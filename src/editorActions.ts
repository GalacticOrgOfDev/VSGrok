// Right-click / palette actions: Explain This, Write Tests for This, Fix Problems Here, Refactor…
import * as vscode from 'vscode';
import { ChatViewProvider } from './chat';
import { Sym, enclosingSymbol, fallbackSpan, actionPrompt, EditorAction } from './editorCore';
import { detectProjectTests, collectProblems } from './agent/checks';
import { filterProblems, formatProblems, testLocationHint } from './agent/checksCore';
import { checkReadable } from './security';

function toSym(s: vscode.DocumentSymbol): Sym {
  return { name: s.name, kind: vscode.SymbolKind[s.kind], startLine: s.range.start.line, endLine: s.range.end.line, children: s.children?.map(toSym) };
}

/** Selection, else the enclosing symbol, else a window around the cursor. */
export async function resolveTarget(ed: vscode.TextEditor): Promise<{ range: vscode.Range; label: string }> {
  const doc = ed.document;
  if (!ed.selection.isEmpty) {
    return { range: new vscode.Range(ed.selection.start, ed.selection.end), label: `the selected code (lines ${ed.selection.start.line + 1}-${ed.selection.end.line + 1})` };
  }
  const line = ed.selection.active.line;
  try {
    const raw = await Promise.race([
      vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', doc.uri),
      new Promise<undefined>(r => setTimeout(() => r(undefined), 3000)),
    ]) ?? [];
    const syms: Sym[] = raw.map(s => 'children' in s ? toSym(s) : { name: s.name, kind: vscode.SymbolKind[s.kind], startLine: s.location.range.start.line, endLine: s.location.range.end.line });
    const hit = enclosingSymbol(syms, line);
    if (hit) { return { range: new vscode.Range(hit.startLine, 0, hit.endLine, doc.lineAt(hit.endLine).text.length), label: `${hit.kind.toLowerCase()} \`${hit.name}\` (lines ${hit.startLine + 1}-${hit.endLine + 1})` }; }
  } catch { /* no provider */ }
  const sp = fallbackSpan(doc.lineCount, line);
  return { range: new vscode.Range(sp.start, 0, sp.end, doc.lineAt(sp.end).text.length), label: sp.start === 0 && sp.end === doc.lineCount - 1 ? 'this file' : `lines ${sp.start + 1}-${sp.end + 1}` };
}

export const REFACTOR_PRESETS: { label: string; detail: string }[] = [
  { label: 'Improve readability', detail: 'Clearer names, structure and formatting; same behavior' },
  { label: 'Extract smaller functions', detail: 'Split long code into well-named helpers' },
  { label: 'Simplify control flow', detail: 'Flatten nesting, early returns, fewer branches' },
  { label: 'Tighten types', detail: 'Add or narrow types, remove any/unknown where possible' },
  { label: 'Remove duplication', detail: 'Factor repeated logic into one place' },
  { label: 'Rename for clarity', detail: 'Better names, callers updated' },
  { label: 'Modernize syntax', detail: 'Use current language features and idioms' },
  { label: 'Convert to async/await', detail: 'Replace callbacks/promise chains with async/await' },
];

export async function runEditorAction(chat: ChatViewProvider, action: EditorAction, instruction?: string): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { vscode.window.setStatusBarMessage('VSGrok: open a file first', 3000); return; }
  const chk = await checkReadable(ed.document.uri);
  if (!chk.ok) { vscode.window.setStatusBarMessage(`VSGrok: refused (${chk.reason})`, 4000); return; }
  if (action === 'refactor' && instruction === undefined) {
    const pick = await vscode.window.showQuickPick([...REFACTOR_PRESETS, { label: '$(edit) Describe the refactor…', detail: 'Tell Grok exactly what to change', custom: true }], { placeHolder: 'How should Grok refactor this?', matchOnDetail: true });
    if (!pick) { return; }
    instruction = 'custom' in pick ? await vscode.window.showInputBox({ prompt: 'Describe the refactor', ignoreFocusOut: true }) : pick.label;
    if (!instruction?.trim()) { return; }
  }
  const { range, label } = await resolveTarget(ed);
  const path = vscode.workspace.asRelativePath(ed.document.uri, false);
  let extra: Parameters<typeof actionPrompt>[1] = { label, path, instruction };
  if (action === 'tests') {
    const tc = await detectProjectTests(path).catch(() => undefined);
    extra = { ...extra, framework: tc?.framework, testCommand: tc?.command, testLocation: testLocationHint(tc?.framework ?? '', path) };
  }
  if (action === 'fix') {
    const all = collectProblems([ed.document.uri]).filter(p => p.line - 1 >= range.start.line && p.line - 1 <= range.end.line);
    const { items, total } = filterProblems(all, { minSeverity: 'hint', max: 50 });
    extra.problems = total ? formatProblems(items, total) : undefined;
  }
  await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
  await chat.addFileContext(ed.document.uri, range);
  await chat.injectQuery(actionPrompt(action, extra), { agent: action !== 'explain' ? true : undefined });
}
