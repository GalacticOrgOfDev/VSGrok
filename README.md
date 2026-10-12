# VSGrok

An AI coding assistant for VS Code that talks only to the **xAI Grok API**. Bring your own xAI API key; no other AI provider is contacted.

## Features

- **Streaming chat sidebar** — markdown rendered as it streams, Stop button (or `Esc`), regenerate, copy, per-reply model / token / latency footer.
- **Code-block actions** — every code block has **Copy**, **Insert** (at cursor / replace selection) and **Apply as diff** (opens a diff of the target file vs. Grok's proposal; nothing is written until you click **Accept**). A fence like ` ```ts path=src/a.ts ` targets that file.
- **Context chips** — attach the current file, the current selection (shown automatically, click to pin), workspace files via quick pick, or files dragged from the Explorer. `@file` and `@workspace` in a message also still work. Large files are truncated at 100k characters.
- **Workspace tools in every chat** — Grok can always call `get_workspace_overview` (folder, top-level tree, package.json/README summary, open editors, git branch/status), `read_file`, `list_files` and `search_workspace` (read-only, run directly, restricted to the workspace). It keeps calling tools until it has an answer (cap: `vsgrok.agent.maxSteps`), and each call shows in the chat as a collapsible line (e.g. *✓ Read src/a.ts*) with its output.
- **Agent** (header toggle, on by default, or *VSGrok: Start Agent Task*) adds the write tools:
  - `propose_edit` — always shown as a diff and applied only if you accept,
  - `run_command` — runs in the workspace root only after you confirm a modal prompt.
- **Grok reasoning & prompt caching** — `vsgrok.reasoningEffort` sets xAI's `reasoning_effort` (low / medium / high / xhigh; [docs](https://docs.x.ai/developers/model-capabilities/text/reasoning)). If the API streams reasoning text it shows as a collapsible *Thought* line. Each chat sends an `x-grok-conv-id` header so follow-up turns reuse xAI's prompt cache ([docs](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits)); reasoning and cached token counts appear under each reply.
- **Inline ghost-text completions** — debounced (default 275 ms), cancelled when you keep typing, toggle with *VSGrok: Toggle Inline Completions* or `vsgrok.inlineCompletions.enabled`.
- **Commands** — Explain / Fix / Add Comments / Write Tests on a selection (streamed into chat); **Generate Commit Message** from the staged diff (button in the Source Control title bar); **Fix with Grok** Quick Fix on diagnostics (lightbulb), applied through the same diff + Accept flow.

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
| `vsgrok.baseUrl` | `https://api.x.ai/v1` | OpenAI-compatible endpoint |
| `vsgrok.temperature` / `vsgrok.maxTokens` | `0.3` / `8192` | |
| `vsgrok.requestTimeoutSeconds` | `120` | Idle timeout |
| `vsgrok.agent.enabledByDefault` / `vsgrok.agent.maxSteps` | `true` / `15` | Read-only workspace tools are always on; Agent adds edits (diff + Accept) and commands (confirm) |
| `vsgrok.inlineCompletions.*` | enabled, model = chat model, 275 ms, 128 tokens | |

## Privacy

- Requests go directly from your machine to the configured base URL (default `api.x.ai`). There is no VSGrok server and no telemetry.
- What is sent: your messages, attached context (files/selections you attach, or that agent tools read), and for inline completions up to ~6,000 characters before and ~2,000 after the cursor in the current file. Turn inline completions off if you don't want code sent while typing.
- xAI's handling of API data is governed by xAI's own terms and privacy policy.
- Usage is billed to your xAI account.

## Development

```bash
pnpm install
pnpm run check-types && pnpm run lint
pnpm test            # unit tests (SSE parsing, tool-call assembly, completion cleanup)
node esbuild.mjs     # or --watch / --production
npx @vscode/vsce package --no-dependencies
```

## Status

v0.3.0. Built and unit-tested without a live API key; please report issues.
