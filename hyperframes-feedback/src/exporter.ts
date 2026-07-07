/**
 * exporter.ts — assembles the Timeline contract from Live via the adapter.
 * Pure orchestration: no SDK calls, no rendering. Easy to unit test by
 * mocking liveAdapter.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Timeline, RenderRequest } from './types';
import { TimeBridge } from './timebridge';
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

/**
 * The caller resolves the selection once (run-once command model) and holds
 * it while the studio is open, so refresh-from-Set re-exports re-use it.
 */
export async function exportSelection(
  sel: live.SelectionContext,
  req: RenderRequest,
): Promise<ExportResult> {
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
  const durationSeconds = new TimeBridge(tempoMap).beatsToSeconds(sel.durationBeats);

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

function tmpBase(): string {
  return process.env.TMPDIR ?? '/tmp';
}
