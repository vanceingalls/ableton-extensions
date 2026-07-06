/**
 * liveAdapter.ts — the ONLY file that talks to the Ableton Extensions SDK.
 *
 * Written against @ableton-extensions/sdk 1.0.0-beta.0 (real types, installed
 * from the SDK bundle tarball). Confirmed API reference:
 * research/sdk-typedoc-summary.md. Known SDK gaps that shape this file:
 *   - no automation/envelope read (getAutomation returns {})
 *   - static tempo only (one-point tempo map)
 *   - renderPreFxAudio is typed AudioTrack-only; whether it accepts
 *     Song.mainTrack at runtime is the M1 experiment (see bounceAudio)
 *   - no track color; no song-level time signature
 */

import {
  initialize,
  DataModelObject,
  Clip,
  AudioClip,
  MidiClip,
  ClipSlot,
  Track,
  AudioTrack,
  MidiTrack,
  type ActivationContext,
  type ExtensionContext,
  type ContextMenuScope,
  type Handle,
  type ArrangementSelection,
  type ClipSlotSelection,
  type WarpMarker,
} from '@ableton-extensions/sdk';

import type {
  Note,
  AutomationLane,
  Marker,
  TempoPoint,
  TimeSignature,
  TrackInfo,
} from './types';
import type { ProjectSummary, TrackSummary } from './feedbackTypes';

const API_VERSION = '1.0.0' as const;
type V = typeof API_VERSION;

let ctx: ExtensionContext<V>;

/** Call once from the extension's activate() before anything else.
 *  Takes unknown so main.ts never needs an SDK import (iron rule). */
export function bindActivation(activation: unknown): void {
  ctx = initialize(activation as ActivationContext, API_VERSION);
}

// ---------------------------------------------------------------- selection

export interface SelectionContext {
  scope: 'clip' | 'track' | 'arrangement';
  clipName: string;
  clipColor: string; // "#rrggbb"
  isMidi: boolean;
  /** Absolute Set position of the exported region (beats). 0 for session clips. */
  startBeat: number;
  durationBeats: number;
  /** Live handles held for the session (refresh-from-Set re-reads through these). */
  clip?: Clip<V>;
  tracks?: Track<V>[];
}

/**
 * Resolve the context-menu command argument. Per the SDK docs, arg is a
 * Handle for object scopes (MidiClip/AudioClip/MidiTrack/AudioTrack…), an
 * ArrangementSelection for *.ArrangementSelection scopes, or a
 * ClipSlotSelection for ClipSlotSelection scope.
 */
export async function getSelection(targetArg: unknown): Promise<SelectionContext> {
  if (isArrangementSelection(targetArg)) {
    const start = num(targetArg.time_selection_start);
    const end = num(targetArg.time_selection_end);
    const tracks = targetArg.selected_lanes.map((h) =>
      ctx.getObjectFromHandle(h, Track<V>),
    );
    return {
      scope: 'arrangement',
      clipName: tracks[0]?.name ?? 'Arrangement',
      clipColor: '#ff5722', // tracks have no color in this SDK
      isMidi: tracks.some((t) => t instanceof MidiTrack),
      startBeat: start,
      durationBeats: end - start,
      tracks,
    };
  }

  if (isClipSlotSelection(targetArg)) {
    // MVP: take the first slot that holds a clip.
    for (const h of targetArg.selected_clip_slots) {
      const slot = ctx.getObjectFromHandle(h, ClipSlot<V>);
      if (slot.clip) return clipSelection(slot.clip);
    }
    throw new Error('No clip in the selected clip slots.');
  }

  const obj = ctx.getObjectFromHandle(targetArg as Handle, DataModelObject<V>);
  if (obj instanceof Clip) return clipSelection(obj);
  if (obj instanceof ClipSlot) {
    if (!obj.clip) throw new Error('The clicked clip slot is empty.');
    return clipSelection(obj.clip);
  }
  if (obj instanceof Track) {
    const clips = obj.arrangementClips;
    const start = clips.length ? Math.min(...clips.map((c) => num(c.startTime))) : 0;
    const end = clips.length ? Math.max(...clips.map((c) => num(c.endTime))) : 0;
    return {
      scope: 'track',
      clipName: obj.name,
      clipColor: clips.length ? colorToHex(clips[0].color) : '#ff5722',
      isMidi: obj instanceof MidiTrack,
      startBeat: start,
      durationBeats: end - start,
      tracks: [obj],
    };
  }
  throw new Error(`Unsupported context-menu target: ${String(obj?.constructor?.name)}`);
}

