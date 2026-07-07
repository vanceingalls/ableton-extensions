# AGENT_INSTRUCTIONS.md — Clip2Video / HyperFrames Studio for Ableton Live

You are implementing **Clip2Video**: an Ableton Live Extension that embeds a
HyperFrames authoring studio inside Live and renders deterministic, music-locked
MP4s from the producer's Set. This document is the complete handoff. Read it
fully before writing code. The repository you receive contains a skeleton that
encodes the architecture; parts of it are intentionally provisional and this
document tells you exactly which parts, and what to do about them.

---

## 1. Mission and product definition

One sentence: *right-click your track in Ableton Live → a HyperFrames studio
opens inside Live, already previewing a video composition built from your
session's own notes, tempo, colors, and structure → tweak → render a
frame-exact MP4 in the cloud.*

The differentiating insight, which every design decision serves: video/music
sync is normally approximated by analyzing audio. We instead read **ground-truth
musical timing** (tempo map, MIDI note times, automation breakpoints, markers,
warp markers) directly from the Live Set via the Extensions SDK, and HyperFrames'
deterministic virtual-clock renderer turns that into exact frame placement.
**Sync is exact by construction, never detected.** If any implementation choice
would reintroduce audio analysis or approximate timing, it is wrong.

Two personas, one artifact:
- **A-side (Ableton-first producers):** push timing OUT of Live to make videos
  (WIP social clips, Spotify Canvas loops, sample-pack demos, stem breakdowns).
- **B-side (HyperFrames-first video composers):** push timing INTO Live
  (import a comp's cue sheet as locators so music is scored to picture; export
  real Set data as template test fixtures).

The **timeline JSON** (section 4) is the same artifact flowing both directions.
Preserve that symmetry.

---

## 2. Ground truth vs. assumptions — resolve on day one

Everything in this section was established by research in June–July 2026.
The Ableton Extensions SDK is a **public beta released 2026-06-02** and is a
moving target. Your first task (Milestone 0) is to verify every item marked
VERIFY against the actual SDK bundle.

### Confirmed (multiple sources, treat as reliable)
- Extensions run on **Node.js** (JavaScript/TypeScript), packaged as `.ablx`,
  require **Live 12 Suite beta 12.4.5+**. Tooling: `@ableton-extensions/sdk`,
  `@ableton-extensions/cli`, `@ableton-extensions/create-extension`.
- Object model: entry `activate()` receiving an `ExtensionContext` with
  `application`, `commands`, `ui`, `resources`, `environment`. Classes
  distinguish `AudioTrack`/`MidiTrack`, `AudioClip`/`MidiClip`, devices
  (e.g. Simpler vs racks). Canonical patterns: `initialize(activation, "1.0.0")`,
  `registerCommand` + `registerContextMenuAction`, `getObjectFromHandle` to
  resolve the user's selection, `withinTransaction` for batched single-undo edits.
- Capabilities: read/write tracks, clips, MIDI notes, devices, tempo, scenes,
  set structure; **import files**; **render audio from the arrangement**.
  SDK bundle ships examples: `context-menu`, `modal-dialog`, `progress-dialog`,
  `audio-clips`, `arrangementselection`, `warpMode`, `strip-silence`.
- Execution model: extensions are **run-once commands** — triggered from the
  right-click context menu, optional parameter pop-up, perform task, stop.
  UI primitives: context-menu actions, **modal dialogs hosting WebView HTML**,
  progress dialogs. The WebView is powerful: community has run DOOM,
  TensorFlow.js inference, and OAuth flows with file downloads inside it.
