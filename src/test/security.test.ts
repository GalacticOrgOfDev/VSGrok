import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { isSecretPath, globToRegExp, gitignoreMatcher, parseGitignore, GIT_LS_ARGS, isInside } from '../index/lexical';
import { redact, sanitizeUrl } from '../diagLog';
import { versionChanged } from '../updateCheck';

test('HIGH 4: widened secret patterns', () => {
  for (const p of ['id_rsa', 'id_ed25519_work', 'id_rsa.old', 'keys/putty.ppk', 'AuthKey_ABC.p8', 'prod.tfvars', 'x.tfvars.json', 'terraform.tfstate', 'terraform.tfstate.backup',
    '.pgpass', '.boto', '.yarnrc.yml', '.vault-token', 'kubeconfig', 'kubeconfig-prod', 'auth.json', '.azure/accessTokens.json', '.config/gcloud/credentials.db', 'home/.config/gcloud/x']) {
    assert.ok(isSecretPath(p), p);
  }
  for (const p of ['src/auth.ts', 'terraform/main.tf', 'docs/kube.md', 'src/config/gcloud.ts']) { assert.ok(!isSecretPath(p), p); }
});

test('MED 9: glob [!x] negated class', () => {
  assert.ok(globToRegExp('file[!0-9].txt').test('filea.txt'));
  assert.ok(!globToRegExp('file[!0-9].txt').test('file1.txt'));
});

test('MED 9: .gitignore negation, dir-only, escapes, anchoring, nested files', () => {
  const m = gitignoreMatcher([
    { dir: '', text: '*.log\n!keep.log\nbuild/\n/root-only.txt\n\\#hash.txt\n\\!bang.txt\ntrail.txt   \n' },
    { dir: 'pkg', text: 'gen/\n!important.log\n' },
  ]);
  assert.ok(m('a/b.log')); assert.ok(!m('keep.log')); assert.ok(!m('x/keep.log'));
  assert.ok(m('build/x.js')); assert.ok(m('src/build/x.js')); assert.ok(!m('build')); // dir-only: a file named build is kept
  assert.ok(m('root-only.txt')); assert.ok(!m('sub/root-only.txt'));
  assert.ok(m('#hash.txt')); assert.ok(m('!bang.txt')); assert.ok(m('trail.txt'));
  assert.ok(m('pkg/gen/a.ts')); assert.ok(!m('gen/a.ts'));
  assert.ok(m('pkg/other.log')); assert.ok(!m('pkg/important.log')); // nested negation wins
  assert.equal(parseGitignore('# c\n\n!\n').length, 0);
});

test('HIGH 2: git runs with fsmonitor disabled', () => {
  assert.deepEqual(GIT_LS_ARGS.slice(0, 2), ['-c', 'core.fsmonitor=false']);
  assert.ok(GIT_LS_ARGS.includes('--exclude-standard'));
});

test('HIGH 3: isInside for symlink realpath checks', () => {
  assert.ok(isInside('/w/proj', '/w/proj/a.ts'));
  assert.ok(isInside('/w/proj/', '/w/proj'));
  assert.ok(!isInside('/w/proj', '/w/project2/a.ts'));
  assert.ok(!isInside('/w/proj', '/home/u/.ssh/id_rsa'));
  assert.ok(isInside('C:\\w\\proj', 'C:\\w\\proj\\a.ts', '\\'));
});

test('HIGH 5: redaction of JSON keys, Basic auth, x-api-key, URL userinfo, query keys', () => {
  const cases: [string, RegExp][] = [
    ['{"api_key": "abc123secret"}', /"api_key": "\[redacted\]"/],
    ["{'token':'t0k3n-value'}", /'token':'\[redacted\]'/],
    ['Authorization: Basic dXNlcjpwYXNz', /Basic \[redacted\]/],
    ['x-api-key: abcdef123456', /x-api-key: \[redacted\]/],
    ['https://user:hunter2@proxy.example.com/v1', /https:\/\/\[redacted\]@proxy\.example\.com\/v1/],
    ['https://api.example.com/v1?key=AIzaSecret&x=1', /\?key=\[redacted\]&x=1/],
    ['GET /v1?access_token=abc', /access_token=\[redacted\]/],
    ['password=hunter2', /password=\[redacted\]/],
  ];
  for (const [inp, re] of cases) {
    const out = redact(inp);
    assert.match(out, re, inp);
    assert.doesNotMatch(out, /abc123secret|t0k3n-value|dXNlcjpwYXNz|abcdef123456|hunter2|AIzaSecret/, inp);
  }
});

