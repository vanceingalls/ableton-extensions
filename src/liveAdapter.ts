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
    const start = targetArg.time_selection_start;
    const end = targetArg.time_selection_end;
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
      const slot = ctx.getObjectFromHandle(h, DataModelObject<V>) as any;
      if (slot.clip) return clipSelection(slot.clip as Clip<V>);
    }
    throw new Error('No clip in the selected clip slots.');
  }

  const obj = ctx.getObjectFromHandle(targetArg as Handle, DataModelObject<V>);
  if (obj instanceof Clip) return clipSelection(obj);
  if (obj instanceof Track) {
    const clips = obj.arrangementClips;
    const start = clips.length ? Math.min(...clips.map((c) => c.startTime)) : 0;
    const end = clips.length ? Math.max(...clips.map((c) => c.endTime)) : 0;
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
    durationBeats: clip.duration,
    clip,
  };
}

// ---------------------------------------------------------------- readers

export async function getTempoMap(): Promise<TempoPoint[]> {
  // Static tempo only in SDK 1.0.0-beta.0 (VERIFY 3) — one-point map.
  return [{ beat: 0, bpm: ctx.application.song.tempo }];
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
        if (clip.endTime <= sel.startBeat) continue;
        if (clip.startTime >= sel.startBeat + sel.durationBeats) continue;
        if (!(clip instanceof MidiClip)) continue;
        collectClipNotes(clip, clip.startTime - sel.startBeat, trackId(track), collected);
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
      pitch: n.pitch,
      startBeat: n.startTime + offsetBeats, // NoteDescription times are in beats
      lengthBeats: n.duration,
      velocity: clampVelocity(n.velocity),
      probability: n.probability,
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
  try {
    const main = ctx.application.song.mainTrack;
    const rendered = await ctx.resources.renderPreFxAudio(
      main as AudioTrack<V>,
      sel.startBeat,
      sel.startBeat + sel.durationBeats,
    );
    if (rendered !== outPath) {
      const fs = await import('node:fs/promises');
      await fs.copyFile(rendered, outPath);
    }
    return outPath;
  } catch {
    return null;
  }
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

/**
 * Register the studio command + context-menu action on every scope that maps
 * to our clip/track/arrangement model. Returns an unregister-all function.
 */
export async function registerStudioAction(
  title: string,
  commandId: string,
  onInvoke: (targetArg: unknown) => void,
): Promise<() => Promise<void>> {
  const SCOPES: ContextMenuScope<V>[] = [
    'MidiClip',
    'AudioClip',
    'MidiTrack',
    'AudioTrack',
    'MidiTrack.ArrangementSelection',
    'AudioTrack.ArrangementSelection',
  ];
  ctx.commands.registerCommand(commandId, (...args: unknown[]) => onInvoke(args[0]));
  const unregisters = await Promise.all(
    SCOPES.map((scope) => ctx.ui.registerContextMenuAction(scope, title, commandId)),
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
  fn: (report: (pct: number, text?: string) => void, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return (await ctx.ui.withinProgressDialog(
    text,
    { progress: 0 },
    (update, signal) =>
      fn((pct, newText) => void update(newText ?? text, pct), signal),
  )) as T;
}

// ---------------------------------------------------------------- helpers

function isArrangementSelection(x: unknown): x is ArrangementSelection {
  return !!x && typeof x === 'object' && 'selected_lanes' in x;
}

function isClipSlotSelection(x: unknown): x is ClipSlotSelection {
  return !!x && typeof x === 'object' && 'selected_clip_slots' in x;
}

function colorToHex(c: number): string {
  return '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);
}

function clampVelocity(v: number | undefined): number {
  return Math.min(127, Math.max(1, Math.round(v ?? 100)));
}

function trackId(t: Track<V>): string {
  return String(t.handle.id);
}
