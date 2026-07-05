"use strict";
var TimeBridgeLib = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/timebridge.ts
  var timebridge_exports = {};
  __export(timebridge_exports, {
    TimeBridge: () => TimeBridge,
    beatsToWarp: () => beatsToWarp,
    warpToBeats: () => warpToBeats
  });
  var TimeBridge = class {
    map;
    /** Cumulative seconds at each tempo point, precomputed for O(log n) lookups. */
    cumSec;
    constructor(tempoMap) {
      if (!tempoMap.length) throw new Error("TimeBridge: empty tempo map");
      this.map = [...tempoMap].sort((a, b) => a.beat - b.beat);
      this.cumSec = [0];
      for (let i = 0; i < this.map.length - 1; i++) {
        this.cumSec.push(
          this.cumSec[i] + segmentSeconds(this.map[i], this.map[i + 1], this.map[i + 1].beat)
        );
      }
    }
    // ---------- beats <-> seconds ----------
    beatsToSeconds(beat) {
      const i = this.segmentAt(beat);
      return this.cumSec[i] + segmentSeconds(this.map[i], this.map[i + 1], beat);
    }
    secondsToBeats(t) {
      let i = this.cumSec.length - 1;
      for (let k = 1; k < this.cumSec.length; k++) {
        if (t < this.cumSec[k]) {
          i = k - 1;
          break;
        }
      }
      const a = this.map[i];
      const b = this.map[i + 1];
      const dt = t - this.cumSec[i];
      if (a.ramp && b && b.bpm !== a.bpm) {
        const k = (b.bpm - a.bpm) / (b.beat - a.beat);
        return a.beat + a.bpm / k * (Math.exp(k * dt / 60) - 1);
      }
      return a.beat + dt * (a.bpm / 60);
    }
    // ---------- seconds <-> frames ----------
    secondsToFrame(t, fps, q = "nearest") {
      return quantize(t * fps, q);
    }
    frameToSeconds(frame, fps) {
      return frame / fps;
    }
    // ---------- beats <-> frames (the common path) ----------
    /**
     * Where a musical event lands on the render timeline.
     * Policy guidance: 'nearest' for accents/pulses, 'floor' for cut
     * boundaries (a cut belongs to the frame it starts in).
     */
    beatsToFrame(beat, fps, q = "nearest") {
      return this.secondsToFrame(this.beatsToSeconds(beat), fps, q);
    }
    frameToBeats(frame, fps) {
      return this.secondsToBeats(this.frameToSeconds(frame, fps));
    }
    // ---------- diagnostics ----------
    /**
     * Round-trip invariant for the B-side (cue sheets -> Live -> back).
     * Returns max |t - beatsToSeconds(secondsToBeats(t))| over sample points.
     * Assert this < 1e-6 in tests; timing must not decay across import cycles.
     */
    roundTripError(durationSeconds, samples = 1e3) {
      let worst = 0;
      for (let i = 0; i <= samples; i++) {
        const t = i / samples * durationSeconds;
        worst = Math.max(worst, Math.abs(t - this.beatsToSeconds(this.secondsToBeats(t))));
      }
      return worst;
    }
    segmentAt(beat) {
      let lo = 0, hi = this.map.length - 1;
      if (hi < 0) return 0;
      while (lo < hi) {
        const mid = lo + hi + 1 >> 1;
        if (this.map[mid].beat <= beat) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    }
  };
  function warpToBeats(markers, sampleTime) {
    const m = [...markers].sort((a2, b2) => a2.sampleTime - b2.sampleTime);
    if (m.length === 1) return m[0].beatTime;
    let i = m.length - 2;
    for (let k = 0; k < m.length - 1; k++) {
      if (sampleTime < m[k + 1].sampleTime) {
        i = k;
        break;
      }
    }
    const a = m[i], b = m[i + 1];
    const f = (sampleTime - a.sampleTime) / (b.sampleTime - a.sampleTime);
    return a.beatTime + f * (b.beatTime - a.beatTime);
  }
  function beatsToWarp(markers, beatTime) {
    const m = [...markers].sort((a2, b2) => a2.beatTime - b2.beatTime);
    if (m.length === 1) return m[0].sampleTime;
    let i = m.length - 2;
    for (let k = 0; k < m.length - 1; k++) {
      if (beatTime < m[k + 1].beatTime) {
        i = k;
        break;
      }
    }
    const a = m[i], b = m[i + 1];
    const f = (beatTime - a.beatTime) / (b.beatTime - a.beatTime);
    return a.sampleTime + f * (b.sampleTime - a.sampleTime);
  }
  function segmentSeconds(a, b, beat) {
    const span = Math.max(0, beat - a.beat);
    if (span === 0) return 0;
    if (a.ramp && b && b.bpm !== a.bpm) {
      const k = (b.bpm - a.bpm) / (b.beat - a.beat);
      const bpmAtBeat = a.bpm + k * span;
      return 60 / k * Math.log(bpmAtBeat / a.bpm);
    }
    return 60 / a.bpm * span;
  }
  function quantize(x, q) {
    if (q === "floor") return Math.floor(x);
    if (q === "ceil") return Math.ceil(x);
    return Math.round(x);
  }
  return __toCommonJS(timebridge_exports);
})();