test('HIGH 5: sanitizeUrl strips userinfo, query and fragment', () => {
  assert.equal(sanitizeUrl('https://u:p@api.x.ai:8443/v1?key=1#f'), 'https://api.x.ai:8443/v1');
  assert.equal(sanitizeUrl('not a url'), '[invalid url]');
});

test('update throttle resets when the installed version changes', () => {
  assert.equal(versionChanged(undefined, '0.6.2'), true);
  assert.equal(versionChanged('0.6.1', '0.6.2'), true);
  assert.equal(versionChanged('0.6.2', '0.6.2'), false);
});

test('0.14.2: demo doc is bundled, addressed to Grok, and keeps approvals', async () => {
  const fs = await import('node:fs');
  const md = fs.readFileSync('docs/DEMO.md', 'utf8');
  assert.match(md, /^# VSGrok demo: instructions for Grok/);
  for (const t of ['get_workspace_overview', 'find_relevant_files', 'propose_plan', 'run_tests', 'get_problems', 'propose_edit', 'Web search', 'X search', 'cost meter', 'commit-buddy/', '--dry-run', 'Start demo']) { assert.ok(md.includes(t), t); }
  assert.match(md, /under \$1/); assert.match(md, /\$0\.80/); assert.match(md, /Never call the real xAI API from commit-buddy/);
  assert.match(md, /approval stays in place/i);
  assert.match(md, /## For the human: recording tips/);
  assert.match(fs.readFileSync('.vscodeignore', 'utf8'), /^!docs\/DEMO\.md$/m);
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.ok(pkg.contributes.commands.some((c: { command: string }) => c.command === 'vsgrok.runDemo'));
});

test('0.14.3: demo trigger phrases; budget prefers reported cost, weights cached tokens, cap fits a full run', async () => {
  const d = await import('../chatDemo');
  for (const t of ['hey grok, execute the demo', 'Run the demo', 'build the example project', 'please build the sample project', 'continue the demo']) { assert.ok(d.isDemoTrigger(t), t); }
  for (const t of ['demolish the shed', 'what demo?', 'run tests']) { assert.ok(!d.isDemoTrigger(t), t); }
  const L = d.DEMO_LIMITS;
  // Reported cost wins: huge token counts don't stop a run that is under $1.
  assert.equal(d.demoOverBudget({ input: 2_000_000, cached: 1_900_000, output: 50_000, costUsd: 0.6, costMissing: false }, L), undefined);
  assert.match(d.demoOverBudget({ input: 1, cached: 0, output: 1, costUsd: 1.0, costMissing: false }, L) ?? '', /^demo budget of \$1\.00/);
  // Cost missing: cached input counts at 0.25. The 0.14.2 log (~15 calls, ~30k context each, mostly cached) no longer trips it.
  const run = { input: 15 * 30_000, cached: 15 * 27_000, output: 15 * 3_000, costUsd: 0, costMissing: true };
  assert.ok(d.weightedTokens(run) < L.maxWeightedTokens * 0.75, String(d.weightedTokens(run)));
  assert.equal(d.demoOverBudget(run, L), undefined);
  // ...and the token cap stays under $1 at list price ($2/M input-equivalent).
  assert.ok(L.maxWeightedTokens * 2 / 1e6 < 1);
  assert.match(d.demoOverBudget({ input: 500_000, cached: 0, output: 0, costUsd: 0, costMissing: true }, L) ?? '', /xAI reported no cost/);
});
