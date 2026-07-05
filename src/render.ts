/**
 * render.ts — hands the exported bundle to HyperFrames.
 *
 * Two paths:
 *   local: spawn the HyperFrames CLI against the chosen template folder.
 *   cloud: POST the bundle to HyperFrames Cloud (needs an API key).
 *
 * ⚠️ Exact CLI flags / API routes: verify against the HyperFrames repo
 * (github.com/heygen-com/hyperframes) — you know this codebase better than
 * this comment does. The contract this wrapper relies on is only:
 *   input  = a template dir (HTML entry) + timeline.json + audio.wav
 *   output = a deterministic MP4 at `outFile`, audio muxed in.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { Timeline } from './types';

export interface RenderJob {
  workDir: string; // contains timeline.json + audio.wav
  templateDir: string; // e.g. templates/pulse-waveform
  timeline: Timeline;
  outFile?: string;
}

export async function renderLocal(job: RenderJob): Promise<string> {
  const outFile = job.outFile ?? path.join(job.workDir, 'output.mp4');
  const { width, height, fps } = job.timeline.video;
  const durationSec = job.timeline.audio.durationSeconds;

  // Stage the template next to the data so relative fetches of
  // ./timeline.json and ./audio.wav resolve inside the render page.
  await copyDir(job.templateDir, job.workDir);

  const args = [
    'hyperframes', 'render',
    path.join(job.workDir, 'index.html'),
    '--width', String(width),
    '--height', String(height),
    '--fps', String(fps),
    '--duration', durationSec.toFixed(3),
    '--audio', path.join(job.workDir, 'audio.wav'),
    '--out', outFile,
  ];

  await run('npx', args, job.workDir);
  return outFile;
}

export async function renderCloud(job: RenderJob, apiKey: string): Promise<string> {
  // Sketch: zip workDir, POST to the HyperFrames Cloud render endpoint,
  // poll for completion, download MP4. Fill in against the real API.
  throw new Error('Cloud rendering not wired up yet — use renderLocal.');
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)),
    );
  });
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.cp(src, dest, { recursive: true, force: true });
}
