# DECISIONS.md — Clip2Video decision log

Required by AGENT_INSTRUCTIONS §2/§13. Append; don't rewrite history.

## Decisions

### 2026-07-05 — TimeBridge `segmentAt` past-the-map fix
AGENT_INSTRUCTIONS called timebridge.ts "final unless tests find a bug." The
new test suite found one: the binary search capped at `map.length - 2`, so any
beat at or past the last tempo point was converted using the second-to-last
segment — a held tempo used the wrong BPM, and a final *ramp* extrapolated
without bound. Fixed by letting `segmentAt` return the last point;
`segmentSeconds` already holds that point's bpm when `map[i+1]` is undefined.
Covered by the "holds the final tempo beyond the last point" tests.

### 2026-07-05 — `TempoPoint`/`WarpMarker` defined once, in timebridge.ts
The same shapes existed in both `types.ts` and `timebridge.ts`. The
one-implementation rule (§6) extends to type definitions: `timebridge.ts`
(the time-math owner, which must compile standalone for the browser bundle)
owns them; `types.ts` re-exports so the contract surface stays complete.

### 2026-07-05 — `exportSelection(sel, req)` takes the resolved selection
The exporter used to resolve the selection itself. In the run-once command
model, `main.ts` resolves the right-clicked handle once and holds it for the
whole studio session, so refresh-from-Set (§7) re-exports the *same* target.
Passing `sel` in also makes the exporter trivially testable with a plain
object instead of a mocked `getSelection`.

### 2026-07-05 — SDK UI primitives live in liveAdapter.ts
Modal/progress dialogs are SDK surface. To preserve "no other file may import
the SDK," the adapter exports `openStudioDialog()` and `withProgress()`
wrappers plus `bindContext(extensionContext)` so `activate()` can hand over
the `ExtensionContext`. `main.ts` talks only to these wrappers.

### 2026-07-05 — Template manifest + `gridDensity` implemented
Added `templates/pulse-waveform/template.json` (§8 manifest, mapping-UI
source of truth). While writing it, found `gridDensity` was documented in the
template header but never read by `renderFrame`; implemented it (background
beat-grid line count) rather than shipping a manifest that lies.

### 2026-07-05 — timebridge.browser.js is a committed build artifact
The template loads TimeBridge via `<script src="./timebridge.browser.js">`
(IIFE global `TimeBridgeLib`, built by `npm run build:template-lib`). It is
committed so the template keeps working standalone in a browser with no build
step. Rule: any edit to `src/timebridge.ts` must regenerate and commit the
bundle in the same commit, or Node and template math silently diverge.

### 2026-07-05 — Studio protocol as specced, plus `protocolVersion` in `init`
`src/studioProtocol.ts` implements the §7 message set verbatim, adding only
`protocolVersion` on `init` (the WebView must refuse a MAJOR mismatch) and the
`StyleInfo`/`TemplateManifest` shapes for `availableStyles`, sourced from the
template manifests.

### 2026-07-05 — `HYPERFRAMES_API_KEY` env var is a stopgap
`main.ts#requireApiKey()` reads an env var so the render path has a seam.
Real credential handling is an open question for the user (§13) — see
VERIFY 8 notes below.

### 2026-07-05 — Early binary-level findings (pre-SDK, from Live 12.4.2)
Strings in Live's `Extensions/AddOns/Ableton AddOns` helper binary (present
and identical in the 12.4.2 build): `TExtensionsAddOnBackend`, "Extensions:
Invalid package.json at", "Extensions: Error scanning",
`InstallableExtensionsFolder`. So the extension host is a separate AddOns
process that scans an installable-extensions folder for packages with a
`package.json` — consistent with the announced `.ablx`/npm-style tooling.
The 12.4.2 release binary itself shows no `.ablx` strings; the runtime
presumably completes in 12.4.5+. Confirm all of this against the real SDK.

### 2026-07-05 — VERIFY evidence from Live 12.4.5b6 binaries (pre-SDK-zip)

Live 12.4.5b6 (build 2026-06-29) is installed. Its extension host is
`Contents/Helpers/ExtensionHost/`: a bundled **Node v24.14.1** plus
`ExtensionHostNodeModule.node` (~26 MB), which **embeds the SDK's host-side
JavaScript in plaintext**. Extracted (scratchpad `module-strings.txt`):
the full 103-function `bindings.*` low-level API, and the privileged JS layer
(`withinTransaction`, `registerContextMenuAction`, `showModalDialog`,
`showProgressDialog`, `renderPreFxAudio`, `importIntoProject`). Everything
below cites those strings; confirm against SDK TypeDoc when the zip arrives.

