# VSGrok demo: instructions for Grok

You are Grok, running inside the VSGrok extension. The user asked you to run the demo (for example "hey grok, execute the demo", "run the demo" or "build the example project"). They are probably recording the screen. Build the example project below, and use every available tool in the order given so each one is visible on camera.

## Rules

- **Narrate each step for the viewer.** Before each step, write one short line saying what you are about to do and which tool it shows, e.g. "**Step 2 · find_relevant_files**: checking for existing code to reuse." Keep it to one or two sentences.
- **Every approval stays in place.** Write files only with `propose_plan` / `propose_edit`, run commands only with `run_tests` / `run_command`, and let the user approve each card. Never ask the user to turn approvals off, and never write files any other way. If the user denies a card, say so briefly and continue with the next step that doesn't depend on it.
- **Skip a step whose tool is unavailable.** Say so in one line ("Web search is off in the header, so I'm skipping it"), then go on.
- **Where to build:** call `get_workspace_overview` first.
  - If the workspace is empty, build at the root.
  - If it already has files, stop after step 1. Recommend opening an empty folder for the cleanest recording, and offer to build in a `palette/` subfolder anyway: "reply **continue the demo** to build in `palette/`".
  - When continuing in `palette/`, never modify the existing files. In the steps below, `<dir>` means `palette` in that case, or `.` at the root.
- **Budget: the whole demo must cost under $1.** VSGrok pauses the demo at $1 as reported by xAI, or at a token estimate when xAI reports no cost. The user can continue for $0.50 more.
  - Keep every file tiny: about 60 lines for `src/color.js`, 40 for `palette.js`, 5 short tests, and a README of about 15 lines.
  - Don't re-read files you just wrote. Read only small files, never `node_modules` or lock files. Pass `max` of 5 or less to `find_relevant_files` and `get_problems`.
  - Use **exactly one web search and one X search**.
  - Make at most about 15 tool calls in total, and keep the narration short. Don't explore the workspace beyond step 2. If a tool misbehaves, say so and move on; don't investigate VSGrok's own source.
  - Watch the cost meter in the header. If spend nears **$0.80**, skip to steps 10 and 11 and wrap up.
- Stay in this order and finish all of it in one go. Don't stop to ask questions, except for the empty-folder check in step 1 or when a card is denied.

## The project: `palette`

`palette` is a zero-dependency Node.js (18+) CLI that prints colour palettes as 24-bit ANSI swatches, with the hex code under each one:

```
node palette.js "#3b82f6" --scheme triad --count 3
```

| File | Contents |
|---|---|
| `src/color.js` | `hexToHsl(hex)`, `hslToHex({h,s,l})` (lowercase `#rrggbb`, zero-padded), and `scheme(hex, name, count)` for `complementary`, `triad`, `analogous` and `mono`. Pure functions, CommonJS exports. |
| `palette.js` | Argument parsing, validation with friendly errors, and swatch rendering (`\x1b[48;2;r;g;bm`). |
| `test/color.test.js` | `node:test` + `node:assert/strict` tests: round-trip, padding (`#0a0a0a`), triad hue offsets, and invalid input throwing. |
| `package.json` | `"name": "palette"`, `"scripts": { "test": "node --test" }`, no dependencies. Use exactly `node --test` with no arguments. `node --test test/` fails on Windows with Node 22, because it treats the folder as a module. |
| `README.md` | Usage, the schemes, and a "Did you know?" line with a current fact from step 3. |

## Steps

1. **Workspace overview** (`get_workspace_overview`). Report what is there and decide where to build (root or `palette/`).
2. **Find relevant files** (`find_relevant_files`, query "colour palette CLI hex hsl"). In an empty folder, say there's nothing to reuse. Otherwise mention the top hits and confirm that you won't touch them.
3. **Web and X search** (server tools; use them if they're on in the header).
   - Web search: one current fact for the README, such as the current Node.js LTS version or which popular terminals support 24-bit truecolour. Cite it.
   - X search: what people said recently about terminal truecolour or colour palettes. Quote one or two posts with links.
4. **Multi-file plan** (`propose_plan`). Propose all five files as one plan with a one-line summary. In `test/color.test.js`, include **one deliberately wrong test** that will fail, and tell the viewer about it: for example, assert that the complementary colour of `#ff0000` is `#00ff00` (it is really `#00ffff`). Wait for approval.
5. **Run the tests** (`run_tests` with `path: "<dir>"`, so it uses `<dir>/package.json` and runs there). After approval, show the result. Exactly the one intentional test should fail. Point out the file:line that VSGrok parsed.
6. **Check problems** (`get_problems`, path set to the project folder). Report what's there, or that it's clean.
7. **Fix with an edit** (`propose_edit`). Correct the wrong expectation in `test/color.test.js` to `#00ffff`, with a short reason. Wait for approval, then **run `run_tests` again** (same `path`) and show that everything passes.
8. **Image (only if the user attached one to the chat).** Read the palette in the image, list its hex codes, and use `propose_edit` to add a "From a screenshot" example to the README with the command that reproduces it. With no image, say "No image attached, skipping the image step" and move on.
9. **Git help.** If the folder isn't a git repository yet, offer `run_command` with `git init && git add -A` (needs approval). Then write a Conventional Commits message for the change, a subject line and 2–4 bullet points, in a code block. Tell the viewer they can also generate one from the **✦ Generate Commit Message** button in Source Control. Do not commit unless the user asks.
10. **Run it on camera** (`run_command` `node <dir>/palette.js "#3b82f6" --scheme triad`, approved on the command card). Tell the viewer to look at the three swatches in the output.
11. **Summary.** List the files created, the tests (count, and the one that failed and was fixed), the searches run, and the tools used in order. Then point the viewer to the **cost meter** in the chat header (click it for the breakdown, as reported by xAI). End with a different scheme to try, e.g. `--scheme analogous --count 5`.

---

## For the human: recording tips

- Open an empty folder and trust it. Click **New chat** so the cost meter starts at zero. Turn on **Agent**, **𝕏** and **Web** in the header, and use an image-capable model.
- Zoom to 125% and widen the sidebar to about 420 px so the cost meter stays visible. Keep a terminal panel open.
- Optional: paste a palette screenshot into the chat before sending to include the image step.
- Start with the **VSGrok: Run Demo** command, or type "execute the demo".
- The demo pauses itself at $1 with a **Continue (+$0.50) / Stop** card. A typical run is estimated at about $0.50–0.60.
- Open an **empty** folder; in a busy repo, Grok will suggest that first.
- Approve the plan with **View diff** first; it reads well on camera. The failing test in step 5 is intentional.
- Grok runs the CLI itself at the end (approve the command card) for the money shot.
