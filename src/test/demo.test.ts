import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { demoEstimateUsd, DEMO_LIMITS } from '../chatDemo';

const root = path.join(__dirname, '..', '..');
const md = fs.readFileSync(path.join(root, 'docs', 'DEMO.md'), 'utf8');
const files: Record<string, string> = {};
for (const m of md.matchAll(/`<dir>\/([^`]+)`[^\n]*\n````\w*\n([\s\S]*?)\n````/g)) { files[m[1]] = m[2] + '\n'; }
const fixed = md.match(/\*\*Fixed test file\*\*[^\n]*\n````\w*\n([\s\S]*?)\n````/)![1] + '\n';

test('0.14.4: DEMO.md commit-buddy files are known-good: one intentional failure, green after the fix, dry run needs no key', () => {
  assert.deepEqual(Object.keys(files).sort(), ['README.md', 'bin/commit-buddy.js', 'package.json', 'src/core.js', 'test/core.test.js']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-demo-'));
  for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); }
  const run = () => spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  const r1 = run();
  assert.equal(r1.status, 1, r1.stdout + r1.stderr);
  assert.match(r1.stdout, /not ok \d+ - treats \.env\.production as a secret|✖ treats \.env\.production as a secret/);
  assert.match(r1.stdout, /# pass 5|ℹ pass 5/);
  fs.writeFileSync(path.join(dir, 'test', 'core.test.js'), fixed);
  const r2 = run();
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  // On-camera command: no API call, no key.
  const env = { ...process.env, XAI_API_KEY: '', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q'], { cwd: dir }); execFileSync('git', ['add', '-A'], { cwd: dir });
  const dry = spawnSync(process.execPath, ['bin/commit-buddy.js', '--dry-run'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^\[dry run\] model: grok-4\.20-0309-non-reasoning\n\[dry run\] \d+ diff chars/);
  const nokey = spawnSync(process.execPath, ['bin/commit-buddy.js'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(nokey.status, 1); assert.match(nokey.stderr, /XAI_API_KEY is not set/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('0.14.4: demo files are short (cost) and the pre-flight estimate is sane', () => {
  const total = Object.values(files).reduce((a, c) => a + c.length, 0) + fixed.length;
  assert.ok(total < 14_000, String(total));
  const est = demoEstimateUsd();
  assert.ok(est > 0.2 && est < 0.6 && est < DEMO_LIMITS.maxCostUsd * 0.6, String(est));
});
