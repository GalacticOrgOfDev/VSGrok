// Drives the real media/webview/main.js in jsdom: plan card, plan applied/undone, checks offer, Problems chip.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const root = path.join(__dirname, '..', '..');
/* eslint-disable @typescript-eslint/no-explicit-any */
function boot() {
  const src = fs.readFileSync(path.join(root, 'src', 'chat.ts'), 'utf8');
  const body = src.slice(src.indexOf('<body'), src.indexOf('<script', src.indexOf('<body'))).replace(/\$\{[^}]*\}/g, '');
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head>${body}</body></html>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window as any;
  const sent: any[] = [];
  w.acquireVsCodeApi = () => ({ postMessage: (m: any) => sent.push(m), getState: () => undefined, setState: () => undefined });
  w.requestAnimationFrame = (f: any) => setTimeout(f, 0); w.cancelAnimationFrame = (id: any) => clearTimeout(id);
  w.HTMLElement.prototype.scrollIntoView = () => undefined;
  if (!w.matchMedia) { w.matchMedia = () => ({ matches: false, addEventListener() { /* */ }, addListener() { /* */ } }); }
  for (const f of ['marked.min.js', 'purify.min.js', 'cards.js']) { w.eval(fs.readFileSync(path.join(root, 'media', 'webview', f), 'utf8')); }
  w.eval(fs.readFileSync(path.join(root, 'media', 'webview', 'main.js'), 'utf8'));
  const post = (m: any) => w.dispatchEvent(new w.MessageEvent('message', { data: m }));
  return { w, d: w.document as Document, sent, post };
}
const planReq = { kind: 'plan', summary: 'S', files: [
  { path: 'src/components/a.ts', op: 'create', added: 3, removed: 0 },
  { path: 'src/b.ts', op: 'delete', added: 0, removed: 4 },
  { path: 'src/c.ts', op: 'rename', newPath: 'src/d.ts', added: 0, removed: 0 },
  { path: '.env.local', op: 'create', added: 0, removed: 0, refused: 'secrets/credentials file' },
] };

test('plan card: refused row disabled with reason; meta line; Select all tri-state; focus not on Approve', () => {
  const { d, post } = boot();
  post({ type: 'approvalRequest', reqId: 'r1', request: planReq });
  const card = d.querySelector('.plan-card')!;
  assert.match(card.querySelector('.approval-head')!.textContent!, /3 files/);
  assert.equal(card.querySelector('.plan-meta')!.textContent, '1 new · 1 rename · 1 delete · 1 refused');
  const rows = [...card.querySelectorAll('.plan-file')] as HTMLElement[];
  assert.equal(rows.length, 4);
  const ref = rows[3]; const rcb = ref.querySelector('input') as HTMLInputElement;
  assert.ok(ref.classList.contains('refused')); assert.equal(rcb.disabled, true); assert.equal(rcb.checked, false);
  assert.equal(d.getElementById(rcb.getAttribute('aria-describedby')!)!.textContent, '⛔ secrets/credentials file');
  assert.equal(ref.querySelector('.plan-diff'), null);
  assert.equal(rows[1].dataset.op, 'delete');
  assert.equal(rows[0].querySelector('.plan-op')!.getAttribute('aria-hidden'), 'true');
  assert.equal(rows[0].querySelector('.sr-only')!.textContent, 'new: ');
  assert.equal(rows[0].querySelectorAll('wbr').length, 2);
  assert.match(rows[2].querySelector('.plan-new')!.textContent!, /→ src\/d\.ts/);
  assert.equal(rows[1].querySelector('.plan-delta')!.getAttribute('aria-label'), '4 lines removed');
  const ok = card.querySelector('.approval-btn.approve') as HTMLButtonElement;
  const all = card.querySelector('.plan-all input') as HTMLInputElement;
  assert.equal(ok.textContent, 'Approve all (3)');
  assert.notEqual(d.activeElement, ok); assert.equal(d.activeElement, all);
  (rows[1].querySelector('input') as HTMLInputElement).click();
  assert.equal(ok.textContent, 'Approve selected (2/3)'); assert.equal(all.indeterminate, true);
  all.click(); assert.equal(ok.textContent, 'Approve all (3)'); assert.equal(all.indeterminate, false);
  all.click(); assert.equal(ok.disabled, true);
  all.click();
});

test('plan card: decision sends file indices, marks skipped rows, holds then returns focus', () => {
  const { d, post, sent } = boot();
  post({ type: 'approvalRequest', reqId: 'r1', request: planReq });
  const card = d.querySelector('.plan-card')!;
  const rows = [...card.querySelectorAll('.plan-file')] as HTMLElement[];
  (rows[1].querySelector('input') as HTMLInputElement).click();
  (card.querySelector('.approval-btn.approve') as HTMLButtonElement).click();
  const m = sent.find(x => x.type === 'approvalResponse');
  assert.deepEqual([...m.selected], [0, 2]);
  assert.ok(rows[1].classList.contains('skipped')); assert.ok(!rows[0].classList.contains('skipped'));
  const status = card.querySelector('.approval-status')!;
  assert.equal(d.activeElement, status); assert.equal(status.textContent, 'Applying…');
  post({ type: 'approvalResolved', reqId: 'r1', state: 'approved' });
  assert.equal(d.activeElement, d.getElementById('input'));
  assert.equal(card.querySelector('.approval-actions'), null);
});

