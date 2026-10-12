import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { filterDiff, droppedNote, commitUserPrompt, reviewPrompt, prUserPrompt, parseFileLink } from '../gitCore';

const sec = (p: string, body = '+x\n') => `diff --git a/${p} b/${p}\nindex 1..2 100644\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n${body}`;

test('git diff filter: secret files dropped (incl. rename onto/off a secret), binaries summarised, keys redacted', () => {
  const d = sec('src/a.ts', '+const k = "sk-abcdefghijklmnopqrstuv";\n') + sec('.env', '+API_KEY=hunter2\n') + sec('config/credentials.json')
    + 'diff --git a/notes.txt b/.env.local\nsimilarity index 90%\nrename from notes.txt\nrename to .env.local\n'
    + 'diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n' + sec('.env.example');
  const f = filterDiff(d);
  assert.deepEqual(f.files, ['src/a.ts', 'img.png', '.env.example']);
  assert.deepEqual(f.dropped, ['.env', 'config/credentials.json', '.env.local']);
  assert.doesNotMatch(f.text, /hunter2|sk-abcdef/);
  assert.match(f.text, /\(binary file changed\)/);
  assert.match(droppedNote(f), /never sent\): \.env, config\/credentials\.json, \.env\.local/);
});

test('git diff filter: per-file and total budgets', () => {
  const big = sec('a.ts', '+' + 'x'.repeat(500) + '\n') + sec('b.ts', '+' + 'y'.repeat(500) + '\n') + sec('c.ts');
  const f = filterDiff(big, 700, 300);
  assert.deepEqual(f.files, ['a.ts', 'b.ts', 'c.ts']);
  assert.ok(f.truncated.includes('a.ts') && f.truncated.includes('b.ts'));
  assert.ok(f.text.length < 1000);
  const g = filterDiff(big, 400, 1000);
  assert.match(g.text, /omitted: diff budget reached/);
  assert.equal(filterDiff('').files.length, 0);
});

test('commit prompt: recent subjects, draft and dropped note included; secrets redacted', () => {
  const diff = filterDiff(sec('a.ts') + sec('.env'));
  const p = commitUserPrompt({ diff, recent: ['feat: add x', 'fix(y): z'], draft: 'wip token sk-abcdefghijklmnopqrstuv', branch: 'feature/q' });
  assert.match(p, /Branch: feature\/q/); assert.match(p, /- feat: add x/); assert.match(p, /User's draft message:\nwip token \[redacted\]/);
  assert.match(p, /Omitted \(secret files, never sent\): \.env/); assert.match(p, /Staged diff:\ndiff --git a\/a\.ts/);
  assert.doesNotMatch(commitUserPrompt({ diff, recent: [] }), /draft|Recent/);
});

test('review + PR prompts', () => {
  const r = reviewPrompt({ files: ['a.ts'], note: 'Omitted (secret files, never sent): .env', untracked: ['new.ts'] });
  assert.match(r, /severity/); assert.match(r, /\[src\/app\.ts:42\]\(src\/app\.ts#L42\)/); assert.match(r, /New untracked files: new\.ts/); assert.match(r, /\.env/);
  const p = prUserPrompt({ base: 'origin/main', branch: 'feat', commits: ['feat: a'], diff: filterDiff(sec('a.ts')), stat: ' a.ts | 1 +' });
  assert.match(p, /Branch feat → origin\/main/); assert.match(p, /- feat: a/); assert.match(p, /Diffstat/);
  assert.match(prUserPrompt({ base: 'main', branch: 'main', commits: [], diff: filterDiff(sec('a.ts')), stat: '' }), /none yet/);
});

test('file links from answers', () => {
  assert.deepEqual(parseFileLink('src/a.ts#L12'), { path: 'src/a.ts', line: 12, endLine: undefined });
  assert.deepEqual(parseFileLink('src/a.ts#L12-L20'), { path: 'src/a.ts', line: 12, endLine: 20 });
  assert.deepEqual(parseFileLink('./src/my%20file.ts:7'), { path: 'src/my file.ts', line: 7, endLine: undefined });
  assert.deepEqual(parseFileLink('README.md'), { path: 'README.md', line: undefined, endLine: undefined });
  for (const bad of ['https://x.com/a.ts#L1', 'command:workbench.action.x', 'javascript:alert(1)', '/etc/passwd', '../x.ts#L1', 'src/../../x', 'C:\\x.ts', '#L5', '', 'file:///etc/passwd']) {
    assert.equal(parseFileLink(bad), undefined, bad);
  }
});

test('FM7: repo-local filter/diff driver commands are blanked', async () => {
  const { driverOverrides } = await import('../gitCore');
  assert.deepEqual(driverOverrides('filter.evil.clean sh -c "curl x"\ndiff.pdf.textconv ./run\nfilter.evil.process ./p\ncore.editor vim\n'),
    ['-c', 'filter.evil.clean=', '-c', 'filter.evil.required=false', '-c', 'diff.pdf.textconv=', '-c', 'filter.evil.process=']);
  assert.deepEqual(driverOverrides(''), []);
});
