import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { tokenize, makeDoc, Bm25Index, globToRegExp, makeMatcher, gitignoreToGlobs, isSecretPath, bestLines } from '../index/lexical';
import { redact, formatEntry, RingLog } from '../diagLog';
import { formatRules, rulesPrompt } from '../rulesFormat';

test('tokenize splits camelCase, snake_case and paths', () => {
  const t = tokenize('src/agent/runToolLoop parse_args HTTPServer');
  for (const w of ['src', 'agent', 'run', 'tool', 'loop', 'runtoolloop', 'parse', 'args', 'http', 'server']) { assert.ok(t.includes(w), w); }
});

test('BM25 ranks path+symbol matches first and updates incrementally', () => {
  const ix = new Bm25Index();
  ix.upsert(makeDoc('src/update.ts', 'export class Updater { check() {} download vsix release }', ['Updater', 'check']));
  ix.upsert(makeDoc('src/chat.ts', 'chat view provider release notes mention once', ['ChatViewProvider']));
  ix.upsert(makeDoc('README.md', 'install from release page', []));
  assert.equal(ix.search('updater release check')[0].path, 'src/update.ts');
  assert.equal(ix.search('chat view')[0].path, 'src/chat.ts');
  ix.remove('src/update.ts');
  assert.equal(ix.size, 2);
  assert.ok(!ix.search('updater').length);
  ix.upsert(makeDoc('src/chat.ts', 'totally different', []));
  assert.equal(ix.size, 2);
  assert.ok(!ix.search('provider').length);
  assert.deepEqual(ix.search(''), []);
});

test('globToRegExp / makeMatcher', () => {
  assert.ok(globToRegExp('**/node_modules/**').test('a/node_modules/x.js'));
  assert.ok(globToRegExp('*.log').test('deep/dir/x.log'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
  assert.ok(globToRegExp('src/*.ts').test('src/b.ts'));
  assert.ok(globToRegExp('**/*.{png,jpg}').test('img/a.jpg'));
  assert.ok(globToRegExp('data').test('data/big.csv'));
  const m = makeMatcher(['**/fixtures/**', 'dist']);
  assert.ok(m('test/fixtures/a.json')); assert.ok(m('dist/x.js')); assert.ok(!m('src/x.ts'));
});

test('gitignoreToGlobs', () => {
  assert.deepEqual(gitignoreToGlobs('# c\nnode_modules/\n/build\n*.log\n!keep.log\ndocs/gen/\n'), ['**/node_modules', '/build', '**/*.log', '/docs/gen']);
  const m = makeMatcher(gitignoreToGlobs('node_modules/\n/build\n*.log'));
  assert.ok(m('pkg/node_modules/a.js')); assert.ok(m('build/x')); assert.ok(!m('src/build/x')); assert.ok(m('a/b.log'));
});

test('isSecretPath blocks .env and credentials, allows normal code', () => {
  for (const p of ['.env', '.env.local', 'config/.env.production', 'prod.env', 'id_rsa', '.ssh/config', 'certs/server.pem', 'tls.key', 'secrets.json', 'credentials.json', 'service-account-prod.json', '.npmrc', '.aws/credentials', 'app.secret.yaml']) { assert.ok(isSecretPath(p), p); }
  for (const p of ['src/secrets.ts', 'src/env.ts', '.env.example', 'README.md', 'src/keyboard.ts', 'package.json', 'docs/keys.md']) { assert.ok(!isSecretPath(p), p); }
});

test('bestLines finds matching lines', () => {
  const r = bestLines('a\nfunction checkUpdate() {}\nfoo\nconst update = 1', 'check update');
  assert.equal(r[0].line, 2);
  assert.equal(r.length, 2);
});

test('diagnostics: redact keys/tokens, truncate long values, ring buffer cap', () => {
  assert.equal(redact('key xai-abcdefghijklmnop end'), 'key [redacted] end');
  assert.equal(redact('Authorization: Bearer abc.def'), 'Authorization: Bearer [redacted]');
  assert.match(redact('api_key=xyz123'), /api_key=\[redacted\]/);
  assert.match(redact('ghp_' + 'a'.repeat(36)), /\[redacted\]/);
  const line = formatEntry(new Date(0), 'evt', { a: 1, s: 'x'.repeat(300), k: 'xai-1234567890abcdef', u: undefined });
  assert.match(line, /^1970-01-01T00:00:00.000Z evt a=1 s="x{120}…"/);
  assert.doesNotMatch(line, /xai-1234/);
  assert.doesNotMatch(line, / u=/);
  const r = new RingLog(3); for (let i = 0; i < 5; i++) { r.push(String(i)); }
  assert.deepEqual(r.all(), ['2', '3', '4']);
});

test('rules: formatRules + rulesPrompt', () => {
  assert.equal(formatRules([{ file: 'VSGrok.md', text: '   ' }]), undefined);
  const r = formatRules([{ file: 'VSGrok.md', text: 'Use tabs.' }, { file: '.vsgrok/rules.md', text: 'No any.' }])!;
  assert.deepEqual(r.files, ['VSGrok.md', '.vsgrok/rules.md']);
  assert.match(rulesPrompt(r), /Use tabs\.[\s\S]*No any\./);
  assert.equal(rulesPrompt(undefined), '');
  const big = formatRules([{ file: 'VSGrok.md', text: 'x'.repeat(30000) }])!;
  assert.ok(big.truncated && big.text.length < 20100);
  assert.notEqual(r.hash, big.hash);
});
