# Changelog

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
