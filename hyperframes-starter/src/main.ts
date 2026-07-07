/**
 * main.ts — the whole loop.
 *
 * right-click an arrangement selection → summarize it (SDK) → review it (Anthropic)
 * → render the review into a video (HyperFrames Cloud) → import it back into the Set.
 *
 * Both API keys are resolved from an env var or the extension's storage dir, and
 * prompted for (and stored) if missing. The HeyGen key is required to render
 * inside an installed extension — local rendering is blocked by the host sandbox.
 */

import './polyfill'; // MUST be first: installs fetch/web globals before the SDK loads
import * as path from 'node:path';
import * as live from './liveAdapter';
import { generateReview, resolveKey, persistKey } from './feedback';
import { render } from './render';

// Composition timing (seconds): intro, per-card, outro.
const INTRO = 2.2, PER = 2.6, OUTRO = 1.6;

export async function activate(activation: unknown): Promise<void> {
  live.bindActivation(activation);
  await live.registerStudioAction(
    'Create Feedback Video from Selection…',
    'starter.feedback',
    (target) => { void runSession(target).catch((e) => console.error('session failed:', e)); },
    live.PROJECT_SCOPES, // arrangement time-selection: select all tracks for the whole project
  );
  console.log('activate: registered');
}

async function runSession(target: unknown): Promise<void> {
  // 1. Read the selection and summarize it (the only SDK work).
  const sel = await live.getSelection(target);
  const summary = await live.getProjectSummary(sel);
  console.log(`summary: ${summary.tracks.length} tracks, ${summary.totalNotes} notes`);

  // 2. API #1 — Anthropic reviews the project.
  const anthropicKey = (await resolveKey('anthropic', live.storageDirectory())) ?? (await promptForKey('anthropic'));
  if (!anthropicKey) return;

  try {
    const report = await live.withProgress('Reviewing your project…', () => generateReview(summary, anthropicKey));
    console.log(`review: score ${report.score}, ${report.points.length} points`);

    // Shape the review for the composition (window.FEEDBACK).
    const colorByTrack = new Map(summary.tracks.map((t) => [t.name, t.color]));
    const accent = summary.tracks.find((t) => t.color)?.color ?? '#ff9d4d';
    const feedback = {
      title: report.title || summary.title,
      overall: report.overall,
      score: report.score,
      accent,
      points: report.points.map((p) => ({
        heading: p.heading, detail: p.detail, sentiment: p.sentiment,
        track: p.track, trackColor: p.track ? colorByTrack.get(p.track) : undefined,
      })),
    };
    const durationSeconds = INTRO + Math.max(1, report.points.length) * PER + OUTRO;

    // 3. API #2 — HyperFrames Cloud renders the composition. A HeyGen key is
    //    required in a real install; "Skip" falls back to local render (dev host).
    const heygenKey = (await resolveKey('heygen', live.storageDirectory())) ?? (await promptForKey('heygen'));
    const workDir = path.join(live.tempDirectory() ?? process.env.TMPDIR ?? '/tmp', `fb-${Date.now()}`);

    const mp4 = await live.withProgress('Rendering feedback video…', (r) => {
      r(undefined, heygenKey ? 'Rendering with HyperFrames Cloud…' : 'Rendering locally…');
      return render({ workDir, feedback, durationSeconds, width: 1080, height: 1920, fps: 30, title: feedback.title }, heygenKey ?? undefined);
    });

    // 4. Import the MP4 back into the Set.
    const delivered = await live.deliverIntoProject(mp4);
    const action = await live.showStudioDialog(doneDialog(delivered), 560, 240).catch(() => 'ok');
    if (action === 'reveal') await live.revealFile(delivered);
    else if (action === 'open') await live.openFile(delivered);
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error('failed:', message);
    await live.showStudioDialog(dialog('Something went wrong', message), 520, 240).catch(() => {});
  }
}

