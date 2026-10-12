# VSGrok demo script: a sample project from an empty folder

This is a 4–6 minute recording that shows VSGrok building a small, visual project from nothing. It covers a multi-file plan card, running tests, fixing a failure, image input, the cost meter and X Search.

**Project:** `palette`, a zero-dependency Node.js CLI that prints colour palettes as swatches in the terminal (`node palette.js "#3b82f6" --scheme triad`). It is small enough to build in a few turns, it looks good on camera, and pure functions make it easy to test with `node:test`.

---

## 0. Setup (before you hit record)

1. Install VSGrok 0.8.0 or later: **Extensions → … → Install from VSIX**, or let the self-update card do it.
2. Set your xAI API key: **VSGrok: Set API Key**.
3. Create an empty folder and open it: `mkdir palette-demo && code palette-demo`. Trust the workspace when asked; Agent edits need a trusted workspace for git and project rules.
4. Open the Grok chat in the sidebar. Check:
   - the model is **grok-4.7** (it accepts image input);
   - **Agent** is on, **𝕏** is on, and **Web** is optional.
5. Recording tips:
   - **New chat** (header) so the cost meter starts at zero.
   - Hide other notifications.
   - Zoom to 125% (`Ctrl+=`) so the cards are readable.
   - Have a terminal panel open.
6. Optional: take a screenshot of a colour palette you like (any website or a Dribbble shot) for step 6.

---

## 1. Ask for the project (≈30 s)

Type into the chat (Enter to send):

> Create a tiny zero-dependency Node.js CLI called **palette** in this empty folder. `node palette.js <hex> [--scheme complementary|triad|analogous|mono] [--count N]` prints coloured swatches in the terminal using 24-bit ANSI colours, with the hex code under each swatch. Put the colour maths in `src/color.js` (hexToHsl, hslToHex, schemes), the CLI in `palette.js`, tests in `test/color.test.js` using `node:test`, a `package.json` with `"test": "node --test test/"`, and a short README. Propose everything as one plan.

**What the viewer sees:**
- Activity lines appear first: *✓ Read workspace overview* (empty folder), then maybe *✓ Listed files*.
- Then the **plan card**: **"✦ Grok proposes a plan · 5 files"**, with the meta line **"5 new"**.
  - Rows: `package.json`, `src/color.js`, `palette.js`, `test/color.test.js`, `README.md`, each with **＋**, a `+N −0` count and **View diff**.
  - `package.json` carries a **⚠ changes scripts or CI that run commands** note. Point it out: VSGrok flags files that change what runs.
  - Focus is on **Select all**, not on Approve.

## 2. Review and approve (≈40 s)

1. Click **View diff** on `src/color.js`. VS Code's diff editor opens with the proposed content. Scroll briefly, then close it.
2. Untick `README.md` to show partial approval. The button changes to **Approve selected (4/5)**.
3. Tick it again (**Approve all (5)**) and click it.

**Expected:**
- The card resolves to **✓ Approved**, and the files appear in the Explorer.
- A **✓ Plan applied** card shows the five paths with **Undo plan** and **Re-run checks**.
- Optional beat: click **Undo plan**. The files disappear and the card reads **↶ Plan undone**. Then ask Grok "apply it again" and approve. Skip this if you're short on time.

## 3. Run it (≈20 s)

In the terminal: `node palette.js "#3b82f6" --scheme triad`. You should see three coloured blocks with their hex codes. This is the visual money shot, so hold it for a second.

## 4. Run the tests through Grok (≈40 s)

On the Plan applied card, click **Re-run checks**, or type:

> Run the tests.

**Expected:**
- *Running the tests…* appears, followed by the **command approval card**: **⚡ Grok wants to run a command**, `npm test`.
- Under it: **This runs:** `test: node --test test/`, and **From package.json scripts.test · repo-controlled**. Mention that you can see exactly what runs.
- Click **Run**. Grok reports `exit code 0`, "All tests passed", and the number of tests.

## 5. Break something and let Grok fix it (≈60 s)

1. Open `src/color.js` and introduce a bug, for example change the hue rotation in the triad scheme from `120` to `100`, or make `hslToHex` forget to pad single-digit hex values (`.padStart(2, '0')` → remove it). Save.
2. Ask:

   > Run the tests again and fix whatever fails.

**Expected:**
- Approve the `npm test` card. The output shows a failure.
- Grok's reply lists the failure as **`test/color.test.js:NN`** with the assertion message. VSGrok parses failures into file:line.
- Grok proposes the fix as an **edit card** (one file, "✦ Grok wants to edit a file") or a one-row plan card. Click **View diff** to show the one-line change, then **Approve**.
- Grok re-runs the tests (approve again) and gets **all passing**.
- A **🧪 Re-run checks** button appears under the reply if Grok edited without re-running.
- Optional: right-click inside `hexToHsl` and choose **Grok → Explain This** to show the context-menu actions.

## 6. Show it a picture (≈40 s)

1. Paste the palette screenshot into the chat input (`Ctrl+V`). A thumbnail chip appears above the input; hover it, and note the **×** that removes it.
2. Type:

   > Add a `--from-image` example to the README: describe the palette in this screenshot as hex codes and show the command that reproduces it.

**Expected:**
- The message shows the thumbnail. Grok reads the image and answers with the hex codes.
- Grok proposes a README edit; approve it.
- If you had switched to a model without image input, an in-chat note would offer **Switch to grok-4.7** instead of sending.

## 7. X Search question (≈30 s)

With **𝕏** on in the header, type:

> What are people on X saying this week about terminal colour palettes or truecolor support? Give me three posts with links.

**Expected:**
- An *X search* activity line appears, followed by the answer with **citations listed as links** under the reply.
- Note in voice-over that X Search runs on xAI's servers and is billed by xAI per call.

## 8. Wrap up on the cost meter (≈15 s)

Point at the header meter, e.g. **"48k tok · $0.09"**. Hover it for the breakdown: turns, input (cached), output (reasoning), and the cost **as reported by xAI**. Click **New chat** to show that it resets.

---

## Troubleshooting while recording

| Symptom | Fix |
|---|---|
| No plan card, just code blocks | Agent is off: toggle **Agent** in the header and ask again ("propose it as a plan"). |
| `npm test` card shows a different command | You have `vsgrok.testCommand` set; clear it for the demo. |
| "can't read images" note | Pick **grok-4.7** (or click **Switch to …** on the note). |
| Cost meter shows tokens but no `$` | The API didn't report a cost for those turns; VSGrok never estimates prices. |
| Deletes fail on Linux without a desktop trash | Set `files.enableTrash: false` (only matters if you show Undo of a delete). |

## Not included

There is no **VSGrok: New Sample Project** command in 0.8.0. It was optional, and typing the prompt on camera is the better demo anyway. It would also add a code path that writes files without the plan card.
