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

## VERIFY items (AGENT_INSTRUCTIONS §2)

Evidence = 12.4.5b6 binary strings (above). Final confirmation = SDK zip
TypeDoc + a running test extension.

| # | Item | Status | Answer / citation |
|---|------|--------|-------------------|
| 1 | Audio render scope | EVIDENCE | `renderPreFxAudio(lane,{startTime,endTime})→path`, per-lane pre-FX; try main track for full mix; manual-export fallback kept |
| 2 | Automation read | EVIDENCE: NOT AVAILABLE | zero envelope/automation bindings in 12.4.5b6 → v1 ships without lane mappings |
| 3 | Tempo map | EVIDENCE: STATIC ONLY | `song_get_tempo` only → one-point tempo map |
| 4 | WebView engine | EVIDENCE | WKWebView (WebKit); Canvas2D/WebGL OK, no Chromium extras |
| 5 | Dialog sizing/modality | EVIDENCE (partial) | `showModalDialog(url,w,h)`; result payload on close; modality/max size untested |
| 6 | Warp marker read | EVIDENCE | `audioclip_get_warp_markers`; shape TBD from TypeDoc |
| 7 | MP4 delivery | EVIDENCE | `importIntoProject(path)` into the project folder |
| 8 | HyperFrames API | OPEN — ask the user | |

## Manual test matrix (§11) — fill in during M1/M2

| Scope | Constant tempo | Tempo changes | Empty automation |
|---|---|---|---|
| MIDI clip | | | |
| Audio clip (warped) | | | |
| Track | | | |
| Arrangement | | | |
