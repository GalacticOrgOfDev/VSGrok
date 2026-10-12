# VSGrok demo: instructions for Grok

You are Grok, running inside the VSGrok extension. The user asked you to run the demo, and is probably recording the screen. Build **commit-buddy**, a tiny CLI that writes Conventional Commits messages with the xAI API, showcasing each tool in the order given.

## Rules

- **Narrate briefly.** Before each step, write one line for the viewer, e.g. "**Step 5 · propose_plan**: the whole project as one reviewable plan." No other commentary.
- **Every approval stays in place.** Write files only with `propose_plan` / `propose_edit`, and run commands only with `run_tests` / `run_command`. The user approves each card. If a card is denied, say so in one line and skip whatever depends on it.
- **Copy the files below exactly.** Don't improvise, reformat or add files. Use the README template with one line filled in.
- **Never call the real xAI API from commit-buddy during the demo.** Only run it with `--dry-run`. Never set or ask for `XAI_API_KEY`.
- **Budget: under $1 in total.**
  - Exactly the 13 steps below, and one tool call per step. No extra reads, searches or retries.
  - Don't re-read files you wrote. Use small `max` values.
  - If a tool misbehaves, say so in one line and continue. Never investigate VSGrok's own source.
  - Watch the cost meter in the header. If it nears **$0.80**, jump to step 13.
- **Skip a step whose tool is unavailable** (for example, Web or 𝕏 off in the header). Say so in one line.

## Where to build

Call `get_workspace_overview` in step 1.
- **If the workspace is empty, build at the root.** `<dir>` below is `.`, and file paths have no prefix.
- **If it has files, stop after step 1.** Say: "For the cleanest recording, open an empty folder and run the demo there. Or reply **continue the demo** and I'll build it in `commit-buddy/` without touching anything else." In that case `<dir>` is `commit-buddy`, and every path below is prefixed with `commit-buddy/`.

## Steps

1. **Overview** (`get_workspace_overview`). One line on what's there, including whether it's a git repository, then decide `<dir>`.
2. **Relevant files** (`find_relevant_files`, query `git commit message CLI`, max 3). In an empty folder there is nothing to reuse.
3. **Web search** (one search). Find the current Node.js Active LTS version. Cite it, and use it to fill the README's "Did you know?" line.
4. **X search** (one search, max 3 posts). Find recent posts about AI-written commit messages. Quote one, with its link.
5. **Plan** (`propose_plan`). One plan with all five files below, exactly as given, summary "commit-buddy: AI commit messages CLI". Tell the viewer that the last test is deliberately wrong.
6. **Run the tests** (`run_tests` with `path: "<dir>"`). Exactly one test fails: "treats .env.production as a secret". Point out the file:line that VSGrok parsed, and explain that the test, not the code, is wrong: production env files must be withheld.
7. **Problems** (`get_problems`, `path: "<dir>"`, max 5). Report it in one line.
8. **Fix** (`propose_edit`, path `<dir>/test/core.test.js`, the "fixed test file" below, reason "env files are secrets").
9. **Re-run the tests** (`run_tests`, same path). All 6 pass.
10. **Image.** Only if the user attached an image to the chat: describe it in one line. Otherwise say "No image attached, skipping."
11. **Dry run on camera** (`run_command`).
    - In an empty folder that isn't a git repository, the command is `git init -q && git add -A && node bin/commit-buddy.js --dry-run`.
    - In an existing repository, it is `git add <dir> && node <dir>/bin/commit-buddy.js --dry-run`. Say that this stages only `<dir>`.
    - The output shows the model, the diff size, and the start of the prompt. No API call is made.
12. **Commit message.** Write a Conventional Commits message in a code block: subject `feat: add commit-buddy CLI` and three bullets. Don't commit. Say that commit-buddy does this for real with `node bin/commit-buddy.js --apply` once `XAI_API_KEY` is set, and mention VSGrok's **✦ Generate Commit Message** button in Source Control.
13. **Summary.** Up to five lines: the files, the tests (6, one failed on purpose and was fixed), the dry run, the two searches, and the cost meter in the header (click it for the breakdown, as reported by xAI).

## Files (copy exactly)

`<dir>/package.json`
````json
{
  "name": "commit-buddy",
  "version": "1.0.0",
  "description": "Conventional commit messages for your staged changes, written by Grok (xAI). Bring your own API key.",
  "bin": {
    "commit-buddy": "bin/commit-buddy.js"
  },
  "scripts": {
    "test": "node --test"
  },
  "engines": {
    "node": ">=18"
  },
  "license": "MIT",
  "author": "Timothy Payn",
  "files": [
    "bin",
    "src",
    "README.md",
    "LICENSE"
  ],
  "keywords": [
    "git",
    "commit",
    "conventional-commits",
    "xai",
    "grok",
    "cli"
  ]
}
````

`<dir>/src/core.js`
````js
'use strict';

