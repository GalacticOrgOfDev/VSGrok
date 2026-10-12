# Changelog

## 0.7.0 — 2026-10-12
**Multi-file edit plans**
- New `propose_plan` agent tool: create / modify / delete / rename up to 50 files in one in-chat **plan card**. Each file shows its op, +/− line counts, a **View diff** link and a checkbox; **Approve selected (n/N)** or **Deny**.
- The approved subset is applied as one atomic `WorkspaceEdit`. A **Plan applied** card offers **Undo plan** (reverts the whole plan in one step; it refuses if any file changed since) and **Re-run checks**.
- The secret filter and workspace-only rules apply to every path and rename target. Refused items are listed and never applied.

**Diagnostics awareness**
- New `get_problems` tool (VS Code diagnostics, filterable by file and severity, capped).
- Problems in the active and attached files are sent with your message automatically. A **⚠ N problems** chip shows this; click it to turn it off or on.
- New `run_tests` tool: detects the test command (package.json scripts with npm/pnpm/yarn/bun, pytest, `go test`, `cargo test`, or the new `vsgrok.testCommand` setting). It runs through the command approval card and parses failures into file:line (pytest, go, cargo, jest/vitest, node:test).
- After the agent edits files, the chat offers **Re-run checks**.

**Right-click commands** (editor context menu and Command Palette)
- **VSGrok: Explain This**, **Write Tests for This**, **Fix Problems Here** and **Refactor…** work on the selection, or else the enclosing function/class (from the language server's symbols), and send it to the chat as context.
- Write Tests uses the detected framework and the project's test location, and proposes the files through a plan card.
- Fix Problems Here includes the diagnostics in range.
- Refactor asks for a goal (presets or free text).

**Other**
- If a plan or undo fails while deleting because the OS trash is unavailable, the message now points to `files.enableTrash`.

## 0.6.2 — 2026-10-12
**Fix: "Update failed: undefined" (self-update).** Root cause, reproduced against the real GitHub release in VS Code 1.141: the `.vsix` was saved under `globalStorageUri`, which on current desktop builds uses the `vscode-userdata:` scheme. VS Code's VSIX installer only accepts `file:`/`vscode-remote:` URIs and rejects others with the bare string `"No Servers"` (not an Error), so `err.message` was `undefined`. Now:
- the download goes to a `file:` folder (global storage when it is `file:`, else the OS temp dir);
- every update error names the step and HTTP status and always has a real message (string rejections, `fetch failed` causes, empty errors);
- GitHub redirects are followed manually: the first URL must be this repo's release download, and each hop must be an https GitHub asset host;
- the GitHub API request sends a versioned User-Agent and API version, and a 403/429 explains the rate limit;
- the 24h throttle resets when the installed version changes, and the first check runs as soon as you open the chat panel.

**Security review (JGrok)**
- Chat attachments, drag-and-drop, `@file`, folder and `@workspace` listings, the file picker and inline completions now use the secret filter and only accept files inside the workspace (`file`/`vscode-remote`). A refused file shows a "⛔ Refused" chip.
- git runs only in trusted workspaces, with `core.fsmonitor=false`. Restricted Mode support is declared (`capabilities.untrustedWorkspaces: limited`). Project rules files are ignored in untrusted workspaces.
- Symlinks are never followed by the index. `read_file`/search refuse any path whose real location is outside the workspace or is a secret.
- Wider secret patterns: SSH key variants, `.ppk`, `.p8`, `.tfvars`, `terraform.tfstate*`, `.pgpass`, `.boto`, `.yarnrc.yml`, `.vault-token`, kubeconfig, `auth.json`, `.azure/`, `.config/gcloud/`.
- Diagnostics redaction now covers JSON/JS-quoted keys, Basic/Token auth, `x-api-key`, `user:pass@` in URLs and `?key=`/`token=` query values; the base URL is reported without credentials or query.
- Index: builds into a fresh index and swaps it in (a generation counter discards stale builds); deleting or renaming a folder drops everything under it; one watcher per workspace folder; every folder of a multi-root workspace is indexed; the `.gitignore` fallback handles `!` negation, trailing `/`, escapes and nested files; `[!x]` globs.
- Retry-After gets jitter and a 250 ms floor; inline completions never retry; documented that a retry can rarely re-run a request xAI already accepted.
- CI: `permissions: contents: read`, actions pinned to commit SHAs, `vsce`/`ovsx` as devDependencies, versioned VS Code test cache key.
- Test hooks are compiled out of production builds (`__VSGROK_TEST__`).

**UI review (UIGrok)**
- UI review fixes (UIGrok) for the error cards: amber background for rate-limit/offline/timeout/connection cards, a cyan info card for a missing key, a 4px left severity bar and contrast border in high-contrast themes, a single screen-reader announcement per error, wrapping for long titles, an inset look inside replies, Open Settings buttons (offline → API base URL, timeout → request timeout), a New chat button for too-much-context, a first-line hint for unknown errors, the "Rate limited by xAI" title, and their own `.error-btn` button styles.
- Rules chip: purple border (no longer looks focused), contrast border in HC, "📜 Rules · N" count and "Project rules (N): … Added to every chat." tooltip, a quick pick when several rule files exist, collapses to the icon on narrow sidebars.
- Header: wraps on narrow sidebars (container queries), semantic `<header>`, `type="button"` and `aria-controls` on header buttons; the Rules chip sits right before ⚙.
- Card view-models moved to `media/webview/cards.js` (unit-tested).

## 0.6.1 — 2026-10-12
- Fix: unit-test script failed on Node 22 in CI (`node --test` with a directory); now passes explicit test files. The v0.6.0 tag's release workflow stopped at this step, so 0.6.1 is the first published 0.6 build. No extension code changes.

## 0.6.0 — 2026-10-12
**Robustness**
- Integration tests in real VS Code (`@vscode/test-electron`, headless via xvfb): activation, every contributed command registered, chat webview ready, approval-card round trip (approve / deny / Stop), project rules, workspace index (ranking, `.gitignore`, `.env` never read, incremental update), update check against a mocked release, Copy Diagnostics.
- CI workflow (`ci.yml`) runs type-check, lint, unit and integration tests on every push and PR; the release workflow runs both suites before publishing.
- xAI client: retries 429 and 5xx/connection errors with exponential backoff + full jitter, honoring `Retry-After` (capped at 60 s); never retries after streaming has started; cancel works during backoff; offline detection (DNS/refused/unreachable) separate from dropped connections; idle timeout kept.
- Friendly in-chat error cards per error kind (key, credits, rate limit, xAI server, offline, timeout, context too large) with Set API Key / Open xAI Console / Retry / Copy diagnostics and expandable details (attempt count). Command and Quick Fix API errors also go to the chat instead of notifications.
- Opt-in local diagnostics log (`vsgrok.diagnostics.enabled`, off by default): request retries, error kinds, tool names and timings, index stats, update checks. Never the API key, prompts, responses or file contents; values are redacted and truncated. **VSGrok: Copy Diagnostics** copies version/platform/settings/log for bug reports.

**Codebase awareness**
- Local workspace index: file list (git `ls-files` for exact `.gitignore` semantics, `.gitignore` parsing fallback, `vsgrok.index.exclude`), BM25 over paths, symbol names and contents, symbol outlines via `vscode.executeDocumentSymbolProvider` (lazy, cached), incremental updates from a file watcher, capped by `vsgrok.index.maxFiles` (default 5000) and a per-build read budget. No external embedding service.
- New always-on tool `find_relevant_files` (ranked files with matching lines and symbol outlines); the system prompt tells Grok to start with it. **VSGrok: Rebuild Workspace Index**.
- Per-project instructions: `VSGrok.md` and/or `.vsgrok/rules.md` are injected into the system prompt (20k-char cap, live-reloaded; mid-chat changes are sent as an update) and shown as a **📜 Rules** chip in the chat header (click to open).
- `.env` and secret-looking files (keys, certificates, credentials, `.npmrc`, `.ssh/`, `.aws/` …) are never read by `read_file`, searched, or indexed.

## 0.5.1 — 2026-10-12
- **GitHub self-update:** once a day (`vsgrok.checkForUpdates`, default on; throttled via globalState) VSGrok checks the latest GitHub release and, if newer (semver compare), shows an in-chat card: **Update now** downloads the release `.vsix` to global storage and installs it with `workbench.extensions.installExtension`, then offers **Reload Window** in chat. No notifications.
- New command **VSGrok: Check for Updates**.
- `.github/workflows/release.yml`: on `v*` tags builds, tests, packages and creates a GitHub Release with the `.vsix` attached. Marketplace `publish.yml` and `docs/PUBLISHING.md` kept, marked for later (manual trigger only).
- Tests for version compare, 24h throttle and release-asset parsing.

## 0.5.0 — 2026-10-12
- **Approvals in chat:** every permission request (agent `run_command`, agent `propose_edit`, *Apply as diff* from code blocks, *Fix with Grok* / editor fixes) is now an inline card in the chat with Approve/Run and Deny; edits add **View diff** (opens the diff editor, decision stays in chat). Removed the modal and notification prompts. Each request carries a request id; Stop, New chat, closing or reloading the panel resolve pending requests as Deny. With no chat available nothing runs.
- Galactic-themed approval cards (plain VS Code colors in the `vscode` theme and high contrast).
- **Publishing for auto-update:** `.github/workflows/publish.yml` publishes tagged releases (`v*`) to the VS Code Marketplace (`VSCE_PAT`) and Open VSX (`OVSX_PAT`), skipping either when its secret is missing, and attaches the vsix to a GitHub release. Owner steps in `docs/PUBLISHING.md`.
- `homepage` and `galleryBanner` in package.json. License MIT (pending owner confirmation).
- Docs: real-world example `docs/examples/polisim-workspace-analysis.md`, generated live by VSGrok with all six tools.
- Tests: approval broker (ids, approve/deny, cancel/abort, View diff, no-approver deny) and a guard that tool code uses no VS Code pop-ups.

## 0.4.0
- xAI Responses API for chat, agent and commands; Web/X Search, Code Execution, reasoning summaries, compaction, citations; Chat Completions fallback.

## 0.3.x
- Workspace tools in every chat and real tool loop (0.3.1); reasoning effort, prompt caching (0.3.2); model dropdown, galactic theme, sign-in card (0.3.0).

## 0.2.0
- Streaming chat webview, agent tools with reviewed edits, inline completions, commit messages, quick fixes.
