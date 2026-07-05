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

export interface SelectionContext {
  scope: 'clip' | 'track' | 'arrangement';
  clipName: string;
  clipColor: string; // "#rrggbb"
  isMidi: boolean;
  startBeat: number; // absolute Set position of the exported region
  durationBeats: number;
}

/** What did the user right-click? */
export async function getSelection(): Promise<SelectionContext> {
  // SDK: read the context-menu target the Extension was launched from.
  const target = await ableton.selection.getTarget();
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
  // SDK: read song tempo + tempo automation if exposed. Constant-tempo Sets
  // return a single point, which is all the MVP needs.
  const bpm = await ableton.song.getTempo();
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
  const lanes: Record<string, AutomationLane> = {};
  const envelopes = await ableton.selection.getEnvelopes(); // SDK
  for (const env of envelopes) {
    const id = slug(`${env.deviceName}.${env.parameterName}`);
    lanes[id] = {
      name: `${env.deviceName} > ${env.parameterName}`,
      unit: env.unit,
      min: env.min,
      max: env.max,
      points: env.breakpoints.map((p: any) => ({
        beat: p.time,
        value: p.value,
        curve: 'linear',
      })),
    };
  }
  return lanes;
}

export async function getMarkers(sel: SelectionContext): Promise<Marker[]> {
  if (sel.scope === 'clip') return [];
  const locators = await ableton.song.getLocators(); // SDK
  return locators
    .filter((l: any) => l.time >= sel.startBeat && l.time < sel.startBeat + sel.durationBeats)
    .map((l: any) => ({ beat: l.time - sel.startBeat, label: l.name, kind: 'section' as const }));
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
 * Bounce the selection to a WAV on disk. THE critical unknown (see header).
 * Returns the absolute path of the rendered file, or null if the SDK can't
 * do it yet — in which case main.ts shows the manual-export fallback UI.
 */
export async function bounceAudio(sel: SelectionContext, outPath: string): Promise<string | null> {
  try {
    await ableton.export.renderAudio({ // SDK: may not exist in beta
      scope: sel.scope,
      start: sel.startBeat,
      length: sel.durationBeats,
      path: outPath,
    });
    return outPath;
  } catch {
    return null; // trigger manual-export fallback
  }
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