const API_URL = process.env.COMMIT_BUDDY_API_URL || 'https://api.x.ai/v1/chat/completions';
const DEFAULT_MODEL = 'grok-4.20-0309-non-reasoning';
const MAX_CHARS = 12000;
const SECRET = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|id_(rsa|ed25519|ecdsa)|.*\.(pem|key|p12|pfx)|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;

function isSecretPath(p) {
  return SECRET.test(String(p).replace(/\\/g, '/'));
}

// Split a unified diff into per-file chunks and drop secret-looking files.
function filterDiff(diff) {
  const chunks = String(diff).split(/^(?=diff --git )/m).filter((c) => c.trim());
  const kept = [];
  const skipped = [];
  for (const c of chunks) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(c);
    const file = m ? m[2] : '';
    if (file && isSecretPath(file)) skipped.push(file);
    else kept.push(c);
  }
  return { diff: kept.join(''), skipped };
}

function truncate(text, max = MAX_CHARS) {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + '\n[diff truncated]\n', truncated: true };
}

function buildPrompt(diff) {
  return 'Write a Conventional Commits message for this staged diff. Reply with the message only: ' +
    'a subject line under 72 characters (type(scope): summary), a blank line, then up to 4 short bullet points.\n\n' + diff;
}

function cleanMessage(text) {
  return String(text).replace(/^\s*```[\w-]*\s*\n?/, '').replace(/\n?```\s*$/, '').replace(/^["']|["']$/g, '').trim();
}

async function generate({ diff, apiKey, model = DEFAULT_MODEL, fetch = globalThis.fetch }) {
  if (!apiKey) throw new Error('XAI_API_KEY is not set. Get a key at https://console.x.ai and export XAI_API_KEY=...');
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: buildPrompt(diff) }], temperature: 0.2 }),
  });
  if (!res.ok) throw new Error(`xAI API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const msg = cleanMessage(data?.choices?.[0]?.message?.content ?? '');
  if (!msg) throw new Error('xAI API returned an empty message.');
  return msg;
}

module.exports = { API_URL, DEFAULT_MODEL, MAX_CHARS, isSecretPath, filterDiff, truncate, buildPrompt, cleanMessage, generate };
````

`<dir>/bin/commit-buddy.js`
````js
#!/usr/bin/env node
'use strict';
const { execFileSync } = require('node:child_process');
const readline = require('node:readline');
const { DEFAULT_MODEL, filterDiff, truncate, buildPrompt, generate } = require('../src/core');

const HELP = `Usage: commit-buddy [--apply] [--model <name>] [--dry-run]
  Writes a Conventional Commits message for your staged changes using the xAI API.
  --apply     run git commit -m with the message (asks y/N first)
  --model     xAI model (default ${DEFAULT_MODEL})
  --dry-run   show what would be sent; no API call, no key needed
  Needs XAI_API_KEY in the environment.`;

function fail(msg) { console.error(`commit-buddy: ${msg}`); process.exit(1); }

async function main(argv) {
  const opts = { apply: false, dryRun: false, model: process.env.COMMIT_BUDDY_MODEL || DEFAULT_MODEL };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') opts.apply = true;
    else if (argv[i] === '--dry-run') opts.dryRun = true;
    else if (argv[i] === '--model') opts.model = argv[++i] || fail('--model needs a value');
    else if (argv[i] === '--help' || argv[i] === '-h') { console.log(HELP); return; }
    else fail(`unknown option ${argv[i]}\n${HELP}`);
  }
  let raw;
  try { raw = execFileSync('git', ['diff', '--staged', '--no-color'], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { fail('not a git repository (or git is not installed).'); }
  if (!raw.trim()) fail('no staged changes. Stage files with git add first.');
  const { diff, skipped } = filterDiff(raw);
  if (skipped.length) console.error(`commit-buddy: not sending secret-looking files: ${skipped.join(', ')}`);
  if (!diff.trim()) fail('only secret-looking files are staged; nothing to send.');
  const { text, truncated } = truncate(diff);
  if (opts.dryRun) {
    const prompt = buildPrompt(text);
    console.log(`[dry run] model: ${opts.model}`);
    console.log(`[dry run] ${text.length} diff chars${truncated ? ' (truncated)' : ''}, ${skipped.length} file(s) withheld`);
    console.log('[dry run] prompt starts:\n' + prompt.split('\n').slice(0, 8).join('\n'));
    return;
  }
  const msg = await generate({ diff: text, apiKey: process.env.XAI_API_KEY, model: opts.model }).catch((e) => fail(e.message));
  console.log(msg);
  if (!opts.apply) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((r) => rl.question('Commit with this message? [y/N] ', r));
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) { console.error('commit-buddy: not committed.'); return; }
  execFileSync('git', ['commit', '-m', msg], { stdio: 'inherit' });
}

main(process.argv.slice(2));
````

`<dir>/test/core.test.js` (the last test is deliberately wrong)
````js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isSecretPath, filterDiff, truncate, cleanMessage, generate, API_URL } = require('../src/core');

const diffOf = (file) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+hello\n`;

test('withholds secret-looking files from the diff', () => {
  const r = filterDiff(diffOf('src/app.js') + diffOf('.env'));
  assert.deepEqual(r.skipped, ['.env']);
  assert.match(r.diff, /src\/app\.js/);
  assert.doesNotMatch(r.diff, /\.env/);
});

test('truncates big diffs', () => {
  const r = truncate('x'.repeat(50), 10);
  assert.equal(r.truncated, true);
  assert.match(r.text, /^x{10}\n\[diff truncated\]/);
});

test('cleans code fences and quotes from the reply', () => {
  assert.equal(cleanMessage('```\nfeat: add x\n```'), 'feat: add x');
});

test('calls the xAI API with the key and model (fake fetch, no network)', async () => {
  let seen;
  const fetch = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ choices: [{ message: { content: 'fix: handle empty input' } }] }) }; };
  const msg = await generate({ diff: diffOf('a.js'), apiKey: 'k', model: 'm', fetch });
  assert.equal(msg, 'fix: handle empty input');
  assert.equal(seen.url, API_URL);
  assert.equal(seen.init.headers.Authorization, 'Bearer k');
  assert.equal(JSON.parse(seen.init.body).model, 'm');
});

