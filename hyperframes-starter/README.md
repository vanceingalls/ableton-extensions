# HyperFrames Feedback Starter

The smallest working version of the [feedback extension](../hyperframes-feedback/): right-click an
arrangement selection → **Create Feedback Video from Selection…** → Claude reviews the selection and
the review is rendered into a short video, imported back into your Set.

It exists to show the two API wire-ups clearly, in as little code as possible:

- **Anthropic** (`src/feedback.ts`) — the review. How to call Claude with a **JSON Schema** so the
  response is structured (score + points), streamed, with the `refusal` check.
- **HyperFrames Cloud / HeyGen** (`src/render.ts`) — the render. The full upload → submit → poll →
  download flow, and **why a HeyGen key is required**: Live's managed host sandboxes Node child
  processes, so the local `hyperframes` CLI can't run in a real install — rendering has to be a
  network call.

Unlike the full extension, the composition here is a **fixed** template (`template/composition.html`),
not authored per-project by the model. That keeps the starter focused on the pipeline; the
"Claude designs the video" step is the advanced move you can add next (see the full extension).

## The loop

```
Ableton Live ──▶ Extensions SDK ──▶ Anthropic ──▶ HyperFrames Cloud ──▶ MP4 → Set
 selection       getProjectSummary   review (JSON)  render (HeyGen)      importIntoProject
```

## Prerequisites

- **Node 20+**
- **Ableton Live 12.4.5+ Suite (Beta)** with the **[Extensions SDK](https://ableton.github.io/extensions-sdk/)**
  (a private beta from the Ableton beta program — not included here). The SDK tarballs are referenced
  by `package.json` at `../../extensions-sdk-1.0.0-beta.0/*.tgz`; place the SDK bundle beside the repo
  or edit that path.
- An **[Anthropic](https://console.anthropic.com)** API key (the review).
- A **[HeyGen](https://platform.heygen.com)** API key (HyperFrames Cloud rendering). Both are entered
  in Live on first use and stored locally; or set `ANTHROPIC_API_KEY` / `HEYGEN_API_KEY` in the env.

## Quick start

```bash
cd hyperframes-starter
npm install
npm run check     # build + offline load-check (no Ableton needed)
npm run run       # build + launch the dev host (Developer Mode ON in Live)
```

Then in Live: select a range across tracks in Arrangement view → right-click → **Create Feedback
Video from Selection…**. It prompts for the two keys on first use. With a HeyGen key it renders in the
cloud (works in an installed `.ablx`); without one it falls back to the local CLI, which only works on
the dev host.

## File map

| File | What it is |
| --- | --- |
| `src/main.ts` | The whole loop: read → review → render → import, plus the key prompts. |
| `src/liveAdapter.ts` | **The only file that imports the SDK.** Selection + `getProjectSummary`, host services. |
| `src/feedback.ts` | **API #1 — Anthropic.** Structured review + key storage. |
| `src/render.ts` | **API #2 — HyperFrames Cloud.** Upload/submit/poll/download (+ local for the dev host). |
| `src/feedbackTypes.ts` | `ProjectSummary`, `FeedbackReport`, and the JSON Schema for structured output. |
| `template/composition.html` | The fixed HyperFrames composition (a paused GSAP timeline). Edit this to change the look. |
| `template/gsap.txt` | GSAP, inlined into the bundle and written next to the composition at render time. |
| `src/polyfill.ts` · `src/webglobals.ts` | Restore the web globals the host strips (imported first). |
| `tools/build.mjs` · `tools/load-check.cjs` | esbuild bundle (with the text loaders) + offline load check. |

## Make it yours

- **Different look:** edit `template/composition.html`. Everything must be a pure function of the
  timeline's seek time — one paused `gsap.timeline({paused:true})` on `window.__timelines['main']`, no
  `Date.now()`/`Math.random()` — or frames won't be reproducible.
- **Richer review:** extend the prompt and schema in `feedback.ts` / `feedbackTypes.ts`.
- **Let the model design the video:** instead of the fixed template, have Claude author the composition
  and lint-fix it before rendering — that's what the full [`hyperframes-feedback`](../hyperframes-feedback/)
  extension does.
