/**
 * TimeBridge tests — the highest-value test surface in the project (§11).
 * Covers: constant tempo, held tempo changes, linear ramps, positions beyond
 * the last tempo point, quantize policies, warp-marker composition, and the
 * round-trip invariant (< 1e-6) that the B-side import/export cycle needs.
 */
import { describe, it, expect } from 'vitest';
import { TimeBridge, warpToBeats, beatsToWarp, type TempoPoint, type WarpMarker } from '../src/timebridge';

const LN2 = Math.log(2);

describe('constant tempo', () => {
  const tb = new TimeBridge([{ beat: 0, bpm: 120 }]);

  it('anchors beat 0 at second 0', () => {
    expect(tb.beatsToSeconds(0)).toBe(0);
    expect(tb.secondsToBeats(0)).toBe(0);
  });

  it('converts at 0.5 s/beat', () => {
    expect(tb.beatsToSeconds(1)).toBeCloseTo(0.5, 12);
    expect(tb.beatsToSeconds(7.5)).toBeCloseTo(3.75, 12);
    expect(tb.secondsToBeats(3.75)).toBeCloseTo(7.5, 12);
  });

  it('rejects an empty tempo map', () => {
    expect(() => new TimeBridge([])).toThrow();
  });
});

describe('held tempo changes (no ramp)', () => {
  // 120 BPM for 4 beats (2 s), then an instant jump to 60 BPM (1 s/beat).
  const tb = new TimeBridge([
    { beat: 0, bpm: 120 },
    { beat: 4, bpm: 60 },
  ]);

  it('is exact inside the first segment', () => {
    expect(tb.beatsToSeconds(2)).toBeCloseTo(1, 12);
  });

  it('is exact at the change point', () => {
    expect(tb.beatsToSeconds(4)).toBeCloseTo(2, 12);
  });

  it('uses the new tempo after the change', () => {
    expect(tb.beatsToSeconds(5)).toBeCloseTo(3, 12);
    expect(tb.beatsToSeconds(6)).toBeCloseTo(4, 12);
  });

  it('holds the final tempo beyond the last point', () => {
    expect(tb.beatsToSeconds(10)).toBeCloseTo(8, 12); // 2s + 6 beats @ 60
    expect(tb.secondsToBeats(8)).toBeCloseTo(10, 12);
  });
});

describe('linear tempo ramps', () => {
  // 120 → 60 BPM ramped linearly (in the beat domain) over 4 beats.
  // t(4) = (60/k)·ln(60/120) with k = -15 bpm/beat = 4·ln2.
  const tb = new TimeBridge([
    { beat: 0, bpm: 120, ramp: true },
    { beat: 4, bpm: 60 },
  ]);

  it('matches the exact ramp integral at the endpoint', () => {
    expect(tb.beatsToSeconds(4)).toBeCloseTo(4 * LN2, 12);
  });

  it('matches the exact ramp integral mid-segment', () => {
    // bpm(2) = 90 → t = (60/-15)·ln(90/120) = 4·ln(4/3)
    expect(tb.beatsToSeconds(2)).toBeCloseTo(4 * Math.log(4 / 3), 12);
  });

  it('inverts the ramp integral exactly', () => {
    expect(tb.secondsToBeats(4 * LN2)).toBeCloseTo(4, 9);
    expect(tb.secondsToBeats(4 * Math.log(4 / 3))).toBeCloseTo(2, 9);
  });

  it('holds tempo after the ramp target', () => {
    // 4·ln2 s for the ramp, then 60 BPM (1 s/beat) held.
    expect(tb.beatsToSeconds(6)).toBeCloseTo(4 * LN2 + 2, 12);
  });
});

describe('mixed map: ramp, hold, jump', () => {
  const map: TempoPoint[] = [
    { beat: 0, bpm: 120, ramp: true },
    { beat: 4, bpm: 60 },          // held 4→8
    { beat: 8, bpm: 240 },         // jump, held onward
  ];
  const tb = new TimeBridge(map);

  it('accumulates all three segment kinds', () => {
    const expected = 4 * LN2 + 4 * 1 + 2 * (60 / 240); // ramp + hold + 2 beats @ 240
    expect(tb.beatsToSeconds(10)).toBeCloseTo(expected, 12);
  });

  it('sorts an unsorted tempo map', () => {
    const shuffled = new TimeBridge([map[2], map[0], map[1]]);
    expect(shuffled.beatsToSeconds(10)).toBeCloseTo(tb.beatsToSeconds(10), 12);
  });

  it('round-trips within 1e-6 across the whole timeline and past the map', () => {
    const dur = tb.beatsToSeconds(32); // well beyond the last tempo point
    expect(tb.roundTripError(dur)).toBeLessThan(1e-6);
  });
});

