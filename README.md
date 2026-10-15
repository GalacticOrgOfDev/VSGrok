# VSGrok

An AI coding assistant for VS Code that talks only to the **xAI Grok API**. Bring your own xAI API key; no other AI provider is contacted.

## Features

- **Streaming chat sidebar** — markdown rendered as it streams, Stop button (or `Esc`), regenerate, copy, per-reply model / token / latency footer.
- **Code-block actions** — every code block has **Copy**, **Insert** (at cursor / replace selection) and **Apply as diff** (opens a diff of the target file vs. Grok's proposal; nothing is written until you click **Approve** on the card in chat). A fence like ` ```ts path=src/a.ts ` targets that file.
- **Context chips** — attach the current file, the current selection (shown automatically, click to pin), workspace files via quick pick, or files dragged from the Explorer. `@file` and `@workspace` in a message also still work. Attached files are sent in full up to `vsgrok.context.maxFileChars` (default 1,000,000 characters; grok-4.7 has a 500k-token context window).
- **Workspace tools in every chat** — Grok can always call `get_workspace_overview` (folder, top-level tree, package.json/README summary, open editors, git branch/status), `read_file`, `list_files` and `search_workspace` (read-only, run directly, restricted to the workspace). It keeps calling tools until it has an answer (cap: `vsgrok.agent.maxSteps`), and each call shows in the chat as a collapsible line (e.g. *✓ Read src/a.ts*) with its output.
- **Finds the right files** — `find_relevant_files` searches a local workspace index (paths, symbol outlines from your language servers, BM25 over contents; respects `.gitignore` and `vsgrok.index.exclude`; capped by `vsgrok.index.maxFiles`). Everything stays on your machine. `.env` and credential-looking files are never read, searched or indexed.
- **Project rules** — put instructions in `VSGrok.md` (or `.vsgrok/rules.md`) at the workspace root; Grok follows them in every chat and a **📜 Rules** chip shows in the header while they're active.
- **Resilient** — automatic retries with backoff for rate limits and xAI server errors (honoring `Retry-After`), offline detection, and clear in-chat error cards with one-click fixes. Optional local diagnostics log (`vsgrok.diagnostics.enabled`, never records your key or code) and **VSGrok: Copy Diagnostics** for bug reports.
- **Agent** (header toggle, on by default, or *VSGrok: Start Agent Task*) adds the write tools:
  - `propose_edit` — applied only after you click **Approve**,
  - `run_command` — runs in the workspace root only after you click **Run**.
- **Approvals in the chat** — every permission request (commands, agent edits, *Apply as diff*, *Fix with Grok*) appears as an inline card in the chat with **Approve/Run** and **Deny** (edits also have **View diff**, which opens VS Code's diff editor; the decision is still made in the chat). No pop-ups or notifications. Stopping, starting a new chat or closing the panel counts as Deny.
- **Multi-file plans** — the agent bundles create/modify/delete/rename edits into one plan card with per-file diffs and checkboxes. Approve all or a subset; it is applied atomically, and one **Undo plan** click reverts it.
- **Problems and tests** — `get_problems` reads VS Code diagnostics, and problems in the active and attached files ride along with your message (toggle with the ⚠ chip). `run_tests` detects and runs your test command (or `vsgrok.testCommand`) through the approval card and reports failures as file:line. After edits the chat offers **Re-run checks**.
- **MCP servers**: add Model Context Protocol servers in `vsgrok.mcp.servers` (user settings) or `.vscode/vsgrok-mcp.json` (trusted workspaces only). Servers defined by a repo (that file or workspace settings) never start until you allow them once for that repo in *VSGrok: MCP Servers*; changing their config asks again. Both stdio (`command`/`args`/`env`) and streamable HTTP (`url`/`headers`) are supported. With Agent on, their tools are offered to Grok as `mcp__<server>__<tool>`, and every call shows an approval card with the arguments and, for your own servers, an **Always allow** box for that tool. *VSGrok: MCP Servers* shows status and tools, reconnects, and clears always-allow choices. Example:
  ```json
  "vsgrok.mcp.servers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "…" } }, "docs": { "url": "https://example.com/mcp" } }
  ```
- **Chat history and tabs**: chats are saved on this machine (VS Code global storage) after each answer. 🕘 in the header opens the history list, where you can search, reopen, rename, delete or **Export .md**. A tab strip above the chat keeps up to 8 chats open (**+** for a new tab; closing a tab keeps the chat in history). Reopened chats continue where they left off: through `previous_response_id` when responses are stored on xAI, otherwise by resending the saved local items (or the transcript). API keys are never saved, secret-looking tokens are redacted, and images aren't kept. `vsgrok.history.enabled` turns saving off.
- **Run task (background agent)** — click **▶ Task** next to Send (or *VSGrok: Run Task in Background*). Grok then plans, edits, runs tests and fixes failures on its own until it's done or blocked. A task card shows progress: steps, tokens, cost, the current step and an approval log, with a **Stop task** button. At the end it lists the changed files with **Undo all**. `vsgrok.agent.autoApprove` (user settings only; default `none`) can auto-approve workspace creates and edits (`safeEdits`), plus commands exactly matching `vsgrok.agent.commandAllowlist` (`editsAndCommands`). Deletes, renames, flagged files (package.json, CI, .vscode, rules), other commands and anything outside the workspace always ask in the chat. Limits: `vsgrok.agent.task.maxSteps` / `maxTokens` / `maxCostUsd`.
- **Inline edit (Ctrl+I / Cmd+I)** — select code (or just put the cursor on a line), press `Ctrl+I`, type what to change in the inline box that opens at the cursor, and Grok streams the proposed change as a diff inside that box (**View diff** opens it side by side); your file isn't touched until you accept. **Tab** (in the editor) or **Ctrl/Cmd+Enter** accepts as one undoable edit, **Esc** rejects, and replying in the same box refines the result. Secret-looking files and files outside the workspace are refused. If another inline-chat extension (e.g. Copilot) owns `Ctrl+I`, run *VSGrok: Inline Edit with Grok* or rebind `vsgrok.inlineEdit`.
- **Right-click actions** — *Explain This*, *Write Tests for This*, *Fix Problems Here* and *Refactor…* on the selection or the enclosing symbol.
- **Images in chat** — paste a screenshot, drop image files or click 🖼 to attach them (thumbnails before sending). They are downscaled locally and sent as `input_image` to vision-capable models; if the selected model can't read images, the chat offers to switch.
- **Cost meter** — running tokens and cost for the current chat in the header (cost only when xAI reports it), with a breakdown tooltip.
- **Demo script** — [docs/DEMO.md](docs/DEMO.md) walks through building a sample project from an empty folder.
- **Real-world example** — [PoliSim workspace analysis](docs/examples/polisim-workspace-analysis.md), generated live by VSGrok using all six workspace tools.
- **Built on xAI's Responses API** (`POST /v1/responses`, [docs](https://docs.x.ai/developers/rest-api-reference/inference/responses)) — chat, agent mode and commands stream Responses events; client-side tools use `function_call` / `function_call_output` items ([function calling](https://docs.x.ai/developers/tools/function-calling)).
- **Server-side conversation history** — follow-up turns send only the new input plus `previous_response_id` ([chaining](https://docs.x.ai/developers/model-capabilities/text/generate-text#chaining-the-conversation)). VSGrok also keeps every returned item (including reasoning `encrypted_content`) verbatim, so if a stored response has expired or you set `vsgrok.responses.store` to `false`, it resends the full history unchanged ([encrypted reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning#encrypted-reasoning-content)). Long chats are compacted with `POST /v1/responses/compact` once input reaches `vsgrok.responses.compactAtTokens` ([context compaction](https://docs.x.ai/developers/advanced-api-usage/context-compaction)). There is no fixed message limit.
- **Web Search and X Search** — header toggles (**Web**, **𝕏**) or `vsgrok.tools.webSearch` / `vsgrok.tools.xSearch` enable xAI's built-in server-side tools ([web search](https://docs.x.ai/developers/tools/web-search), [X search](https://docs.x.ai/developers/tools/x-search)). Searches show as activity lines, and the sources come back as `url_citation` annotations ([citations](https://docs.x.ai/developers/tools/citations)) and are listed as links under the answer. xAI bills these tools separately.
- **Code Execution (opt-in)** — `vsgrok.tools.codeExecution` adds xAI's `code_interpreter` tool, which runs Python in xAI's sandbox, not on your machine ([docs](https://docs.x.ai/developers/tools/code-execution)).
- **Reasoning summaries** — `response.reasoning_summary_text.delta` streams into a collapsible *Thought* line. `vsgrok.reasoningEffort` sets `reasoning.effort` (low / medium / high / xhigh; [docs](https://docs.x.ai/developers/model-capabilities/text/reasoning)).
- **Prompt caching and cost** — each chat sends an `x-grok-conv-id` header so turns reuse xAI's prompt cache ([docs](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits)). Under each reply: output, reasoning and cached tokens, context size and cost (from `usage.cost_in_usd_ticks`).
- **Chat Completions fallback** — `vsgrok.api: "chat"` switches back to the legacy `/v1/chat/completions` path (no server-side tools, citations or compaction; history is kept locally).
- **Inline ghost-text completions** — debounced (default 275 ms), cancelled when you keep typing, toggle with *VSGrok: Toggle Inline Completions* or `vsgrok.inlineCompletions.enabled`.
- **Commands** — Explain / Fix / Add Comments / Write Tests on a selection (streamed into chat); **Generate Commit Message** from the staged diff (button in the Source Control title bar; uses [structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs) with a `{subject, body[]}` JSON schema); **Fix with Grok** Quick Fix on diagnostics (lightbulb), approved through the same in-chat card.
- **Git help** (Source Control title bar and `…` menu) — **Generate Commit Message** writes into the commit box, follows your recent commit style and keeps your draft's intent; **Review My Changes** sends the uncommitted diff (staged, unstaged and small new files) to chat for a severity-grouped review with clickable `file:line` links; **Draft PR Description** summarises the branch against `origin/HEAD`/`main` and copies it or saves a `.md`. Secret files (`.env`, keys, credentials) are left out of every diff and key-like strings are redacted. Read-only: VSGrok never commits or pushes.
- **Terminal helper** — when a command fails in the integrated terminal (shell integration, non-zero exit; Ctrl+C ignored), a quiet **✨ Ask Grok** item appears in the status bar — no popups. One click sends the command, exit code and the last 80 lines of output (ANSI stripped, keys redacted; withheld entirely if the command touches a secrets file) to chat with Agent on, so the fix comes back through the approval card. It hides after a later success or 3 minutes. Turn off with `vsgrok.terminalHelper.enabled`.

## Setup

1. Open the VSGrok view in the activity bar. Without a key it shows a **Connect Grok** card.
2. Click **Get an API key** (or run **VSGrok: Sign In / Get API Key**). It opens the [xAI Console](https://console.x.ai/team/default/api-keys), where you sign in with your X or xAI account and create a key.
3. Click **Paste API key** (or **VSGrok: Set API Key**). It is stored in VS Code SecretStorage, never in settings. **VSGrok: Clear API Key** removes it.
4. Pick a model from the dropdown in the chat header or with **VSGrok: Select Model**. The list comes live from xAI's `GET /v1/models` (cached for an hour), with a built-in list when offline or before a key is set.

**SuperGrok / X Premium:** xAI's subscription sign-in is currently limited to partner apps xAI has approved (for example [OpenCode](https://x.ai/news/grok-opencode)), with no public way for other apps to register. VSGrok therefore uses an API key, which xAI bills per token separately from a SuperGrok subscription. If xAI opens subscription sign-in to third-party apps, VSGrok will add it.

## Settings

| Setting | Default | |
|---|---|---|
| `vsgrok.model` | `grok-4.7` | Model id for chat / commands / agent ([model list](https://docs.x.ai/docs/models)) |
| `vsgrok.theme` | `galactic` | `galactic` (deep-space Grok look) or `vscode` (plain theme colors). High-contrast themes always use VS Code colors. |
| `vsgrok.api` | `responses` | `responses` (Responses API) or `chat` (legacy Chat Completions fallback). Inline completions always use Chat Completions. |
| `vsgrok.responses.store` | `true` | Store responses on xAI for 30 days and chain with `previous_response_id`; `false` sends `store: false` and resends local history |
| `vsgrok.responses.compactAtTokens` | `300000` | Compact the chat when input reaches this many tokens (0 = off) |
| `vsgrok.tools.webSearch` / `vsgrok.tools.xSearch` / `vsgrok.tools.codeExecution` | `false` | xAI server-side tools (billed by xAI) |
| `vsgrok.context.maxFileChars` | `1000000` | Per-file cap for attached context |
| `vsgrok.baseUrl` | `https://api.x.ai/v1` | xAI API base URL |
| `vsgrok.temperature` / `vsgrok.maxTokens` | `0.3` / `8192` | |
| `vsgrok.requestTimeoutSeconds` | `120` | Idle timeout |
| `vsgrok.agent.enabledByDefault` / `vsgrok.agent.maxSteps` | `true` / `15` | Read-only workspace tools are always on; Agent adds edits (diff + Accept) and commands (confirm) |
| `vsgrok.agent.autoApprove` | `none` | Run task only: `none` / `safeEdits` / `editsAndCommands` (user settings only) |
| `vsgrok.agent.commandAllowlist` | test/lint commands | Exact-match commands for `editsAndCommands` |
| `vsgrok.agent.task.maxSteps` / `.maxTokens` / `.maxCostUsd` | `40` / `2000000` / `2` | Run task limits (0 = none for tokens/cost) |
| `vsgrok.mcp.servers` | `{}` | MCP servers (stdio or streamable HTTP); also `.vscode/vsgrok-mcp.json` in trusted workspaces |
| `vsgrok.history.enabled` | `true` | Save chats locally for history, tabs and export |
| `vsgrok.history.saveContext` | `false` | Also save each chat's full model context (attached files, tool outputs, diffs) for exact resume; off = transcript only |
| `vsgrok.inlineEdit.enabled` | `true` | Inline edit with `Ctrl+I` / `Cmd+I` |
| `vsgrok.inlineCompletions.*` | enabled, model = chat model, 275 ms, 128 tokens | |

## Privacy

- Requests go directly from your machine to the configured base URL (default `api.x.ai`). There is no VSGrok server and no telemetry.
- What is sent: your messages, attached context (files/selections you attach, or that agent tools read), and for inline completions up to ~6,000 characters before and ~2,000 after the cursor in the current file. Turn inline completions off if you don't want code sent while typing.
- xAI's handling of API data is governed by xAI's own terms and privacy policy.
- With `vsgrok.responses.store` on (default), xAI stores each response for 30 days so chats can continue by id. Turn it off to send `store: false`.
- Web Search, X Search and Code Execution run on xAI's servers only when you enable them.
- Usage is billed to your xAI account.

## Development

```bash
pnpm install
pnpm run check-types && pnpm run lint
pnpm test                         # unit tests
xvfb-run -a pnpm run test:integration   # real VS Code (drop xvfb-run on desktop)
# incl. a fake Responses-API server (streaming events, function calls, chaining, compaction)
node esbuild.mjs     # or --watch / --production
npx @vscode/vsce package --no-dependencies
```

## Install and updates

Download `vsgrok-X.Y.Z.vsix` from [GitHub Releases](https://github.com/GalacticOrgOfDev/VSGrok/releases) and run **Extensions: Install from VSIX…**. After that VSGrok updates itself: once a day (setting `vsgrok.checkForUpdates`, default on) it checks the latest GitHub release and, if it is newer, shows an **Update now** card in the chat that downloads and installs the `.vsix`, then offers **Reload Window**. Run **VSGrok: Check for Updates** anytime. Marketplace publishing (for VS Code's built-in auto-update) is planned; see [docs/PUBLISHING.md](docs/PUBLISHING.md).

## Status

v0.15.0. Unit- and integration-tested against a local fake server and used live against the xAI API (see the [PoliSim example](docs/examples/polisim-workspace-analysis.md)); please report issues.
