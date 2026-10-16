# VSGrok

An AI coding assistant for VS Code. Chat, inline completions, and agent turns go only to the **xAI Grok API** with your own key. There is no VSGrok server and no telemetry.

When xAI is down, rate-limited, or the key has no credits, VSGrok shows an in-chat card with a direct fix. It does not retry once streaming has started.

Edits and shell commands wait for an **Approve** card in the chat. Reading and searching the workspace stays on your machine. `.env` and credential files are never opened. GitHub and other MCP servers are contacted only when you turn them on.

**0.15.0** · [MIT](LICENSE) · VS Code **1.105+** · [Releases](https://github.com/GalacticOrgOfDev/VSGrok/releases) · [Changelog](CHANGELOG.md) · [Issues](https://github.com/GalacticOrgOfDev/VSGrok/issues)

New in this version: **VSGrok: Connect GitHub**, and a red approval card for any command that would read stored credentials.

## Contents

- [Install](#install)
- [Setup](#setup)
- [Chat](#chat)
- [Workspace](#workspace)
- [Agent](#agent)
- [GitHub](#github)
- [Editor](#editor)
- [Git and the terminal](#git-and-the-terminal)
- [MCP servers](#mcp-servers)
- [xAI API](#xai-api)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Settings](#settings)
- [Privacy](#privacy)
- [Restricted Mode](#restricted-mode)
- [Development](#development)

## Install

Download `vsgrok-X.Y.Z.vsix` from [GitHub Releases](https://github.com/GalacticOrgOfDev/VSGrok/releases) and run **Extensions: Install from VSIX…**. The same file installs in VS Code forks.

VSGrok then updates itself. Once a day (`vsgrok.checkForUpdates`, on by default) it checks the latest GitHub release. If that release is newer, an **Update now** card in the chat downloads the `.vsix`, installs it, and offers **Reload Window**. Run **VSGrok: Check for Updates** any time.

Publishing to the Marketplace and Open VSX (so the editor’s own auto-update can take over) is planned. See [docs/PUBLISHING.md](docs/PUBLISHING.md).

## Setup

1. Open **VSGrok** in the activity bar (the view is titled **VSGrok Agent**). With no key it shows a **Connect Grok** card.
2. Click **Get an API key**, or run **VSGrok: Sign In / Get API Key**. That opens the [xAI Console](https://console.x.ai/team/default/api-keys). Sign in with your X or xAI account and create a key.
3. Click **Paste API key**, or run **VSGrok: Set API Key**. The key is stored in VS Code SecretStorage, never in settings. **VSGrok: Clear API Key** removes it.
4. Pick a model in the chat header, or with **VSGrok: Select Model**. The list comes from `GET /v1/models` and is cached for an hour. Offline, or before a key is set, VSGrok uses a built-in list. The default model is `grok-4.7`.

**SuperGrok / X Premium.** Subscription sign-in is limited to partner apps xAI has approved (for example [OpenCode](https://x.ai/news/grok-opencode)). There is no public way for other apps to register, so VSGrok uses an API key. xAI bills that key per token, separately from a SuperGrok subscription. If xAI opens subscription sign-in to third-party apps, VSGrok will add it.

To see the extension exercise itself, open an empty folder and run **VSGrok: Run Demo**, or ask Grok to execute the demo. A pre-flight card shows a cost estimate. Nothing is sent until you click **Start**. The script is [docs/DEMO.md](docs/DEMO.md). Every write and command still asks. A live run against a real project is written up in the [PoliSim workspace analysis](docs/examples/polisim-workspace-analysis.md).

## Chat

The sidebar streams markdown as it arrives. **Stop**, or `Esc` while the chat is focused, aborts the turn. Each reply can be regenerated or copied, and a footer shows the model, tokens, and latency.

- **Code blocks** have **Copy**, **Insert** (at the cursor, or replacing the selection) and **Apply as diff**. Apply opens a diff and writes nothing until you approve the card in chat. A fence tagged `path=src/a.ts` (after the language) targets that file.
- **Context.** Attach the current file, pin the current selection (it appears on its own; click to keep it), pick workspace files, or drag them from the Explorer. `@file` and `@workspace` still work. Each attachment is sent in full up to `vsgrok.context.maxFileChars` (default 1,000,000 characters; grok-4.7’s window is 500k tokens).
- **Images.** Paste a screenshot, drop image files, or click the attach-image button. Thumbnails show before send. Images are downscaled on your machine and sent as `input_image` to vision-capable models (up to 8 per message). If the selected model cannot read images, the chat offers to switch. Chats that contain images are not stored on xAI’s servers.
- **History and tabs.** Chats are saved on this machine after each answer (the newest 200; `vsgrok.history.enabled` turns saving off). The history button in the header opens a searchable list: reopen, rename, delete, or **Export .md**. A tab strip keeps up to 8 chats open. Closing a tab keeps the chat in history. API keys are never saved, secret-looking tokens are redacted, and images are not kept. By default only the visible transcript is saved. `vsgrok.history.saveContext` also keeps the model context so a reopened chat resumes exactly.
- **Cost.** The header shows tokens and, when xAI reports it, US dollars for this chat. Prices are never estimated. A **+** means some turns had no reported cost. The meter resets on **New**.
- **Look.** `vsgrok.theme` is `galactic` (the default) or `vscode`. High-contrast themes always use VS Code colors.
- **When something fails.** Rate limits and xAI server errors are retried with backoff, honoring `Retry-After`. A request is not retried once streaming has started. Offline, timeout, missing-key, credits, and context-length errors become in-chat cards with a direct fix. An optional local log (`vsgrok.diagnostics.enabled`, off by default) never records your key, prompts, responses, or file contents. **VSGrok: Copy Diagnostics** copies a redacted report.

Reopened chats continue through `previous_response_id` when responses are stored on xAI. Otherwise VSGrok resends the saved local items, or rebuilds the turn from the transcript.

## Workspace

Grok can see the open workspace without you pasting files in. These tools are always available, read-only, and run immediately. Each call is a collapsible line in the chat (for example *Read src/a.ts*), and Grok keeps calling them until it can answer, up to `vsgrok.agent.maxSteps`.

| Tool | What it does |
| --- | --- |
| `get_workspace_overview` | Folder, top-level tree, package.json and README summary, open editors, git branch and status |
| `find_relevant_files` | Ranked files from a local index: paths, symbol outlines, BM25 over contents |
| `read_file` | One workspace file |
| `list_files` | A glob, inside the workspace |
| `search_workspace` | Text search, inside the workspace |

The index is built on your machine. No embedding service is called. It respects `.gitignore` and `vsgrok.index.exclude`, skips symlinks, and is capped by `vsgrok.index.maxFiles` (default 5,000). **VSGrok: Rebuild Workspace Index** rebuilds it. `.env` and credential-looking files are never read, searched, or indexed.

**Project rules.** Put instructions in `VSGrok.md` or `.vsgrok/rules.md` at the workspace root. They are added to every chat, reloaded when you edit them, and shown as a **Rules** chip in the header. They are ignored in [Restricted Mode](#restricted-mode).

## Agent

The **Agent** toggle in the header is on by default (`vsgrok.agent.enabledByDefault`). It adds the tools that change things. Read-only workspace tools stay available when Agent is off. With it off, ask Grok to show a `path=` code block and use **Apply**.

- `propose_edit` writes one file, and only after **Approve**. **View diff** opens VS Code’s diff editor. The decision stays in the chat.
- `propose_plan` creates, modifies, deletes, or renames several files on one card, with a per-file diff and a checkbox. Approve all or a subset. The selected rows are applied atomically. **Undo plan** reverts that apply in one step. The last 10 plans keep an undo snapshot.
- `run_command` runs inside the workspace, only after **Run**. The card names the folder.
- `get_problems` reads VS Code diagnostics. Problems in the active and attached files also ride along with your message. The problems chip turns that off.
- `run_tests` detects the test command, or uses `vsgrok.testCommand`. The card shows exactly what will run, including `pre` and `post` script hooks, and reports failures as `file:line`. After edits, the chat offers **Re-run checks**.

Every permission request is a card in the chat: commands, edits, plans, **Apply as diff**, **Fix Problem with Grok**, and MCP calls. There are no pop-ups. Stopping, starting a new chat, or closing the panel counts as Deny. If the chat cannot be shown, nothing runs.

**Run task.** **Task** next to Send, or **VSGrok: Run Task in Background**, lets Grok plan, edit, test, and fix on its own until it is done or blocked. The task card shows the step, tokens, cost, and an approval log, with **Stop task**. At the end, **Undo all** restores only that task’s writes (a second click confirms) and skips files you changed afterwards. Run task needs the Responses API.

`vsgrok.agent.autoApprove` applies to Run task only. Normal chat always asks. The level is read from your user settings, never from the workspace.

| Level | What it auto-approves |
| --- | --- |
| `none` (default) | Nothing |
| `safeEdits` | Creates and edits of ordinary workspace files |
| `editsAndCommands` | Those edits, plus commands that exactly match `vsgrok.agent.commandAllowlist` |

Deletes, renames, flagged files (package.json, CI, build and hook configs, `.vscode`, project rules), commands with shell metacharacters, MCP calls, and anything outside the workspace always ask.

A command that reads stored credentials gets a red card. Focus starts on **Deny**, and the command is never auto-approved. That covers `git credential fill`, `gh auth token`, keychain and cloud-CLI token commands, reading credential files (`.netrc`, `.npmrc`, `~/.aws/credentials`, an SSH private key), and printing token, key, secret, or password variables. For GitHub work, use [Connect GitHub](#github) instead.

Limits: `vsgrok.agent.task.maxSteps` (40), `maxTokens` (2,000,000) and `maxCostUsd` ($2, and only when xAI reports a cost).

## GitHub

**VSGrok: Connect GitHub** gives Grok tools from [GitHub’s official remote MCP server](https://github.com/github/github-mcp-server) at `https://api.githubcopilot.com/mcp/`. Use it for repositories, issues, pull requests, and releases. Do not ask Grok to print a token or run `gh auth token`.

Sign in one of two ways:

- **Sign in with GitHub** (recommended) uses VS Code’s built-in GitHub account. There is no token to paste. The scopes requested are `repo`, `read:org`, and `user:email`.
- **Use a personal access token** (`ghp_…` or `github_pat_…`). It is stored in SecretStorage, never in settings.

**VSGrok: Disconnect GitHub** turns the connector off and deletes a stored token. It does not sign you out of VS Code. Use the Accounts menu for that.

The token is sent only in the `Authorization` header to GitHub. It is not written to settings, the diagnostics log, stored approval records, or any request to xAI. The GitHub settings are user-level only, so a repository cannot enable the connector or point it somewhere else.

Tools are offered when Agent is on, named `mcp__github__…`. Tools GitHub marks read-only run without a card. Anything that writes shows the usual approval card. `vsgrok.github.readOnly` offers only the read tools. The default toolsets are `context`, `repos`, `issues`, and `pull_requests`. Fewer toolsets means fewer definitions in the prompt. If you already have an MCP server named `github`, the connector is offered as `github-vsgrok`.

VSGrok calls GitHub itself, rather than handing the token to xAI. The Responses API can attach a remote MCP server, but it documents no per-call approval, so writes would run without you and the token would pass through xAI. The connector on grok.com is not part of the API. See [remote MCP](https://docs.x.ai/developers/tools/remote-mcp) and [xAI’s grok.com connectors](https://docs.x.ai/grok/connectors).

## Editor

- **Ghost text.** Inline completions are debounced (default 275 ms) and cancelled if you keep typing. Toggle them with **VSGrok: Toggle Inline Completions** or `vsgrok.inlineCompletions.enabled`. They always use the Chat Completions API, and they never read a secret-looking file.
- **Inline edit.** Select code, or put the cursor on a line, and press `Ctrl+I` (`Cmd+I` on macOS). Type the change. Grok streams a diff in the inline box. The file is not touched until you accept, so formatters and autosave never see a proposal. **Tab** in the editor, or `Ctrl+Enter` / `Cmd+Enter`, accepts it as one undoable edit. `Esc` rejects it. Reply in the same box to refine. Secret-looking files, and files outside the workspace, are refused. If another extension owns `Ctrl+I` (for example Copilot), run **VSGrok: Inline Edit with Grok** or rebind `vsgrok.inlineEdit`.
- **Right-click, Grok menu.** *Explain This*, *Write Tests for This*, *Fix Problems Here*, *Refactor…*, and *Add Comments to This* act on the selection, or on the enclosing symbol.
- **Lightbulb.** *Fix Problem with Grok* on a diagnostic. The fix comes back through the same approval card.
- **Palette commands** on a selection: Explain, Fix, Add Comments, and Write Tests stream into the chat. **Generate Commit Message** uses a structured `{subject, body}` response from the staged diff.

## Git and the terminal

In the Source Control title bar and the overflow menu:

- **Generate Commit Message** writes into the commit box from the staged diff. It follows your recent commit style and keeps the intent of any draft already in the box. If you type while it is writing, the message goes to the clipboard instead.
- **Review My Changes** sends the uncommitted diff (staged, unstaged, and small new files) to chat. Findings are grouped by severity, with `file:line` links that open the file.
- **Draft PR Description** summarises the branch against `origin/HEAD`, or `main` / `master`, including uncommitted work, and lets you copy it or save a Markdown file.

Secret files (`.env`, keys, credentials) are left out of every diff, and key-like strings are redacted. Git runs read-only, and only in a trusted workspace. VSGrok never commits, pushes, or opens a pull request. Use the GitHub connector if you want Grok to open one. You will still approve that call.

**Terminal.** When a command exits non-zero, a quiet **Ask Grok** item appears in the status bar. Shell integration is required. Ctrl+C and signal exits are ignored. There is no notification. One click sends the command, exit code, and the last 80 lines of output to chat, with Agent on, so the fix comes back through an approval card. ANSI codes are stripped and keys are redacted. Output is withheld entirely if the command names a secrets file. The item hides after a later success, when you click it, or after 3 minutes. Turn it off with `vsgrok.terminalHelper.enabled`.

## MCP servers

Add Model Context Protocol servers in `vsgrok.mcp.servers` (your user settings) or in `.vscode/vsgrok-mcp.json`. The workspace file is read only in a trusted workspace. Its shape is `{ "servers": { … } }`. `mcpServers` is accepted too. A workspace file cannot override a server of the same name from your user settings.

- **stdio:** `command`, `args`, `env`, `cwd`
- **Streamable HTTP:** `url` and `headers`. https only, except plain http on localhost
- `"disabled": true` skips a server

For GitHub, use [Connect GitHub](#github). Do not put a GitHub token in settings.

```json
{
  "vsgrok.mcp.servers": {
    "docs": { "url": "https://example.com/mcp" },
    "local": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"],
      "disabled": true
    }
  }
}
```

Servers defined by a repository, whether in that file or in workspace settings, do not start until you allow them once for that repo and that exact configuration, in **VSGrok: MCP Servers**. Changing the command, args, env, cwd, URL, or headers asks again. A shield button appears in the header while servers are waiting, and a warning button when one failed.

With Agent on, tools are offered as `mcp__<server>__<tool>`. Every call shows an approval card with the arguments. For servers you configured yourself, **Always allow** remembers that tool until the server’s config changes. It is not offered for repository servers, and Run task never auto-approves MCP tools. Results are capped and treated as untrusted data.

**VSGrok: MCP Servers** shows status and tools, reconnects, opens the config, and clears always-allow choices. Limits: 20 servers, 100 tools each, 20 seconds to connect, 120 seconds per call.

## xAI API

Chat, agent mode, and the palette commands use the [Responses API](https://docs.x.ai/developers/rest-api-reference/inference/responses) (`POST /v1/responses`). Client-side tools are `function_call` and `function_call_output` items ([function calling](https://docs.x.ai/developers/tools/function-calling)).

- **Conversation.** Follow-up turns send the new input plus `previous_response_id` ([chaining](https://docs.x.ai/developers/model-capabilities/text/generate-text#chaining-the-conversation)). VSGrok also keeps every returned item, including reasoning `encrypted_content`, so if a stored response has expired, a turn was stopped, or you set `vsgrok.responses.store` to `false`, the full local history is resent ([encrypted reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning#encrypted-reasoning-content)). There is no fixed message limit. Long chats are compacted with `POST /v1/responses/compact` once input reaches `vsgrok.responses.compactAtTokens` ([context compaction](https://docs.x.ai/developers/advanced-api-usage/context-compaction)).
- **Prompt cache.** Each chat sends `prompt_cache_key` and an `x-grok-conv-id` header so later turns can reuse xAI’s cache ([docs](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits)). The reply footer shows output, reasoning and cached tokens, context size, and cost from `usage.cost_in_usd_ticks`.
- **Web Search and X Search.** Header toggles (**Web**, **X**), or `vsgrok.tools.webSearch` and `vsgrok.tools.xSearch`. These are xAI server-side tools ([web](https://docs.x.ai/developers/tools/web-search), [X](https://docs.x.ai/developers/tools/x-search)). Searches show as activity lines. Sources come back as `url_citation` annotations ([citations](https://docs.x.ai/developers/tools/citations)) and are listed under the answer. xAI bills them separately.
- **Code execution.** `vsgrok.tools.codeExecution` adds `code_interpreter`, which runs Python in xAI’s sandbox, not on your machine ([docs](https://docs.x.ai/developers/tools/code-execution)).
- **Reasoning.** Summaries stream into a collapsible *Thought* line. `vsgrok.reasoningEffort` sets `reasoning.effort` (`low`, `medium`, `high`, `xhigh`). `default` omits the field. xAI’s own default is `high`. Not applied to inline completions. [Docs](https://docs.x.ai/developers/model-capabilities/text/reasoning).
- **Fallback.** `vsgrok.api` set to `chat` uses the legacy `/v1/chat/completions` path. No server-side tools, citations, or compaction. History stays local. Inline completions always use this path.

## Keyboard shortcuts

| Action | Windows and Linux | macOS |
| --- | --- | --- |
| Ask Grok | `Ctrl+Alt+G` | `Cmd+Alt+G` |
| Stop generating (chat focused) | `Esc` | `Esc` |
| Inline edit | `Ctrl+I` | `Cmd+I` |
| Accept inline edit | `Tab`, or `Ctrl+Enter` | `Tab`, or `Cmd+Enter` |
| Reject inline edit | `Esc` | `Esc` |

`Ctrl+I` and `Cmd+I` yield when another inline-chat provider is installed. Rebind `vsgrok.inlineEdit` if you want both.

## Settings

All of these live under **Settings, VSGrok**. The values below are the defaults.

### Model and requests

| Setting | Default | Notes |
| --- | --- | --- |
| `vsgrok.model` | `grok-4.7` | Chat, commands and agent ([models](https://docs.x.ai/docs/models)) |
| `vsgrok.api` | `responses` | `responses`, or `chat` for the legacy fallback |
| `vsgrok.baseUrl` | `https://api.x.ai/v1` | xAI API base URL |
| `vsgrok.temperature` | `0.3` | Sampling temperature |
| `vsgrok.maxTokens` | `8192` | Visible output tokens |
| `vsgrok.reasoningEffort` | `default` | `default` omits the field. Also `low`, `medium`, `high`, `xhigh` |
| `vsgrok.requestTimeoutSeconds` | `120` | Idle timeout, not a total cap |
| `vsgrok.responses.store` | `true` | Store responses on xAI for 30 days and chain by id |
| `vsgrok.responses.compactAtTokens` | `300000` | `0` turns compaction off |
| `vsgrok.theme` | `galactic` | `galactic` or `vscode` |

### Tools and context

| Setting | Default | Notes |
| --- | --- | --- |
| `vsgrok.tools.webSearch` | `false` | Also the **Web** header toggle. Billed by xAI |
| `vsgrok.tools.xSearch` | `false` | Also the **X** header toggle. Billed by xAI |
| `vsgrok.tools.codeExecution` | `false` | xAI sandbox, not your machine |
| `vsgrok.context.maxFileChars` | `1000000` | Per attached file |
| `vsgrok.index.enabled` | `true` | Local index for `find_relevant_files` |
| `vsgrok.index.exclude` | `[]` | Extra globs to keep out of the index |
| `vsgrok.index.maxFiles` | `5000` | Shallowest paths first |
| `vsgrok.testCommand` | *(empty)* | Empty detects npm, pnpm, yarn, bun, pytest, go test or cargo test. A workspace value is labelled on the card |
| `vsgrok.checks.offerAfterEdits` | `true` | **Re-run checks** after agent edits |

### Agent and tasks

| Setting | Default | Notes |
| --- | --- | --- |
| `vsgrok.agent.enabledByDefault` | `true` | |
| `vsgrok.agent.maxSteps` | `15` | Tool rounds per chat turn |
| `vsgrok.agent.autoApprove` | `none` | Run task only. User settings only |
| `vsgrok.agent.commandAllowlist` | test, lint and build commands | Exact match. User settings only |
| `vsgrok.agent.task.maxSteps` | `40` | |
| `vsgrok.agent.task.maxTokens` | `2000000` | `0` means no limit |
| `vsgrok.agent.task.maxCostUsd` | `2` | `0` means no limit. Ignored when xAI reports no cost |

### Editor, history and GitHub

| Setting | Default | Notes |
| --- | --- | --- |
| `vsgrok.inlineEdit.enabled` | `true` | `Ctrl+I` / `Cmd+I` |
| `vsgrok.inlineCompletions.enabled` | `true` | Ghost text while typing |
| `vsgrok.inlineCompletions.model` | *(chat model)* | Empty uses `vsgrok.model` |
| `vsgrok.inlineCompletions.debounceMs` | `275` | |
| `vsgrok.inlineCompletions.maxTokens` | `128` | |
| `vsgrok.terminalHelper.enabled` | `true` | Status-bar **Ask Grok** after a failed command |
| `vsgrok.history.enabled` | `true` | Save chats on this machine |
| `vsgrok.history.saveContext` | `false` | Also save attached files, tool output and diffs |
| `vsgrok.checkForUpdates` | `true` | Daily check of GitHub Releases |
| `vsgrok.diagnostics.enabled` | `false` | Local log. Never your key or your code |
| `vsgrok.mcp.servers` | `{}` | See [MCP servers](#mcp-servers) |
| `vsgrok.github.enabled` | `false` | User settings only. **Connect GitHub** turns it on |
| `vsgrok.github.readOnly` | `false` | Only GitHub’s read tools |
| `vsgrok.github.toolsets` | `context,repos,issues,pull_requests` | Comma-separated |
| `vsgrok.github.mcpUrl` | `https://api.githubcopilot.com/mcp/` | https only. Change for Enterprise or testing |

## Privacy

- Requests to xAI go from your machine to `vsgrok.baseUrl` (default `api.x.ai`). Nothing is proxied through a VSGrok server. There is no telemetry.
- What is sent: your messages, context you attach or that tools read, and, for inline completions, up to about 6,000 characters before the cursor and 2,000 after, in the current file. Turn inline completions off if you do not want code sent while you type.
- With `vsgrok.responses.store` on (the default), xAI stores each response for 30 days so a chat can continue by id. Turn it off to send `store: false`.
- Web Search, X Search and Code Execution run on xAI’s servers only when you enable them.
- The GitHub token, if you connect GitHub, goes only to GitHub.
- MCP servers you configure are contacted only for those tools, after you approve the call, or after **Always allow** on a server you configured yourself.
- Usage is billed to your xAI account. xAI’s handling of API data is governed by xAI’s own terms and privacy policy.

## Restricted Mode

In an untrusted workspace VSGrok does not run git, and it ignores `VSGrok.md`, `.vsgrok/rules.md` and `.vscode/vsgrok-mcp.json`. It also ignores workspace values of `vsgrok.testCommand`, `vsgrok.agent.autoApprove`, `vsgrok.agent.commandAllowlist` and `vsgrok.mcp.servers`. It still never reads `.env` or credential files. Agent edits and commands still need your approval.

## Development

```bash
pnpm install
pnpm run check-types && pnpm run lint
pnpm test                         # unit tests
xvfb-run -a pnpm run test:integration   # real VS Code; drop xvfb-run on a desktop
# includes a fake Responses API (streaming, function calls, chaining, compaction)
node esbuild.mjs                  # or --watch / --production
npx @vscode/vsce package --no-dependencies
```

CI runs the type-check, lint, unit tests and integration tests on every push and pull request. Release tags (`v*`) package the `.vsix` and attach it to a GitHub Release.

## Status

v0.15.0. Tested against a local fake xAI server and a GitHub MCP mock, and used live against the xAI API. Please [report issues](https://github.com/GalacticOrgOfDev/VSGrok/issues). For a bug, enable `vsgrok.diagnostics.enabled`, reproduce it, and run **VSGrok: Copy Diagnostics**.

[MIT](LICENSE) licensed. Copyright 2026 Galactic Organization of Development.
