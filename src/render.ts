/**
 * render.ts — hands the exported bundle to HyperFrames (v0.7.36 conventions,
 * verified against the CLI source + hyperframes.heygen.com docs; see
 * research/sdk-typedoc-summary.md).
 *
 * Bundle staging: template dir is copied over the work dir (which already
 * holds timeline.json + audio.wav), plus timeline.js (inlined data so the
 * composition needs no runtime fetch) and meta.json.
 *
 * renderLocal — dev machines only: `npx hyperframes render` (needs Chrome +
 *   FFmpeg). Not shipped in the extension.
 * renderCloud — the shipped path: POST /v3/hyperframes/renders with the
 *   zipped bundle inline (base64), poll, download the MP4.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { Timeline } from './types';
import { TEMPLATE_ASSETS } from './templateAssets.generated';

export type RenderPhase = 'uploading' | 'rendering' | 'downloading';

const API_BASE = process.env.HEYGEN_API_URL?.replace(/\/+$/, '') ?? 'https://api.heygen.com';
/** Inline-base64 project limit; beyond this switch to the /v3/assets upload flow (M2+). */
const MAX_INLINE_ZIP_BYTES = 40 * 1024 * 1024;

export interface RenderJob {
  workDir: string; // contains timeline.json + audio.wav
  templateDir: string; // e.g. templates/pulse-waveform
  timeline: Timeline;
  outFile?: string;
  /** Extra JS files to write into the bundle (e.g. feedback.js setting a global). */
  injectScripts?: { filename: string; content: string }[];
  /** The work dir already holds a complete composition (e.g. Claude-authored) —
   *  skip template staging entirely and render it as-is. */
  prestaged?: boolean;
}

/** Write the template's inlined files into the work dir, inline the timeline as
 *  JS, and patch the composition's data attributes (HyperFrames reads
 *  duration/size from the HTML, not from flags).
 *
 *  Files come from TEMPLATE_ASSETS (bundled at build time), NOT from the
 *  extension's install dir — Live's sandbox forbids reading it. The style is
 *  the template dir's basename. The work dir already holds the real exported
 *  timeline.json + audio.wav (written there by the exporter). */