Design consequences:

- **Audio render is `renderPreFxAudio(lane, {startTime, endTime}) → path`** —
  per-lane, PRE-effects. For a full-mix soundtrack, the promising route is
  `song_get_main_track` (exists): the main track's *input* is the summed
  post-FX output of every track, so pre-FX-of-main ≈ the mix without
  main-bus processing. TEST THIS FIRST in M1; manual-export fallback stays.
- **No automation/envelope bindings exist at all** (no value-at-time either),
  and tempo is **static only** (`song_get_tempo`; `scene_get_tempo`). So v1
  mappings cannot read automation lanes — exporter emits `automation: {}`,
  constant tempo becomes the one-point map TimeBridge already handles. Keep
  the schema fields; they are forward-compatible. Mapping UI v1 can offer
  note-derived signals (energy/velocity) instead of lanes.
- **Modal dialog: `showModalDialog(url, width, height, onResult, onError)`**
  — takes a URL and calls back once with a payload when the dialog closes.
  No push-messaging API to the WebView in the embedded JS. BUT Node has
  outbound network and the dialog loads any URL, so the studio bridge becomes:
  **the extension serves the studio over loopback HTTP (+ WebSocket) and
  passes `http://127.0.0.1:<port>` to showModalDialog**. Full-duplex
  Node↔WebView messaging without any SDK support; `studioProtocol.ts` types
  ride the WebSocket unchanged; the close payload is the fallback channel.
  (Live-side WKWebView does have `TWebViewScriptMessageHandler`, so an
  official bridge may exist — check the SDK docs for it first.)
- **WebView is WKWebView** (WebKit, not Chromium): Canvas 2D and WebGL/WebGL2
  fine on modern macOS; don't count on Chromium-only APIs.
- **Warp markers readable**: `audioclip_get_warp_markers` (+ `warp_mode`,
  `warping`, `audioclip_get_file_path`). Exact marker shape TBD from TypeDoc.
- **Markers**: `song_get_cue_points` + `cuepoint_get_name`/`get_time`.
  ⚠️ No cue-point *creation* binding found — M4 cue-sheet import may be
  blocked in this beta (locators can be renamed but perhaps not created).
- **Delivery**: `importIntoProject(filePath) → destinationPath` imports a
  file into the project folder — the clean MP4 delivery path (VERIFY 7).
- Notes: `midiclip_get_notes`/`set_notes` with API↔flip converters. Clip
  region: `clip_get_start/end_time`, `loop_start/end`, `start/end_marker`.
  `clip_get_color` exists; no track-color binding; time signature only per
  scene (`scene_get_signature_*`) — default 4/4 for arrangement scope.
- Context menu: `registerContextMenuAction(category, title, commandId, cb)`;
  the title is auto-prefixed with the extension name; valid `category`
  values not visible in the binary (SDK docs). Action callbacks receive
  flip refs revived into handles — matches the `getObjectFromHandle` story.
- Undo: `song_begin/end_undo_step_send` underpin `withinTransaction` ✓.

### 2026-07-05 — M0 CLOSED: SDK zip TypeDoc + HyperFrames docs verified

SDK zip 1.0.0-beta.0 unpacked (`~/Downloads/extensions-sdk-1.0.0-beta.0`);
full confirmed API in `research/sdk-typedoc-summary.md`. HyperFrames turned
out to be **public** (github.com/heygen-com/hyperframes, v0.7.36, docs at
hyperframes.heygen.com) — no need to ask the user; conventions verified
against the CLI itself and its docs. Corrections to earlier binary evidence:

- **Cue points CAN be created/deleted** (`Song.createCuePoint(timeBeats)`,
  `deleteCuePoint`) — the earlier "M4 at risk" note was wrong; M4 is GO.
- `renderPreFxAudio(track: AudioTrack, startBeats, endBeats) → wav path` —
  types demand AudioTrack, but `Song.mainTrack: Track` exists; whether the
  runtime accepts main (pre-FX of main ≈ full summed mix) is the M1 test.
