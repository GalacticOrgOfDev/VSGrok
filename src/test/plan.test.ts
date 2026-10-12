import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { normPath, validatePlan, selectedIndices, hashText, sensitivePath, decodeText, MAX_PLAN_TOTAL } from '../agent/planCore';
import { ApprovalBroker, ApprovalCardMessage } from '../agent/approvals';

test('plan: normPath rejects absolute, .. and .git', () => {
  assert.equal(normPath('src/a.ts'), 'src/a.ts');
  assert.equal(normPath('./src\\b.ts'), 'src/b.ts');
  for (const bad of ['/etc/passwd', 'C:/x', '../x', 'a/../b', '.git/config', '', 5]) { assert.equal(normPath(bad), undefined, String(bad)); }
});

test('plan: validatePlan keeps valid ops and refuses secrets, duplicates, bad renames', () => {
  const { plan, errors } = validatePlan({ summary: 's', changes: [
    { op: 'create', path: 'src/n.ts', content: 'x' },
    { op: 'modify', path: 'src/m.ts', content: 'y' },
    { op: 'delete', path: 'src/d.ts' },
    { op: 'rename', path: 'src/r.ts', newPath: 'src/r2.ts' },
    { op: 'create', path: '.env', content: 'SECRET=1' },
    { op: 'rename', path: 'src/q.ts', newPath: 'id_rsa' },
    { op: 'modify', path: 'src/m.ts', content: 'again' },
    { op: 'modify', path: 'src/nocontent.ts' },
    { op: 'rename', path: 'src/s.ts', newPath: 'src/s.ts' },
    { op: 'explode', path: 'src/z.ts' },
  ] });
  assert.deepEqual(plan.changes.map(c => c.op + ':' + c.path), ['create:src/n.ts', 'modify:src/m.ts', 'delete:src/d.ts', 'rename:src/r.ts']);
  assert.equal(errors.length, 6);
  assert.ok(errors.some(e => /\.env/.test(e) && /secret/i.test(e)));
  assert.deepEqual(validatePlan({ changes: [{ op: 'create', path: '.env', content: 'x' }, { op: 'rename', path: 'a.ts', newPath: 'id_rsa' }] }).refused.map(r => r.path), ['.env', 'a.ts']);
});

test('plan: too many changes and empty plans are reported', () => {
  assert.ok(validatePlan({ changes: [] }).errors.some(e => /no changes/.test(e)));
  const many = Array.from({ length: 51 }, (_, i) => ({ op: 'create', path: `f${i}.ts`, content: '' }));
  assert.ok(validatePlan({ changes: many }).errors.some(e => /max is 50/.test(e)));
});

test('plan: selectedIndices dedups, sorts and drops out-of-range; hashText is stable', () => {
  assert.deepEqual(selectedIndices(3), [0, 1, 2]);
  assert.deepEqual(selectedIndices(3, [2, 0, 2, 7, -1]), [0, 2]);
  assert.equal(hashText('abc'), hashText('abc'));
  assert.notEqual(hashText('abc'), hashText('abd'));
});

test('approval: plan decision carries the selected subset; empty selection denies', async () => {
  const posted: ApprovalCardMessage[] = [];
  const b = new ApprovalBroker((m) => posted.push(m as ApprovalCardMessage));
  const req = { kind: 'plan' as const, files: [{ path: 'a', op: 'create' as const, added: 1, removed: 0 }, { path: 'b', op: 'delete' as const, added: 0, removed: 3 }] };
  const p = b.requestDecision(req);
  b.handle({ type: 'approvalResponse', reqId: posted[0].reqId, decision: 'approve', selected: [1] });
  assert.deepEqual(await p, { ok: true, selected: [1] });
  const p2 = b.requestDecision(req);
  b.handle({ type: 'approvalResponse', reqId: posted.at(-1)!.reqId, decision: 'approve', selected: [] });
  assert.equal((await p2).ok, false);
});

test('L1/L2: case-insensitive .git, Windows ADS/reserved names/trailing dot-space refused', () => {
  for (const bad of ['.GIT/config', 'a/.Git/hooks/pre-commit', 'a.ts:stream', 'CON', 'src/nul.txt', 'lpt1', 'src/foo./x.ts', 'src/foo /x.ts']) { assert.equal(normPath(bad), undefined, bad); }
  assert.equal(normPath('src/console.ts'), 'src/console.ts');
  assert.equal(normPath('.gitignore'), '.gitignore');
});

test('L1: behavior-changing paths are flagged', () => {
  assert.ok(sensitivePath('.vscode/tasks.json')); assert.ok(sensitivePath('VSGrok.md')); assert.ok(sensitivePath('.vsgrok/rules.md'));
  assert.ok(sensitivePath('.github/workflows/ci.yml')); assert.ok(sensitivePath('package.json'));
  assert.equal(sensitivePath('src/a.ts'), undefined);
});

test('L3: byte-based per-file cap and a plan total', () => {
  const emoji = '😀'.repeat(300_000); // 600k UTF-16 units, 1.2 MB UTF-8
  assert.ok(validatePlan({ changes: [{ op: 'create', path: 'e.txt', content: emoji }] }).errors.some(e => /too large/.test(e)));
  const chunk = 'x'.repeat(900_000);
  const r = validatePlan({ changes: Array.from({ length: 7 }, (_, i) => ({ op: 'create', path: `f${i}.txt`, content: chunk })) });
  assert.equal(r.plan.changes.length, Math.floor(MAX_PLAN_TOTAL / 900_000));
  assert.ok(r.errors.some(e => /in total/.test(e)));
});

test('M3: decodeText refuses binary / invalid UTF-8; hashes are sha256', () => {
  assert.equal(decodeText(Buffer.from('héllo')), 'héllo');
  assert.equal(decodeText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1])), undefined);
  assert.equal(decodeText(Buffer.from([0xe9, 0x61])), undefined); // latin-1
  assert.equal(hashText('a').length, 64);
});

test('M4: plan approvals only count selectable rows; out-of-range or missing selection denies', async () => {
  const posted: ApprovalCardMessage[] = [];
  const b = new ApprovalBroker((m) => posted.push(m as ApprovalCardMessage));
  const req = { kind: 'plan' as const, files: [{ path: 'a', op: 'create' as const, added: 1, removed: 0 }, { path: '.env', op: 'create' as const, added: 0, removed: 0, refused: 'secret' }] };
  for (const sel of [[999], [1], undefined]) {
    const p = b.requestDecision(req);
    b.handle({ type: 'approvalResponse', reqId: posted.at(-1)!.reqId, decision: 'approve', ...(sel ? { selected: sel } : {}) });
    assert.equal((await p).ok, false, JSON.stringify(sel));
  }
  const p = b.requestDecision(req);
  b.handle({ type: 'approvalResponse', reqId: posted.at(-1)!.reqId, decision: 'approve', selected: [0, 0, 1] });
  assert.deepEqual(await p, { ok: true, selected: [0] });
});
