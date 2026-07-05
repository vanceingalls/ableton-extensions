/**
 * exporter.ts — assembles the Timeline contract from Live via the adapter.
 * Pure orchestration: no SDK calls, no rendering. Easy to unit test by
 * mocking liveAdapter.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Timeline, RenderRequest } from './types';
import * as live from './liveAdapter';

const FORMAT_VERSION = '1.0.0';
const EXTENSION_VERSION = '0.1.0';

const ASPECTS: Record<RenderRequest['aspect'], { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '16:9': { width: 1920, height: 1080 },
};

export interface ExportResult {
  timeline: Timeline;
  timelinePath: string;
  audioPath: string | null; // null => user must export audio manually
  workDir: string;
}

export async function exportSelection(req: RenderRequest): Promise<ExportResult> {
  const sel = await live.getSelection();

  const [tempoMap, timeSignatures, notes, automation, markers, tracks] = await Promise.all([
    live.getTempoMap(),
    live.getTimeSignatures(),
    live.getNotes(sel),
    live.getAutomation(sel),
    live.getMarkers(sel),
    live.getTracks(),
  ]);

  const workDir = req.outputDir ?? path.join(tmpBase(), `clip2video-${Date.now()}`);
  await fs.mkdir(workDir, { recursive: true });

  const audioPath = await live.bounceAudio(sel, path.join(workDir, 'audio.wav'));
  const durationSeconds = beatsToSeconds(sel.durationBeats, tempoMap);

  const timeline: Timeline = {
    formatVersion: FORMAT_VERSION,
    meta: {
      title: sel.clipName,
      clipColor: sel.clipColor,
      extensionVersion: EXTENSION_VERSION,
      exportedAt: new Date().toISOString(),
      sourceScope: sel.scope,
    },
    timing: { durationBeats: sel.durationBeats, tempoMap, timeSignatures },
    audio: {
      file: 'audio.wav',
      durationSeconds,
      offsetBeats: 0,
    },
    notes,
    automation,
    markers,
    tracks,
    video: {
      ...ASPECTS[req.aspect],
      fps: req.fps,
      style: req.style,
      mappings: req.mappings,
    },
  };

  const timelinePath = path.join(workDir, 'timeline.json');
  await fs.writeFile(timelinePath, JSON.stringify(timeline, null, 2), 'utf8');

  return { timeline, timelinePath, audioPath, workDir };
}

/**
 * Convert a beat position to seconds through the tempo map.
 * Handles held tempos and linear ramps between points.
 */
export function beatsToSeconds(beat: number, tempoMap: Timeline['timing']['tempoMap']): number {
  let seconds = 0;
  for (let i = 0; i < tempoMap.length; i++) {
    const cur = tempoMap[i];
    const next = tempoMap[i + 1];
    const segEnd = next ? Math.min(next.beat, beat) : beat;
    if (segEnd <= cur.beat) break;
    const segBeats = segEnd - cur.beat;

    if (cur.ramp && next && next.bpm !== cur.bpm) {
      // Linear BPM ramp: integrate 60/bpm(beats) over the segment.
      const span = next.beat - cur.beat;
      const b0 = cur.bpm;
      const b1 = cur.bpm + (next.bpm - cur.bpm) * (segBeats / span);
      seconds += (60 * segBeats * Math.log(b1 / b0)) / (b1 - b0);
    } else {
      seconds += (60 / cur.bpm) * segBeats;
    }
    if (!next || beat <= next.beat) break;
  }
  return seconds;
}

function tmpBase(): string {
  return process.env.TMPDIR ?? '/tmp';
}