- `showModalDialog` officially supports **http://localhost** URLs — the
  loopback studio-server design is the sanctioned pattern, not a workaround.
  Dialog returns a string by posting `{method:"close_and_send",
  params:[str]}` to `window.webkit.messageHandlers.live` (macOS) /
  `window.chrome.webview` (Windows).
- Progress dialog is `ui.withinProgressDialog(text, {progress}, cb(update,
  abortSignal))` — cancellation is an AbortSignal; wire it to cancelRender.
- Context-menu scopes are string literals; for clip/track/arrangement
  coverage register: MidiClip, AudioClip, MidiTrack, AudioTrack,
  MidiTrack.ArrangementSelection, AudioTrack.ArrangementSelection.
- Note fields are `startTime`/`duration` (beats), `velocity?` optional;
  `Clip.color` is a **number**; tracks have NO color.
- HyperFrames seek hook for canvas templates: listen for the **`hf-seek`**
  CustomEvent (`detail.time` seconds) — replaces our imagined
  `window.renderFrame(seconds)` convention. Composition = HTML with
  data-composition-* attrs; `<audio class="clip">` elements are muxed
  automatically; local render `hyperframes render [DIR] -c … -o … -f …`;
  cloud = `POST /v3/assets` → `POST /v3/hyperframes/renders` → poll →
  presigned video_url, auth via HEYGEN_API_KEY/HYPERFRAMES_API_KEY.

## VERIFY items (AGENT_INSTRUCTIONS §2) — ALL RESOLVED

| # | Item | Status | Answer (citations in research/sdk-typedoc-summary.md) |
|---|------|--------|-------------------|
| 1 | Audio render scope | RESOLVED (runtime test pending) | pre-FX render of an AudioTrack over a beat range; main-track full-mix trick to test in M1; manual-export fallback kept for MIDI-only Sets |
| 2 | Automation read | RESOLVED: NOT AVAILABLE | no envelope API in SDK 1.0.0-beta.0 → v1 ships without lane mappings |
| 3 | Tempo map | RESOLVED: STATIC ONLY | `Song.tempo` scalar → one-point tempo map |
| 4 | WebView engine | RESOLVED | WKWebView (macOS) / WebView2 (Windows implied); Canvas2D/WebGL OK |
| 5 | Dialog sizing/modality | RESOLVED | `showModalDialog(url,w,h)→Promise<string>`; http://localhost allowed; close via close_and_send message; no documented size limits |
| 6 | Warp marker read | RESOLVED | `AudioClip.warpMarkers: {beatTime, sampleTime}[]` — matches TimeBridge exactly |
| 7 | MP4 delivery | RESOLVED | `resources.importIntoProject(path)`; temp files in `environment.tempDirectory` |
| 8 | HyperFrames API | RESOLVED | public repo/docs; hf-seek event hook; CLI + /v3 cloud API (see summary) |

### 2026-07-05 — Local render pipeline verified END-TO-END (no Ableton)

`renderLocal()` was exercised for real: synthesized 124 BPM fixture
(`tools/make-fixture.mjs`) → stageBundle → `hyperframes render` (Chrome +
static ffmpeg/ffprobe in `~/.local/bin`) → 540×960 @30fps MP4, audio muxed.
Results:
- **Sync verified visually**: frame at beat 4 shows the bloom/glow/note
  pulse; the between-beats frame is dim. (Programmatic ±1-frame assertion
  still to add per §10 M2.)
- **Determinism verified**: two renders → 243/243 identical frame md5s
  (`ffmpeg -f framemd5`), even without `--docker`.
- **Template must register a stub `window.__timelines['main']`
  synchronously** — the renderer polls for a registered timeline per
  composition and otherwise burns its full 45s budget (98s → 6.5s render
  after the fix). Our animation rides the `hf-seek` event; the stub is
  no-op-seekable.
- `stageBundle` patches `data-duration/width/height` into index.html —
  HyperFrames reads them from the composition, not from CLI flags.

### 2026-07-05 — M1 RUNS INSIDE LIVE (12.4.5b6 dev mode)

The extension loads and the full path works end-to-end in Live: right-click a
MIDI clip → "Render Video…" → dialog → Render → MP4 imported into the project
(`…/Live Recordings/<project>/Samples/Imported/output.mp4`). Hard-won findings:

