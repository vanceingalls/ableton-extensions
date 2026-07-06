# Ableton Extensions SDK 1.0.0-beta.0 — confirmed API (TypeDoc)

Source: `~/Downloads/extensions-sdk-1.0.0-beta.0/api/` (TypeDoc HTML), verified
2026-07-05. This supersedes the binary-strings evidence in sdk-api-notes.md
where they differ. File paths below are relative to that `api/` dir.

## Entry + context

```ts
// extension exports activate(context: ActivationContext)
initialize<V extends "1.0.0">(context: ActivationContext, apiVersion: V): ExtensionContext<V>

interface ExtensionContext<V> {
  application: Application<V>;   // .song → Song
  commands: Commands<V>;         // registerCommand(commandId, cb) / executeCommand
  environment: Environment<V>;   // .language, .storageDirectory, .tempDirectory
  resources: Resources<V>;       // importIntoProject, renderPreFxAudio
  ui: Ui<V>;                     // registerContextMenuAction, showModalDialog, withinProgressDialog
  getObjectFromHandle<T>(handle: Handle, type: new (...a: never) => T): T;
  withinTransaction<T>(fn: () => T): T;  // sync callback; return Promise.all([...]) to group async
}
interface Handle { id: bigint }
```

## Context menu (functions/initialize.html, classes/Ui.html, types/ContextMenuScope.html)

```ts
ui.registerContextMenuAction(scope: ContextMenuScope, title: string, commandId: string)
  : Promise<() => Promise<void>>  // unregister fn

type ContextMenuScope =
  | "AudioClip" | "MidiClip" | "AudioTrack" | "MidiTrack"
  | "ClipSlot" | "DrumRack" | "Sample" | "Scene" | "Simpler"
  | "ClipSlotSelection"
  | "AudioTrack.ArrangementSelection" | "MidiTrack.ArrangementSelection";
```

Command callback arg[0] by scope: object scopes → `Handle`;
`ClipSlotSelection` → `{ selected_clip_slots: Handle[] }`;
`*.ArrangementSelection` → `{ selected_lanes: Handle[],
time_selection_start: number, time_selection_end: number }` (beats).

## Data model

- **Song**: `tempo` (scalar get/set — NO tempo map/automation anywhere),
  `tracks`, `returnTracks`, `mainTrack: Track`, `scenes`, `cuePoints`,
  `createCuePoint(timeBeats): Promise<CuePoint>`, `deleteCuePoint(cp)`,
  `createAudioTrack/createMidiTrack/createScene`, `gridQuantization`,
  `gridIsTriplet`, `rootNote`, `scale*`.
- **Track**: `name`, `arm`, `mute`, `solo`, `mutedViaSolo`,
  `arrangementClips: Clip[]`, `clipSlots`, `devices`, `groupTrack`, `mixer`,
  `takeLanes`; `clearClipsInRange`, `deleteClip`, device CRUD. **No color.**
- **Clip** (base): `name`, `color: number`, `muted`, `looping`,
  read-only `duration`, `startTime`, `endTime`, `startMarker`, `endMarker`,
  `loopStart`, `loopEnd`.
- **MidiClip extends Clip**: `notes: NoteDescription[]` (get/set).
  ```ts
  type NoteDescription = {
    pitch: number; startTime: number; duration: number;
    velocity?: number; muted?: boolean; probability?: number;
    releaseVelocity?: number; selected?: boolean; velocityDeviation?: number;
  }
  ```
- **AudioClip extends Clip**: `warping`, `warpMode`,
  `warpMarkers: WarpMarker[]` (read-only), `filePath`.
  `interface WarpMarker { beatTime: number; sampleTime: number }` — matches
  timebridge.ts exactly.
- **CuePoint**: `name` (get/set), `time` (get only, beats).

## Services

```ts
resources.renderPreFxAudio(track: AudioTrack, startTime: number, endTime: number): Promise<string>
  // beats in, WAV path out (extension tempDirectory). PRE-FX. AudioTrack only
  // in the types; song.mainTrack is Track — whether the runtime accepts it is
  // the M1 experiment (pre-FX of main ≈ summed post-FX mix of all tracks).
resources.importIntoProject(filePath: string): Promise<string>  // copy into project, use returned path

ui.showModalDialog(url: string, width: number, height: number): Promise<string>
  // URL schemes: file:, data:, https:, http://localhost  ← loopback studio server is OFFICIAL
  // Dialog closes itself by posting {method:"close_and_send", params:[resultString]} to
  //   macOS:   window.webkit.messageHandlers.live.postMessage(...)
  //   Windows: window.chrome.webview.postMessage(...)
  // Promise resolves with that string.

ui.withinProgressDialog(
  text: string,
  options: { progress?: number },              // 0-100
  callback: (update: (text: string, progress?: number) => Promise<void>,
             abortSignal: AbortSignal) => Promise<unknown>,
): Promise<unknown>  // auto-closes when callback settles; abortSignal on user cancel
```

## Gaps confirmed (NOT in this SDK)

- Automation/envelope read of any kind; tempo map (scalar tempo only)
- Post-FX or master render; MIDI-track render (renderPreFxAudio is AudioTrack-typed)
- Track color; song-level time signature (scene-level only)
- Event/observer APIs (model is poll/read-based)

# HyperFrames — confirmed conventions (v0.7.36)

Verified via `npx hyperframes render --help`, `npx hyperframes docs …`,
`hyperframes init` scaffold, hyperframes.heygen.com docs, and the CLI bundle
source (npx cache).

- **Project**: dir with `index.html` (+ `hyperframes.json`, `meta.json`).
  Composition root: `<div data-composition-id data-start data-duration
  data-width data-height>`; timed elements need `class="clip"` +
  `data-start/data-duration/data-track-index`.
- **Audio**: `<audio class="clip" src data-start data-volume
  data-media-start>` elements are muxed into the render automatically.
- **Seek**: per frame the renderer seeks registered GSAP timelines
  (`window.__timelines[compositionId]`, paused), sets
  `document.getAnimations()` currentTime, and dispatches
  **`window CustomEvent "hf-seek" with detail:{time: seconds}`** — the hook
  for canvas-drawn pure-function-of-t templates. FrameAdapter contract
  {id, init, getDurationFrames, seekFrame, destroy} exists for full runtimes.
- **Local render**: `hyperframes render [DIR] -c <composition.html>
  -o <out.mp4> -f <fps>` (+ --quality, --resolution presets incl. portrait
  1080x1920 / square). Dimensions/duration come from the composition, NOT
  flags. Requires Chrome (puppeteer-core) + FFmpeg. `--docker` for
  bit-deterministic renders.
- **Cloud**: `hyperframes auth login` (OAuth PKCE or API key);
  `hyperframes cloud render` — or raw HTTP: `POST /v3/assets` (zipped
  project) → `POST /v3/hyperframes/renders` → poll
  `GET /v3/hyperframes/renders/{id}` → download presigned `video_url`.
  Keys: `HEYGEN_API_KEY` or `HYPERFRAMES_API_KEY` env, or
  `~/.heygen/credentials`. `--callback-url` webhook + `--no-wait` for
  fire-and-forget; `--idempotency-key` for safe retries.
- **Determinism rules**: no Date.now/Math.random/network fetches in
  compositions; `npx hyperframes lint` / `npm run check` enforces.
  (Our timeline.json should be INLINED into the composition at export time
  rather than fetched — verify with lint in M1.)
