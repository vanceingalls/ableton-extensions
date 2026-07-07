# Building HyperFrames Extensions for Ableton Live — A Complete Technical Walkthrough

This document dissects the **HyperFrames Feedback** extension end to end and generalizes it
into a template for building your own Ableton Live extension that renders video with
HyperFrames. Every subsystem, every non-obvious constraint, and every hard-won fix is
documented here. If you are starting a new extension, read the **Architecture** and
**The two runtime environments** sections first — most bugs come from not understanding
those two things.

- Target: **Ableton Extensions SDK `1.0.0-beta.0`** (`@ableton-extensions/sdk`), Live **12.4.5b6** beta.
- Runtime: extensions run inside a bundled **Node 24** "Extension Host" process that Live spawns.
- Renderer: **HyperFrames** (`hyperframes` npm CLI / HyperFrames Cloud, a HeyGen-hosted service).
- Language: TypeScript, bundled to a single CommonJS file with **esbuild**.

---

## 1. What the extension does (the shape of the problem)

Two user-facing commands, both reached by right-clicking in Live:

1. **Render Video…** — export a clip/track/arrangement selection to a music-locked MP4
   (a "pulse-waveform" style visualization driven by the actual notes/tempo).
2. **Create Feedback Video from Selection…** — send a structured summary of the selection
   to Claude, get a production review back, have Claude **author a HyperFrames composition**
   visualizing that review, lint-fix it, render it, and import the MP4 into the Live set.

Plus a utility command, **Manage API Keys…**, for storing/updating the two API keys.

The whole thing is a **run-once command model**: one right-click → one self-contained
session → one rendered video. There is no long-lived UI server, no background process.

---

## 2. Architecture and the "iron rule"

```
 Live (Ableton) ──spawns──▶ Extension Host (Node 24, sandboxed)
                                   │  loads dist/extension.js (one bundled CJS file)
                                   ▼
        ┌───────────────────────── src/main.ts ─────────────────────────┐
        │  activate(): registers commands + context-menu actions          │
        │  session handlers: runStudioSession / runFeedbackSession        │
        │  UI dialogs (data: URLs), key prompts, progress, done/error     │
        └───────┬───────────────┬───────────────┬───────────────┬────────┘
                │               │               │               │
                ▼               ▼               ▼               ▼
        liveAdapter.ts     exporter.ts      feedback.ts     composer.ts
        (ONLY SDK caller)  (Timeline)       (Claude review) (Claude authors comp)
                │               │               │               │
                │               ▼               │               ▼
                │           timebridge.ts        │           render.ts ──▶ HyperFrames
                │           (beats↔seconds)       │           (local CLI or Cloud API)
                ▼                                 ▼
        @ableton-extensions/sdk            @anthropic-ai/sdk
```

**The iron rule: only `liveAdapter.ts` imports the Ableton SDK.** Everything else takes
plain data. `main.ts` receives the context-menu argument as `unknown` and passes it straight
to `liveAdapter.getSelection()`. This keeps the SDK surface (which is beta and quirky —
see §7) quarantined in one auditable file, and lets you unit-test the exporter/composer by
mocking `liveAdapter`.

### File map

