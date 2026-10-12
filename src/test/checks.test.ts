import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { filterProblems, formatProblems, detectTestCommand, parseTestFailures, testLocationHint, Problem } from '../agent/checksCore';
import { enclosingSymbol, fallbackSpan, actionPrompt } from '../editorCore';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cards = require(path.join(__dirname, '..', '..', 'media', 'webview', 'cards.js'));

const P = (path: string, line: number, severity: Problem['severity']): Problem => ({ path, line, col: 1, severity, message: `${severity} at ${line}` });

test('problems: filter by severity and path, sorted, capped with total', () => {
  const list = [P('src/a.ts', 5, 'warning'), P('src/a.ts', 2, 'error'), P('src/b/c.ts', 1, 'info'), P('lib/x.ts', 1, 'error')];
  const w = filterProblems(list);
  assert.deepEqual(w.items.map(p => p.path + ':' + p.line), ['lib/x.ts:1', 'src/a.ts:2', 'src/a.ts:5']);
  assert.equal(filterProblems(list, { path: 'src', minSeverity: 'info' }).total, 3);
  assert.equal(filterProblems(list, { path: 'src/b', minSeverity: 'info' }).items[0].path, 'src/b/c.ts');
  const capped = filterProblems(list, { minSeverity: 'hint', max: 1 });
  assert.equal(capped.items.length, 1); assert.equal(capped.total, 4);
  assert.match(formatProblems(capped.items, capped.total), /lib\/x\.ts:1/);
});

test('tests: detect command from package.json, lockfile, pytest, go, cargo and override', () => {
  assert.deepEqual(detectTestCommand({ packageJson: JSON.stringify({ scripts: { test: 'vitest run' } }), lockfile: 'pnpm' }), { command: 'pnpm test', framework: 'vitest', source: 'package.json scripts.test' });
  assert.equal(detectTestCommand({ packageJson: JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }), undefined);
  assert.equal(detectTestCommand({ packageJson: JSON.stringify({ scripts: { 'test:unit': 'node --test' } }) })?.command, 'npm run test:unit');
  assert.equal(detectTestCommand({ hasPytestIni: true })?.framework, 'pytest');
  assert.equal(detectTestCommand({ hasGoMod: true })?.command, 'go test ./...');
  assert.equal(detectTestCommand({ hasCargo: true })?.command, 'cargo test');
  assert.equal(detectTestCommand({ hasCargo: true }, ' make check ')?.command, 'make check');
  assert.equal(detectTestCommand({}), undefined);
});

test('tests: parse failures from pytest, go and jest output into file/line', () => {
  const py = parseTestFailures('FAILED tests/test_x.py::test_add - AssertionError: 1 != 2\ntests/test_x.py:12: AssertionError');
  assert.ok(py.some(f => f.file === 'tests/test_x.py'), JSON.stringify(py));
  const go = parseTestFailures('--- FAIL: TestAdd (0.00s)\n    add_test.go:9: got 1 want 2');
  assert.ok(go.some(f => f.file?.endsWith('add_test.go') && f.line === 9), JSON.stringify(go));
  const jest = parseTestFailures('  ● sum › adds\n\n    expect(received).toBe(expected)\n\n      at Object.<anonymous> (/repo/src/sum.test.ts:4:17)', '/repo');
  assert.ok(jest.some(f => f.file === 'src/sum.test.ts' && f.line === 4), JSON.stringify(jest));
  assert.deepEqual(parseTestFailures('all good'), []);
});

test('tests: location hint per framework', () => {
  assert.equal(testLocationHint('pytest', 'pkg/calc.py'), 'tests/test_calc.py');
  assert.equal(testLocationHint('go', 'pkg/calc.go'), 'pkg/calc_test.go');
  assert.ok(testLocationHint('vitest', 'src/calc.ts').includes('calc'));
});

test('editor: innermost enclosing function/class wins; fallback span', () => {
  const syms = [{ name: 'A', kind: 'Class', startLine: 0, endLine: 50, children: [
    { name: 'm', kind: 'Method', startLine: 10, endLine: 20, children: [{ name: 'v', kind: 'Variable', startLine: 12, endLine: 12 }] }] }];
  assert.equal(enclosingSymbol(syms, 12)?.name, 'm');
  assert.equal(enclosingSymbol(syms, 30)?.name, 'A');
  assert.equal(enclosingSymbol(syms, 60), undefined);
  assert.deepEqual(fallbackSpan(20, 5), { start: 0, end: 19 });
  assert.deepEqual(fallbackSpan(500, 100), { start: 70, end: 130 });
});

test('editor: prompts — tests go through propose_plan with framework/location; fix carries problems', () => {
  const t = actionPrompt('tests', { label: 'function `f`', path: 'src/a.ts', framework: 'vitest', testCommand: 'pnpm test', testLocation: 'src/a.test.ts' });
  assert.match(t, /propose_plan/); assert.match(t, /vitest/); assert.match(t, /src\/a\.test\.ts/);
  assert.match(actionPrompt('fix', { label: 'x', path: 'p', problems: 'ERR p:1 boom' }), /boom/);
  assert.match(actionPrompt('refactor', { label: 'x', path: 'p', instruction: 'Extract smaller functions' }), /Extract smaller functions/);
  assert.doesNotMatch(actionPrompt('explain', { label: 'x', path: 'p' }), /propose_/);
});

test('cards: plan spec, approve label and problems chip', () => {
  const s = cards.planSpec({ summary: 'Do it', files: [{ path: 'a.ts', op: 'create', added: 3, removed: 0 }, { path: 'b.ts', op: 'rename', newPath: 'c.ts', added: 0, removed: 0 }, { path: 'd.ts', op: 'delete', added: 0, removed: 7 }] });
  assert.match(s.title, /3 files/); assert.equal(s.summary, 'Do it');
  assert.equal(s.files[0].delta, '+3 −0'); assert.match(s.files[1].path, /b\.ts → c\.ts/); assert.equal(s.files[2].delta, '−7');
  assert.equal(cards.approveLabel(3, 3), 'Approve all (3)');
  assert.equal(cards.approveLabel(1, 3), 'Approve selected (1/3)');
  assert.equal(cards.problemsChip(0, true).hidden, true);
  assert.match(cards.problemsChip(2, true).text, /2 problems/);
  assert.match(cards.problemsChip(1, false).text, /⊘ 1 problem$/);
});
