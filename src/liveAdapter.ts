/**
 * liveAdapter.ts — the ONLY file that talks to the Ableton Extensions SDK.
 *
 * ⚠️ The Extensions SDK is a brand-new public beta (June 2026) and its exact API
 * surface is evolving. Every call below marked `SDK:` is a placeholder for the
 * real SDK function — check the official repo/docs and the #extensions channel
 * on Ableton's Discord, then update ONLY this file. Everything else in the
 * project depends on the clean interfaces here, not on the SDK directly.
 *
 * Known-unknowns to verify against the real beta:
 *   1. Can we programmatically bounce/export audio for a clip or the master?
 *      If not (likely in early beta), we fall back to asking the user to
 *      File > Export Audio manually and drop the file on the panel.
 *   2. How automation lanes are enumerated and read (per-clip envelopes vs.
 *      arrangement automation), and whether curve shapes are exposed.
 *   3. Whether locators/markers are readable in Session-only scope.
 */

import type {
  Note,
  AutomationLane,
  Marker,
  TempoPoint,
  TimeSignature,
  TrackInfo,
} from './types';

// Replace with the real import from the Extensions SDK, e.g.:
// import { getSelection, getSet } from '@ableton/extensions-sdk';
declare const ableton: any; // SDK: injected/imported SDK entry point

/**
 * SDK: the real entry point is `activate(context: ExtensionContext)` with
 * { application, commands, ui, resources, environment }. main.ts hands the
 * context here so every SDK touch stays inside this file.
 */
let ctx: any = null;
export function bindContext(extensionContext: unknown): void {
  ctx = extensionContext;
}

export interface SelectionContext {
  scope: 'clip' | 'track' | 'arrangement';
  clipName: string;
  clipColor: string; // "#rrggbb"
  isMidi: boolean;
  startBeat: number; // absolute Set position of the exported region
  durationBeats: number;
}

/** What did the user right-click? */
export async function getSelection(targetHandle?: unknown): Promise<SelectionContext> {
  // SDK: resolve the context-menu target the command was invoked on —
  // canonical pattern is getObjectFromHandle(targetHandle) (§2 confirmed).
  const target = targetHandle
    ? await ctx.application.getObjectFromHandle(targetHandle)
    : await ableton.selection.getTarget();
  return {
    scope: target.type, // 'clip' | 'track' | 'arrangement'
    clipName: target.name ?? 'Untitled',
    clipColor: rgbToHex(target.color),
    isMidi: target.isMidiClip ?? false,
    startBeat: target.startTime ?? 0,
    durationBeats: target.length ?? 0,
  };
}

export async function getTempoMap(): Promise<TempoPoint[]> {
  // VERIFY 3 RESOLVED (12.4.5b6 evidence): only static `song_get_tempo`
  // exists — no tempo-automation read. One-point map; TimeBridge handles it.
  const bpm = await ableton.song.getTempo(); // SDK: bindings.song_get_tempo
  return [{ beat: 0, bpm }];
}

export async function getTimeSignatures(): Promise<TimeSignature[]> {
  const [numerator, denominator] = await ableton.song.getTimeSignature(); // SDK
  return [{ beat: 0, numerator, denominator }];
}

/** All notes in the selected region, normalized so the region starts at beat 0. */
export async function getNotes(sel: SelectionContext): Promise<Note[]> {
  if (!sel.isMidi) return [];
  // SDK: clip.getNotes() or equivalent. Live exposes pitch, start, duration,
  // velocity, mute, probability per note in Live 12.
  const raw = await ableton.selection.getClip().getNotes();
  return raw
    .filter((n: any) => !n.muted)
    .map((n: any) => ({
      pitch: n.pitch,
      startBeat: n.startTime - 0, // clip-relative in most APIs; adjust if absolute
      lengthBeats: n.duration,
      velocity: n.velocity,
      probability: n.probability,
    }))
    .sort((a: Note, b: Note) => a.startBeat - b.startBeat);
}

/**
 * Enumerate readable automation lanes for the selection.
 * Returns breakpoints; if the SDK only exposes value-at-time queries, sample
 * at 1/16-note resolution instead and mark every point 'linear'.
 */
export async function getAutomation(
  sel: SelectionContext,
): Promise<Record<string, AutomationLane>> {
  // VERIFY 2 RESOLVED (12.4.5b6 evidence): NO automation/envelope bindings
  // exist in this beta — not even value-at-time. v1 ships without lane
  // mappings; the timeline keeps its `automation` field (schema is
  // forward-compatible) and the studio offers note-derived signals instead.
  // Re-check each SDK release; restore a real implementation when Ableton
  // exposes envelopes.
  return {};
}

