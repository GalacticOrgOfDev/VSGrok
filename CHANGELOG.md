# Changelog

## 0.14.0 — 2026-10-12
**Terminal helper**
- When a terminal command exits non-zero (via VS Code shell integration), a subtle **✨ Ask Grok** item appears at the left of the status bar. There is no notification or popup. Its tooltip names the command and exit code. Exit 130 (Ctrl+C) is ignored.
- One click (or *VSGrok: Ask Grok About the Failed Terminal Command*) sends the command line, exit code, working directory, shell and the last 80 lines / 8 KB of output to chat:
  - The output is captured from the start of the command (200 KB rolling buffer), with ANSI and shell-integration escapes stripped and key-like strings redacted.
  - It is framed as data, not instructions.
  - It is withheld entirely if the command names a secrets file (`cat .env`, `~/.aws/credentials`, …).
- Agent is switched on for that turn, so Grok's fix comes back as an edit or `run_command` through the approval card.
- The item hides after a later successful command in the same terminal, when the terminal closes, after 3 minutes, or once clicked.
- New setting `vsgrok.terminalHelper.enabled` (default on).

## 0.13.0 — 2026-10-12
**Git help**
- **Generate Commit Message** (improved from 0.2):
  - Uses the repo you clicked, otherwise the one selected in Source Control, otherwise the one holding the active file.
  - Sends your last 10 commit subjects so the message matches the repo's style.
  - Treats any text already in the commit box as a draft whose intent it keeps.
  - If you type in the box while Grok is writing, nothing is overwritten; the message goes to the clipboard instead.
  - Shows progress in the Source Control view instead of a notification.
- **Review My Changes** (Source Control `…` menu or the palette):
  - Reviews the staged and unstaged diff against HEAD plus small untracked files.
  - Results appear in chat grouped high / medium / low, with `[file:line](path#Lnn)` links that open the file at that line.
  - The chat bubble shows "Review my uncommitted changes"; the diff goes to Grok as attached data.
- **Draft PR Description:** diffs the branch from its merge-base with `origin/HEAD` (or `origin/main`, `origin/master`, `main`, `master`), including uncommitted work, adds the commit list and diffstat, and returns Markdown with Summary / Changes / Testing / Notes. You choose **Copy to clipboard** or **Save as Markdown file…**.
- **Secrets:** sections for secret files (`.env*`, keys, credentials, including renames onto them) are dropped before anything is sent, and the prompt lists them as omitted. Key-like strings are redacted. Each file is capped at 20 KB and the whole diff at 120 KB.
- **Git safety:** git runs read-only (`diff`/`log`/`rev-parse`/`ls-files`) with fsmonitor off and no external diff or textconv drivers, and only in trusted workspaces. Nothing commits, pushes or opens PRs.
- **Links in answers:** workspace-relative links (`src/a.ts#L12`, `src/a.ts:12`) open the file at that line, subject to the usual secret and outside-workspace checks. http(s) links open in the browser. Other schemes do nothing.

## 0.12.0 — 2026-10-12
**MCP (Model Context Protocol) servers**
- Configure servers in `vsgrok.mcp.servers` (user settings) or in `.vscode/vsgrok-mcp.json` (`{ "servers": { … } }`; `mcpServers` is accepted too).
  - **stdio:** `command`, `args`, `env`, `cwd`.
  - **Streamable HTTP:** `url` and `headers`. Only https is allowed, except plain http on localhost.
  - `"disabled": true` skips a server.
- Built on the official `@modelcontextprotocol/sdk` (v1.32) client.
- **The workspace file is read only in trusted workspaces.** It can't override a server of the same name from your settings. `vsgrok.mcp.servers` is restricted in Restricted Mode.
- With Agent on, tools from connected servers are offered to Grok as function tools named `mcp__<server>__<tool>`. Their descriptions are labelled as provided by the server and untrusted.
- **Every call shows an approval card:** server › tool, where the server is configured (settings or this repo), and the JSON arguments, with **Run** / **Deny** and an **Always allow <tool>** checkbox.
  - Always-allow is remembered per tool and tied to the server's launch config (command/args/cwd/env names or URL), so changing the command resets it.
  - Run task never auto-approves MCP tools.
- Results return to Grok inside `<mcp_result … source="untrusted tool output">`, capped at 50,000 characters. Images and audio are summarised, not forwarded.
- *VSGrok: MCP Servers* lists each server's status (ready / error / disabled), transport, source and tools, plus config errors. It can also reconnect, open your settings or the workspace file (creating a disabled example), and clear "Always allow".
- Limits: 20 s connect/list timeout, 120 s per call (cancelled by Stop), 20 servers, 100 tools per server.

