# HyperFrames Starter

The smallest working **Ableton Live Extension × HyperFrames** integration: right-click a MIDI clip
→ **Render Clip to Video…** → a music-locked MP4 (the clip's notes scrolling past a playhead) is
rendered and imported back into your Set.

It's a scaffold, not a product — ~10 small, commented files that demonstrate the whole loop so you
don't start from a blank folder. For the full story (both render modes, the AI "feedback video",
and every wall we hit), see the [build guide](../docs/BUILDING-HYPERFRAMES-EXTENSIONS.md)
and the complete [`hyperframes-feedback`](../hyperframes-feedback/) extension.

## The recipe

```
Ableton Live  ──▶  Extensions SDK  ──▶  Timeline  ──▶  HyperFrames  ──▶  MP4 → Set
  a MIDI clip       liveAdapter.ts      main.ts       composition.html    render.ts
```

## Prerequisites

- **Node 20+**
- **Ableton Live 12.4.5+ Suite (Beta)** with the **[Extensions SDK](https://ableton.github.io/extensions-sdk/)**
  (a private beta from the Ableton beta program — not included here).
- The SDK tarballs, referenced by `package.json` at `../../extensions-sdk-1.0.0-beta.0/*.tgz`.
  Put the SDK bundle beside this repo, or edit that path. Without it, `npm install` won't resolve the SDK.
- *(Optional, for rendering inside an installed extension)* a **[HeyGen](https://platform.heygen.com)**
  API key for HyperFrames Cloud.

## Quick start (dev host)

```bash
cd hyperframes-starter
npm install
npm run check     # build + offline load-check (no Ableton needed)
npm run run       # build + launch the dev host (Developer Mode ON in Live)
```

Then in Live: right-click a MIDI clip → **Render Clip to Video…**. On the dev host this renders
**locally** via the `hyperframes` CLI (needs Chrome + ffmpeg on PATH) — no key required.

## Rendering in a real install

An installed `.ablx` runs under Live's sandbox, where local rendering is impossible (the Node
permission model is inherited by child processes, so the `hyperframes` CLI can't run). Set a
**HeyGen API key** and it renders in the cloud instead:

```bash
export HEYGEN_API_KEY=hg_...        # or write it to <storageDir>/heygen-key
```

`render()` uses cloud when a key is present, local otherwise. Why this is necessary is the crux of
the [build guide](../docs/BUILDING-HYPERFRAMES-EXTENSIONS.md).

## File map

| File | What it does |
| --- | --- |
| `src/main.ts` | Entry: `activate()`, one command, the render session. |
| `src/liveAdapter.ts` | **The only file that imports the SDK.** Selection + note reading, `num()` BigInt coercion, host services. |
| `src/render.ts` | Stage the composition + data; local and HeyGen-cloud render. |
| `template/composition.html` | The HyperFrames composition — a canvas driven by the `hf-seek` event. Edit this to change the visuals. |
| `src/polyfill.ts` · `src/webglobals.ts` | Restore the web globals the host strips (imported first). |
| `tools/build.mjs` | esbuild bundle + polyfill banner; inlines the composition via the `.html` text loader. |
| `tools/load-check.cjs` | Offline "does it load under the stripped-globals host?" check. |

## Make it yours

- **Different visuals:** edit `template/composition.html`. Everything must be a pure function of the
  seek time `t` (no `Date.now()`, no `Math.random()`), or frames won't be reproducible.
- **More data:** read more from the clip/track in `liveAdapter.ts` (devices, color, markers…) and add
  it to the `Timeline`. Coerce every integer through `num()`.
- **A GSAP/DOM composition instead of canvas:** register one paused `gsap.timeline({paused:true})` on
  `window.__timelines['main']` — the renderer seeks that. (Canvas uses `hf-seek`; DOM uses GSAP.)
