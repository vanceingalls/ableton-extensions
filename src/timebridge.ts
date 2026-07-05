/**
 * timebridge.ts — the ONE implementation of time conversion for Clip2Video.
 *
 * Compiled for both Node (exporter, cue-sheet importer) and the browser
 * (studio WebView, HyperFrames templates). Never reimplement any of this
 * math elsewhere: two implementations = drift.
 *
 * Domains:
 *   beats   — musical position (Live's native domain). Source of truth.
 *   seconds — wall-clock position in the bounced audio. Exchange currency.
 *   frames  — HyperFrames render domain, derived as t * fps.
 *
 * Anchor: beat 0 === second 0 === frame 0 === start of exported region.
 * Pre-roll is carried explicitly (Timeline.audio.offsetBeats), never implied.
 */

export interface TempoPoint {
  beat: number;
  bpm: number;
  /** If true, BPM ramps linearly (in the beat domain) to the next point. */
  ramp?: boolean;
}

export interface WarpMarker {
  /** Position inside the clip's audio file, in seconds of source material. */
  sampleTime: number;
  /** Musical position of that sample, in beats (clip-relative). */
  beatTime: number;
}

export type Quantize = 'nearest' | 'floor' | 'ceil';

export class TimeBridge {
  private readonly map: TempoPoint[];
  /** Cumulative seconds at each tempo point, precomputed for O(log n) lookups. */
  private readonly cumSec: number[];

  constructor(tempoMap: TempoPoint[]) {
    if (!tempoMap.length) throw new Error('TimeBridge: empty tempo map');
    this.map = [...tempoMap].sort((a, b) => a.beat - b.beat);
    this.cumSec = [0];
    for (let i = 0; i < this.map.length - 1; i++) {
      this.cumSec.push(
        this.cumSec[i] +
          segmentSeconds(this.map[i], this.map[i + 1], this.map[i + 1].beat),
      );
    }
  }

  // ---------- beats <-> seconds ----------

  beatsToSeconds(beat: number): number {
    const i = this.segmentAt(beat);
    return this.cumSec[i] + segmentSeconds(this.map[i], this.map[i + 1], beat);
  }

  secondsToBeats(t: number): number {
    // Find the segment whose cumulative-seconds range contains t.
    let i = this.cumSec.length - 1;
    for (let k = 1; k < this.cumSec.length; k++) {
      if (t < this.cumSec[k]) { i = k - 1; break; }
    }
    const a = this.map[i];
    const b = this.map[i + 1];
    const dt = t - this.cumSec[i];

    if (a.ramp && b && b.bpm !== a.bpm) {
      // Invert the ramp integral: t(β) = (60/k)·ln((b0+kβ)/b0), k = bpm slope/beat
      const k = (b.bpm - a.bpm) / (b.beat - a.beat);
      return a.beat + (a.bpm / k) * (Math.exp((k * dt) / 60) - 1);
    }
    return a.beat + dt * (a.bpm / 60);
  }

  // ---------- seconds <-> frames ----------

  secondsToFrame(t: number, fps: number, q: Quantize = 'nearest'): number {
    return quantize(t * fps, q);
  }

  frameToSeconds(frame: number, fps: number): number {
    return frame / fps;
  }

  // ---------- beats <-> frames (the common path) ----------

  /**
   * Where a musical event lands on the render timeline.
   * Policy guidance: 'nearest' for accents/pulses, 'floor' for cut
   * boundaries (a cut belongs to the frame it starts in).
   */
  beatsToFrame(beat: number, fps: number, q: Quantize = 'nearest'): number {
    return this.secondsToFrame(this.beatsToSeconds(beat), fps, q);
  }

  frameToBeats(frame: number, fps: number): number {
    return this.secondsToBeats(this.frameToSeconds(frame, fps));
  }

  // ---------- diagnostics ----------

  /**
   * Round-trip invariant for the B-side (cue sheets -> Live -> back).
   * Returns max |t - beatsToSeconds(secondsToBeats(t))| over sample points.
   * Assert this < 1e-6 in tests; timing must not decay across import cycles.
   */
  roundTripError(durationSeconds: number, samples = 1000): number {
    let worst = 0;
    for (let i = 0; i <= samples; i++) {
      const t = (i / samples) * durationSeconds;
      worst = Math.max(worst, Math.abs(t - this.beatsToSeconds(this.secondsToBeats(t))));
    }
    return worst;
  }

  private segmentAt(beat: number): number {
    let lo = 0, hi = this.map.length - 2;
    if (hi < 0) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.map[mid].beat <= beat) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
}

/**
 * Warped audio clips: Live's warp markers define a piecewise-linear map
 * between source-audio sample time and clip beats. Compose with the tempo
 * map to place a transient from a warped clip on the render timeline:
 *
 *   const clipBeat = warpToBeats(markers, transientSampleTime);
 *   const t = bridge.beatsToSeconds(clipStartBeat + clipBeat);
 */
export function warpToBeats(markers: WarpMarker[], sampleTime: number): number {
  const m = [...markers].sort((a, b) => a.sampleTime - b.sampleTime);
  if (m.length === 1) return m[0].beatTime; // degenerate; treat as anchor
  let i = m.length - 2;
  for (let k = 0; k < m.length - 1; k++) {
    if (sampleTime < m[k + 1].sampleTime) { i = k; break; }
  }
  const a = m[i], b = m[i + 1];
  const f = (sampleTime - a.sampleTime) / (b.sampleTime - a.sampleTime);
  return a.beatTime + f * (b.beatTime - a.beatTime); // extrapolates past ends
}

export function beatsToWarp(markers: WarpMarker[], beatTime: number): number {
  const m = [...markers].sort((a, b) => a.beatTime - b.beatTime);
  if (m.length === 1) return m[0].sampleTime;
  let i = m.length - 2;
  for (let k = 0; k < m.length - 1; k++) {
    if (beatTime < m[k + 1].beatTime) { i = k; break; }
  }
  const a = m[i], b = m[i + 1];
  const f = (beatTime - a.beatTime) / (b.beatTime - a.beatTime);
  return a.sampleTime + f * (b.sampleTime - a.sampleTime);
}

// ---------- internals ----------

/** Seconds spanned from segment start `a` to position `beat` (<= b.beat). */
function segmentSeconds(a: TempoPoint, b: TempoPoint | undefined, beat: number): number {
  const span = Math.max(0, beat - a.beat);
  if (span === 0) return 0;
  if (a.ramp && b && b.bpm !== a.bpm) {
    const k = (b.bpm - a.bpm) / (b.beat - a.beat); // bpm per beat
    const bpmAtBeat = a.bpm + k * span;
    return (60 / k) * Math.log(bpmAtBeat / a.bpm);
  }
  return (60 / a.bpm) * span;
}

function quantize(x: number, q: Quantize): number {
  if (q === 'floor') return Math.floor(x);
  if (q === 'ceil') return Math.ceil(x);
  return Math.round(x);
}