| File | Responsibility |
|---|---|
| `src/main.ts` | Entry point; `activate()`; command registration; session orchestration; all dialogs. |
| `src/liveAdapter.ts` | **The only SDK caller.** Selection resolution, data readers, UI (dialogs/progress), file delivery. |
| `src/exporter.ts` | Assembles the `Timeline` data contract from adapter reads. No SDK, no rendering. |
| `src/timebridge.ts` | Deterministic beats↔seconds↔frames mapping (ramp-aware). Compiles for Node **and** browser. |
| `src/render.ts` | Stages the bundle; `renderLocal` (dev) and `renderCloud` (shipped); the HyperFrames Cloud HTTP flow. |
| `src/feedback.ts` | Calls Claude for the review (structured JSON output); API-key persistence helpers. |
| `src/composer.ts` | Claude **authors** a HyperFrames composition, then `hyperframes lint`→fix loop. |
| `src/feedbackTypes.ts` | `ProjectSummary`, `FeedbackReport`, and the JSON Schema for structured output. |
| `src/types.ts` | The `Timeline` contract and related interfaces. |
| `src/polyfill.ts` / `src/webglobals.ts` | Install Web globals the host strips (fetch family, Event/AbortController, etc.). |
| `src/templateAssets.generated.ts` | **Auto-generated.** Template + panel HTML inlined as strings (sandbox workaround). |
| `templates/*` | The HyperFrames compositions (HTML) and their manifests. |
| `panel/index.html` | The "studio" dialog HTML for the Render Video flow. |
| `tools/build-extension.mjs` | esbuild build with the polyfill banner + asset generation. |
| `tools/gen-template-assets.mjs` | Reads template/panel files → writes `templateAssets.generated.ts`. |
| `tools/load-check.cjs` | Offline load test simulating the host's stripped-globals context. |
| `manifest.json` | Extension manifest (name, entry, versions). |

---

## 3. The two runtime environments (read this twice)

Your code runs in **one of two hosts**, and they behave very differently. Almost every
"works on my machine but fails in Live" bug traces back to this distinction.

### 3a. The dev host — `extensions-cli run`
- Launched from **your shell** (`npm run run:ext` → `extensions-cli run`).
- Inherits your full shell environment: `PATH`, `HOME`, everything.
- **No filesystem sandbox, no Node permission model.** Child processes (npx, Chrome, ffmpeg)
  run freely. `renderLocal` works here.
- Requires **Developer Mode ON** in Live. Handshake to Live can be flaky (retry).

### 3b. The managed host — an installed `.ablx`
- What a normal user gets: package the extension, install the `.ablx`, **Developer Mode OFF**.
- Live spawns the Extension Host with a **hard Node permission sandbox** and a **stripped
  set of Web globals**. This is the environment you must actually support.
- Two consequences that dominate the design:

**(i) Filesystem sandbox.** The extension's Node process may read/write **only** its own
`storageDirectory` and `tempDirectory` (from `ctx.environment`). Not `/tmp`, not the OS temp
dir, **not even the extension's own install directory**. Attempting anything else throws
`ERR_ACCESS_DENIED … Use --allow-fs-read/--allow-fs-write`.
- → All work dirs go under `tempDirectory()` (see `main.ts` `workBase()`).
- → You cannot read your own bundled template files at runtime. They are **inlined at build
  time** into `templateAssets.generated.ts` and written out from memory (§6, §9).
- → Persist keys under `storageDirectory()` only.

**(ii) The Node permission model is inherited by child processes.** This is the subtle one.
The host runs your Node under `--permission` (fs restricted to storage/temp). **Any child
Node process you spawn inherits that sandbox and cannot be granted more.** `hyperframes` is a
Node CLI (run via `npx`, also Node), so spawning it fails immediately:

```
ERR_ACCESS_DENIED, permission: 'FileSystemRead',
resource: '.../npm/bin/npx-cli.js'
```

The child Node can't even read its own program files (they live outside storage/temp).
Stripping `NODE_OPTIONS` does **not** help — the inheritance is built into the permission
model, not passed via env. **Therefore local rendering is impossible in the managed host.**
Native binaries (ffmpeg, Chrome, `zip`, `open`) are *not* subject to Node's permission model,
so they're fine as children — but `hyperframes` itself is Node, so it isn't.
- → The shipped render path must be **HyperFrames Cloud** (a network POST — no child Node),
  which is why `renderCloud` exists and needs a HeyGen API key (§9).

**(iii) Stripped Web globals.** The host omits many WHATWG/web globals that Node normally
provides. The Anthropic SDK + undici reference them at module load, so they must be
polyfilled **before** those modules load (§5).

**(iv) No dynamic `import()`.** The bundled host cannot evaluate a runtime `import()` — it
throws `A dynamic import callback was not specified`. Use **static top-level imports** only;
esbuild inlines them at build time. (This bit us in `revealFile`/`openFile`.)