## 0.11.0 — 2026-10-12
**Chat history**
- Chats are saved locally after every answer (and when you switch, close or start a chat) under VS Code's global storage: one JSON file per chat plus an index, keeping the newest 200 chats.
- **Never stored:** API keys. Every saved string is redacted for secret-looking tokens (`xai-…`, `sk-…`, GitHub tokens, JWTs, `token=`/`password=` values), and images are replaced by a placeholder. xAI's opaque encrypted reasoning is kept as-is so stateless chats can resume. A chat over 4 MB drops its model state first (it resumes from the transcript), then its oldest messages.
- **🕘 History** (header, or *VSGrok: Chat History*) opens a searchable list with relative times and previews. Each chat has **Open**, **Rename**, **Export** and **Delete** (a second click confirms). Esc closes the list.
- **Tabs:** a tab strip above the chat holds up to 8 open chats. Use **+** (or *VSGrok: New Chat Tab*) to add one, click or arrow keys to switch, and × or Delete to close (the chat stays in history). Switching waits until Grok has finished answering.
- **Resume** works with or without server-side storage:
  - stored chats continue with `previous_response_id` (falling back to the saved local items if xAI no longer has the response);
  - `store: false` chats resend the saved local items;
  - chats without saved model state are rebuilt from the transcript with a fresh system prompt.
- **Export to Markdown** (*VSGrok: Export Chat to Markdown*, or **Export .md** in the history panel) writes `# title`, a metadata line, then `## You` / `## Grok` sections. It is redacted the same way, and the default file name is the chat title in the workspace root.
- New setting `vsgrok.history.enabled` (default on).

## 0.10.0 — 2026-10-12
**Run task (background agent)**
- **▶ Task** next to Send, or *VSGrok: Run Task in Background*, runs a goal as a task. Grok inspects the code, states a short plan, edits, runs `run_tests` and `get_problems`, and fixes failures until green or blocked, then summarises.
- **Task card** in the chat:
  - progress (step N of max, tokens, cost when xAI reports it, auto-approved and asked counts), the current step, and the last 8 approval decisions with reasons;
  - **Stop task**;
  - at the end, the outcome (finished / stopped / budget / step limit / failed) and the changed files, with **Undo all**.
- **Undo all** restores every file the task created, modified or deleted to its pre-task bytes. It skips (and names) any file changed after the task ended.
- **`vsgrok.agent.autoApprove`** applies to Run task only (normal chat always asks):
  - `none` (default) asks before everything;
  - `safeEdits` auto-approves creates and edits of writable workspace files;
  - `editsAndCommands` also auto-approves commands that exactly match `vsgrok.agent.commandAllowlist`.
