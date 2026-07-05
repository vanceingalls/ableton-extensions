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

## VERIFY items (AGENT_INSTRUCTIONS §2) — all OPEN

Blocked on the SDK bundle (Centercode beta download requires the user's
Ableton account) and on HyperFrames details only the user has. Cite a TypeDoc
page or a test result when closing an item.

| # | Item | Status | Answer / citation |
|---|------|--------|-------------------|
| 1 | Audio render scope (clip/session bounce vs arrangement range) | OPEN | |
| 2 | Automation enumeration + breakpoint read; curve shapes? | OPEN | |
| 3 | Tempo map (ramps) readable, or static tempo only? | OPEN | |
| 4 | WebView engine: Chromium? WebGL/WebGL2? | OPEN | |
| 5 | Dialog sizing/modality; is Live blocked while open? | OPEN | |
| 6 | Warp marker read access; exact shape | OPEN | |
| 7 | Sandbox escape hatch for delivering the MP4 | OPEN | |
| 8 | HyperFrames render invocation (CLI flags / Cloud API, auth, seek hook) | OPEN — ask the user | |

## Manual test matrix (§11) — fill in during M1/M2

| Scope | Constant tempo | Tempo changes | Empty automation |
|---|---|---|---|
| MIDI clip | | | |
| Audio clip (warped) | | | |
| Track | | | |
| Arrangement | | | |
