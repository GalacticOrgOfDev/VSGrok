# VSGrok

An AI coding assistant for VS Code that talks only to the **xAI Grok API**. Bring your own xAI API key; no other AI provider is contacted.

## Features

- **Streaming chat sidebar** — markdown rendered as it streams, Stop button (or `Esc`), regenerate, copy, per-reply model / token / latency footer.
- **Code-block actions** — every code block has **Copy**, **Insert** (at cursor / replace selection) and **Apply as diff** (opens a diff of the target file vs. Grok's proposal; nothing is written until you click **Approve** on the card in chat). A fence like ` ```ts path=src/a.ts ` targets that file.
- **Context chips** — attach the current file, the current selection (shown automatically, click to pin), workspace files via quick pick, or files dragged from the Explorer. `@file` and `@workspace` in a message also still work. Attached files are sent in full up to `vsgrok.context.maxFileChars` (default 1,000,000 characters; grok-4.7 has a 500k-token context window).
- **Workspace tools in every chat** — Grok can always call `get_workspace_overview` (folder, top-level tree, package.json/README summary, open editors, git branch/status), `read_file`, `list_files` and `search_workspace` (read-only, run directly, restricted to the workspace). It keeps calling tools until it has an answer (cap: `vsgrok.agent.maxSteps`), and each call shows in the chat as a collapsible line (e.g. *✓ Read src/a.ts*) with its output.
- **Agent** (header toggle, on by default, or *VSGrok: Start Agent Task*) adds the write tools:
  - `propose_edit` — applied only after you click **Approve**,
  - `run_command` — runs in the workspace root only after you click **Run**.
- **Approvals in the chat** — every permission request (commands, agent edits, *Apply as diff*, *Fix with Grok*) appears as an inline card in the chat with **Approve/Run** and **Deny** (edits also have **View diff**, which opens VS Code's diff editor; the decision is still made in the chat). No pop-ups or notifications. Stopping, starting a new chat or closing the panel counts as Deny.
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
pnpm test            # unit tests incl. a fake Responses-API server (streaming events, function calls, chaining, compaction)
node esbuild.mjs     # or --watch / --production
npx @vscode/vsce package --no-dependencies
```

## Install and updates

Download `vsgrok-X.Y.Z.vsix` from [GitHub Releases](https://github.com/GalacticOrgOfDev/VSGrok/releases) and run **Extensions: Install from VSIX…**. After that VSGrok updates itself: once a day (setting `vsgrok.checkForUpdates`, default on) it checks the latest GitHub release and, if it is newer, shows an **Update now** card in the chat that downloads and installs the `.vsix`, then offers **Reload Window**. Run **VSGrok: Check for Updates** anytime. Marketplace publishing (for VS Code's built-in auto-update) is planned; see [docs/PUBLISHING.md](docs/PUBLISHING.md).

## Status

v0.5.1. Unit-tested against a local fake server and used live against the xAI API (see the [PoliSim example](docs/examples/polisim-workspace-analysis.md)); please report issues.
