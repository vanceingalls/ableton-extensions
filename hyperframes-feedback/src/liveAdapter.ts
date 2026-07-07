/**
 * liveAdapter.ts — the ONLY file that talks to the Ableton Extensions SDK.
 *
 * Written against @ableton-extensions/sdk 1.0.0-beta.0. The feedback feature
 * reads a compact, LLM-friendly summary of an arrangement selection; all SDK
 * access is quarantined here so the rest of the extension is plain data.
 *
 * Known SDK gaps that shape this file: no automation read, static tempo only,
 * no song-level time signature, no track color (colors come from clips).
 */

import {
  initialize,
  MidiClip,
  Track,
  MidiTrack,
  type ActivationContext,
  type ExtensionContext,
  type ContextMenuScope,
  type ArrangementSelection,
} from '@ableton-extensions/sdk';

import { spawn } from 'node:child_process';
import type { ProjectSummary, TrackSummary } from './feedbackTypes';

const API_VERSION = '1.0.0' as const;
type V = typeof API_VERSION;

let ctx: ExtensionContext<V>;

/** Call once from the extension's activate() before anything else. */
export function bindActivation(activation: unknown): void {
  ctx = initialize(activation as ActivationContext, API_VERSION);
}

// ---------------------------------------------------------------- selection

export interface SelectionContext {
  scope: 'arrangement';
  /** Absolute Set position of the selected region (beats). */
  startBeat: number;
  durationBeats: number;
  /** The selected tracks (an empty selection falls back to the whole song). */
  tracks: Track<V>[];
}

/**
 * Resolve the context-menu argument for the feedback command. It fires on
 * `*.ArrangementSelection` scopes, so the argument is an ArrangementSelection: a
 * time window plus the lanes (tracks) it spans.
 */
export async function getSelection(targetArg: unknown): Promise<SelectionContext> {
  if (!isArrangementSelection(targetArg)) {
    throw new Error('Select a range across one or more tracks in Arrangement view, then try again.');
  }
  const start = num(targetArg.time_selection_start);
  const end = num(targetArg.time_selection_end);
  const tracks = targetArg.selected_lanes.map((h) => ctx.getObjectFromHandle(h, Track<V>));
  return { scope: 'arrangement', startBeat: start, durationBeats: end - start, tracks };
}

/**
 * Compact, LLM-friendly description of the SELECTION: the selected tracks over
 * the selected time range (select all tracks → whole-project review). Reads note
 * counts, per-track color, device names, and pitch range — no raw notes, no audio.
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

// ---------------------------------------------------------------- host services

/** Where the extension stores API keys (persists across sessions). */
export function storageDirectory(): string | undefined {
  return ctx.environment.storageDirectory;
}

/** Per-extension scratch dir provided by Live (render bundles). */
export function tempDirectory(): string | undefined {
  return ctx.environment.tempDirectory;
}

/** Copy a finished file (the MP4) into the Live project; returns the imported path. */
export async function deliverIntoProject(filePath: string): Promise<string> {
  return ctx.resources.importIntoProject(filePath);
}

// ---------------------------------------------------------------- UI

/** Scope presets. The feedback command is project-wide, so it appears only on an
 *  arrangement time-selection; the key-manager is registered on all scopes so
 *  it's reachable from any right-click. */
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
  'MidiTrack.ArrangementSelection',
  'AudioTrack.ArrangementSelection',
];

/** Register a command + context-menu action on the given scopes. */
export async function registerStudioAction(
  title: string,
  commandId: string,
  onInvoke: (targetArg: unknown) => void,
  scopes: ContextMenuScope<V>[] = CLIP_SCOPES,
): Promise<() => Promise<void>> {
  ctx.commands.registerCommand(commandId, (...args: unknown[]) => onInvoke(args[0]));
  const unregisters = await Promise.all(
    scopes.map(async (scope) => {
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
 * Open a modal WebView (pass a data: URL — an http://localhost page won't load).
 * Resolves with the string the dialog posts via {method:'close_and_send',
 * params:[str]} when the user closes it.
 */
export async function showStudioDialog(url: string, width: number, height: number): Promise<string> {
  return ctx.ui.showModalDialog(url, width, height);
}

/**
 * Run `fn` under Live's progress dialog. `report(pct, text?)` updates it; the
 * AbortSignal fires on user-cancel — pass it into cancellable work (cloud render).
 */
export async function withProgress<T>(
  text: string,
  fn: (report: (pct: number | undefined, text?: string) => void, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return (await ctx.ui.withinProgressDialog(
    text,
    {},
    (update, signal) => fn((pct, newText) => void update(newText ?? text, pct), signal),
  )) as T;
}

/** Reveal a file in Finder (macOS) / Explorer, or open it with the default app. */
export async function revealFile(filePath: string): Promise<void> {
  const cmd = process.platform === 'darwin' ? ['open', ['-R', filePath]]
    : process.platform === 'win32' ? ['explorer', [`/select,${filePath}`]]
    : ['xdg-open', [filePath]];
  spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: 'ignore' }).unref();
}

export async function openFile(filePath: string): Promise<void> {
  const bin = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(bin, [filePath], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
}

// ---------------------------------------------------------------- helpers

function isArrangementSelection(x: unknown): x is ArrangementSelection {
  return !!x && typeof x === 'object' && 'selected_lanes' in x;
}

/**
 * RUNTIME REALITY (Live 12.4.5b6): integer values cross the bindings as BigInt
 * even where the TypeDoc says number (first seen: Clip.color). Coerce every
 * integral read through num() before math or JSON.stringify.
 */
function num(v: number | bigint | undefined, fallback = 0): number {
  return v === undefined ? fallback : Number(v);
}

function colorToHex(c: number | bigint): string {
  return '#' + (num(c) & 0xffffff).toString(16).padStart(6, '0');
}