function clipSelection(clip: Clip<V>): SelectionContext {
  return {
    scope: 'clip',
    clipName: clip.name,
    clipColor: colorToHex(clip.color),
    isMidi: clip instanceof MidiClip,
    // Session clips: region is the clip content itself, anchored at beat 0.
    startBeat: 0,
    durationBeats: num(clip.duration),
    clip,
  };
}

// ---------------------------------------------------------------- readers

export async function getTempoMap(): Promise<TempoPoint[]> {
  // Static tempo only in SDK 1.0.0-beta.0 (VERIFY 3) — one-point map.
  return [{ beat: 0, bpm: num(ctx.application.song.tempo, 120) }];
}

export async function getTimeSignatures(): Promise<TimeSignature[]> {
  // No song-level time signature in this SDK (scenes only). Default 4/4;
  // revisit when the SDK exposes it.
  return [{ beat: 0, numerator: 4, denominator: 4 }];
}

/** All notes in the selected region, normalized so the region starts at beat 0. */
export async function getNotes(sel: SelectionContext): Promise<Note[]> {
  if (!sel.isMidi) return [];
  const collected: Note[] = [];

  if (sel.clip instanceof MidiClip) {
    collectClipNotes(sel.clip, 0, undefined, collected);
  } else {
    for (const track of sel.tracks ?? []) {
      if (!(track instanceof MidiTrack)) continue;
      for (const clip of track.arrangementClips) {
        if (num(clip.endTime) <= sel.startBeat) continue;
        if (num(clip.startTime) >= sel.startBeat + sel.durationBeats) continue;
        if (!(clip instanceof MidiClip)) continue;
        collectClipNotes(clip, num(clip.startTime) - sel.startBeat, trackId(track), collected);
      }
    }
  }
  return collected.sort((a, b) => a.startBeat - b.startBeat);
}

function collectClipNotes(
  clip: MidiClip<V>,
  offsetBeats: number,
  tid: string | undefined,
  out: Note[],
): void {
  for (const n of clip.notes) {
    if (n.muted) continue;
    out.push({
      pitch: num(n.pitch),
      startBeat: num(n.startTime) + offsetBeats, // NoteDescription times are in beats
      lengthBeats: num(n.duration),
      velocity: clampVelocity(n.velocity),
      ...(n.probability !== undefined ? { probability: num(n.probability) } : {}),
      ...(tid ? { trackId: tid } : {}),
    });
  }
}

export async function getAutomation(
  _sel: SelectionContext,
): Promise<Record<string, AutomationLane>> {
  // VERIFY 2: no envelope API exists in SDK 1.0.0-beta.0. Schema keeps the
  // field for forward compatibility; the studio offers note-derived signals.
  return {};
}

export async function getMarkers(sel: SelectionContext): Promise<Marker[]> {
  if (sel.scope === 'clip') return [];
  return ctx.application.song.cuePoints
    .map((c) => ({ time: num(c.time), name: c.name }))
    .filter((c) => c.time >= sel.startBeat && c.time < sel.startBeat + sel.durationBeats)
    .map((c) => ({ beat: c.time - sel.startBeat, label: c.name, kind: 'section' as const }));
}

export async function getTracks(): Promise<TrackInfo[]> {
  return ctx.application.song.tracks.map((t) => ({
    id: trackId(t),
    name: t.name,
    kind: t instanceof MidiTrack ? ('midi' as const) : ('audio' as const),
    // No track color in this SDK.
  }));
}

/** Warp markers of an audio clip — shape matches TimeBridge exactly (VERIFY 6). */
export async function getWarpMarkers(clip: AudioClip<V>): Promise<WarpMarker[]> {
  return clip.warpMarkers;
}

/**
 * Compact, LLM-friendly description of the SELECTION for the feedback feature:
 * the selected tracks over the selected arrangement time range. Select all
 * tracks across the whole song → whole-project review; select a range → that
 * section. Reads note counts, per-track color, device names, pitch range — no
 * raw notes, no audio.
 */
