/**
 * render.ts — stage the composition + data, then render it.
 *
 * The composition HTML is inlined into the bundle at build time (esbuild's
 * `text` loader), so we never read our own install directory — Live's managed
 * host forbids that. We write the composition + data into a work dir under
 * tempDirectory() and hand it to HyperFrames.
 *
 * renderLocal — the `hyperframes` CLI (needs Chrome + ffmpeg). Works only on
 *   the un-sandboxed dev host (`extensions-cli run`).
 * renderCloud — the shipped path: upload the zipped bundle to HyperFrames Cloud
 *   (HeyGen) and poll. Works under the managed host's sandbox (no child Node).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import COMPOSITION from '../template/composition.html';

const API_BASE = 'https://api.heygen.com';

export interface Timeline {
  title: string;
  color: string;
  bpm: number;
  notes: { pitch: number; startBeat: number; lengthBeats: number; velocity: number }[];
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
}

/** Write index.html (with size/duration patched in) + data.js into workDir. */
async function stage(workDir: string, tl: Timeline): Promise<void> {
  await fs.mkdir(workDir, { recursive: true });
  const html = COMPOSITION
    .replace(/data-duration="[^"]*"/, `data-duration="${tl.durationSeconds.toFixed(3)}"`)
    .replace(/data-width="[^"]*"/, `data-width="${tl.width}"`)
    .replace(/data-height="[^"]*"/, `data-height="${tl.height}"`);
  await fs.writeFile(path.join(workDir, 'index.html'), html);
  await fs.writeFile(path.join(workDir, 'data.js'), `window.TIMELINE = ${JSON.stringify(tl)};`);
}

/** Render `tl` into workDir/output.mp4. Cloud when a HeyGen key is given, else local. */
export async function render(workDir: string, tl: Timeline, heygenKey?: string): Promise<string> {
  await stage(workDir, tl);
  return heygenKey ? renderCloud(workDir, tl, heygenKey) : renderLocal(workDir, tl);
}

// ---------------------------------------------------------------- local (dev host)

async function renderLocal(workDir: string, tl: Timeline): Promise<string> {
  const out = path.join(workDir, 'output.mp4');
  await run('npx', ['-y', 'hyperframes', 'render', workDir, '--output', out, '--fps', String(tl.fps), '--quiet'], workDir);
  return out;
}

// ---------------------------------------------------------------- cloud (shipped)

async function renderCloud(workDir: string, tl: Timeline, apiKey: string): Promise<string> {
  const out = path.join(workDir, 'output.mp4');
  const zipPath = path.join(path.dirname(workDir), `${path.basename(workDir)}.zip`);
  await run('zip', ['-r', '-q', zipPath, '.'], workDir); // native binary — sandbox-safe
  const assetId = await uploadZip(await fs.readFile(zipPath), apiKey);
  await fs.rm(zipPath, { force: true });

  const submit = await api('POST', '/v3/hyperframes/renders', apiKey, {
    project: { type: 'asset_id', asset_id: assetId }, fps: tl.fps, format: 'mp4', title: tl.title,
  });
  const renderId = submit.render_id ?? submit.data?.render_id;

  for (;;) {
    await sleep(5000);
    const st = await api('GET', `/v3/hyperframes/renders/${renderId}`, apiKey);
    const status = st.status ?? st.data?.status;
    if (status === 'completed') {
      const res = await fetch(st.video_url ?? st.data.video_url);
      await fs.writeFile(out, Buffer.from(await res.arrayBuffer()));
      return out;
    }
    if (status === 'failed' || status === 'error') throw new Error('Cloud render failed.');
  }
}

/** Direct-to-S3 upload the hyperframes CLI uses: create-upload → PUT → complete. */
async function uploadZip(zip: Buffer, apiKey: string): Promise<string> {
  const checksum = createHash('sha256').update(zip).digest('hex');
  const init = await api('POST', '/v3/assets/direct-uploads', apiKey, {
    filename: 'project.zip', content_type: 'application/zip', size_bytes: zip.byteLength, checksum_sha256: checksum,
  });
  const d = init.data ?? init;
  const headers: Record<string, string> = { 'content-type': 'application/zip', ...(d.upload_headers ?? {}) };
  const put = await fetch(d.upload_url, { method: 'PUT', headers, body: new Uint8Array(zip) });
  if (!put.ok) throw new Error(`upload PUT failed: HTTP ${put.status}`);
  for (let i = 0; i < 5; i++) {
    try {
      await api('POST', `/v3/assets/${d.asset_id}/complete`, apiKey, { checksum_sha256: checksum });
      return d.asset_id;
    } catch (e) {
      if (i === 4 || !/HTTP 409/.test(String((e as Error).message))) throw e;
      await sleep(500 * (i + 1));
    }
  }
  return d.asset_id;
}

// ---------------------------------------------------------------- internals

async function api(method: string, apiPath: string, apiKey: string, body?: unknown): Promise<any> {
  const res = await fetch(API_BASE + apiPath, {
    method,
    headers: { 'x-api-key': apiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HyperFrames ${method} ${apiPath} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const extra = [`${process.env.HOME}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin'].join(':');
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${extra}:${process.env.PATH ?? ''}` };
    delete env.NODE_OPTIONS; // don't hand the host's sandbox flags to children
    let out = '';
    const child = spawn(cmd, args, { cwd, env });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => reject(e));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}:\n${out.slice(-1200)}`))));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
