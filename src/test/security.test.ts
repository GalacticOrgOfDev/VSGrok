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
