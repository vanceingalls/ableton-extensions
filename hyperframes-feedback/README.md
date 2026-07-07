# HyperFrames Feedback — an AI project review, as a video, inside Ableton Live

Select a range across your tracks in Arrangement view → right-click → **Create
Feedback Video from Selection…**. Claude reviews what you selected, *designs* a
HyperFrames composition presenting that review, and the rendered MP4 is imported
straight back into your Set. Select all tracks for a whole-project review, or a
range for one section.

```
Ableton Live (Extension, TS/Node, run-once command)
  summarize the selection (tracks, note counts, devices, register, sections)
        │
        ▼
Anthropic — Claude reviews the project → structured JSON (score + points)
  Claude authors a HyperFrames composition of the review → lint → fix → repeat
        │
        ▼
HyperFrames Cloud (HeyGen) renders the composition → MP4
        │
        ▼
imported back into the Live Set
```

Two API keys are needed and are entered in Live (stored locally, never in the
repo): **Anthropic** (the review + authoring) and **HeyGen** (HyperFrames Cloud
rendering) — separate accounts, separate billing. Manage them any time via
right-click → **HyperFrames: Manage API Keys…**.

## File map

| Path | What it is |
| --- | --- |
| `src/main.ts` | Extension entry: `activate()`, the feedback session, the key dialogs. |
| `src/liveAdapter.ts` | **The only file that touches the Extensions SDK.** Selection + project summary, `num()` BigInt coercion, host services. |
| `src/feedback.ts` | Anthropic call: the review as validated JSON (structured output). Key persistence. |
| `src/composer.ts` | Claude authors the HyperFrames composition, then `hyperframes lint` → fix loop. |
| `src/render.ts` | HyperFrames Cloud upload/submit/poll/download; local render for the dev host. |
| `src/feedbackTypes.ts` | `ProjectSummary`, `FeedbackReport`, and the JSON Schema for structured output. |
| `src/polyfill.ts` · `src/webglobals.ts` | Restore the web globals Live's host strips (imported first). |
| `templates/project-feedback/` | The fixed fallback composition (used only if Claude's authored one can't be made lint-clean). |
| `tools/build-extension.mjs` | esbuild bundle + polyfill banner; inlines templates via `gen-template-assets.mjs`. |
| `tools/load-check.cjs` | Offline "does it load under the stripped-globals host?" check. |
| `DECISIONS.md` | Decision log. |

## Build & run

```bash
export PATH="$HOME/.local/node/node-v24.18.0-darwin-arm64/bin:$PATH"  # if Node is user-local

npm install            # needs the Ableton SDK tarballs (see the repo README)
npm run typecheck
npm run build:ext      # bundle to dist/extension.js
node tools/load-check.cjs   # offline load check (no Ableton needed)
npm run package:ext    # produce dist/hyperframes-feedback.ablx to install in Live
npm run run:ext        # or launch the dev host (Developer Mode ON in Live)
```

## Notes

- **Rendering in a real install requires a HeyGen key.** Live's managed host
  sandboxes Node child processes, so the local `hyperframes` CLI can't run there —
  the shipped path is HyperFrames Cloud. Local render works only on the dev host.
- **Authored compositions follow the HyperFrames conventions** (one paused GSAP
  timeline on `window.__timelines['main']`, determinism rules) — see the build
  guide in `../docs/BUILDING-HYPERFRAMES-EXTENSIONS.md`.
- All SDK access is quarantined in `src/liveAdapter.ts`; integers are coerced
  through `num()` because the bindings return BigInt where the types say number.