export async function stageBundle(job: RenderJob): Promise<void> {
  if (job.prestaged) return; // work dir already holds a complete composition
  const style = path.basename(job.templateDir);
  const assets = TEMPLATE_ASSETS[style];
  if (!assets) throw new Error(`Unknown template "${style}" — not in TEMPLATE_ASSETS.`);
  for (const [name, content] of Object.entries(assets)) {
    await fs.writeFile(path.join(job.workDir, name), content, 'utf8');
  }

  const indexPath = path.join(job.workDir, 'index.html');
  const { width, height } = job.timeline.video;
  const durationSeconds = job.timeline.audio.durationSeconds;
  const html = (await fs.readFile(indexPath, 'utf8'))
    .replace(/data-duration="[^"]*"/, `data-duration="${durationSeconds.toFixed(3)}"`)
    .replace(/data-width="[^"]*"/, `data-width="${width}"`)
    .replace(/data-height="[^"]*"/, `data-height="${height}"`);
  await fs.writeFile(indexPath, html, 'utf8');

  await fs.writeFile(
    path.join(job.workDir, 'timeline.js'),
    `window.TIMELINE = ${JSON.stringify(job.timeline)};\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(job.workDir, 'meta.json'),
    JSON.stringify({ id: 'clip2video', name: job.timeline.meta.title }, null, 2),
    'utf8',
  );

  for (const s of job.injectScripts ?? []) {
    await fs.writeFile(path.join(job.workDir, s.filename), s.content, 'utf8');
  }
}

/** Dev-machine render via the local CLI. Dimensions/duration/audio all come
 *  from the composition's data attributes, not flags. */
export async function renderLocal(job: RenderJob): Promise<string> {
  const outFile = job.outFile ?? path.join(job.workDir, 'output.mp4');
  await stageBundle(job);
  await run(
    'npx',
    ['-y', 'hyperframes', 'render', job.workDir, '--output', outFile, '--fps', String(job.timeline.video.fps), '--quiet'],
    job.workDir,
  );
  return outFile;
}

export async function renderCloud(
  job: RenderJob,
  apiKey: string,
  onProgress?: (phase: RenderPhase, pct: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const outFile = job.outFile ?? path.join(job.workDir, 'output.mp4');
  await stageBundle(job);

  // Zip the bundle (macOS ships /usr/bin/zip; Live extensions run on Node).
  onProgress?.('uploading', 0);
  const zipPath = path.join(path.dirname(job.workDir), `clip2video-${path.basename(job.workDir)}.zip`);
  await run('zip', ['-r', '-q', zipPath, '.'], job.workDir);
  const zipBytes = await fs.readFile(zipPath);
  await fs.rm(zipPath, { force: true });
  if (zipBytes.byteLength > MAX_INLINE_ZIP_BYTES) {
    throw new Error(
      `Bundle is ${Math.round(zipBytes.byteLength / 1e6)} MB — too large for inline upload; implement the /v3/assets flow.`,
    );
  }

  const submit = await api('POST', '/v3/hyperframes/renders', apiKey, {
    // Discriminated union (like the CLI's {type:'asset_id', asset_id}); the
    // base64 form carries a nested {media_type, data} object.
    project: { type: 'base64', base64: { media_type: 'application/zip', data: zipBytes.toString('base64') } },
    fps: job.timeline.video.fps,
    format: 'mp4',
    title: job.timeline.meta.title,
  }, signal);
  const renderId: string | undefined = submit.render_id ?? submit.data?.render_id;
  if (!renderId) throw new Error(`Cloud submit returned no render_id: ${JSON.stringify(submit).slice(0, 300)}`);
  onProgress?.('uploading', 100);

  // Poll until completed.
  for (;;) {
    signal?.throwIfAborted();
    await sleep(5000, signal);
    const st = await api('GET', `/v3/hyperframes/renders/${renderId}`, apiKey, undefined, signal);
    const s = st.status ?? st.data?.status;
    const pct = Number(st.progress ?? st.data?.progress ?? 0);
    if (s === 'completed') {
      const videoUrl: string | undefined = st.video_url ?? st.data?.video_url;
      if (!videoUrl) throw new Error('Render completed but no video_url in response.');
      onProgress?.('downloading', 0);
      const res = await fetch(videoUrl, { signal });
      if (!res.ok) throw new Error(`MP4 download failed: HTTP ${res.status}`);
      await fs.writeFile(outFile, Buffer.from(await res.arrayBuffer()));
      onProgress?.('downloading', 100);
      return outFile;
    }
    if (s === 'failed' || s === 'error') {
      throw new Error(`Cloud render failed: ${st.error ?? st.data?.error ?? 'unknown error'}`);
    }
    onProgress?.('rendering', Number.isFinite(pct) ? pct : 0);
  }
}

// ---------------------------------------------------------------- internals

async function api(
  method: string,
  apiPath: string,
  apiKey: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<any> {
  const res = await fetch(API_BASE + apiPath, {
    method,
    headers: {
      'x-api-key': apiKey,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HyperFrames Cloud ${method} ${apiPath} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`HyperFrames Cloud returned non-JSON: ${text.slice(0, 200)}`);
  }
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Live's managed host doesn't inherit a dev shell PATH, so the local render
    // (npx/hyperframes/ffmpeg) can't find its tools. Prepend the common
    // user-local install dirs so local render works regardless of how the host
    // was launched. (The shipped path is cloud render; this is the dev path.)
    const extra = [
      `${process.env.HOME}/.local/bin`,
      `${process.env.HOME}/.local/node/node-v24.18.0-darwin-arm64/bin`,
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ].join(':');
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${extra}:${process.env.PATH ?? ''}` };
    // Live's managed host runs the extension's Node under the permission model
    // (--experimental-permission / --allow-fs-*), often via NODE_OPTIONS. A
    // child `npx` (also Node) would inherit that and be sandboxed too, so its
    // file writes (Chrome profile, temp, output) fail. Strip it for children —
    // they run as ordinary OS processes.
    delete env.NODE_OPTIONS;
    // Capture output so a child failure surfaces WHY (inherited stdio would be
    // lost — the host only logs the extension's own console output).
    let out = '';
    const child = spawn(cmd, args, { cwd, env });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => reject(new Error(`${cmd} failed: ${e.message}`)));
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} exited with ${code}. Output tail:\n${out.slice(-1800)}`)),
    );
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('cancelled'));
    }, { once: true });
  });
}