test('missing key fails cleanly without calling the API', async () => {
  await assert.rejects(generate({ diff: 'x', apiKey: '', fetch: () => assert.fail('no call') }), /XAI_API_KEY is not set/);
});

// Deliberately wrong for the demo: production env files ARE secrets and must be withheld.
test('treats .env.production as a secret', () => {
  assert.equal(isSecretPath('config/.env.production'), false);
});
````

`<dir>/README.md` (replace FACT_FROM_WEB_SEARCH with one sentence from step 3)
````md
# commit-buddy

Conventional commit messages for your staged changes, written by Grok. No dependencies, Node.js 18+, bring your own `XAI_API_KEY`.

```
git add -A
node bin/commit-buddy.js            # print a message
node bin/commit-buddy.js --apply    # ask y/N, then git commit
node bin/commit-buddy.js --dry-run  # show what would be sent (no API call)
```

Secret-looking files (`.env*`, keys, credentials) are never sent. Diffs over 12,000 characters are truncated.

Did you know? FACT_FROM_WEB_SEARCH
````

**Fixed test file** for step 8:
````js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isSecretPath, filterDiff, truncate, cleanMessage, generate, API_URL } = require('../src/core');

const diffOf = (file) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+hello\n`;

test('withholds secret-looking files from the diff', () => {
  const r = filterDiff(diffOf('src/app.js') + diffOf('.env'));
  assert.deepEqual(r.skipped, ['.env']);
  assert.match(r.diff, /src\/app\.js/);
  assert.doesNotMatch(r.diff, /\.env/);
});

test('truncates big diffs', () => {
  const r = truncate('x'.repeat(50), 10);
  assert.equal(r.truncated, true);
  assert.match(r.text, /^x{10}\n\[diff truncated\]/);
});

test('cleans code fences and quotes from the reply', () => {
  assert.equal(cleanMessage('```\nfeat: add x\n```'), 'feat: add x');
});

test('calls the xAI API with the key and model (fake fetch, no network)', async () => {
  let seen;
  const fetch = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ choices: [{ message: { content: 'fix: handle empty input' } }] }) }; };
  const msg = await generate({ diff: diffOf('a.js'), apiKey: 'k', model: 'm', fetch });
  assert.equal(msg, 'fix: handle empty input');
  assert.equal(seen.url, API_URL);
  assert.equal(seen.init.headers.Authorization, 'Bearer k');
  assert.equal(JSON.parse(seen.init.body).model, 'm');
});

test('missing key fails cleanly without calling the API', async () => {
  await assert.rejects(generate({ diff: 'x', apiKey: '', fetch: () => assert.fail('no call') }), /XAI_API_KEY is not set/);
});

test('treats .env.production as a secret', () => {
  assert.equal(isSecretPath('config/.env.production'), true);
});
````

---

## For the human: recording tips

- Open an **empty** folder and trust it. Click **New chat** so the cost meter starts at zero. Turn on **Agent**, **𝕏** and **Web** in the header. Use grok-4.7.
- Zoom to 125% and widen the sidebar to about 420 px so the cost meter stays visible.
- Run **VSGrok: Run Demo**, or type "execute the demo". A **Start demo (est. $…)** card appears first. Nothing is spent until you click it.
- You'll approve, in order: the plan card (5 files), `npm test` (it fails on purpose), the test-file edit, `npm test` again (green), and the dry run.
- The demo pauses itself at $1 with a **Continue (+$0.50) / Stop** card.
- commit-buddy never calls xAI during the demo. Afterwards, try it for real: set `XAI_API_KEY`, stage something, and run `node bin/commit-buddy.js`.