---

## 4. The manifest and packaging

`manifest.json`:
```json
{
  "name": "HyperFrames Feedback",
  "author": "HyperFrames",
  "entry": "dist/extension.js",
  "version": "0.1.0",
  "minimumApiVersion": "1.0.0"
}
```
- `entry` points at the single bundled CJS file.
- `package.json` **must** also have `"main": "dist/extension.js"` — without it the
  ExtensionHost handshake times out.

Packaging (`npm run package:ext`):
```
extensions-cli package -o dist/hyperframes-feedback.ablx -i panel -i templates .
```
- `-i panel -i templates` includes those directories in the `.ablx` (a zip). Note: even
  though they're in the package, the sandbox forbids reading them at runtime — they're
  included for completeness/inspection; the code uses the inlined copies. Fixture files
  (`timeline.json`, `audio.wav`, etc.) are deleted before packaging so they never ship.

---

## 5. The polyfill layer (why the SDK loads at all)

Three cooperating pieces install missing globals, in strict order.

**(a) esbuild banner** (`tools/build-extension.mjs`) — runs first, before any bundled module.
It restores globals that *are* available from Node built-ins via `require`:
```js
pick('node:util', ['TextEncoder','TextDecoder']);
pick('node:url', ['URL','URLSearchParams']);
pick('node:buffer', ['Blob','File','atob','btoa']);
pick('node:stream/web', ['ReadableStream','WritableStream','TransformStream', …]);
pick('node:perf_hooks', ['performance','PerformanceObserver']);
pick('node:worker_threads', ['MessageChannel','MessagePort','BroadcastChannel']);
```

**(b) `src/webglobals.ts`** — imported first inside the bundle. Covers globals the host omits
that have **no requireable Node source** (they're "global only"): `Event`, `EventTarget`
(from `event-target-shim`), `AbortController`, `AbortSignal` (from `abort-controller`), plus a
minimal `DOMException` subclass and a JSON-based `structuredClone`.

**(c) `src/polyfill.ts`** — imported first in `main.ts` (`import './polyfill'` on line 1).
Imports `webglobals` first, then installs the **fetch family** from bundled **undici**
(`fetch`, `Headers`, `Request`, `Response`, `FormData`) and `Blob`/`File` from `node:buffer`.
The Anthropic SDK needs `fetch`; the host doesn't provide it, so undici (the library Node's
own fetch is built on) is bundled and installed as globals.

**Ordering is load-bearing:** `main.ts` line 1 is `import './polyfill'`, and polyfill's line 1
is `import './webglobals'`. If the Anthropic SDK module evaluates before these globals exist,
you get `Headers is not defined` at load.

**`tools/load-check.cjs`** validates all of this **offline**: it deletes ~24 globals from
`globalThis` to simulate the host, then `require()`s the built bundle. If it prints
`LOADED OK; exports: activate`, your polyfills cover every load-time global — no Ableton
round-trip needed to catch a missing one. Run it after every build.

---

## 6. The build pipeline

```
npm run build:ext   → node tools/build-extension.mjs
```
1. `execFileSync('node', ['tools/gen-template-assets.mjs'])` — reads every file listed in
   `gen-template-assets.mjs`'s `STYLES` map plus `panel/index.html` and `gsap.min.js`, and
   writes `src/templateAssets.generated.ts` exporting:
   - `TEMPLATE_ASSETS: Record<style, Record<filename, contents>>`
   - `STUDIO_HTML: string` (the panel HTML)
   - `GSAP_MIN: string` (bundled GSAP for authored compositions)
2. esbuild bundles `src/main.ts` → `dist/extension.js`:
   - `format: 'cjs'`, `platform: 'node'`, `bundle: true` (the Ableton SDK and all deps are
     inlined), `banner` = the polyfill IIFE, `minify` in `--production`.

`package:ext` runs the production build, strips fixtures, then `extensions-cli package`.