- **`package.json` needs `"main": "dist/extension.js"`** or `extensions-cli
  run` silently fails the control-channel handshake (host bring-up timeout).
- **Killing the dev host orphans Live's dev-mode connection** → subsequent
  `run` gets "bring-up timed out". Reset: toggle Developer Mode off/on (or
  restart Live). No programmatic reset. Painful iteration tax.
- **Integers arrive as BigInt** across the bindings even where TypeDoc says
  `number` (Clip.color, note times, tempo…). Coerce everything through
  `num()` in liveAdapter or math/JSON.stringify throws
  "Cannot mix BigInt and other types". First real runtime surprise.
- **Session-clip right-click fires the `ClipSlotSelection` scope** (and
  `ClipSlot`), not `MidiClip`. Registered all of MidiClip/AudioClip/ClipSlot/
  ClipSlotSelection/MidiTrack/AudioTrack/±ArrangementSelection to be safe.
- **`showModalDialog` with `http://localhost` does NOT load** (white window,
  resolves instantly with empty payload) despite the docs listing it as an
  allowed scheme. The SDK's own modal-dialog example uses a **`data:` URL**;
  that works. So M1 uses a self-contained data-URL dialog: inject the timeline
  in, get the render request out via `close_and_send`. The loopback
  studioServer.ts is kept for M3 (live preview needs a transport) but is
  currently unused by main.ts. Retest http://localhost per SDK release.
- **`renderPreFxAudio(song.mainTrack)` fails** (error is `undefined` — the
  reject carries no message). So the full-mix bounce trick does NOT work in
  this build; VERIFY 1's optimistic path is dead. v1 renders silent unless we
  find another bounce route (per-AudioTrack works in principle, untested) or
  the user exports audio manually. bounceAudio now tries mainTrack then any
  selected AudioTrack, logging each failure.
- **Data-URL injection must stay valid JS before and after substitution** —
  a dangling fallback object after the injected JSON was a syntax error that
  silently killed the whole page script (dead dropdown + dead buttons, but the
  static shell still rendered, so it looked "almost working").
- Local render from inside Live works because the dev host inherits the PATH I
  launched it with (Chrome + `~/.local/bin` ffmpeg). The **shipped** `.ablx`
  won't have that — production requires the cloud path (needs HEYGEN_API_KEY).
- Menu renamed **"Render Video…"** (was "Open HyperFrames Studio…") — at M1 it
  is a render dialog, not yet the live studio. The studio (preview, scrub,
  mappings, refresh-from-Set) is still M3.

### 2026-07-05 — LLM feedback video feature

New feature: right-click → "Create Feedback Video…" → the extension summarizes
the whole Set (`getProjectSummary`: per-track note counts, densities, device
names, colors, tempo, sections), sends it to Claude (`src/feedback.ts`, model
`claude-opus-4-8`, structured-output JSON schema), and renders the returned
critique as a HyperFrames video (`templates/project-feedback`). Verified
end-to-end with mock feedback (real 1080×1920 MP4; one card at a time,
sentiment-colored, score count-up).

- **API key**: read from `ANTHROPIC_API_KEY` (dev) or a `anthropic-key` file in
  `environment.storageDirectory` (shipped); a paste-key dialog writes it there.
- **DOM/CSS text is NOT bit-reproducible on host Chrome.** Two renders of the
  feedback template differ at the byte level but are visually identical
  (SSIM 0.99999, PSNR ~66 dB) — sub-pixel text antialiasing only. This is
  expected: the canvas path (pulse-waveform) IS bit-exact; DOM text isn't
  without `--docker`. For the feedback *review* video that's fine (no music
  sync to protect); if bit-repro is ever required, render with `--docker`.
- The feedback template drives animation via the `hf-seek` event (pure fn of
  t) with a self-cancelling dev-preview loop guarded on the renderer globals
  (`__hfSeekAllAdapters` etc.), so the preview never races capture.
- `RenderJob.injectScripts` lets a render inject extra globals (here
  `window.FEEDBACK`); `stageBundle` writes them into the bundle.

## Manual test matrix (§11) — fill in during M1/M2

| Scope | Constant tempo | Tempo changes | Empty automation |
|---|---|---|---|
| MIDI clip | | | |
| Audio clip (warped) | | | |
| Track | | | |
| Arrangement | | | |
