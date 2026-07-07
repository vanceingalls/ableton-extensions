/**
 * main.ts — extension entry point.
 *
 * One command: right-click a clip → "Render Clip to Video…". We read the clip's
 * notes via the SDK adapter, build a Timeline, render it with HyperFrames, and
 * import the MP4 back into the Set. One click = one render.
 */

import './polyfill'; // MUST be first: installs fetch/web globals before anything else loads
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as live from './liveAdapter';
import { render, type Timeline } from './render';

export async function activate(activation: unknown): Promise<void> {
  live.bindActivation(activation);
  await live.registerAction('Render Clip to Video…', 'starter.render', (target) => {
    void runSession(target).catch((e) => console.error('render session failed:', e));
  });
  console.log('activate: registered');
}

async function runSession(target: unknown): Promise<void> {
  const sel = await live.getSelection(target);
  console.log(`selection "${sel.title}": ${sel.notes.length} notes @ ${sel.bpm} bpm`);

  const timeline: Timeline = {
    title: sel.title,
    color: sel.color,
    bpm: sel.bpm,
    notes: sel.notes,
    durationSeconds: (sel.durationBeats / sel.bpm) * 60, // constant-tempo beats → seconds
    width: 1080,
    height: 1920,
    fps: 30,
  };

  const workDir = path.join(live.tempDirectory() ?? process.env.TMPDIR ?? '/tmp', `render-${Date.now()}`);

  // A HeyGen key (env or stored) → cloud render (works in an installed extension).
  // No key → local render, which only works on the dev host (`extensions-cli run`).
  const heygenKey = process.env.HEYGEN_API_KEY ?? (await readStoredKey());

  try {
    const mp4 = await live.withProgress('Rendering…', (report) => {
      report(undefined, 'Rendering with HyperFrames…');
      return render(workDir, timeline, heygenKey);
    });
    const delivered = await live.deliverIntoProject(mp4);
    console.log('imported:', delivered);
    await live.showDialog(dialog('Render complete', `Imported into your project:\n${delivered}`), 520, 220).catch(() => {});
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error('render failed:', message);
    await live.showDialog(dialog('Render failed', message), 520, 240).catch(() => {});
  }
}

/** Read a stored HeyGen key from the extension's storage dir, if present. */
async function readStoredKey(): Promise<string | undefined> {
  const dir = live.storageDirectory();
  if (!dir) return undefined;
  try {
    const k = (await fs.readFile(path.join(dir, 'heygen-key'), 'utf8')).trim();
    return k || undefined;
  } catch {
    return undefined;
  }
}

/** A minimal modal built as a data: URL (http://localhost won't load in the WebView). */
function dialog(heading: string, message: string): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
  const html =
    `<!doctype html><meta charset=utf-8><body style="margin:0;background:#333;color:#ddd;` +
    `font:13px -apple-system,sans-serif;display:flex;flex-direction:column;gap:14px;padding:20px;height:100vh;box-sizing:border-box">` +
    `<b style="color:#ff9d4d">${esc(heading)}</b>` +
    `<div style="flex:1;white-space:pre-line;word-break:break-all">${esc(message)}</div>` +
    `<button style="align-self:flex-end;padding:6px 18px;border-radius:12px;border:0;background:#ff9d4d;color:#1a1200;font:inherit" ` +
    `onclick="(window.webkit?.messageHandlers?.live||window.chrome?.webview).postMessage({method:'close_and_send',params:['ok']})">Close</button></body>`;
  return 'data:text/html,' + encodeURIComponent(html);
}