export async function getMarkers(sel: SelectionContext): Promise<Marker[]> {
  if (sel.scope === 'clip') return [];
  // SDK: bindings.song_get_cue_points + cuepoint_get_time/get_name
  // (12.4.5b6 evidence). NOTE: no cue-point CREATE binding exists — the
  // M4 cue-sheet import needs a plan B if the SDK zip confirms that.
  const cuePoints = await ableton.song.getCuePoints();
  return cuePoints
    .filter((c: any) => c.time >= sel.startBeat && c.time < sel.startBeat + sel.durationBeats)
    .map((c: any) => ({ beat: c.time - sel.startBeat, label: c.name, kind: 'section' as const }));
}

/** Warped audio clips (VERIFY 6): bindings.audioclip_get_warp_markers exists
 *  in 12.4.5b6; exact marker field names TBD from the SDK TypeDoc. */
export async function getWarpMarkers(clipHandle: unknown): Promise<import('./timebridge').WarpMarker[]> {
  const raw = await ableton.audioClip.getWarpMarkers(clipHandle); // SDK
  return raw.map((m: any) => ({ sampleTime: m.sampleTime, beatTime: m.beatTime }));
}

export async function getTracks(): Promise<TrackInfo[]> {
  const tracks = await ableton.song.getTracks(); // SDK
  return tracks.map((t: any) => ({
    id: String(t.id),
    name: t.name,
    color: rgbToHex(t.color),
    kind: t.kind,
  }));
}

/**
 * Bounce the selection to a WAV on disk.
 * VERIFY 1 evidence (12.4.5b6): the only render API is
 * `renderPreFxAudio(lane, {startTime, endTime}) → path` — per-lane, PRE-FX.
 * Hypothesis to test first in M1: the main track's input is the summed
 * post-FX output of all tracks (bindings.song_get_main_track exists), so
 * pre-FX-of-main ≈ the full mix minus main-bus processing.
 * Returns null if unavailable/failed → main.ts shows the manual-export
 * fallback (File > Export Audio/Video).
 */
export async function bounceAudio(sel: SelectionContext, outPath: string): Promise<string | null> {
  try {
    const mainTrack = await ableton.song.getMainTrack(); // SDK: song_get_main_track
    const renderedPath: string = await ableton.files.renderPreFxAudio(mainTrack, {
      startTime: sel.startBeat,
      endTime: sel.startBeat + sel.durationBeats,
    });
    // The host chooses the output location; move it where the bundle expects.
    if (renderedPath !== outPath) {
      const fs = await import('node:fs/promises');
      await fs.copyFile(renderedPath, outPath);
    }
    return outPath;
  } catch {
    return null; // trigger manual-export fallback
  }
}

// ---- UI primitives (also SDK surface, so they live in the quarantine) ----

/**
 * Show the modal studio WebView (12.4.5b6 evidence):
 * showModalDialog(url, width, height, onResult, onError) loads a URL and
 * calls back ONCE with a payload when the dialog closes. There is no
 * push-messaging API — live Node↔WebView traffic goes over the loopback
 * studio server (src/studioServer.ts); this call just opens the dialog and
 * resolves with the close payload when the user is done.
 */
export async function showStudioDialog(
  url: string,
  width: number,
  height: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ctx.ui.showModalDialog(url, width, height, resolve, (msg: string) => reject(new Error(msg))); // SDK
  });
}

/**
 * Run `fn` under Live's progress dialog (12.4.5b6 evidence):
 * showProgressDialog({text, progress}, onShowDialog, onCancelled), with
 * dialog.update({text, progress}, cb) / dialog.close(cb). User cancellation
 * rejects with 'cancelled' — callers translate that to aborting the work.
 */
export async function withProgress<T>(
  text: string,
  fn: (report: (pct: number, text?: string) => void) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    ctx.ui.showProgressDialog( // SDK
      { text, progress: 0 },
      (dialog: any) => {
        fn((pct, newText) => dialog.update({ text: newText ?? text, progress: pct / 100 }, () => {}))
          .then((value) => dialog.close(() => resolve(value)))
          .catch((err) => dialog.close(() => reject(err)));
      },
      () => reject(new Error('cancelled')),
    );
  });
}

// ---- helpers ----

function rgbToHex(c: any): string {
  if (typeof c === 'string') return c;
  if (typeof c === 'number') return '#' + c.toString(16).padStart(6, '0');
  return '#ff5722';
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}