export async function getProjectSummary(sel: SelectionContext): Promise<ProjectSummary> {
  const song = ctx.application.song;
  const scopeTracks = sel.tracks && sel.tracks.length ? sel.tracks : [...song.tracks];
  const start = sel.startBeat;
  const region = sel.durationBeats || regionFromTracks(scopeTracks) - start;
  const end = start + region;

  const tracks: TrackSummary[] = [];
  let totalNotes = 0;
  let minPitch = Infinity;
  let maxPitch = -Infinity;

  for (const track of scopeTracks) {
    let noteCount = 0;
    let color: string | undefined;
    for (const clip of track.arrangementClips) {
      const clipStart = num(clip.startTime);
      const clipEnd = num(clip.endTime);
      if (clipEnd <= start || clipStart >= end) continue; // outside the window
      if (color === undefined) color = colorToHex(clip.color);
      if (clip instanceof MidiClip) {
        for (const n of clip.notes) {
          if (n.muted) continue;
          const abs = clipStart + num(n.startTime); // absolute arrangement beat
          if (abs < start || abs >= end) continue;
          noteCount++;
          const p = num(n.pitch);
          if (p < minPitch) minPitch = p;
          if (p > maxPitch) maxPitch = p;
        }
      }
    }
    totalNotes += noteCount;
    tracks.push({
      name: track.name,
      kind: track instanceof MidiTrack ? 'midi' : 'audio',
      color,
      noteCount,
      devices: track.devices.map((d) => d.name),
      density: region > 0 ? +(noteCount / region).toFixed(2) : 0,
    });
  }

  const wholeSong = scopeTracks.length === song.tracks.length;
  return {
    title: wholeSong ? 'Full Project' : 'Arrangement Selection',
    tempoBpm: num(song.tempo, 120),
    timeSignature: '4/4', // no song-level signature in this SDK
    durationBeats: region,
    scope: sel.scope,
    sections: song.cuePoints
      .map((c) => ({ beat: num(c.time), label: c.name }))
      .filter((c) => c.beat >= start && c.beat < end)
      .sort((a, b) => a.beat - b.beat),
    tracks,
    totalNotes,
    pitchRange: Number.isFinite(minPitch) ? { min: minPitch, max: maxPitch } : null,
  };
}

function regionFromTracks(tracks: Track<V>[]): number {
  let end = 0;
  for (const t of tracks) {
    for (const c of t.arrangementClips) end = Math.max(end, num(c.endTime));
  }
  return end;
}

/** Where the extension stores the Anthropic API key (persists across sessions). */
export function storageDirectory(): string | undefined {
  return ctx.environment.storageDirectory;
}

// ---------------------------------------------------------------- services

/**
 * Bounce the selection to a WAV at outPath, or return null → manual-export
 * fallback. THE M1 EXPERIMENT: renderPreFxAudio is typed AudioTrack-only,
 * but Song.mainTrack exists (typed Track) and its pre-FX input is the summed
 * post-FX mix of every track. The cast below is intentional; if the runtime
 * rejects main, fall back per-track or to manual export, and record the
 * outcome in DECISIONS.md.
 */
export async function bounceAudio(sel: SelectionContext, outPath: string): Promise<string | null> {
  // Candidate render sources, best first. The M1 experiment: does
  // renderPreFxAudio accept the main track (full mix), or only real
  // AudioTracks? We now find out from the logged errors instead of guessing.
  const candidates: { label: string; track: AudioTrack<V> }[] = [];
  try {
    candidates.push({ label: 'mainTrack', track: ctx.application.song.mainTrack as AudioTrack<V> });
  } catch (e) {
    console.error('bounce: mainTrack unavailable:', e);
  }
  for (const t of sel.tracks ?? []) {
    if (t instanceof AudioTrack) candidates.push({ label: `audioTrack ${t.name}`, track: t });
  }

  for (const c of candidates) {
    try {
      const rendered = await ctx.resources.renderPreFxAudio(
        c.track,
        sel.startBeat,
        sel.startBeat + sel.durationBeats,
      );
      console.log(`bounce: rendered via ${c.label} → ${rendered}`);
      if (rendered !== outPath) {
        const fs = await import('node:fs/promises');
        await fs.copyFile(rendered, outPath);
      }
      return outPath;
    } catch (e) {
      console.error(`bounce: renderPreFxAudio failed via ${c.label}:`, (e as Error)?.message ?? e);
    }
  }
  return null;
}

/** Copy a finished file (the MP4) into the Live project; returns the imported path. */
export async function deliverIntoProject(filePath: string): Promise<string> {
  return ctx.resources.importIntoProject(filePath);
}

/** Per-extension scratch dir provided by Live (renders, bundles). */
export function tempDirectory(): string | undefined {
  return ctx.environment.tempDirectory;
}

// ---------------------------------------------------------------- UI

