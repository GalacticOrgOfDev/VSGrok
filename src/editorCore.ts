// Pure helpers for editor actions. No vscode import.
export interface Sym { name: string; kind: string; startLine: number; endLine: number; children?: Sym[] }
const CONTAINER = new Set(['Function', 'Method', 'Constructor', 'Class', 'Interface', 'Enum', 'Struct', 'Module', 'Namespace', 'Property', 'Variable', 'Constant', 'Field']);
const PREFERRED = new Set(['Function', 'Method', 'Constructor', 'Class', 'Interface', 'Enum', 'Struct']);

/** Innermost function/method/class containing `line` (0-based). Variables/properties only if nothing better encloses it. */
export function enclosingSymbol(symbols: Sym[], line: number): Sym | undefined {
  let best: Sym | undefined; let bestPref: Sym | undefined;
  const walk = (list: Sym[]) => {
    for (const s of list) {
      if (line < s.startLine || line > s.endLine) { continue; }
      if (CONTAINER.has(s.kind)) {
        if (!best || (s.endLine - s.startLine) <= (best.endLine - best.startLine)) { best = s; }
        if (PREFERRED.has(s.kind) && (!bestPref || (s.endLine - s.startLine) <= (bestPref.endLine - bestPref.startLine))) { bestPref = s; }
      }
      if (s.children) { walk(s.children); }
    }
  };
  walk(symbols);
  return bestPref ?? best;
}

/** Fallback span when there is no selection or symbol: the whole file if short, else ±window lines. */
export function fallbackSpan(lineCount: number, line: number, window = 30): { start: number; end: number } {
  if (lineCount <= window * 2 + 1) { return { start: 0, end: Math.max(0, lineCount - 1) }; }
  return { start: Math.max(0, line - window), end: Math.min(lineCount - 1, line + window) };
}

export type EditorAction = 'explain' | 'tests' | 'fix' | 'refactor' | 'comment';
export function actionPrompt(a: EditorAction, o: { label: string; path: string; framework?: string; testCommand?: string; testLocation?: string; problems?: string; instruction?: string }): string {
  switch (a) {
    case 'explain': return `Explain ${o.label} in ${o.path} (attached). Cover what it does, how it fits into the codebase (look up callers/related code with find_relevant_files or search_workspace if useful), inputs/outputs, edge cases and anything surprising. Don't change files.`;
    case 'tests': return `Write tests for ${o.label} in ${o.path} (attached).\n` +
      `Test framework: ${o.framework ?? 'unknown — infer it from the project'}${o.testCommand ? `; tests run with \`${o.testCommand}\`` : ''}.\n` +
      `Put them where this project keeps tests (suggested: ${o.testLocation ?? 'follow existing test files'}); first look at existing tests (find_relevant_files / list_files) to match naming, imports and style.\n` +
      'Cover normal cases, edge cases and errors. Propose the test file(s) with propose_plan (create or modify test files only, never the code under test), then offer to run them with run_tests.';
    case 'fix': return `Fix the problems in ${o.label} in ${o.path} (attached).\n${o.problems ? o.problems + '\n' : 'VS Code reports no problems in this range. Say so briefly and do not edit anything; you may point out likely bugs you notice.\n'}` +
      (o.problems ? 'Make the smallest correct change. Use propose_edit for one file or propose_plan if the fix spans files, then check with get_problems.' : '');
    case 'comment': return `Add clear, concise comments and doc comments to ${o.label} in ${o.path} (attached), in this language's usual style. Explain intent and non-obvious logic; don't restate the code or change behavior. Propose the change with propose_edit.`;
    case 'refactor': return `Refactor ${o.label} in ${o.path} (attached): ${o.instruction ?? 'improve readability and structure without changing behavior'}.\n` +
      'Keep behavior identical and update callers if signatures change (find them with find_relevant_files / search_workspace). Use propose_plan when more than one file changes, otherwise propose_edit. Afterwards check get_problems.';
  }
}
