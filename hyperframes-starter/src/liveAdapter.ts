/**
 * liveAdapter.ts — the ONLY file that imports the Ableton Extensions SDK.
 *
 * Keeping every SDK call here (and taking `unknown` at the boundary) means the
 * rest of the extension is plain data you can unit-test by mocking this module.
 * Written against @ableton-extensions/sdk 1.0.0-beta.0.
 */

import {
  initialize,
  DataModelObject,
  Clip,
  MidiClip,
  ClipSlot,
  type ActivationContext,
  type ExtensionContext,
  type ContextMenuScope,
  type Handle,
  type ClipSlotSelection,
} from '@ableton-extensions/sdk';

const API_VERSION = '1.0.0' as const;
type V = typeof API_VERSION;

let ctx: ExtensionContext<V>;

/** Call once from activate(), before anything else. */
export function bindActivation(activation: unknown): void {
  ctx = initialize(activation as ActivationContext, API_VERSION);
}

// ---------------------------------------------------------------- selection

export interface Note {
  pitch: number;
  startBeat: number;
  lengthBeats: number;
  velocity: number;
}

export interface Selection {
  title: string;
  color: string; // "#rrggbb"
  bpm: number;
  notes: Note[];
  durationBeats: number;
}

/** Scopes where the command appears. Clip scopes cover both Session and
 *  Arrangement right-clicks (Session fires ClipSlotSelection, not MidiClip). */
export const CLIP_SCOPES: ContextMenuScope<V>[] = [
  'MidiClip',
  'AudioClip',
  'ClipSlot',
  'ClipSlotSelection',
];

/** Register a command + a context-menu item on each scope. */
export async function registerAction(
  title: string,
  commandId: string,
  onInvoke: (target: unknown) => void,
): Promise<void> {
  ctx.commands.registerCommand(commandId, (...args: unknown[]) => onInvoke(args[0]));
  for (const scope of CLIP_SCOPES) {
    await ctx.ui.registerContextMenuAction(scope, title, commandId);
  }
}

/** Resolve the clicked target into a Selection. */
export async function getSelection(target: unknown): Promise<Selection> {
  if (isClipSlotSelection(target)) {
    for (const h of target.selected_clip_slots) {
      const slot = ctx.getObjectFromHandle(h, ClipSlot<V>);
      if (slot.clip) return fromClip(slot.clip);
    }
    throw new Error('No clip in the selected clip slots.');
  }
  const obj = ctx.getObjectFromHandle(target as Handle, DataModelObject<V>);
  if (obj instanceof Clip) return fromClip(obj);
  if (obj instanceof ClipSlot && obj.clip) return fromClip(obj.clip);
  throw new Error('Right-click a clip to render it.');
}

function fromClip(clip: Clip<V>): Selection {
  const notes: Note[] = [];
  if (clip instanceof MidiClip) {
    for (const n of clip.notes) {
      if (n.muted) continue;
      notes.push({
        pitch: num(n.pitch),
        startBeat: num(n.startTime),
        lengthBeats: num(n.duration),
        velocity: num(n.velocity, 100),
      });
    }
  }
  return {
    title: clip.name || 'Untitled',
    color: colorToHex(clip.color),
    bpm: num(ctx.application.song.tempo, 120),
    notes: notes.sort((a, b) => a.startBeat - b.startBeat),
    durationBeats: num(clip.duration),
  };
}

// ---------------------------------------------------------------- host services

/** The two directories the sandbox lets you write to. */
export function tempDirectory(): string | undefined { return ctx.environment.tempDirectory; }
export function storageDirectory(): string | undefined { return ctx.environment.storageDirectory; }

/** Import a finished file (the MP4) into the Live project. */
export async function deliverIntoProject(filePath: string): Promise<string> {
  return ctx.resources.importIntoProject(filePath);
}

/** Show a modal WebView (pass a data: URL); resolves with what the page posts
 *  back via { method:'close_and_send', params:[str] }. */
export async function showDialog(url: string, w: number, h: number): Promise<string> {
  return ctx.ui.showModalDialog(url, w, h);
}

/** Run `fn` under Live's progress dialog. */
export async function withProgress<T>(
  text: string,
  fn: (report: (pct: number | undefined, text?: string) => void, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return (await ctx.ui.withinProgressDialog(
    text,
    {},
    (update, signal) => fn((pct, t) => void update(t ?? text, pct), signal),
  )) as T;
}

// ---------------------------------------------------------------- helpers

function isClipSlotSelection(x: unknown): x is ClipSlotSelection {
  return !!x && typeof x === 'object' && 'selected_clip_slots' in x;
}

/**
 * The SDK returns BigInt for integer fields even where the types say `number`
 * (color, note times, pitch, velocity). Coerce every integral read here, before
 * any math or JSON.stringify — a stray BigInt crashes serialization.
 */
function num(v: number | bigint | undefined, fallback = 0): number {
  return v === undefined ? fallback : Number(v);
}

function colorToHex(c: number | bigint): string {
  return '#' + (num(c) & 0xffffff).toString(16).padStart(6, '0');
}