/** Scope presets for the two commands. Clip/track scopes make sense for a
 *  clip-specific render; the feedback command is project-wide, so it only
 *  appears on whole-project gestures (a Scene row, or a time selection across
 *  the arrangement) — never on a single clip. */
export const CLIP_SCOPES: ContextMenuScope<V>[] = [
  'MidiClip',
  'AudioClip',
  'ClipSlot',
  'ClipSlotSelection',
  'MidiTrack',
  'AudioTrack',
  'MidiTrack.ArrangementSelection',
  'AudioTrack.ArrangementSelection',
];

export const PROJECT_SCOPES: ContextMenuScope<V>[] = [
  // Arrangement time-selection only: the selection itself defines the scope.
  // Select across all tracks for the whole song, or a range for one section.
  'MidiTrack.ArrangementSelection',
  'AudioTrack.ArrangementSelection',
];

/**
 * Register a command + context-menu action on the given scopes.
 * Returns an unregister-all function.
 */
export async function registerStudioAction(
  title: string,
  commandId: string,
  onInvoke: (targetArg: unknown) => void,
  scopes: ContextMenuScope<V>[] = CLIP_SCOPES,
): Promise<() => Promise<void>> {
  const SCOPES = scopes;
  ctx.commands.registerCommand(commandId, (...args: unknown[]) => onInvoke(args[0]));
  const unregisters = await Promise.all(
    SCOPES.map(async (scope) => {
      try {
        const unregister = await ctx.ui.registerContextMenuAction(scope, title, commandId);
        console.log(`registered context-menu action on ${scope}`);
        return unregister;
      } catch (e) {
        console.error(`context-menu registration FAILED on ${scope}:`, e);
        throw e;
      }
    }),
  );
  return async () => {
    await Promise.all(unregisters.map((u) => u()));
  };
}

/**
 * Open the modal studio WebView. `http://localhost` URLs are officially
 * supported, so this receives the loopback studio-server URL. Resolves with
 * the string the dialog posts via {method:'close_and_send', params:[str]}
 * (window.webkit.messageHandlers.live on macOS / window.chrome.webview on
 * Windows) when the user closes the studio.
 */
export async function showStudioDialog(
  url: string,
  width: number,
  height: number,
): Promise<string> {
  return ctx.ui.showModalDialog(url, width, height);
}

/**
 * Run `fn` under Live's progress dialog. `report(pct, text?)` updates it
 * (pct 0–100); the AbortSignal fires if the user cancels — pass it into
 * cancellable work (cloud render). Dialog auto-closes when fn settles.
 */
export async function withProgress<T>(
  text: string,
  fn: (report: (pct: number | undefined, text?: string) => void, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  // progress === undefined → indeterminate bar (the host reads a "has progress"
  // flag). Start indeterminate; callers set a number once they have one.
  return (await ctx.ui.withinProgressDialog(
    text,
    {},
    (update, signal) =>
      fn((pct, newText) => void update(newText ?? text, pct), signal),
  )) as T;
}

/** Reveal a file in Finder (macOS) / Explorer, or open it with the default app. */
export async function revealFile(filePath: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const cmd = process.platform === 'darwin' ? ['open', ['-R', filePath]]
    : process.platform === 'win32' ? ['explorer', [`/select,${filePath}`]]
    : ['xdg-open', [filePath]];
  spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: 'ignore' }).unref();
}

export async function openFile(filePath: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const bin = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(bin, [filePath], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
}

// ---------------------------------------------------------------- helpers

function isArrangementSelection(x: unknown): x is ArrangementSelection {
  return !!x && typeof x === 'object' && 'selected_lanes' in x;
}

function isClipSlotSelection(x: unknown): x is ClipSlotSelection {
  return !!x && typeof x === 'object' && 'selected_clip_slots' in x;
}

/**
 * RUNTIME REALITY (found in Live 12.4.5b6): integer values cross the bindings
 * as BigInt even where the TypeDoc says number (first seen: Clip.color).
 * Coerce every integral read through num() before math or JSON.stringify —
 * a stray BigInt in the timeline would also crash serialization.
 */
function num(v: number | bigint | undefined, fallback = 0): number {
  return v === undefined ? fallback : Number(v);
}

function colorToHex(c: number | bigint): string {
  return '#' + (num(c) & 0xffffff).toString(16).padStart(6, '0');
}

function clampVelocity(v: number | bigint | undefined): number {
  return Math.min(127, Math.max(1, Math.round(num(v, 100))));
}

function trackId(t: Track<V>): string {
  return String(t.handle.id);
}
