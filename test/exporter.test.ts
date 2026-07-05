/**
 * Exporter tests (§11): exporter against a mocked liveAdapter; every emitted
 * timeline validated against the normative schema with ajv; audio duration
 * derived through TimeBridge (ramp map, so re-derived math would drift).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const TEMPO_MAP = [
  { beat: 0, bpm: 120, ramp: true },
  { beat: 8, bpm: 90 },
];

vi.mock('../src/liveAdapter', () => ({
  getTempoMap: vi.fn(async () => TEMPO_MAP),
  getTimeSignatures: vi.fn(async () => [{ beat: 0, numerator: 4, denominator: 4 }]),
  getNotes: vi.fn(async () => [
    { pitch: 36, startBeat: 0, lengthBeats: 0.5, velocity: 100 },
    { pitch: 38, startBeat: 1, lengthBeats: 0.5, velocity: 90 },
  ]),
  getAutomation: vi.fn(async () => ({
    track1_filter_freq: {
      name: 'Auto Filter > Frequency',
      unit: 'Hz',
      min: 20,
      max: 20000,
      points: [
        { beat: 0, value: 200, curve: 'linear' },
        { beat: 8, value: 8000, curve: 'linear' },
      ],
    },
  })),
  getMarkers: vi.fn(async () => [{ beat: 0, label: 'Intro', kind: 'section' }]),
  getTracks: vi.fn(async () => []),
  bounceAudio: vi.fn(async (_sel: unknown, outPath: string) => outPath),
}));

import { exportSelection } from '../src/exporter';
import { TimeBridge } from '../src/timebridge';
import * as live from '../src/liveAdapter';
import type { RenderRequest } from '../src/types';

const SEL: live.SelectionContext = {
  scope: 'clip',
  clipName: 'Kick Pattern',
  clipColor: '#ff5722',
  isMidi: true,
  startBeat: 16,
  durationBeats: 16,
};

function makeReq(outputDir: string): RenderRequest {
  return {
    aspect: '9:16',
    fps: 30,
    style: 'pulse-waveform',
    mappings: [{ lane: 'track1_filter_freq', target: 'glow' }],
    outputDir,
  };
}

let ajv: Ajv;
let validate: ReturnType<Ajv['compile']>;

beforeAll(async () => {
  ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const schema = JSON.parse(
    await fs.readFile(path.join(__dirname, '..', 'schema', 'timeline.schema.json'), 'utf8'),
  );
  validate = ajv.compile(schema);
});

async function freshExport() {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'c2v-'));
  return exportSelection(SEL, makeReq(outputDir));
}

describe('exportSelection', () => {
  it('writes timeline.json to the work dir and returns it parsed', async () => {
    const result = await freshExport();
    const onDisk = JSON.parse(await fs.readFile(result.timelinePath, 'utf8'));
    expect(onDisk).toEqual(result.timeline);
    expect(path.dirname(result.timelinePath)).toBe(result.workDir);
  });

  it('emits a schema-valid timeline', async () => {
    const result = await freshExport();
    const ok = validate(result.timeline);
    if (!ok) console.error(validate.errors);
    expect(ok).toBe(true);
  });

  it('derives audio duration through TimeBridge (ramp-aware)', async () => {
    const result = await freshExport();
    const expected = new TimeBridge(TEMPO_MAP).beatsToSeconds(SEL.durationBeats);
    expect(result.timeline.audio.durationSeconds).toBeCloseTo(expected, 12);
    // Sanity: a ramp map, so the naive constant-tempo answer must differ.
    expect(expected).not.toBeCloseTo((60 / 120) * SEL.durationBeats, 2);
  });

  it('maps aspect to pixel dimensions', async () => {
    const result = await freshExport();
    expect(result.timeline.video.width).toBe(1080);
    expect(result.timeline.video.height).toBe(1920);
    expect(result.timeline.video.fps).toBe(30);
  });

  it('carries selection metadata and render request through', async () => {
    const result = await freshExport();
    expect(result.timeline.meta.title).toBe('Kick Pattern');
    expect(result.timeline.meta.clipColor).toBe('#ff5722');
    expect(result.timeline.meta.sourceScope).toBe('clip');
    expect(result.timeline.video.style).toBe('pulse-waveform');
    expect(result.timeline.video.mappings).toEqual([
      { lane: 'track1_filter_freq', target: 'glow' },
    ]);
  });

  it('returns null audioPath when the bounce is unavailable (manual fallback)', async () => {
    vi.mocked(live.bounceAudio).mockResolvedValueOnce(null);
    const result = await freshExport();
    expect(result.audioPath).toBeNull();
    // The timeline is still written; only the audio is missing.
    await expect(fs.stat(result.timelinePath)).resolves.toBeTruthy();
  });
});

describe('schema fixtures', () => {
  it('examples/timeline.example.json validates against the schema', async () => {
    const example = JSON.parse(
      await fs.readFile(path.join(__dirname, '..', 'examples', 'timeline.example.json'), 'utf8'),
    );
    const ok = validate(example);
    if (!ok) console.error(validate.errors);
    expect(ok).toBe(true);
  });
});