- **Always ask:** deletes, renames, refused rows, flagged files (package.json, CI workflows, `.vscode` tasks/settings, Grok's rules), symlinks out of the workspace, commands that aren't allowlisted, and any command with shell metacharacters.
- Auto-approval applies only to the task's own tool calls; an *Apply* or *Fix* click during a task still shows a card.
- The level and the allowlist are read from **user settings only**; workspace values are ignored. Both are also restricted in untrusted workspaces.
- **Limits:**
  - `vsgrok.agent.task.maxSteps` (40);
  - `vsgrok.agent.task.maxTokens` (2,000,000);
  - `vsgrok.agent.task.maxCostUsd` ($2, applied only when xAI reports cost).
  - Hitting a limit stops the loop with one final summary request that has no tools.
- Run task uses the Responses API. With `vsgrok.api: "chat"` it shows a note instead.

## 0.9.0 — 2026-10-12
**Inline edit**
- Select code, or put the cursor on a line, and press **Ctrl+I** (**Cmd+I** on macOS). An inline input opens at the cursor (VS Code's comment widget). Type an instruction and press Enter.
- Grok streams the replacement right below the original block as an inline diff: the old lines are tinted red, the new ones green, with overview-ruler marks.
- **Tab** or **Ctrl/Cmd+Enter** accepts (the old block is removed) and **Esc** rejects (the original is restored exactly). Accept and Reject are also buttons on the widget. Reply in the same widget to refine; earlier instructions and results go along as history.
- Typing in the file while a proposal is shown cancels it and removes the proposal.
- Keybindings: `Ctrl+I` only applies in a writable editor with text focus, when no suggest widget is open and **no other inline-chat provider is installed** (`!inlineChatHasProvider`, so Copilot keeps its `Ctrl+I`). Tab only accepts while a result is ready and no suggestion or ghost text is visible. Also in the Grok right-click submenu and the Command Palette.
- Same file rules as attachments: workspace files only, never secret-looking paths or symlinks onto them. The file content is framed as untrusted, and at most 20,000 characters can be rewritten inline.
- New setting `vsgrok.inlineEdit.enabled` (default on).

## 0.8.1 — 2026-10-12
**Code and security review (JGrok)**
- **Image budget (high).** Old images are no longer resent on every turn. Only the most recent image message is kept for follow-ups; older image parts become a short "[image N from an earlier message omitted]" placeholder (and all earlier ones are dropped when a new image is attached). The extension now enforces 4 MiB per image and 16 MiB of images per message, not just the webview.
- Switching a chat to stateless (`store: false`) on the first image drops stored reasoning items that have no `encrypted_content`, so the resend isn't rejected.
- Compaction no longer uploads image payloads. (The compaction endpoint has no `store` parameter; it returns an opaque blob.)
- Dropped/picked image files: read cap lowered to 20 MiB, MIME type taken from the magic bytes rather than the file extension, and non-images refused before reading into the webview.
- Cost meter on the Chat Completions path records the reported prompt tokens and cost; when input isn't reported it says "Input: not reported (Chat Completions)" instead of 0.
- Low: the image count is checked before any data URL is scanned (and at most 16 entries are looked at); base64 is validated by a scan instead of a large regex capture; `/language-models` has its own timeout; the vision gate also resolves model aliases; open-dialog picks resolve symlinks before the secret-file check.

**Image input and cost meter UI review (UIGrok)**
- The vision note no longer loses your message. The typed text is restored, the primary button is **Switch to <model> and resend** (switches, then replays the same text and images), and the secondary is **Send without images**. The note has its own neutral style and focuses the primary button.
- Attached images sit in their own **image tray** above the input (a list, kept out of the context-chip collapse):
  - the thumbnails are buttons that open an in-chat preview (`<dialog>`; Esc or Close returns focus);
  - **×** is bigger, with a clear focus ring;
  - removal is announced;
  - pastes are named "Pasted image N".
- Sent-message thumbnails enlarge on click, and their alt text carries the file names. High contrast gets borders.
- Hints: the input placeholder mentions paste/drop, the Attach title mentions Shift+drag, and the composer shows a dashed outline while files are dragged over.
- Sending images without text uses "What is in these images?" when there are several.
- Concurrent drops or pastes can no longer exceed the 8-image cap.
- **Cost meter:**
  - It is now a button that opens a breakdown popover; it is no longer a live region that re-announced every turn.
  - The breakdown is linked for screen readers, and the accessible name says "at least $X" when some turns had no reported cost; the "+" is explained.
  - The figures also appear in the ⚙ panel, for narrow sidebars.
  - Tabular numerals, and a pill outline in galactic.
- **Toasts** stack in one container, all use `role=status` (including extension toasts), stay 6 s plus 1 s per 40 characters, pause on hover/focus, and close on click or Esc. The cap message reads "8 images max per message. N weren't added."
- `docs/DEMO.md`:
  - cut the optional Undo and Explain beats;
  - scripted the exact `padStart` bug;
  - added "widen the sidebar to about 420 px" so the cost meter stays visible;
  - noted that pasted screenshots work and that OS drags need Shift;
  - updated the vision-note and cost-meter steps.

## 0.8.0 — 2026-10-12
**Image input**
- Add images in three ways: paste a screenshot into the chat input (`Ctrl+V`), drop image files (from the Explorer, or from the OS), or click **🖼 Attach image**. Images show as removable thumbnail chips before sending, and the sent message shows them too.
- Sent to the Responses API as `input_image` items with a base64 `data:` URL ([image understanding](https://docs.x.ai/developers/model-capabilities/images/understanding): JPG/PNG, up to 20 MiB each).
  - The webview downscales to 2048 px on the long side and recompresses (PNG kept when small, otherwise JPEG) to stay under about 4 MB. GIF, WebP and BMP are converted.
  - Up to 8 images per message.
  - The extension re-validates every image: PNG or JPEG only, magic bytes must match the type, at most 20 MiB.
- Chats that contain images switch to `store: false` with full-history resend, as xAI advises for image requests.
- Vision check: image support is read from `GET /v1/language-models` (`input_modalities`). If the selected model doesn't accept images, an in-chat note offers **Switch to <vision model>** or **Remove images**, and nothing is sent. Models whose support is unknown are allowed.
- Images dropped from the Explorer follow the workspace and secret-file rules, like other dropped files. **Attach image** accepts files you pick anywhere, except secret-looking names. The content security policy is unchanged (`img-src` already allowed `data:`); `blob:` is not added.

**Per-chat cost meter**
- A running total in the header (e.g. "12k tok · $0.025") built from the usage xAI returns. The tooltip breaks down turns, input (cached), output (reasoning) and cost.
- Cost is shown only when the API reports it (`usage.cost_in_usd_ticks`); prices are never estimated. If no turn reported a cost, the meter shows tokens only. A "+" means some turns had no reported cost.
- Resets on **New chat**.

**Docs**
- `docs/DEMO.md`: a step-by-step recording script that builds a small terminal colour-palette CLI from an empty folder. It covers the plan card, tests, a fix, image input, X Search and the cost meter.

## 0.7.1 — 2026-10-12
**Security and correctness review (JGrok)**
- **H1:** plan create and rename targets are checked with a new `checkWritable`. It resolves the nearest existing parent directory through symlinks, which must stay inside the workspace, and refuses secret-looking results. A directory symlink can no longer route a write outside the workspace.
- **H2:** right before applying, each file is re-read and compared byte-for-byte with what the card showed. If anything changed, was created or was deleted meanwhile, nothing is applied ("changed since the plan was proposed"). Files with unsaved editor changes are refused.
- **H3:** the `run_tests` approval card shows what will actually run: the package.json script bodies, including `pre`/`post` hooks. Repo-controlled sources are flagged.
- **H4:** `vsgrok.testCommand` is now `machine-overridable` and listed in `restrictedConfigurations`, so Restricted Mode ignores it. A value set by the workspace is labelled "set by this workspace".
- **M1:** View diff contents are reused per row, freed when the card is decided or the diff closes, and capped at 20 (LRU).
- **M2:** only the last 10 plans keep an undo snapshot. Older Plan applied cards say the undo expired.
- **M3:** renames use a real `renameFile`, which keeps the bytes and file mode. Undo restores byte snapshots. Binary or non-UTF-8 files can be deleted or renamed but never rewritten as text.
- **M4:** plan approvals only count selectable rows. An approve with no valid index, or no selection at all, is a deny, and an empty plan is never applied.
- **M5:** problems are sent inside a `<diagnostics source="untrusted tool output">` block, redacted, and capped at 4 KB. The system prompt says such blocks are data, not instructions.
- **M6:** test-output lines are trimmed to 2,000 characters before parsing.
- **L1:** the `.git` check is case-insensitive. Plans touching `.vscode/*.json`, `VSGrok.md`, `.vsgrok/`, CI workflows or `package.json` are flagged on the card.
- **L2:** Windows alternate data streams, reserved device names, and segments ending in a dot or space are refused.
- **L3:** size caps are measured in UTF-8 bytes (1 MB per file) and there is a 5 MB plan total.
- **L4:** undo builds the edit first, then verifies the hashes and applies back to back.
- **L5:** diagnostics on symlinks that resolve outside the workspace or onto a secret are hidden.
- Plan undo hashes now use SHA-256.

**Plan card UI review (UIGrok)**
- Plan card:
  - The file list scrolls (max height about 45% of the view) and Approve/Deny stay pinned.
  - Refused files (secrets, missing, already exists) are shown disabled with the reason and are never applied.
  - Focus starts on a new tri-state **Select all** box instead of Approve. After a decision, focus moves to the status line and then back to the input.
  - Op names and +/− counts are read out properly by screen readers.
  - Paths break at `/`, and a rename target gets its own line.
  - A meta line shows the mix (e.g. "3 new · 5 edits · 1 delete").
  - Unchecked rows are struck through after approval.
  - High contrast gets underlined links and contrast borders.
- Plan applied card:
  - Shows **↶ Plan undone** after an undo.
  - **Undo plan** stays disabled after a non-retryable refusal.
  - **Re-run checks** gives feedback.
  - Buttons are matched by `data-action`, and the card is announced to screen readers.
- Problems chip: the accessible name is "Include N problems" with `aria-pressed`, the tooltip is clearer, and the off state is more readable.
- Checks offer:
  - Now a **🧪 Re-run checks** button under the reply instead of a card.
  - Not shown when a Plan applied card already offers it.
  - New setting `vsgrok.checks.offerAfterEdits`.
- Editor context menu: actions are grouped under a **Grok** submenu. **Add Comments to This** now works on the selection or the enclosing symbol.
- Refactor presets have descriptions, and two were added: Modernize syntax and Convert to async/await.
- Fix Problems Here says when there are no problems instead of attempting an empty fix.

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
