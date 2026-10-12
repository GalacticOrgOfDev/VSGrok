import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ApprovalBroker, requestApproval, setApprover, lineDelta, ApprovalCardMessage } from '../agent/approvals';

function broker() {
  const posted: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { b: new ApprovalBroker((m) => posted.push(m)), posted };
}

test('approval: card posted with request id; Approve resolves true', async () => {
  const { b, posted } = broker();
  const p = b.request({ kind: 'command', command: 'npm test' });
  const card = posted[0] as ApprovalCardMessage;
  assert.equal(card.type, 'approvalRequest');
  assert.equal(card.request.kind, 'command');
  assert.ok(card.reqId);
  assert.equal(b.handle({ type: 'approvalResponse', reqId: card.reqId, decision: 'approve' }), true);
  assert.equal(await p, true);
  assert.deepEqual(posted[1], { type: 'approvalResolved', reqId: card.reqId, state: 'approved' });
  assert.equal(b.size, 0);
});

test('approval: Deny and unknown decisions resolve false', async () => {
  const { b, posted } = broker();
  const p1 = b.request({ kind: 'edit', path: 'a.ts' });
  const p2 = b.request({ kind: 'edit', path: 'b.ts' });
  b.handle({ type: 'approvalResponse', reqId: posted[0].reqId, decision: 'deny' });
  b.handle({ type: 'approvalResponse', reqId: posted[1].reqId, decision: 'yes please' });
  assert.equal(await p1, false);
  assert.equal(await p2, false);
});

test('approval: ids are distinct and only the matching request resolves', async () => {
  const { b, posted } = broker();
  const p1 = b.request({ kind: 'command', command: 'a' });
  const p2 = b.request({ kind: 'command', command: 'b' });
  assert.notEqual(posted[0].reqId, posted[1].reqId);
  b.handle({ type: 'approvalResponse', reqId: posted[1].reqId, decision: 'approve' });
  assert.equal(await p2, true);
  assert.equal(b.size, 1);
  b.handle({ type: 'approvalResponse', reqId: 'nope', decision: 'approve' });
  assert.equal(b.size, 1);
  b.cancelAll('panel closed');
  assert.equal(await p1, false);
  assert.equal(posted.at(-1).state, 'panel closed');
});

test('approval: abort signal (Stop / cancel) denies; pre-aborted never posts', async () => {
  const { b, posted } = broker();
  const ac = new AbortController();
  const p = b.request({ kind: 'command', command: 'rm -rf x' }, { signal: ac.signal });
  ac.abort();
  assert.equal(await p, false);
  assert.equal(posted.at(-1).state, 'cancelled');
  const n = posted.length;
  assert.equal(await b.request({ kind: 'command', command: 'x' }, { signal: ac.signal }), false);
  assert.equal(posted.length, n);
});

test('approval: View diff calls the hook without deciding', async () => {
  const { b, posted } = broker();
  let viewed = 0;
  const p = b.request({ kind: 'edit', path: 'a.ts' }, { onViewDiff: () => { viewed++; } });
  assert.equal(b.handle({ type: 'approvalViewDiff', reqId: posted[0].reqId }), true);
  assert.equal(viewed, 1);
  assert.equal(b.size, 1);
  b.handle({ type: 'approvalResponse', reqId: posted[0].reqId, decision: 'approve' });
  assert.equal(await p, true);
  assert.equal(b.handle({ type: 'query', text: 'hi' }), false);
});

test('approval: with no chat approver registered, requests are denied', async () => {
  setApprover(undefined);
  assert.equal(await requestApproval({ kind: 'command', command: 'ls' }), false);
  setApprover(async () => true);
  assert.equal(await requestApproval({ kind: 'command', command: 'ls' }), true);
  setApprover(undefined);
});

test('lineDelta counts added/removed lines', () => {
  assert.deepEqual(lineDelta('a\nb\nc', 'a\nB\nc\nd'), { added: 2, removed: 1 });
  assert.deepEqual(lineDelta('', 'x\ny'), { added: 2, removed: 0 });
});

test('no tool approval uses VS Code popups or notifications', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  for (const f of ['src/agent/tools.ts', 'src/proposals.ts']) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
    assert.doesNotMatch(src, /show(Warning|Information|Error)Message|showQuickPick/, f);
    assert.match(src, /requestApproval\(/, f);
  }
});