describe('round-trip invariant (§6)', () => {
  it('holds for a gnarly map with consecutive ramps', () => {
    const tb = new TimeBridge([
      { beat: 0, bpm: 174, ramp: true },
      { beat: 3.5, bpm: 87, ramp: true },
      { beat: 7, bpm: 128 },
      { beat: 16, bpm: 128.5, ramp: true },
      { beat: 33, bpm: 90 },
    ]);
    expect(tb.roundTripError(tb.beatsToSeconds(64))).toBeLessThan(1e-6);
  });

  it('holds for a constant-tempo map', () => {
    expect(new TimeBridge([{ beat: 0, bpm: 124 }]).roundTripError(120)).toBeLessThan(1e-6);
  });
});

describe('frames and quantize policies', () => {
  const tb = new TimeBridge([{ beat: 0, bpm: 120 }]);

  it('beat 1 at 120 BPM lands on frame 15 at 30fps', () => {
    expect(tb.beatsToFrame(1, 30)).toBe(15);
  });

  it('nearest rounds, floor truncates, ceil bumps', () => {
    // beat 1.03 → t = 0.515 s → 15.45 frames @ 30fps
    expect(tb.beatsToFrame(1.03, 30, 'nearest')).toBe(15);
    expect(tb.beatsToFrame(1.03, 30, 'floor')).toBe(15);
    expect(tb.beatsToFrame(1.03, 30, 'ceil')).toBe(16);
    // beat 1.04 → t = 0.52 s → 15.6 frames
    expect(tb.beatsToFrame(1.04, 30, 'nearest')).toBe(16);
    expect(tb.beatsToFrame(1.04, 30, 'floor')).toBe(15);
  });

  it('max sync error of nearest is half a frame period', () => {
    const fps = 30;
    for (let i = 0; i <= 200; i++) {
      const beat = i * 0.173;
      const err = Math.abs(
        tb.frameToSeconds(tb.beatsToFrame(beat, fps), fps) - tb.beatsToSeconds(beat),
      );
      expect(err).toBeLessThanOrEqual(1 / (2 * fps) + 1e-12);
    }
  });

  it('frameToBeats inverts beatsToFrame up to quantization', () => {
    expect(tb.frameToBeats(15, 30)).toBeCloseTo(1, 12);
  });
});

describe('warp markers', () => {
  // Audio stretched to double speed: 2 s of source per 4 beats.
  const markers: WarpMarker[] = [
    { sampleTime: 0, beatTime: 0 },
    { sampleTime: 2, beatTime: 4 },
    { sampleTime: 3, beatTime: 5 }, // slower stretch after 2 s
  ];

  it('interpolates linearly between markers', () => {
    expect(warpToBeats(markers, 1)).toBeCloseTo(2, 12);
    expect(warpToBeats(markers, 2.5)).toBeCloseTo(4.5, 12);
  });

  it('extrapolates past the last marker with the final slope', () => {
    expect(warpToBeats(markers, 4)).toBeCloseTo(6, 12);
  });

  it('round-trips beatsToWarp(warpToBeats)', () => {
    for (const s of [0, 0.7, 1.9, 2.4, 3.3]) {
      expect(beatsToWarp(markers, warpToBeats(markers, s))).toBeCloseTo(s, 9);
    }
  });

  it('treats a single marker as an anchor', () => {
    expect(warpToBeats([{ sampleTime: 1, beatTime: 2 }], 99)).toBe(2);
    expect(beatsToWarp([{ sampleTime: 1, beatTime: 2 }], 99)).toBe(1);
  });

  it('accepts unsorted marker arrays', () => {
    const shuffled = [markers[2], markers[0], markers[1]];
    expect(warpToBeats(shuffled, 1)).toBeCloseTo(2, 12);
  });

  it('composes with the tempo map (docstring contract)', () => {
    // A transient 1 s into the warped source sits at clip beat 2; the clip
    // starts at Set beat 8; 120 BPM constant → 5 s on the render timeline
    // relative to a region starting at beat 0.
    const tb = new TimeBridge([{ beat: 0, bpm: 120 }]);
    const clipBeat = warpToBeats(markers, 1);
    expect(tb.beatsToSeconds(8 + clipBeat)).toBeCloseTo(5, 12);
  });
});