/** Prompt for an API key and store it. Returns null if cancelled/skipped. */
async function promptForKey(which: 'anthropic' | 'heygen'): Promise<string | null> {
  const anthropic = which === 'anthropic';
  const title = anthropic ? 'Anthropic API key needed' : 'HyperFrames Cloud key needed';
  const body = anthropic
    ? 'Claude reviews your project. Paste an Anthropic API key (stored locally) from console.anthropic.com.'
    : 'Rendering inside Live uses HyperFrames Cloud. Paste a HeyGen API key (stored locally) from platform.heygen.com.';
  const cancel = anthropic ? 'Cancel' : 'Skip (dev host)';
  const html =
    `<!doctype html><meta charset=utf-8><body style="margin:0;background:#333;color:#ddd;font:13px -apple-system,sans-serif;` +
    `display:flex;flex-direction:column;gap:12px;padding:20px;height:100vh;box-sizing:border-box">` +
    `<b style="color:#ff9d4d">${title}</b><div>${body}</div>` +
    `<input id=k type=password placeholder="key…" style="padding:7px 10px;border-radius:6px;border:1px solid #111;background:#1e1e1e;color:#eee;font:inherit" />` +
    `<div style="display:flex;gap:8px;justify-content:flex-end">` +
    `<button onclick="post('')" style="padding:6px 18px;border-radius:12px;border:1px solid #111;background:#2a2a2a;color:inherit;font:inherit">${cancel}</button>` +
    `<button onclick="post(document.getElementById('k').value)" style="padding:6px 18px;border-radius:12px;border:0;background:#ff9d4d;color:#1a1200;font-weight:600;font:inherit">Save</button></div>` +
    `<script>function post(v){(window.webkit?.messageHandlers?.live||window.chrome?.webview).postMessage({method:'close_and_send',params:[v]})}</script></body>`;
  const entered = (await live.showStudioDialog('data:text/html,' + encodeURIComponent(html), 460, 240).catch(() => '')).trim();
  if (!entered) return null;
  const dir = live.storageDirectory();
  if (dir) await persistKey(which, dir, entered).catch((e) => console.error(e));
  return entered;
}

function doneDialog(deliveredPath: string): string {
  const btn = (label: string, r: string, primary = false) =>
    `<button onclick="(window.webkit?.messageHandlers?.live||window.chrome?.webview).postMessage({method:'close_and_send',params:['${r}']})" ` +
    `style="padding:6px 18px;border-radius:12px;border:1px solid #111;font:inherit;background:${primary ? '#ff9d4d' : '#2a2a2a'};color:${primary ? '#1a1200' : '#ddd'};${primary ? 'font-weight:600' : ''}">${label}</button>`;
  return dialogUrl('Render complete', `Imported into your project:\n${deliveredPath}`,
    `<div style="display:flex;gap:8px;justify-content:flex-end">${btn('Close', 'ok')}${btn('Reveal', 'reveal')}${btn('Open', 'open', true)}</div>`);
}

function dialog(heading: string, message: string): string {
  return dialogUrl(heading, message,
    `<button onclick="(window.webkit?.messageHandlers?.live||window.chrome?.webview).postMessage({method:'close_and_send',params:['ok']})" ` +
    `style="align-self:flex-end;padding:6px 18px;border-radius:12px;border:1px solid #111;background:#ff9d4d;color:#1a1200;font:inherit">Close</button>`);
}

function dialogUrl(heading: string, message: string, actions: string): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
  const html =
    `<!doctype html><meta charset=utf-8><body style="margin:0;background:#333;color:#ddd;font:13px -apple-system,sans-serif;` +
    `display:flex;flex-direction:column;gap:14px;padding:20px;height:100vh;box-sizing:border-box">` +
    `<b style="color:#ff9d4d">${esc(heading)}</b>` +
    `<div style="flex:1;white-space:pre-line;word-break:break-all">${esc(message)}</div>${actions}</body>`;
  return 'data:text/html,' + encodeURIComponent(html);
}
