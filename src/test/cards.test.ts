import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cards = require(path.join(__dirname, '..', '..', 'media', 'webview', 'cards.js'));

test('error cards: severity per kind (amber warn, info for missing key)', () => {
  for (const k of ['rate_limit', 'offline', 'timeout', 'network']) { assert.equal(cards.errorSpec({ kind: k }, true).sev, 'warn', k); }
  for (const k of ['auth', 'quota_exceeded', 'server', 'context_length', 'generic']) { assert.equal(cards.errorSpec({ kind: k }, true).sev, 'error', k); }
  assert.equal(cards.errorSpec({ kind: 'missing_key' }, true).sev, 'info');
  assert.equal(cards.errorSpec({ kind: 'bogus' }, true).kind, 'generic');
  assert.equal(cards.errorSpec({ kind: '__proto__' }, true).kind, 'generic');
});

test('error cards: wording and actions', () => {
  assert.equal(cards.errorSpec({ kind: 'rate_limit' }, true).title, 'Rate limited by xAI');
  const off = cards.errorSpec({ kind: 'offline' }, true).actions;
  assert.deepEqual(off.find((a: any) => a.label === 'Open Settings').msg, { type: 'openSettings', key: 'vsgrok.baseUrl' }); // eslint-disable-line @typescript-eslint/no-explicit-any
  const to = cards.errorSpec({ kind: 'timeout' }, true).actions;
  assert.deepEqual(to.find((a: any) => a.label === 'Open Settings').msg, { type: 'openSettings', key: 'vsgrok.requestTimeoutSeconds' }); // eslint-disable-line @typescript-eslint/no-explicit-any
  const ctx = cards.errorSpec({ kind: 'context_length' }, true).actions;
  assert.deepEqual(ctx[0], { label: 'New chat', primary: true, msg: { type: 'clearChat' } });
  assert.equal(ctx.filter((a: any) => a.primary).length, 1); // eslint-disable-line @typescript-eslint/no-explicit-any
  const g = cards.errorSpec({ kind: 'generic', msg: '\n  boom: ' + 'x'.repeat(200) + '\nsecond line' }, false);
  assert.equal(g.hint.length, 120); assert.match(g.hint, /^boom: x+…$/);
  assert.equal(g.dismissible, true);
  assert.ok(!g.actions.some((a: any) => a.label === 'Retry')); // eslint-disable-line @typescript-eslint/no-explicit-any
  const mk = cards.errorSpec({ kind: 'missing_key' }, true);
  assert.deepEqual(mk.actions.map((a: any) => a.label), ['Set API Key', 'Copy diagnostics']); // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(cards.errorSpec({ kind: 'server', attempts: 4 }, true).detailsLabel, 'Details (4 attempts)');
  assert.equal(cards.errorSpec({ kind: 'auth', source: 'Grok: fixing problem…' }, false).source, 'fixing problem');
});

test('rules chip: count, tooltip, truncation', () => {
  assert.equal(cards.rulesChip([], false).hidden, true);
  const one = cards.rulesChip(['VSGrok.md'], false);
  assert.equal(one.count, '');
  assert.equal(one.tooltip, 'Project rules (1): VSGrok.md. Added to every chat. Click to open.');
  const two = cards.rulesChip(['VSGrok.md', '.vsgrok/rules.md'], true);
  assert.equal(two.label + two.count, 'Rules · 2');
  assert.equal(two.tooltip, 'Project rules (2): VSGrok.md, .vsgrok/rules.md. (trimmed to 20k chars) Added to every chat. Click to open.');
});

test('stylesheet: amber background, info card, HC border, 4px bar, scoped buttons, header wrap + container query', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'webview', 'style.css'), 'utf8');
  assert.match(css, /\.error-card\[data-sev=warn\]\{[^}]*background:var\(--vscode-inputValidation-warningBackground/);
  assert.match(css, /\.error-card\[data-sev=info\]\{[^}]*border-color:var\(--vscode-focusBorder\)/);
  assert.match(css, /body\.vscode-high-contrast \.error-card[^{]*\{[^}]*--vscode-contrastBorder/);
  assert.match(css, /\.error-card\{[^}]*border-left-width:4px/);
  assert.match(css, /\.error-card \.error-btn\.primary-action/);
  assert.doesNotMatch(css.slice(css.indexOf('/* Error cards')), /\.error-card[^{]*\.approval-btn/);
  assert.match(css, /#header\{flex-wrap:wrap;container-type:inline-size\}/);
  assert.match(css, /@container \(max-width:300px\)\{\.rules-chip \.lbl/);
  assert.doesNotMatch(css.match(/\.rules-chip\{[^}]*\}/)![0], /focusBorder/);
  assert.match(css, /body\.vscode-high-contrast \.rules-chip[^{]*\{border-color:var\(--vscode-contrastBorder\);box-shadow:none\}/);
});
