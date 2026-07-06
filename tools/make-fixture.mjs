// Generates a matched pair of dev fixtures for the pulse-waveform template:
//   audio.wav      — synthesized kick every beat at 124 BPM, 16 beats, 44.1k mono
//   timeline.json  — the same pattern as ground-truth note data
// Because both come from the same numbers, any visual/audio misalignment in
// the browser preview is a template/TimeBridge bug, not a data problem.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2];
if (!OUT) throw new Error('usage: node make-fixture.mjs <template dir>');

const BPM = 124;
const BEATS = 16;
const SR = 44100;
const spb = 60 / BPM;
const durSec = BEATS * spb;
const n = Math.round(durSec * SR);
const pcm = new Float32Array(n);

// Kick: 150→45 Hz pitch sweep, exponential amp decay, ~180 ms.
for (let beat = 0; beat < BEATS; beat++) {
  const start = Math.round(beat * spb * SR);
  const accent = beat % 4 === 0 ? 1.0 : 0.8;
  let phase = 0;
  for (let i = 0; i < 0.18 * SR && start + i < n; i++) {
    const t = i / SR;
    const f = 45 + 105 * Math.exp(-t * 28);
    phase += (2 * Math.PI * f) / SR;
    pcm[start + i] += accent * Math.exp(-t * 22) * Math.sin(phase);
  }
}
// Hat on offbeats so the ear has a subdivision reference.
for (let beat = 0.5; beat < BEATS; beat += 1) {
  const start = Math.round(beat * spb * SR);
  let seed = 12345 + beat * 999; // deterministic noise
  for (let i = 0; i < 0.04 * SR && start + i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    pcm[start + i] += 0.12 * Math.exp(-(i / SR) * 90) * (seed / 0x3fffffff - 1);
  }
}

// 16-bit PCM WAV
const data = new Int16Array(n);
for (let i = 0; i < n; i++) data[i] = Math.max(-1, Math.min(1, pcm[i])) * 32767;
const bytes = new Uint8Array(44 + data.byteLength);
const dv = new DataView(bytes.buffer);
const str = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
str(0, 'RIFF'); dv.setUint32(4, 36 + data.byteLength, true); str(8, 'WAVE');
str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
dv.setUint16(22, 1, true); dv.setUint32(24, SR, true);
dv.setUint32(28, SR * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
str(36, 'data'); dv.setUint32(40, data.byteLength, true);
bytes.set(new Uint8Array(data.buffer), 44);
writeFileSync(join(OUT, 'audio.wav'), bytes);

const timeline = {
  formatVersion: '1.0.0',
  meta: { title: 'Fixture 124', clipColor: '#ff5722', sourceScope: 'clip' },
  timing: {
    durationBeats: BEATS,
    tempoMap: [{ beat: 0, bpm: BPM }],
    timeSignatures: [{ beat: 0, numerator: 4, denominator: 4 }],
  },
  audio: { file: 'audio.wav', sampleRate: SR, channels: 1, durationSeconds: durSec, offsetBeats: 0 },
  notes: Array.from({ length: BEATS }, (_, b) => ({
    pitch: 36, startBeat: b, lengthBeats: 0.25, velocity: b % 4 === 0 ? 127 : 100,
  })),
  automation: {},
  markers: [
    { beat: 0, label: 'Intro', kind: 'section' },
    { beat: 8, label: 'Drop', kind: 'section' },
  ],
  video: { width: 540, height: 960, fps: 30, style: 'pulse-waveform', mappings: [] },
};
writeFileSync(join(OUT, 'timeline.json'), JSON.stringify(timeline, null, 2));
console.log(`wrote audio.wav (${durSec.toFixed(3)}s) + timeline.json to ${OUT}`);
