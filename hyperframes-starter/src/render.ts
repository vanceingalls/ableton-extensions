/**
 * render.ts — API #2: HyperFrames Cloud (HeyGen).
 *
 * Live's managed host sandboxes Node child processes, so the local `hyperframes`
 * CLI can't run in a real install — the shipped path is a network render. This is
 * why a HeyGen key is *required* to render inside Live. The Cloud flow (replicated
 * from the hyperframes CLI so the request shapes are correct):
 *   1. POST /v3/assets/direct-uploads → { asset_id, upload_url }
 *   2. PUT the zip to upload_url (presigned S3 — no api key on that request)
 *   3. POST /v3/assets/{asset_id}/complete
 *   4. POST /v3/hyperframes/renders { project: { type:'asset_id', asset_id } }
 *   5. poll GET /v3/hyperframes/renders/{id} → download video_url
 *
 * The composition (with GSAP + your review data) is inlined into the bundle at
 * build time and written into the work dir — the sandbox forbids reading the
 * install dir at runtime.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import COMPOSITION from '../template/composition.html';
import GSAP from '../template/gsap.txt';

const API_BASE = 'https://api.heygen.com';
const CONTENT_TYPE_ZIP = 'application/zip';

export interface RenderInput {
  workDir: string;
  feedback: unknown; // the object exposed to the composition as window.FEEDBACK
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  title: string;
}

/** Stage the composition, then render. Cloud when a HeyGen key is given, else local (dev host). */
export async function render(input: RenderInput, heygenKey?: string): Promise<string> {
  await stage(input);
  return heygenKey ? renderCloud(input, heygenKey) : renderLocal(input);
}

/** Write index.html (size/duration patched), gsap.min.js, and feedback.js into workDir. */
async function stage(input: RenderInput): Promise<void> {
  await fs.mkdir(input.workDir, { recursive: true });
  const html = COMPOSITION
    .replace(/data-duration="[^"]*"/, `data-duration="${input.durationSeconds.toFixed(3)}"`)
    .replace(/data-width="[^"]*"/, `data-width="${input.width}"`)
    .replace(/data-height="[^"]*"/, `data-height="${input.height}"`);
  await fs.writeFile(path.join(input.workDir, 'index.html'), html);
  await fs.writeFile(path.join(input.workDir, 'gsap.min.js'), GSAP);
  await fs.writeFile(path.join(input.workDir, 'feedback.js'), `window.FEEDBACK = ${JSON.stringify(input.feedback)};`);
}

// ---------------------------------------------------------------- cloud (shipped)

async function renderCloud(input: RenderInput, apiKey: string): Promise<string> {
  const out = path.join(input.workDir, 'output.mp4');
  const zipPath = path.join(path.dirname(input.workDir), `${path.basename(input.workDir)}.zip`);
  await run('zip', ['-r', '-q', zipPath, '.'], input.workDir); // native binary — sandbox-safe
  const assetId = await uploadZip(await fs.readFile(zipPath), apiKey);
  await fs.rm(zipPath, { force: true });

  const submit = await api('POST', '/v3/hyperframes/renders', apiKey, {
    project: { type: 'asset_id', asset_id: assetId }, fps: input.fps, format: 'mp4', title: input.title,
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

/** Direct-to-S3 upload: create-upload → PUT → complete (retry 409). */
async function uploadZip(zip: Buffer, apiKey: string): Promise<string> {
  const checksum = createHash('sha256').update(zip).digest('hex');
  const init = await api('POST', '/v3/assets/direct-uploads', apiKey, {
    filename: 'project.zip', content_type: CONTENT_TYPE_ZIP, size_bytes: zip.byteLength, checksum_sha256: checksum,
  });
  const d = init.data ?? init;
  const headers: Record<string, string> = { 'content-type': CONTENT_TYPE_ZIP, ...(d.upload_headers ?? {}) };
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

// ---------------------------------------------------------------- local (dev host)

async function renderLocal(input: RenderInput): Promise<string> {
  const out = path.join(input.workDir, 'output.mp4');
  await run('npx', ['-y', 'hyperframes', 'render', input.workDir, '--output', out, '--fps', String(input.fps), '--quiet'], input.workDir);
  return out;
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
