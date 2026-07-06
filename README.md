# HyperFrames Feedback — HyperFrames inside Ableton Live

Right-click a clip or track → **Render Video…**, or an arrangement selection →
**Create Feedback Video from Selection…** (an AI review of what you selected).
Renders build from your Set's own notes, tempo, colors, and structure into a
deterministic MP4 whose visuals are frame-locked to the music, because timing
comes from the Set
itself (tempo, MIDI, automation, markers), not from audio analysis.

```
Ableton Live (Extension, TS/Node, run-once command)
  reads tempo map, notes, automation, markers → timeline.json
  bounces the selection                       → audio.wav
        │ modal studio dialog (preview, mappings, refresh-from-Set)
        ▼
HyperFrames Cloud (local CLI for template dev)
  template (HTML/canvas) + timeline.json + audio.wav
  virtual clock seeks; every pixel is a pure function of time
        │
        ▼
output.mp4 — note-accurate by construction
```

**Continuing this work?** Read `AGENT_INSTRUCTIONS.md` (the spec) first, then
`PLAN.md` (current state + next steps). `DECISIONS.md` is the decision log.

## Layout

| Path | What it is |
| --- | --- |
| `schema/timeline.schema.json` | **The contract.** Full JSON Schema for the exported timeline. |
| `src/types.ts` | TS types mirroring the schema. |
| `src/timebridge.ts` | **The one time-conversion module** (beats↔seconds↔frames, warp markers). |
| `src/liveAdapter.ts` | The ONLY file that touches the Extensions SDK (incl. dialogs). Placeholders live here. |
| `src/exporter.ts` | Assembles `timeline.json` from the adapter via TimeBridge. |
| `src/studioProtocol.ts` | Versioned Node ↔ WebView message types for the studio dialog. |
| `src/render.ts` | HyperFrames invocation: cloud (shipped) + local CLI (template dev). |
| `src/main.ts` | Extension entry: context menu → run-once studio session → cloud render. |
| `panel/index.html` | Old prototype panel — becomes the studio dialog in M3 (see PLAN.md). |
| `templates/pulse-waveform/` | Working template (`index.html` + `template.json` manifest + TimeBridge bundle). |
| `examples/timeline.example.json` | Sample data — develop templates without Live. |
| `test/` | Vitest suites: TimeBridge math + exporter/schema validation. |
| `PLAN.md`, `DECISIONS.md` | Continuation plan; decision log + open VERIFY items. |

## Develop without Live

```bash
# Node is user-local on this machine:
export PATH="$HOME/.local/node/node-v24.18.0-darwin-arm64/bin:$PATH"

npm test                      # TimeBridge + exporter/schema suites
npm run typecheck
npm run build:template-lib    # rebuild templates/*/timebridge.browser.js
                              # REQUIRED after any src/timebridge.ts change

# Template preview in a normal browser (WebAudio-clocked, click to play):
cd templates/pulse-waveform
node ../../tools/make-fixture.mjs .   # matched audio.wav + timeline.json (124 BPM kicks)
npx serve .

# Full local render (needs Chrome + ffmpeg/ffprobe; static builds live in ~/.local/bin):
# stage a work dir with timeline.json + audio.wav, then renderLocal() drives
# `npx hyperframes render` — see src/render.ts. Verified deterministic
# (identical frame md5s across runs) on 2026-07-05.
```

The template's one rule: **every pixel is a pure function of time.** No rAF state,
no accumulators, no `Math.random()` at draw time. That's what lets HyperFrames'
virtual clock produce identical, note-accurate frames on every render.

## What must be verified against the real APIs

This code was written against the *announced* capabilities of both systems.
The full list of open integration questions is the **VERIFY table in
`DECISIONS.md`** (8 items: audio bounce scope, automation/tempo/warp read
access, WebView engine, dialog modality, MP4 delivery path, and the
HyperFrames Cloud API + template seek-hook convention — the template currently
exposes `window.renderFrame(seconds)`). All SDK guesses are quarantined in
`src/liveAdapter.ts`; both HyperFrames call sites are marked in `src/render.ts`.

## Roadmap after MVP

- `falling-notes` and `typography` templates (panel buttons already exist)
- Tempo-ramp support in the template (mirror `exporter.beatsToSeconds`)
- Track/arrangement scope: per-stem visuals using `tracks[]` + `trackId` on notes
- HyperFrames Cloud path in `render.ts` for users without local Node tooling
- Ship the timeline schema as a HyperFrames skill so coding agents can generate
  custom templates from "make me a video for this clip, moody and glitchy"