**Why inline the templates?** Because of the filesystem sandbox (§3): the extension cannot
read its own install dir at runtime. So all HTML/JS assets are baked into the bundle as
strings and written into the work dir from memory during staging.

---

## 7. The SDK adapter (`liveAdapter.ts`) in depth

### Initialization
```ts
ctx = initialize(activation as ActivationContext, '1.0.0');
```
`bindActivation(activation: unknown)` takes `unknown` so `main.ts` never imports an SDK type.
`ctx` (an `ExtensionContext`) is the handle to everything: `ctx.application.song`,
`ctx.commands`, `ctx.ui`, `ctx.resources`, `ctx.environment`, `ctx.getObjectFromHandle`.

### Commands + context-menu actions
```ts
ctx.commands.registerCommand(commandId, (...args) => onInvoke(args[0]));
await ctx.ui.registerContextMenuAction(scope, title, commandId); // per scope
```
- A **command** is an id + callback. A **context-menu action** binds a `(scope, title,
  commandId)` so the item appears when the user right-clicks that scope.
- `registerContextMenuAction` returns an **unregister** function; keep them to tear down.
- The callback's first arg is the **target** — its type depends on the scope (below).

### Context-menu scopes (all object-anchored — there is NO global trigger)
Available scopes: `MidiClip`, `AudioClip`, `ClipSlot`, `ClipSlotSelection`, `MidiTrack`,
`AudioTrack`, `Scene`, `MidiTrack.ArrangementSelection`, `AudioTrack.ArrangementSelection`.
There is no "whole application" menu — every action hangs off an object. To get a
"whole project" gesture, register on `*.ArrangementSelection` and let the user select across
all tracks (select-all = whole song). This extension uses:
- `CLIP_SCOPES` (clip/track/arrangement) for **Render Video**.
- `PROJECT_SCOPES` (`*.ArrangementSelection` only) for **Feedback**, so it never appears on a
  single clip.
- The union for **Manage API Keys** so it's reachable from any right-click.

### Resolving the target → `SelectionContext`
`getSelection(targetArg: unknown)` branches on the runtime shape:
- **ArrangementSelection** (`'selected_lanes' in x`): `time_selection_start/end` (beats) and
  `selected_lanes` handles → resolve each to a `Track` via `ctx.getObjectFromHandle(h, Track)`.
- **ClipSlotSelection** (`'selected_clip_slots' in x`): first slot holding a clip.
- Otherwise a **Handle**: `ctx.getObjectFromHandle(arg, DataModelObject)` then `instanceof`
  checks (`Clip` → clip; `ClipSlot` → its clip; `Track` → arrangement span of its clips).

`ctx.getObjectFromHandle(handle, Class)` is the core "rehydrate a live object from an opaque
handle" call. You pass the class you expect; you get a typed live object whose properties
re-read from the Set.

### Data readers
`getNotes`, `getTempoMap`, `getTimeSignatures`, `getMarkers`, `getTracks`, `getProjectSummary`.
Known SDK gaps (documented at the top of the file) that shape these:
- **No automation/envelope API** → `getAutomation()` returns `{}`.
- **Static tempo only** → one-point tempo map from `song.tempo`.
- **No song-level time signature** → hardcoded `4/4`.
- **No track color** → colors are read from **clips** instead.

### ⚠️ The BigInt trap (critical)
> Integer values cross the SDK bindings as **BigInt** even where the TypeDoc says `number`
> (first seen on `Clip.color`, also note times/pitch/velocity). A stray BigInt crashes
> `JSON.stringify` ("Cannot mix BigInt and other types").

Every integral read goes through:
```ts
function num(v: number | bigint | undefined, fallback = 0): number {
  return v === undefined ? fallback : Number(v);
}
```
Do this **at the boundary**, before any math or serialization. `colorToHex` and
`clampVelocity` are built on `num`.

### Environment, UI, delivery
- `storageDirectory()` / `tempDirectory()` → `ctx.environment.*` (the only writable dirs).
- `showStudioDialog(url,w,h)` → `ctx.ui.showModalDialog(url,w,h)`; resolves with the string the
  dialog posts (§10).
