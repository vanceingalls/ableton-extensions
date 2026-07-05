# Clip2Video — HyperFrames inside Ableton Live

Right-click any clip, track, or the arrangement in Live → **Render Video…** → get a
deterministic MP4 whose visuals are frame-locked to the music, because timing comes
from the Set itself (tempo, MIDI, automation, markers), not from audio analysis.

```
Ableton Live (Extension, TS/Node)
  reads tempo map, notes, automation, markers → timeline.json
  bounces the selection                       → audio.wav
        │
        ▼
HyperFrames (local CLI, cloud later)
  template (HTML/canvas) + timeline.json + audio.wav
  virtual clock seeks; every pixel is a pure function of time
        │
        ▼
output.mp4 — note-accurate by construction
```

## Layout

| Path | What it is |
| --- | --- |
| `schema/timeline.schema.json` | **The contract.** Full JSON Schema for the exported timeline. |
| `src/types.ts` | TS types mirroring the schema. |
| `src/liveAdapter.ts` | The ONLY file that touches the Extensions SDK. All placeholders live here. |
| `src/exporter.ts` | Assembles `timeline.json` from the adapter. Includes tempo-map beat↔seconds math. |
| `src/render.ts` | Spawns the HyperFrames CLI on the bundle. |
| `src/main.ts` | Extension entry: context menu → panel → export → render. |
| `panel/index.html` | The in-Live panel UI (style, aspect, automation→visual mappings). |
| `templates/pulse-waveform/index.html` | Working template: canvas visuals as a pure function of `t`. |
| `examples/timeline.example.json` | Sample data — develop templates without Live. |

## Develop the template without Live

```bash
cd templates/pulse-waveform
cp ../../examples/timeline.example.json ./timeline.json
# drop any short WAV next to it as audio.wav
npx serve .   # open in a browser; the rAF preview loop runs
```

The template's one rule: **every pixel is a pure function of time.** No rAF state,
no accumulators, no `Math.random()` at draw time. That's what lets HyperFrames'
virtual clock produce identical, note-accurate frames on every render.

## What must be verified against the real APIs

This skeleton was written against the *announced* capabilities of both systems;
two integration surfaces need checking before anything runs:

**Ableton Extensions SDK (public beta since June 2, 2026 — moving target):**
1. Programmatic audio bounce (`liveAdapter.bounceAudio`). If the beta doesn't
   expose it, the panel already has a manual-export fallback path.
2. Automation lane enumeration + breakpoint read (`liveAdapter.getAutomation`).
   If only value-at-time queries exist, sample at 1/16-note resolution.
3. Context-menu registration and panel messaging APIs in `main.ts`.
   Check the SDK repo/docs and Ableton's Discord #extensions space.

**HyperFrames:**
4. Exact CLI flags in `render.ts` and the template seek-hook convention at the
   bottom of `templates/pulse-waveform/index.html` (currently exposes
   `window.renderFrame(seconds)`). You know the real conventions — adjust there.

## Roadmap after MVP

- `falling-notes` and `typography` templates (panel buttons already exist)
- Tempo-ramp support in the template (mirror `exporter.beatsToSeconds`)
- Track/arrangement scope: per-stem visuals using `tracks[]` + `trackId` on notes
- HyperFrames Cloud path in `render.ts` for users without local Node tooling
- Ship the timeline schema as a HyperFrames skill so coding agents can generate
  custom templates from "make me a video for this clip, moody and glitchy"