- Constraints: **no real-time MIDI/audio stream callbacks** (extensions are an
  offline editing/automation layer, not devices); **aggressive filesystem
  sandbox** (file access outside the extension's folder is a hassle); no Max
  for Live bridge; outbound **network access works** (proven by community
  extensions doing OAuth + downloads).
- Docs live in the SDK zip (Centercode beta program): `docs/` (getting-started,
  essentials, development, design), `api/` (TypeDoc for every class), and
  `examples/`. Community support: Ableton Discord `#extensions-sdk`.

### VERIFY in Milestone 0 (assumptions the skeleton makes)
1. **Audio render scope** — arrangement render is confirmed; verify whether a
   single clip / session-view selection can be bounced directly, or whether we
   must render an arrangement time range. Adapt `liveAdapter.bounceAudio`.
2. **Automation readability** — can automation envelopes/breakpoints be
   enumerated and read? Are curve shapes exposed? If only value-at-time
   queries exist, sample at 1/16-note resolution and emit `linear` points.
3. **Tempo automation** — is the tempo map (ramps) readable, or only static
   song tempo? TimeBridge already handles both; a static tempo is a one-point map.
4. **WebView engine** — is it modern Chromium? Do WebGL/WebGL2 work? (Canvas 2D
   is proven via DOOM.) This gates whether Three.js/shader templates run in the
   in-Live preview or only in cloud render.
5. **Dialog sizing/modality** — max/resizable dialog dimensions; whether Live is
   fully blocked while the dialog is open (shapes the refresh-from-Set flow).
6. **Warp marker read access** — the `warpMode` example implies yes; confirm the
   exact shape and map it to `WarpMarker {sampleTime, beatTime}`.
7. **Sandbox escape hatches** — where CAN we write files the user can retrieve
   (the rendered MP4)? Options: extension sandbox folder + "reveal" action,
   import into the Set, or download from cloud via browser.
8. **HyperFrames render invocation** — exact CLI flags / Cloud API routes.
   The maintainers of this project ARE HyperFrames developers: **ask the user**
   rather than guessing. `src/render.ts` marks both call sites.

Escalation policy: if a VERIFY item contradicts this document, the SDK's actual
TypeDoc wins. Update `liveAdapter.ts` (the quarantine layer, section 5) and note
the discrepancy in `DECISIONS.md` (create it). If something blocks a milestone,
ask the user; do not silently redesign.

---

## 3. Architecture

```
┌─ Ableton Live ──────────────────────────────────────────────┐
│                                                             │
│  right-click → registerContextMenuAction("Open Studio…")    │
│        │                                                    │
│  ┌─ Node side (extension) ─────────────────────────────┐    │
│  │ liveAdapter.ts   ← ONLY file touching the SDK       │    │
│  │ exporter.ts      → timeline.json (beats domain)     │    │
│  │ audio bounce     → audio.wav                        │    │
│  │ cueImporter.ts   ← B-side: cue sheet → locators     │    │
│  └──────────┬──────────────────────────────────────────┘    │
│             │ message bridge (section 7)                    │
│  ┌─ Modal dialog WebView: THE STUDIO ──────────────────┐    │
│  │ comp preview (template runs live, WebAudio clock)   │    │
│  │ beat/frame ruler, mappings UI, refresh-from-Set     │    │
│  └──────────┬──────────────────────────────────────────┘    │
└─────────────┼───────────────────────────────────────────────┘
              │ HTTPS (bundle: template + timeline.json + audio.wav)
              ▼
      HyperFrames Cloud render  →  MP4 (virtual clock, deterministic)
              │
              ▼
      progress dialog in Live → deliver file (per VERIFY item 7)
```

Iron rules:
- **The studio (preview/authoring) lives inside Live. The deterministic render
  does not.** The WebView is a presentation surface with a real clock; it cannot
  be frame-stepped or captured. Never attempt to render final frames in it, and
  never spawn Chromium from the sandboxed Node runtime. Cloud render is the
  default path. (A local companion-process fallback is out of scope for v1.)
- **Preview and render must be the same video by construction:** both drive the
  identical template `renderFrame(tSeconds)`; only the clock differs (WebAudio
  `currentTime` in preview, HyperFrames virtual clock in render).

---

## 4. The timeline contract

`schema/timeline.schema.json` is the normative spec; `src/types.ts` mirrors it;
`examples/timeline.example.json` is a valid instance. Rules:

- **Events stay in beats.** Notes, automation points, markers are stored in the
  beat domain. Never pre-convert to seconds in the exporter — that creates two
  sources of truth. Consumers convert at the last moment via TimeBridge.
- **Anchor:** beat 0 = second 0 = frame 0 = start of exported region. Pre-roll
  is explicit (`audio.offsetBeats`), never implied by the audio file.
- `video.mappings` routes automation lanes to template-exposed visual params
  (`glow`, `zoom`, `hueShift`, `shake`, `gridDensity` in the MVP template).
- Version with `formatVersion` (semver); templates check major version.
- The same schema is the B-side fixture format (user story B3) and, mirrored,
  the cue-sheet import format (section 9).

If the schema must change, update schema + types + example together, bump
`formatVersion`, and record why in `DECISIONS.md`.

---

## 5. Repository as received, and required changes

```
clip2video/
├── README.md                      project overview (keep updated)
├── schema/timeline.schema.json    the contract (section 4)
├── src/
│   ├── types.ts                   mirrors schema — keep in lockstep
│   ├── timebridge.ts              FINAL — the one time-conversion module (§6)
│   ├── liveAdapter.ts             SDK quarantine layer — REWRITE against real SDK
│   ├── exporter.ts                assembles timeline.json — minor fixes (below)
│   ├── render.ts                  HyperFrames invocation — fill in real API (§8)
│   └── main.ts                    entry — REWORK to run-once model (below)
├── panel/index.html               REWORK into the studio dialog (§7)
├── templates/pulse-waveform/      working template — minor fixes (below)
└── examples/timeline.example.json valid sample data
```

Required changes to the skeleton (do these; they are known debts):
1. **`main.ts` assumed a persistent panel.** The SDK's real model is run-once
   commands + modal dialogs. Rework to: `activate()` → `initialize` →
   `registerContextMenuAction` (label "Open HyperFrames Studio…", applies to
   clips, tracks, arrangement) → on invoke: resolve selection via
   `getObjectFromHandle`, run the exporter, bounce audio, open the modal
   dialog with the studio, service the message bridge until the dialog closes,
   show a progress dialog during cloud render. One invocation = one session.
2. **Duplicated time math.** `exporter.beatsToSeconds` and the template's
   `secondsToBeats` predate `timebridge.ts`. Delete both; import TimeBridge in
   the exporter (Node) and bundle it into the template and studio (browser).
   This is the "one implementation" rule and it is non-negotiable (§6).
3. **`liveAdapter.ts` is placeholder pseudocode** against a guessed API. Rewrite
   every function against the real TypeDoc, preserving the exported interface
   (`getSelection`, `getTempoMap`, `getTimeSignatures`, `getNotes`,
   `getAutomation`, `getMarkers`, `getTracks`, `bounceAudio`) so nothing else
   changes. Add `getWarpMarkers(clip)` (VERIFY item 6). Keep the rule stated in
   its header: **no other file may import the SDK.**
4. **`panel/index.html`** becomes the studio (spec in §7). Keep its visual
   language: flat Live-style grays, the clip's own color as the only accent.
5. **Template:** replace its local time math with TimeBridge; keep the pure-
   function-of-t rule and the `window.renderFrame(seconds)` hook (adjust the
   hook name to the real HyperFrames convention after asking the user).

---

## 6. Time: the three-clock bridge (read carefully; this is where quality lives)

Three domains: **beats** (Live, source of truth) → **seconds** (audio, exchange
currency) → **frames** (HyperFrames, derived as `t·fps`). Plus a fourth for
warped audio clips: **sample time ↔ clip beats** via warp markers, composed
with the tempo map to reach the render timeline.

`src/timebridge.ts` is complete and final unless tests find a bug:
ramp-aware `beatsToSeconds`/`secondsToBeats` (piecewise, with exact linear-ramp
integral and its inverse), frame quantization with explicit policy, warp-marker
composition (`warpToBeats`/`beatsToWarp`), and `roundTripError()`.

Policies you must enforce everywhere:
- **Single implementation.** TimeBridge compiles for Node and browser. If you
  ever write `* 60 / bpm` outside this file, stop and import instead.
- **Quantize policy:** `nearest` for accents/pulses, `floor` for cut boundaries.
  Max sync error is 1/(2·fps); offer 60fps for rhythmically aggressive material.
- **Round-trip invariant:** `beatsToSeconds(secondsToBeats(t)) ≈ t` within 1e-6.
  CI-test it (see §10) — the B-side import/export cycle depends on it.
- **UI rule:** display bars.beats to the producer; store seconds internally;
  convert only at the presentation edge.
- **No live transport sync.** The studio owns playback of the bounced audio via
  WebAudio; do not attempt to follow Live's playhead (no real-time callbacks).

---

## 7. The studio (modal dialog WebView)

Layout, top to bottom: comp preview (the template itself, running live) with a
scrub bar and play/pause driven by a WebAudio player of the bounced audio;
a timeline strip showing the Set's real notes/markers with a dual ruler
(bars.beats above, frames below, both positioned via TimeBridge); mapping rows
(`automation lane → visual param`, patch-cable style, already prototyped in the
old panel); style + aspect (9:16, 1:1, 16:9) + fps (30/60) controls;
**Refresh from Set** button; **Render** button.

Refresh-from-Set is the signature interaction: the Node side holds live handles
while the dialog is open, so on refresh it re-reads notes/tempo/markers/
automation and pushes a fresh timeline to the WebView. The producer edits in
Live (if modality allows) or closes → edits → reopens; either way the loop is
seconds, not an export/import cycle.

Node ↔ WebView message protocol (define as TypeScript types in
`src/studioProtocol.ts`; version it):

```
Node → WebView
  init            { timeline, audioUrl, availableStyles[] }
  timelineUpdated { timeline }                    // after refreshFromSet
  renderProgress  { phase: 'uploading'|'rendering'|'downloading', pct }
  renderDone      { deliveredAs: 'path'|'imported'|'url', ref }
  renderError     { message }

WebView → Node
  ready           {}
  refreshFromSet  {}
  requestRender   { style, aspect, fps, mappings[] }
  cancelRender    {}
  closeStudio     {}
```

Transport for `audioUrl`: whatever the WebView can load from the sandbox
(file URL, data URL, or a local blob the Node side streams) — resolve during
Milestone 0 alongside VERIFY item 7.

---

## 8. Rendering

Cloud-first: package `{template dir, timeline.json, audio.wav}` and POST to
HyperFrames Cloud; poll; download MP4; deliver per VERIFY item 7; drive Live's
progress dialog throughout. The exact API is known to the user (they develop
HyperFrames) — **ask for the endpoint, auth, and the template seek-hook
convention before implementing**; both call sites are marked in `render.ts`
and the template. Keep `renderLocal` (CLI spawn) working as a dev-machine path
for template development outside Live; it is not shipped in the extension.

Template requirements (enforced in review for every template):
- Every pixel a pure function of `t`: no rAF-accumulated state, no physics
  integrators, no `Math.random()` at draw time (deterministic pseudo-noise
  seeded from timeline data is fine).
- Reads `./timeline.json` + `./audio.wav` relative paths; uses TimeBridge;
  exposes the seek hook; includes the dev rAF preview loop guarded so it never
  runs under the renderer.
- Declares its visual params (mapping targets) in a small manifest
  (`template.json: { name, params: [...] }`) so the studio can populate the
  mapping UI generically. Add this manifest to pulse-waveform.

---

## 9. B-side: cue-sheet import (Milestone 4)

New module `src/cueImporter.ts` + context-menu action "Import HyperFrames Cue
Sheet…". Input format (add `schema/cuesheet.schema.json`): essentially the
timeline JSON's mirror — `{ formatVersion, meta, fps, durationSeconds,
cues: [{ timeSeconds, label, kind: 'cut'|'beat'|'hold' }] }`. Behavior:
`secondsToBeats` each cue via TimeBridge against the Set's current tempo map →
create locators (and optionally a color-coded guide MIDI track, one clip per
inter-cue span) inside a single `withinTransaction` so the whole import is one
undo step. This turns Live into a score-to-picture stage for HyperFrames comps.

---

## 10. Milestones and acceptance criteria

**M0 — Ground truth (no product code).** Join beta via Centercode; unpack SDK;
run bundled examples; resolve all eight VERIFY items; record answers in
`DECISIONS.md`; get HyperFrames API details from the user.
*Done when:* every VERIFY item has a cited answer (TypeDoc page or test result).

**M1 — Exporter + dev harness.** Real `liveAdapter.ts`; exporter produces
schema-valid timeline.json + bounced audio from a right-clicked MIDI clip;
template runs against it in a normal browser via the dev preview.
*Done when:* right-click → JSON validates against the schema; a 16-beat test
clip's kick pattern visibly pulses in the browser preview at the right moments;
`roundTripError < 1e-6` and TimeBridge unit tests pass (constant tempo, held
changes, ramps; warp composition; quantize policies).

**M2 — A1 MVP: one-shot render.** Full path: right-click → parameter pop-up
(style/aspect/fps) → export → cloud render with progress dialog → MP4 delivered.
*Done when:* a 124 BPM test clip renders a 9:16 MP4 where every kick's visual
pulse is within ±1 frame at 30fps (verify by stepping frames against note
times); two consecutive renders of the same input are byte-comparable or
frame-identical (determinism check).

**M3 — The studio.** Modal WebView per §7: live preview with WebAudio-clocked
playback, scrubbing, dual ruler, mapping UI from the template manifest,
refresh-from-Set, in-dialog render.
*Done when:* preview and final MP4 are visually identical for the same
settings (spot-check 10 frames); refresh reflects a note edit in <2s;
mapping an automation lane to `glow` visibly tracks the lane in preview.

**M4 — B-side.** Cue-sheet import per §9; fixture export (B3) as a bare
"Export Timeline JSON…" context action (it's the M1 exporter with a save step).
*Done when:* importing a cue sheet against a Set with a tempo ramp places
locators at the correct bars.beats positions (hand-verified against TimeBridge
math); the whole import is one undo; export→import→export is stable (§6).

Sequencing rationale: M2 before M3 because the one-shot path exercises the
entire pipeline with minimal UI risk and is independently demoable/shippable.

---

## 11. Testing

- **Unit (Node, CI):** TimeBridge exhaustively (this is the highest-value test
  surface in the project); exporter against a mocked liveAdapter; schema
  validation of every emitted JSON (use ajv).
- **Determinism:** render the example timeline twice, compare frames.
- **Sync ground truth:** a fixture Set with a metronome-like pattern; assert
  extracted note times against known values, and rendered pulse frames against
  `beatsToFrame` expectations.
- **Manual matrix (record in DECISIONS.md):** MIDI clip / audio clip (warped) /
  track / arrangement scopes; constant tempo vs tempo changes; empty automation.

## 12. Non-goals for v1 (do not build)
Real-time/reactive visuals during Live playback (SDK cannot); local Chromium
rendering inside the sandbox; Max for Live integration; persistent background
processes; template marketplace; more than the one polished template plus
manifest mechanism (falling-notes/typography are v2).

## 13. Conduct
Prefer asking the user over guessing on: HyperFrames API/conventions (they
build it), payment/account flows for Cloud, and anything requiring credentials.
Keep `README.md` and `DECISIONS.md` current as you go. Never weaken the three
iron rules: events in beats · one TimeBridge · pure functions of t.