- `withProgress(text, fn)` → `ctx.ui.withinProgressDialog`; `fn(report, signal)` where
  `report(pct?, text?)` updates the bar (undefined pct = indeterminate) and `signal` aborts on
  user-cancel — thread it into cancellable work (cloud polling).
- `deliverIntoProject(path)` → `ctx.resources.importIntoProject(path)` copies the finished MP4
  into the Live project and returns the imported path.
- `revealFile` / `openFile` spawn native `open`/`explorer`/`xdg-open` (static import of
  `spawn` — never dynamic).

---

## 8. The data contract (`Timeline`) and the exporter

`exporter.ts` is pure orchestration (no SDK, no render). It fans out the adapter reads with
`Promise.all`, bounces audio, computes duration via `TimeBridge`, assembles a `Timeline`, and
writes `timeline.json` + `audio.wav` into a fresh work dir.

`Timeline` (see `types.ts`) is the single source of truth passed to the renderer:
```
formatVersion, meta{title,clipColor,exportedAt,sourceScope,…},
timing{durationBeats, tempoMap[], timeSignatures[]},
audio{file, durationSeconds, offsetBeats},
notes[], automation{}, markers[], tracks[],
video{width, height, fps, style, mappings}
```

### TimeBridge — deterministic time mapping
The renderer is seeked by **time in seconds**, but musical data is in **beats**. `TimeBridge`
converts between beats↔seconds↔frames, ramp-aware across a tempo map, with the anchor
`beat 0 === second 0 === frame 0 === start of the exported region`. It compiles for both Node
(the exporter) and the browser (the pulse template bundles it as `timebridge.browser.js` via a
separate esbuild IIFE build). A subtle fixed bug: `segmentAt` must return the **last** tempo
point past the final anchor, or tempo after the last point is wrong.

---

## 9. Rendering (`render.ts`)

### Bundle staging
`stageBundle(job)` writes the composition into the work dir:
- If `job.prestaged` (a Claude-authored composition already sitting in the work dir), it does
  **nothing** — the dir is already complete.
- Otherwise it writes every file from `TEMPLATE_ASSETS[style]` (from memory, not disk),
  patches the composition's `data-duration`/`data-width`/`data-height` (HyperFrames reads
  size/duration from the **HTML**, not CLI flags), inlines the timeline as
  `window.TIMELINE = …` in `timeline.js`, writes `meta.json`, and writes any `injectScripts`
  (e.g. `feedback.js` setting `window.FEEDBACK`).