test('command card keeps focus on Run, then holds and returns focus after the decision', () => {
  const { d, post } = boot();
  post({ type: 'approvalRequest', reqId: 'c1', request: { kind: 'command', command: 'npm test' } });
  const run = d.querySelector('.approval-btn.approve') as HTMLButtonElement;
  assert.equal(d.activeElement, run);
  run.click();
  assert.equal(d.activeElement!.className, 'approval-status');
  post({ type: 'approvalResolved', reqId: 'c1', state: 'approved' });
  assert.equal(d.activeElement, d.getElementById('input'));
});

test('plan applied card: data-action buttons, undone title/state, non-retryable refusal keeps Undo disabled', () => {
  const { d, post, sent } = boot();
  post({ type: 'planApplied', planId: 'p1', paths: ['a', 'b'], summary: 'S' });
  post({ type: 'planApplied', planId: 'p2', paths: ['c'] });
  assert.equal(d.getElementById('sr-announce')!.textContent, 'Plan applied: 1 file');
  const [c1, c2] = [...d.querySelectorAll('.plan-done')] as HTMLElement[];
  const chk = c1.querySelector('[data-action="checks"]') as HTMLButtonElement;
  chk.click();
  assert.equal(c1.querySelector('.approval-status')!.textContent, 'Asked Grok to re-run the checks.');
  assert.ok(sent.some(m => m.type === 'rerunChecks'));
  (c1.querySelector('[data-action="undo"]') as HTMLButtonElement).click();
  assert.ok(sent.some(m => m.type === 'undoPlan' && m.planId === 'p1'));
  post({ type: 'planUndone', planId: 'p1', ok: true, msg: 'Undid plan: a, b' });
  assert.equal(c1.dataset.state, 'undone'); assert.equal(c1.querySelector('.approval-head')!.textContent, '↶ Plan undone');
  assert.equal(c1.querySelector('[data-action="undo"]'), null);
  (c2.querySelector('[data-action="undo"]') as HTMLButtonElement).click();
  post({ type: 'planUndone', planId: 'p2', ok: false, msg: "Can't undo: c changed since the plan was applied." });
  assert.equal((c2.querySelector('[data-action="undo"]') as HTMLButtonElement).disabled, true);
  assert.match(c2.querySelector('.approval-status')!.textContent!, /^✕ Can't undo/);
  post({ type: 'planUndone', planId: 'p2', ok: false, msg: 'Undo failed', retryable: true });
  assert.equal((c2.querySelector('[data-action="undo"]') as HTMLButtonElement).disabled, false);
});

test('checks offer is a footer button on the turn, not a card', () => {
  const { d, post, sent } = boot();
  post({ type: 'streamStart', id: 'a1' });
  post({ type: 'checksOffer' });
  post({ type: 'streamDone', id: 'a1', meta: {} });
  assert.equal(d.querySelector('.checks-offer'), null);
  const b = d.querySelector('.msg-footer .checks-btn') as HTMLButtonElement;
  assert.ok(b); assert.match(b.textContent!, /Re-run checks/);
  b.click(); assert.ok(sent.some(m => m.type === 'rerunChecks')); assert.equal(b.disabled, true);
});

test('Problems chip: aria-label, hidden glyph, aria-pressed toggle', () => {
  const { d, post, sent } = boot();
  post({ type: 'problemsState', count: 3, enabled: true });
  let pc = d.querySelector('.problems-chip') as HTMLButtonElement;
  assert.equal(pc.getAttribute('aria-label'), 'Include 3 problems');
  assert.equal(pc.getAttribute('aria-pressed'), 'true');
  assert.equal(pc.querySelector('.chip-glyph')!.getAttribute('aria-hidden'), 'true');
  assert.match(pc.title, /each message/);
  pc.click(); assert.ok(sent.some(m => m.type === 'toggleProblems'));
  post({ type: 'problemsState', count: 3, enabled: false });
  pc = d.querySelector('.problems-chip') as HTMLButtonElement;
  assert.equal(pc.getAttribute('aria-pressed'), 'false'); assert.ok(pc.classList.contains('off'));
});

test('stylesheet: plan list max height, sticky footer, refused/skipped/undone, HC underline', () => {
  const css = fs.readFileSync(path.join(root, 'media', 'webview', 'style.css'), 'utf8');
  for (const re of [/\.plan-card \.plan-files,\.plan-done \.plan-files\{max-height:min\(45vh,320px\);overflow-y:auto/, /\.plan-card \.approval-actions\{position:sticky;bottom:0/,
    /\.plan-file\.refused \.plan-path\{text-decoration:line-through/, /\.plan-file\.skipped\{/, /\[data-state=undone\]/, /vscode-high-contrast \.plan-diff[^{]*\{text-decoration:underline/,
    /\.chip\.problems-chip\.off\{color:var\(--vscode-descriptionForeground\);border-style:dashed\}/]) { assert.match(css, re); }
  assert.doesNotMatch(css, /overflow-wrap:anywhere;cursor:pointer/);
});
