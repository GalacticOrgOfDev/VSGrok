import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { autoDecision, commandAllowed, budgetExceeded, parseLevel, DEFAULT_COMMAND_ALLOWLIST } from '../agent/autoApproveCore';
import { runResponsesLoop } from '../agent/responsesLoop';
import { requestDecision, setApprover, setAutoPolicy, runInTaskScope } from '../agent/approvals';

const edit = { kind: 'edit' as const, path: 'src/a.ts', added: 1, removed: 0 };
const plan = (files: { path: string; op: 'create' | 'modify' | 'delete' | 'rename'; warn?: string; refused?: string }[]) => ({ kind: 'plan' as const, files: files.map(f => ({ added: 1, removed: 0, ...f })) });

test('auto-approve levels: none asks for everything; safeEdits only workspace creates/edits; commands only at editsAndCommands', () => {
  const ctx = (level: string, writable = true) => ({ level: parseLevel(level), allowlist: DEFAULT_COMMAND_ALLOWLIST, writable });
  assert.equal(autoDecision(edit, ctx('none')).auto, false);
  assert.equal(autoDecision(edit, ctx('safeEdits')).auto, true);
  assert.equal(autoDecision(edit, ctx('safeEdits', false)).auto, false, 'outside / symlinked / flagged → ask');
  assert.equal(autoDecision(plan([{ path: 'a', op: 'create' }, { path: 'b', op: 'modify' }]), ctx('safeEdits')).auto, true);
  assert.match(autoDecision(plan([{ path: 'a', op: 'create' }, { path: 'b', op: 'delete' }]), ctx('editsAndCommands')).why, /deletes b/);
  assert.equal(autoDecision(plan([{ path: 'a', op: 'rename' }]), ctx('editsAndCommands')).auto, false);
  assert.equal(autoDecision(plan([{ path: 'package.json', op: 'modify', warn: 'changes scripts' }]), ctx('editsAndCommands')).auto, false);
  assert.equal(autoDecision(plan([{ path: '.env', op: 'create', refused: 'secret' }]), ctx('editsAndCommands')).auto, false);
  assert.equal(autoDecision({ kind: 'command', command: 'npm test' }, ctx('safeEdits')).auto, false);
  assert.equal(autoDecision({ kind: 'command', command: 'npm  test' }, ctx('editsAndCommands')).auto, true);
  assert.equal(autoDecision({ kind: 'command', command: 'rm -rf .' }, ctx('editsAndCommands')).auto, false);
  assert.equal(parseLevel('everything'), 'none');
});

test('command allowlist: exact match only, shell metacharacters always ask', () => {
  const al = ['npm test', 'go test ./...'];
  assert.equal(commandAllowed(' npm test ', al), true);
  for (const bad of ['npm test; rm -rf ~', 'npm test && curl x', 'npm test | sh', 'npm test > out', 'npm test $(id)', 'npm test `id`', 'npm test\nrm x', 'npm test --watch', 'npm tests']) {
    assert.equal(commandAllowed(bad, al), false, bad);
  }
  assert.equal(commandAllowed('go test ./...', al), true, 'dots and slashes are fine');
});

test('budget: tokens, cost only when reported, 0 = no limit', () => {
  assert.match(budgetExceeded({ tokens: 2000 }, { maxTokens: 1000, maxCostUsd: 0 })!, /token budget/);
  assert.equal(budgetExceeded({ tokens: 2000 }, { maxTokens: 0, maxCostUsd: 1 }), undefined);
  assert.match(budgetExceeded({ tokens: 1, costUsd: 1.5 }, { maxTokens: 0, maxCostUsd: 1 })!, /cost budget of \$1\.00/);
});

test('responses loop: budget stops after a tool round with one no-tools summary call', async () => {
  const fc = (i: number) => ({ type: 'function_call', id: `fc${i}`, call_id: `c${i}`, name: 'read_file', arguments: '{}', status: 'completed' });
  const calls: { tools: unknown[] }[] = [];
  let n = 0;
  const r = await runResponsesLoop({
    state: { items: [] }, newInput: [{ role: 'user', content: 'go' }], tools: [{ type: 'function', name: 'read_file' } as never], maxSteps: 10, useChain: false,
    request: async (_i, _p, tools) => { calls.push({ tools }); n++; const more = tools.length > 0; return { id: `r${n}`, output: more ? [fc(n)] : [], content: more ? '' : 'summary', functionCalls: more ? [fc(n) as never] : [], citations: [], usage: { input_tokens: 600, output_tokens: 10 } } as never; },
    execute: async () => 'ok',
    budget: (acc) => acc.inputTokens >= 600 ? 'token budget of 500 reached' : undefined,
  });
  assert.equal(r.stopReason, 'token budget of 500 reached'); assert.equal(r.hitStepCap, false);
  assert.equal(calls.length, 2); assert.deepEqual(calls[1].tools, []); assert.equal(r.finalText, 'summary');
});

test('approvals: auto policy short-circuits the card and selects every non-refused plan row; false falls through', async () => {
  const seen: unknown[] = [];
  setApprover(async (req) => { seen.push(req); return { ok: false }; });
  setAutoPolicy(async (req) => req.kind === 'plan');
  const p2 = plan([{ path: 'a', op: 'create' }, { path: 'b', op: 'modify' }]);
  const d = await runInTaskScope(() => requestDecision(p2));
  assert.deepEqual(d, { ok: true, selected: [0, 1] });
  assert.equal(seen.length, 0);
  assert.equal((await runInTaskScope(() => requestDecision(edit))).ok, false); assert.equal(seen.length, 1);
  // Outside the task's own tool calls (e.g. an Apply click during a task) the card always shows.
  assert.equal((await requestDecision(p2)).ok, false); assert.equal(seen.length, 2);
  setAutoPolicy(undefined); setApprover(undefined);
});

test('FM4: task progress says when cost is unknown or partial', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cards = require('../../media/webview/cards.js');
  assert.match(cards.taskProgressText({ steps: 2, maxSteps: 40, tokens: 1000, costMissing: 2 }), /cost not reported: token budget only/);
  assert.match(cards.taskProgressText({ steps: 2, maxSteps: 40, tokens: 1000, costUsd: 0.5, costMissing: 1 }), /≥ \$0\.50/);
  assert.doesNotMatch(cards.taskProgressText({ steps: 2, maxSteps: 40, tokens: 1000, costUsd: 0.5 }), /≥|not reported/);
});