### `renderLocal` — dev host only
`npx -y hyperframes render <dir> --output out.mp4 --fps N --quiet`. Works only where there's no
Node sandbox (§3). The `run()` helper: augments `PATH` with common tool dirs, **deletes
`NODE_OPTIONS`** for children, and **captures stdout/stderr** so a child failure surfaces the
real reason (inherited stdio would be lost — the host only logs the extension's own console).

### `renderCloud` — the shipped path
HyperFrames Cloud is a **HeyGen-hosted** service (`https://api.heygen.com`), authed with an
`x-api-key`. The flow, replicated exactly from the `hyperframes` CLI (do **not** guess the
request shapes — the inline-base64 form is undocumented and rejected):

1. **Zip** the work dir (native `zip` binary — fine as a child).
2. **Direct-to-S3 upload** (`uploadProjectZip`):
   - `POST /v3/assets/direct-uploads` with `{filename, content_type:"application/zip",
     size_bytes, checksum_sha256}` → `{asset_id, upload_url, upload_headers}`.
   - `PUT` the bytes to `upload_url` — the presigned S3 URL, **no `x-api-key`** on this request,
     forward `upload_headers`.
   - `POST /v3/assets/{asset_id}/complete` with `{checksum_sha256}`; **retry on HTTP 409**
     (asset not yet visible), up to 5×.
3. **Submit render**: `POST /v3/hyperframes/renders` with
   `{project:{type:"asset_id", asset_id}, fps, format:"mp4", title}` → `{render_id}`.
4. **Poll** `GET /v3/hyperframes/renders/{render_id}` every 5s until `status:"completed"`
   (then download `video_url`) or `"failed"`. Thread the `AbortSignal` so cancel works.

Billing note: the Anthropic API (review + authoring) and HeyGen (rendering) are **separate
accounts with separate credits**. A render costs HeyGen API credits (HTTP 402
`insufficient_credit` if short).

---

## 10. UI dialogs — the `data:` URL + `close_and_send` pattern

The host's WebView will **not** load an `http://localhost` page in a modal (it renders blank).
The proven path is a self-contained **`data:text/html,` URL** with everything inline:
```ts
const html = `<!doctype html>…<button onclick="post('reveal')">Reveal</button>
  <script>function post(v){
    (window.webkit?.messageHandlers?.live || window.chrome?.webview)
      .postMessage({method:'close_and_send', params:[v]})
  }</script>`;
const answer = await live.showStudioDialog('data:text/html,' + encodeURIComponent(html), w, h);
```
- The bridge is `window.webkit.messageHandlers.live` (macOS) / `window.chrome.webview`
  (Windows). Posting `{method:'close_and_send', params:[str]}` closes the dialog and resolves
  `showModalDialog` with `str`.
- To pass data **into** the dialog, string-replace a token in the HTML before encoding
  (`STUDIO_HTML.replace('null /*__STUDIO_DATA__*/', JSON.stringify(data))`). Keep the token a
  valid JS literal so the page parses even un-injected.
- Every dialog in `main.ts` (key prompts, key settings, done, error) follows this pattern.
  Cancel posts `''` → `JSON.parse` fails → treated as "no decision".

---

## 11. The AI feature — review, then author, then self-repair

### 11a. The review (`feedback.ts`)
- Model: **`claude-opus-4-8`**, `thinking:{type:'adaptive'}`, **streaming**
  (`client.messages.stream(...).finalMessage()`).
- **Structured output**: `output_config:{format:{type:'json_schema', schema:FEEDBACK_SCHEMA}}`
  forces valid JSON matching `FeedbackReport` (`feedbackTypes.ts`). Always check
  `message.stop_reason === 'refusal'` before reading content.
- Input is the compact `ProjectSummary` from `getProjectSummary` — note counts, per-track
  color/devices/density, pitch range, sections. **No raw notes, no audio** — small and cheap.

### 11b. Authoring the composition (`composer.ts`) — "make me a video"
Instead of a fixed template, **Claude writes the HyperFrames composition** from the review:
1. `authorHtml` — a Claude call whose **system prompt is the HyperFrames authoring contract**
   (the hard rules from the `hyperframes-core` skill — see §12). It returns one self-contained
   `index.html`. GSAP is provided locally (`gsap.min.js`, from `GSAP_MIN`), so no CDN.
2. **Lint-fix loop** (up to 3 rounds): write the HTML, run
   `npx hyperframes lint <dir> --json`, parse `findings`, and for each `severity:"error"` feed
   `{code, message, fixHint, snippet}` back to Claude to repair. This catches real mistakes
   (e.g. `root_composition_missing_data_start`) the model makes.
3. If it can't be made clean, **throw** → the caller falls back to the fixed
   `project-feedback` template so the user always gets a video.

The authored composition is rendered via the `prestaged` path (§9): the work dir already holds
`index.html` + `gsap.min.js` + `meta.json`, so `stageBundle` skips staging.

---

## 12. HyperFrames composition conventions (what the renderer requires)

The renderer **seeks the composition frame-by-frame**; every frame must be reproducible from
its time value alone. Two valid animation drivers, and the choice matters:

### DOM composition → a real, paused GSAP timeline
```html
<div id="root" data-composition-id="main" data-start="0"
     data-width="1080" data-height="1920" data-duration="17.6"> … </div>
<script src="./gsap.min.js"></script>
<script>
  window.__timelines = window.__timelines || {};
  const tl = gsap.timeline({ paused: true });
  tl.to(/* … */);
  window.__timelines['main'] = tl;      // key === data-composition-id
</script>
```
- Exactly **one** paused timeline, built **synchronously** at load, registered on
  `window.__timelines[id]`. The renderer calls `tl.totalTime(t)` per frame.
- **Critical lesson:** the renderer only dispatches the `hf-seek` event for **canvas** comps.
  A DOM comp with only a *stub* timeline renders **frozen** — you must expose a real GSAP
  timeline. (We shipped a hand-rolled `hf-seek` DOM template that rendered a static first
  frame before switching to GSAP.)
- Root needs `data-start="0"` **and** `data-duration`; every timed element is a clip
  (`class="clip"` + `data-start` + `data-duration` + `data-track-index`); build the visible
  end-state in static HTML/CSS then animate from/to it.

### Canvas composition → the `hf-seek` event (what `pulse-waveform` uses)
```js
window.__timelines['main'] = { /* stub with the methods the seek helper probes */ };
window.addEventListener('hf-seek', (e) => renderFrame(e.detail.time)); // time in SECONDS
```
- `pulse-waveform` draws to a `<canvas>` and is driven purely by `hf-seek` (`detail.time` is
  seconds). It bundles `TimeBridge` in the browser to map seconds→beats and draw notes.

### Determinism bans (lint won't catch all of these)
No `Date.now`/`performance.now`/any render clock; no unseeded `Math.random`; no network
fetch; no hover/scroll/pointer state; no `repeat:-1` (use a finite count); animate **only** the
visual allowlist (`opacity,x,y,scale,rotation,color,backgroundColor,borderRadius,transforms`);
never animate `display`/`visibility`. A dev-preview loop (using `performance.now`) is fine only
if it **bails the moment the renderer is present** — otherwise it competes with capture.

---

## 13. Key management

- Two keys, each stored as a plain file in `storageDirectory()`: `anthropic-key`,
  `heygen-key`. Resolution order for each: explicit arg → env var (`ANTHROPIC_API_KEY`;
  `HEYGEN_API_KEY`/`HYPERFRAMES_API_KEY`) → stored file.
- If missing at point of use, a `data:` URL dialog prompts for it and persists it (mode
  `0600`). The user is told never to paste keys into a chat.
- **Manage API Keys…** command opens a settings dialog: shows each key's status
  (`keyStatus()`), lets the user set a new value (blank = keep) or tick "remove the stored
  key" (`clearStoredKey()`). Registered on all scopes for discoverability.

---

## 14. End-to-end flow: the feedback video

```
right-click arrangement selection → "Create Feedback Video from Selection…"
  main.runFeedbackSession(targetArg)
   ├─ live.getSelection(targetArg)                       # SDK: resolve selection
   ├─ live.getProjectSummary(sel)                        # SDK: compact summary (BigInt-safe)
   ├─ resolveApiKey / promptForApiKey                    # Anthropic key
   ├─ withProgress("Asking Claude…"):
   │    feedback.generateFeedback(summary, key)          # Claude → FeedbackReport (JSON schema)
   ├─ withProgress("Building your feedback video…"):
   │    composer.authorFeedbackComposition(...)          # Claude authors index.html
   │      └─ loop: hyperframes lint --json → fix          #   self-repair (dev host only:
   │                                                       #   lint is Node → managed host can't;
   │                                                       #   see caveat below)
   │      → writes index.html + gsap.min.js + meta.json to workDir (prestaged)
   │    (on failure) fall back to fixed project-feedback template
   ├─ runRenderJob(job, "Rendering feedback video…")
   │    ├─ resolveHeyGenKey / promptForHeyGenKey
   │    ├─ withProgress: renderCloud(job, key)           # zip → S3 upload → submit → poll → mp4
   │    ├─ live.deliverIntoProject(mp4)                  # SDK: import into the set
   │    └─ done dialog → Reveal / Open
```

> **Caveat worth knowing:** `composer` shells out to `hyperframes lint` (a Node CLI), which —
> like local render — cannot run under the managed host's Node sandbox. On the managed host the
> lint step returns no findings (its `runCapture` swallows the failure and returns `[]`), so the
> composition is rendered unlinted and relies on the authoring prompt's rules + the Cloud
> renderer's own tolerance. On the dev host, lint-fix runs for real. If you want lint-fix in the
> managed host, you'd move linting to an in-process validator or a Cloud endpoint.

---

## 15. A checklist for building your own HyperFrames extension

1. **Scaffold**: `manifest.json` (+ `package.json` `"main"`), `src/main.ts` with
   `import './polyfill'` on line 1, one `liveAdapter.ts` that is the *only* SDK importer.
2. **Polyfills**: copy `webglobals.ts` + `polyfill.ts` + the esbuild banner verbatim if you use
   `fetch`/the Anthropic SDK. Add `load-check.cjs` and run it after every build.
3. **Respect the sandbox from day one**: work dirs under `tempDirectory()`; persist under
   `storageDirectory()`; **inline** any asset you need to read (a `gen-*-assets.mjs` step);
   **no dynamic `import()`**; assume you cannot spawn a Node child usefully.
4. **Coerce every integer read through `num()`** at the SDK boundary (BigInt trap).
5. **Pick scopes deliberately**: object-anchored only; use `*.ArrangementSelection` for
   "whole project" gestures. Keep unregister functions.
6. **Dialogs**: `data:text/html,` URLs + `close_and_send`; never `http://localhost`.
7. **Compositions**: DOM → one paused GSAP timeline on `window.__timelines[id]`; canvas →
   `hf-seek` with seconds. Obey the determinism bans. Root needs `data-start="0"` +
   `data-duration`.
8. **Render via Cloud** for the shipped path (local render is dev-only). Replicate the CLI's
   `direct-uploads → PUT → complete → renders` flow exactly; don't invent request shapes.
9. **Two separate billings**: Anthropic (LLM) and HeyGen (render). Prompt/persist both keys;
   surface 402/insufficient-credit clearly.
10. **Diagnose in the managed host** by capturing child output and logging to the extension's
    own console — it lands in Live's `ExtensionHost.txt`
    (`~/Library/Preferences/Ableton/Live <ver>/ExtensionHost.txt` on macOS). Inherited stdio is
    invisible there.

---

## 16. Appendix: the bugs we hit (and the fix), as a cautionary list

| Symptom | Root cause | Fix |
|---|---|---|
| ExtensionHost handshake timeout | `package.json` missing `"main"` | add `"main":"dist/extension.js"` |
| `Cannot mix BigInt and other types` | SDK returns BigInt where TypeDoc says number | `num()` at every integer read |
| Session clip right-click did nothing | it fires `ClipSlotSelection`, not `MidiClip` | register `ClipSlot`/`ClipSlotSelection` |
| Modal loads blank / resolves empty | `http://localhost` won't load in the WebView | `data:` URL + `close_and_send` |
| `Headers is not defined` at load | host strips the fetch family | undici + polyfill, imported first |
| `ERR_ACCESS_DENIED … /tmp` | filesystem sandbox on writes | route work dirs through `tempDirectory()` |
| `--allow-fs-read` reading templates | sandbox forbids reading the install dir | inline assets → `templateAssets.generated.ts` |
| Feedback video renders frozen | DOM comp needs a real GSAP timeline (hf-seek is canvas-only) | build a paused `window.__timelines['main']` |
| `npx exited with 1` (ERR_ACCESS_DENIED on npx-cli.js) | Node permission model inherited by child Node | can't fix locally → use Cloud render |
| Cloud `400 project.base64.media_type` | inline-base64 project shape is undocumented/wrong | use the CLI's `direct-uploads` asset flow |
| Cloud `402 insufficient_credit` | HeyGen credits (separate from Anthropic) | top up HeyGen API credits |
| `A dynamic import callback was not specified` | bundled host can't do runtime `import()` | static top-level imports only |
```
