import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readsCredentials, autoDecision } from '../agent/autoApproveCore';
import { githubPreset, presetHash, GITHUB_MCP_URL } from '../mcpCore';

const BAD = [
  'printf "protocol=https\\nhost=github.com\\n" | git credential fill',
  'git credential-manager get', 'git credential-osxkeychain get', 'gh auth token', 'gh auth status --show-token',
  'security find-generic-password -s github -w', 'security find-internet-password -s github.com',
  'cmdkey /list', 'powershell -c "Get-StoredCredential -Target git:https://github.com"',
  'cat ~/.git-credentials', 'type %USERPROFILE%\\.git-credentials', 'cat ~/.netrc', 'cat ~/.npmrc', 'cat ~/.aws/credentials',
  'cat ~/.config/gh/hosts.yml', 'cat ~/.ssh/id_ed25519', 'echo $GITHUB_TOKEN', 'echo %GH_TOKEN%', 'printenv OPENAI_API_KEY',
  'env | grep TOKEN', 'set | findstr KEY', 'node -e "console.log(process.env.GITHUB_TOKEN)"', 'secret-tool lookup service github',
  'gcloud auth print-access-token', 'npm token list',
];
const OK = ['npm test', 'git status', 'git commit -m "credential fill docs"', 'cat ~/.ssh/id_ed25519.pub', 'echo hello', 'node --test',
  'gh repo view', 'grep -r token src', 'cat README.md', 'git config user.name'];

test('readsCredentials flags credential reads', () => {
  for (const c of BAD) { assert.ok(readsCredentials(c), c); }
  for (const c of OK) { assert.equal(readsCredentials(c), undefined, c); }
});

test('credential commands are never auto-approved, even when allowlisted', () => {
  const d = autoDecision({ kind: 'command', command: 'gh auth token' }, { level: 'editsAndCommands', allowlist: ['gh auth token', '*'] });
  assert.equal(d.auto, false); assert.match(d.why, /credentials/);
});

test('GitHub preset: token only in Authorization, https only, hash excludes token', () => {
  const p = githubPreset('ghp_SECRET123', { toolsets: 'repos;rm -rf,context', readOnly: true });
  assert.equal(p.type, 'http');
  if (p.type !== 'http') { return; }
  assert.equal(p.url, GITHUB_MCP_URL);
  assert.equal(p.headers.Authorization, 'Bearer ghp_SECRET123');
  assert.equal(p.headers['X-MCP-Toolsets'], 'reposrmrf,context');
  assert.equal(p.headers['X-MCP-Readonly'], 'true');
  const evil = githubPreset('t', { url: 'http://evil.example/' });
  assert.equal(evil.type === 'http' ? evil.url : '', GITHUB_MCP_URL);
  assert.equal(presetHash(p), presetHash(githubPreset('ghp_OTHER', { toolsets: 'repos;rm -rf,context', readOnly: true })));
  assert.ok(!JSON.stringify(p).replace(p.headers.Authorization, '').includes('SECRET'));
});
