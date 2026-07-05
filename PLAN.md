# PLAN.md — continuation plan for Clip2Video

Written 2026-07-05 by the previous agent for whoever continues. Follow it in
order. When this plan and `AGENT_INSTRUCTIONS.md` disagree, AGENT_INSTRUCTIONS
wins — read it fully before doing anything.

---

## 0. Environment (do this first, every session)

Node is NOT on the default PATH. It is a user-local install. Start every shell
with:

```bash
export PATH="$HOME/.local/node/node-v24.18.0-darwin-arm64/bin:$PATH"
cd /Users/ttt/Downloads/clip2video-handoff
```

Already done — do not redo: `npm install` (node_modules exists), git repo
initialized. Verify you are green before changing anything:

```bash
npx tsc --noEmit        # must print nothing, exit 0
npx vitest run          # must show 26 passed
```

If either fails, STOP and fix that first — the last commit was green.

Commit convention: small commits, message explains why, ending with
`Co-Authored-By:` line matching `git log`.

## 1. State: what is already done (do not redo)

Git history tells the story — `git log --oneline`:

- `9a64323` pristine handoff skeleton as received
- `fbecfec` toolchain (package.json, tsconfig, vitest) + `test/timebridge.test.ts`
  (26 tests) + a real bug fix in `src/timebridge.ts` `segmentAt` (binary search
  now may return the LAST tempo point so tempo holds past the map; before, the
  second-to-last segment's tempo/ramp extrapolated forever)
- `3f83f93` handoff debts paid:
  - `src/exporter.ts` and the template use TimeBridge; both local
    reimplementations of beat/second math are DELETED
  - `templates/pulse-waveform/timebridge.browser.js` is a build artifact,
    committed; regenerate with `npm run build:template-lib` whenever
    `src/timebridge.ts` changes
  - `src/types.ts` re-exports `TempoPoint`/`WarpMarker` from timebridge
  - `src/main.ts` reworked to run-once command model (right-click → resolve
    handle → export → modal studio dialog → message bridge → progress dialog).
    SDK call signatures are still PLACEHOLDERS pending Milestone 0.
  - `src/liveAdapter.ts` gained `bindContext`, `getSelection(targetHandle?)`,
    `openStudioDialog`, `withProgress` — all placeholder SDK calls
  - `src/studioProtocol.ts` — versioned Node↔WebView message types (§7)
  - `src/exporter.ts` signature is now `exportSelection(sel, req)` (caller
    resolves selection once and holds it)
  - `templates/pulse-waveform/template.json` manifest; `gridDensity` param
    implemented in the template (was documented but missing)
  - `src/render.ts` `renderCloud(job, apiKey, onProgress?)` — still throws;
    real API is VERIFY item 8 (ask the user)

## 2. Invariants — never violate these

1. **Never write time math outside `src/timebridge.ts`.** No `* 60 / bpm`
   anywhere else. Consumers construct `new TimeBridge(tempoMap)`.
2. **Only `src/liveAdapter.ts` may touch the Ableton SDK** (including UI
   dialogs). `main.ts` imports the adapter, never the SDK.
3. **Events stay in beats** in timeline.json. Convert at the last moment.
4. **Templates: every pixel is a pure function of `t`.** No rAF state, no
   accumulators, no `Math.random()` at draw time.
5. Schema (`schema/timeline.schema.json`), types (`src/types.ts`), example
   (`examples/timeline.example.json`) change together + bump `formatVersion`
   + record why in DECISIONS.md.
6. The `any`-typed `ctx`/`ableton`/`dlg` in liveAdapter are INTENTIONAL
   placeholders for the unverified SDK — do not "clean them up".
7. **Ask the user, don't guess:** HyperFrames endpoints/auth/seek-hook,
   payment flows, credentials (AGENT_INSTRUCTIONS §13).

## 3. NEXT TASK (was in progress): exporter tests + schema validation

Create `test/exporter.test.ts`. Steps:

1. `npm install -D ajv-formats` (the schema uses `"format": "date-time"`;
   plain ajv v8 doesn't know it).
2. Mock the adapter BEFORE importing the exporter (vitest hoists `vi.mock`):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

vi.mock('../src/liveAdapter', () => ({
  getTempoMap: vi.fn(async () => [
    { beat: 0, bpm: 120, ramp: true },
    { beat: 8, bpm: 90 },
  ]),
  getTimeSignatures: vi.fn(async () => [{ beat: 0, numerator: 4, denominator: 4 }]),
  getNotes: vi.fn(async () => [
    { pitch: 36, startBeat: 0, lengthBeats: 0.5, velocity: 100 },
    { pitch: 38, startBeat: 1, lengthBeats: 0.5, velocity: 90 },
  ]),
  getAutomation: vi.fn(async () => ({})),
  getMarkers: vi.fn(async () => []),
  getTracks: vi.fn(async () => []),
  bounceAudio: vi.fn(async (_sel: unknown, outPath: string) => outPath),
}));

import { exportSelection } from '../src/exporter';
import { TimeBridge } from '../src/timebridge';
```

3. Build a `sel` (`SelectionContext` shape: scope/clipName/clipColor/isMidi/
   startBeat/durationBeats) and a `req` with
   `outputDir: await fs.mkdtemp(path.join(os.tmpdir(), 'c2v-'))`.
4. Assertions to write, each its own `it`:
   - `timeline.json` exists at `result.timelinePath` and parses.
   - Timeline validates against `schema/timeline.schema.json` via
     `new Ajv({ allErrors: true })` + `addFormats(ajv)`. On failure print
     `ajv.errors`.
   - `examples/timeline.example.json` ALSO validates against the schema
     (separate `it`, no mocks needed).
   - `timeline.audio.durationSeconds` equals
     `new TimeBridge(tempoMap).beatsToSeconds(sel.durationBeats)` (closeTo 12) —
     the tempo map above has a ramp, so this catches any re-derivation drift.
   - `timeline.video` width/height match the aspect table (9:16 → 1080×1920).
   - When `bounceAudio` mock returns `null`, `result.audioPath` is `null`
     (use `vi.mocked(live.bounceAudio).mockResolvedValueOnce(null)`).
5. `npx vitest run` → all green (26 + new). `npx tsc --noEmit` clean. Commit:
   "Exporter tests: schema-valid output, TimeBridge-derived duration, bounce fallback".

## 4. THEN: DECISIONS.md (required by AGENT_INSTRUCTIONS §2)

Create `DECISIONS.md` at repo root with two sections:

**Decisions so far** — record these five, one short paragraph each:
1. TimeBridge `segmentAt` bug found by tests and fixed (past-the-map tempo
   hold); doc said "final unless tests find a bug" — tests did.
2. `types.ts` re-exports `TempoPoint`/`WarpMarker` from `timebridge.ts`
   (one-definition rule extended to types).
3. `exportSelection(sel, req)` takes the resolved selection so the run-once
   session can hold live handles for refresh-from-Set.
4. SDK UI primitives quarantined in liveAdapter (`openStudioDialog`,
   `withProgress`) to preserve the only-one-SDK-file rule.
5. `gridDensity` implemented in pulse-waveform (was documented-but-missing);
   manifest `template.json` added, params list matches what `renderFrame`
   actually reads.

**VERIFY items** — a table of the 8 items from AGENT_INSTRUCTIONS §2, all
status OPEN, empty "answer/citation" column. These CANNOT be resolved from
this machine alone (see §6 below).

Also update `README.md`: layout table (add `studioProtocol.ts`, `PLAN.md`,
`DECISIONS.md`, `template.json`, `test/`), the dev-without-Live section
(mention `npm test`, `npm run build:template-lib`, and the PATH export), and
change the stale "panel" wording to "studio dialog".

Commit. This completes everything doable without the user.

## 5. STOP — blocked on the user. Ask these questions

Do NOT guess any of these. Present them to the user:

1. **HyperFrames Cloud API** (VERIFY 8; they develop HyperFrames): render
   endpoint + request shape, auth scheme, job polling/download lifecycle, and
   the template seek-hook convention (template currently exposes
   `window.renderFrame(seconds)` — confirm or rename). Also exact local CLI
   flags to check `renderLocal` in `src/render.ts`.
2. **Ableton Extensions SDK bundle** (Milestone 0): the SDK zip comes from
   Ableton's Centercode beta program and needs their login. Ask the user to
   download it (and Live 12.4.5+ beta — note: `~/Downloads` only has the
   12.4.2 installer, which is too old). Once the zip is on disk, unpack it and
   resolve all 8 VERIFY items against `api/` TypeDoc + `examples/`, recording
   each answer with a citation in DECISIONS.md.
3. **API key handling**: `main.ts` `requireApiKey()` currently reads
   `HYPERFRAMES_API_KEY` env var as a stopgap — ask how credentials should
   really work (account link in the studio? per-render token?).

## 6. AFTER the user answers (Milestone order, from AGENT_INSTRUCTIONS §10)

1. **M0 remainder:** rewrite `src/liveAdapter.ts` against the real TypeDoc,
   preserving its exported interface exactly; add `getWarpMarkers(clip)`; fix
   `main.ts` `activate()`/registration signatures; record every VERIFY answer.
2. **M1:** real export from a right-clicked MIDI clip; browser dev-preview of
   the template against a real export ("Develop the template without Live" in
   README). Acceptance: schema-valid JSON; kick pattern pulses at the right
   moments; tests green.
3. **M2:** implement `renderCloud` against the real API; one-shot render path;
   determinism + ±1-frame sync acceptance checks (§10 M2).
4. **M3:** build the studio UI in `panel/index.html` per §7 (WebAudio-clocked
   preview of the SAME template, scrub bar, dual bars.beats/frames ruler via
   TimeBridge browser bundle, mapping rows generated from `availableStyles`
   manifests, refresh-from-Set button wired to the `refreshFromSet` message).
   The message protocol is already defined in `src/studioProtocol.ts` — build
   against it; bump its version per its header rules if it must change.
5. **M4:** `src/cueImporter.ts` + `schema/cuesheet.schema.json` per §9.

## 7. Known traps

- Shell state does not persist between tool calls in some harnesses — re-export
  PATH in each command, or chain with `&&`.
- `npx vitest` (watch mode) hangs a non-interactive shell; always `vitest run`.
- If you change `src/timebridge.ts`, run `npm run build:template-lib` and
  commit the regenerated `timebridge.browser.js` too, or template and Node
  math silently diverge — the exact drift this project forbids.
- `panel/index.html` is still the OLD prototype panel (pre-studio). It does
  not speak `studioProtocol` yet — that is M3 work, not a bug to hotfix.
- `.gitignore` excludes `templates/*/timeline.json` and `audio.wav` — those are
  dev fixtures copied in by hand; never commit them.
- The repo lives in `~/Downloads/clip2video-handoff` — suggest the user move it
  somewhere permanent (e.g. `~/code/clip2video`) but don't move it unasked.
