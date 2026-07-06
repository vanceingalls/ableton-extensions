/**
 * main.ts — Clip2Video Extension entry point.
 *
 * Run-once command model (§2 confirmed, §5 debt 1): the user right-clicks a
 * clip/track/the arrangement → "Open HyperFrames Studio…" → we resolve the
 * selection, export the timeline, bounce audio, open the modal studio dialog,
 * service its message bridge until it closes, and drive a progress dialog
 * during cloud render. One invocation = one session; no persistent state.
 *
 * ⚠️ SDK: registration below follows the confirmed canonical pattern
 * (initialize / registerContextMenuAction / getObjectFromHandle) but the
 * exact signatures must be checked against the SDK TypeDoc in Milestone 0.
 * All SDK calls are quarantined in liveAdapter.ts — never import it here.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { exportSelection } from './exporter';
import { renderCloud, renderLocal, type RenderJob } from './render';
import { generateFeedback, resolveApiKey, persistApiKey } from './feedback';
import { type StyleInfo } from './studioProtocol';
import type { RenderRequest, Timeline } from './types';
import type { FeedbackReport } from './feedbackTypes';
import * as live from './liveAdapter';

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const STUDIO_HTML = path.join(__dirname, '..', 'panel', 'index.html');

/** Studio opens with these until the user changes them. */
const DEFAULT_REQUEST: RenderRequest = {
  aspect: '9:16',
  fps: 30,
  style: 'pulse-waveform',
  mappings: [],
};

export async function activate(activation: unknown): Promise<void> {
  console.log('activate: entered');
  try {
    live.bindActivation(activation);
    console.log('activate: SDK initialized');
    // Registers the command + context-menu action on all six scopes that map
    // to our clip/track/arrangement model (see liveAdapter.registerStudioAction).
    await live.registerStudioAction(
      'Render Video…',
      'clip2video.openStudio',
      (targetArg) => {
        console.log('command invoked, target:', JSON.stringify(targetArg, (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
        void runStudioSession(targetArg).catch((e) => console.error('studio session failed:', e));
      },
    );
    await live.registerStudioAction(
      'Create Feedback Video…',
      'clip2video.feedbackVideo',
      (targetArg) => {
        console.log('feedback command invoked');
        void runFeedbackSession(targetArg).catch((e) => console.error('feedback session failed:', e));
      },
    );
    console.log('activate: context-menu actions registered on all scopes');
  } catch (e) {
    console.error('activate FAILED:', e);
    throw e;
  }
}

interface StudioResult {
  action: 'render' | 'cancel';
  style?: string;
  aspect?: RenderRequest['aspect'];
  fps?: RenderRequest['fps'];
}

/**
 * One right-click → one studio session → done.
 *
 * The dialog is a self-contained data: URL (the SDK's proven path — an
 * http://localhost page does not load in the WebView). We inject the exported
 * timeline into the studio HTML, show it, and get the render request back via
 * the dialog's close_and_send payload. Live's live-preview refresh loop (§7)
 * is M3 and will need the server transport; M1 is one request/response.
 */
async function runStudioSession(targetHandle: unknown): Promise<void> {
  const sel = await live.getSelection(targetHandle);
  console.log(`selection: ${sel.scope} "${sel.clipName}" ${sel.durationBeats} beats, midi=${sel.isMidi}`);
  const exported = await exportSelection(sel, DEFAULT_REQUEST);
  console.log(`exported ${exported.timeline.notes.length} notes; audio: ${exported.audioPath ?? 'UNAVAILABLE (silent render)'}`);
  const styles = await loadStyles();

  const dataUrl = await buildStudioDataUrl(exported.timeline, styles, !!exported.audioPath);
  const payload = await live.showStudioDialog(dataUrl, 620, 380);
  console.log('studio closed, payload:', payload);

  let choice: StudioResult;
  try {
    choice = JSON.parse(payload) as StudioResult;
  } catch {
    return; // dialog dismissed without a decision
  }
  if (choice.action !== 'render') return;

  await handleRender(sel, {
    aspect: choice.aspect ?? DEFAULT_REQUEST.aspect,
    fps: choice.fps ?? DEFAULT_REQUEST.fps,
    style: choice.style ?? DEFAULT_REQUEST.style,
    mappings: [],
    useCloud: true,
  });
}

/** Read the studio HTML, inject the session data, return a data: URL. */
async function buildStudioDataUrl(
  timeline: Timeline,
  availableStyles: StyleInfo[],
  audioAvailable: boolean,
): Promise<string> {
  const html = await fs.readFile(STUDIO_HTML, 'utf8');
  const injected = html.replace(
    'null /*__STUDIO_DATA__*/',
    JSON.stringify({ timeline, availableStyles, audioAvailable }),
  );
  return 'data:text/html,' + encodeURIComponent(injected);
}

async function handleRender(sel: live.SelectionContext, req: RenderRequest): Promise<void> {
  const result = await exportSelection(sel, req);
  await runRenderJob(
    {
      workDir: result.workDir,
      templateDir: path.join(TEMPLATES_DIR, req.style),
      timeline: result.timeline,
    },
    'Rendering with HyperFrames…',
  );
}

/**
 * Shared render tail: cloud when HEYGEN_API_KEY is set, else local (dev path,
 * needs Chrome + ffmpeg on PATH). Imports the MP4 into the project and shows
 * the done/error dialog. Used by both the studio render and the feedback video.
 */
async function runRenderJob(job: RenderJob, progressText: string): Promise<void> {
  const apiKey = process.env.HEYGEN_API_KEY ?? process.env.HYPERFRAMES_API_KEY;
  try {
    const mp4 = await live.withProgress(progressText, (report, signal) =>
      apiKey
        ? renderCloud(job, apiKey, (phase, pct) => report(pct, phase), signal)
        : (report(undefined, 'Rendering locally…'), renderLocal(job)),
    );
    const delivered = await live.deliverIntoProject(mp4);
    console.log('render delivered:', delivered);
    const action = await live.showStudioDialog(doneDialogUrl(delivered), 560, 260).catch(() => 'ok');
    if (action === 'reveal') await live.revealFile(delivered);
    else if (action === 'open') await live.openFile(delivered);
  } catch (err) {
    console.error('render failed:', (err as Error)?.message ?? err);
    await live
      .showStudioDialog(errorDialogUrl(String((err as Error)?.message ?? err)), 520, 240)
      .catch(() => {});
  }
}

// ---------------------------------------------------------------- feedback video

const FB_INTRO = 2.2;
const FB_PER = 2.6;
const FB_OUTRO = 1.6;

/**
 * One right-click → project summary → Claude review → feedback video.
 * Needs an Anthropic API key (env ANTHROPIC_API_KEY, or a stored key); if
 * missing, a dialog explains how to add one and offers to paste it.
 */
async function runFeedbackSession(targetArg: unknown): Promise<void> {
  const sel = await live.getSelection(targetArg);
  const summary = await live.getProjectSummary(sel);
  console.log(`feedback summary: ${summary.tracks.length} tracks, ${summary.totalNotes} notes`);

  let apiKey = await resolveApiKey({ storageDir: live.storageDirectory() });
  if (!apiKey) {
    apiKey = await promptForApiKey();
    if (!apiKey) return; // user cancelled
  }

  let report: FeedbackReport;
  try {
    report = await live.withProgress('Asking Claude for feedback…', async (report) => {
      report(undefined, 'Reviewing your project…');
      return generateFeedback(summary, apiKey!);
    });
  } catch (err) {
    await live
      .showStudioDialog(errorDialogUrl(`Feedback failed: ${(err as Error)?.message ?? err}`), 520, 240)
      .catch(() => {});
    return;
  }
  console.log(`feedback: score ${report.score}, ${report.points.length} points`);

  // Resolve each point's track color from the summary for the video.
  const colorByTrack = new Map(summary.tracks.map((t) => [t.name, t.color]));
  const accent = summary.tracks.find((t) => t.color)?.color ?? '#ff9d4d';
  const injected = {
    title: report.title || summary.title,
    overall: report.overall,
    score: report.score,
    accent,
    points: report.points.map((p) => ({
      heading: p.heading,
      detail: p.detail,
      sentiment: p.sentiment,
      track: p.track,
      trackColor: p.track ? colorByTrack.get(p.track) : undefined,
    })),
  };

  const durationSeconds = FB_INTRO + Math.max(1, report.points.length) * FB_PER + FB_OUTRO;
  const timeline = feedbackTimeline(injected.title, durationSeconds);
  const workDir = path.join(tmpBase(), `clip2video-fb-${timeline.meta.exportedAt}`);
  await fs.mkdir(workDir, { recursive: true });

  await runRenderJob(
    {
      workDir,
      templateDir: path.join(TEMPLATES_DIR, 'project-feedback'),
      timeline,
      injectScripts: [
        { filename: 'feedback.js', content: `window.FEEDBACK = ${JSON.stringify(injected)};\n` },
      ],
    },
    'Rendering feedback video…',
  );
}

/** Minimal silent timeline (no audio) sized to the feedback length. */
function feedbackTimeline(title: string, durationSeconds: number): Timeline {
  return {
    formatVersion: '1.0.0',
    meta: { title, exportedAt: new Date().toISOString(), sourceScope: 'arrangement' },
    timing: { durationBeats: 0, tempoMap: [{ beat: 0, bpm: 120 }], timeSignatures: [{ beat: 0, numerator: 4, denominator: 4 }] },
    audio: { file: 'audio.wav', durationSeconds, offsetBeats: 0 },
    notes: [],
    automation: {},
    markers: [],
    video: { width: 1080, height: 1920, fps: 30, style: 'project-feedback' },
  };
}

/** Ask the user to paste an Anthropic API key; store it for next time. */
async function promptForApiKey(): Promise<string | null> {
  const html =
    `<!doctype html><meta charset=utf-8><body style="margin:0;background:hsl(0,0%,21%);color:hsl(0,0%,71%);` +
    `font:13px -apple-system,sans-serif;display:flex;flex-direction:column;gap:12px;padding:20px;height:100vh;box-sizing:border-box">` +
    `<b style="color:#ff9d4d">Anthropic API key needed</b>` +
    `<div>Feedback videos use Claude to review your project. Paste an Anthropic API key ` +
    `(stored locally for next time), or get one at console.anthropic.com.</div>` +
    `<input id=k type=password placeholder="sk-ant-…" style="padding:7px 10px;border-radius:6px;` +
    `border:1px solid hsl(0,0%,7%);background:hsl(0,0%,12%);color:#eee;font:inherit" />` +
    `<div style="display:flex;gap:8px;justify-content:flex-end">` +
    `<button onclick="post('')" style="padding:6px 18px;border-radius:12px;border:1px solid hsl(0,0%,7%);background:hsl(0,0%,16%);color:inherit;font:inherit">Cancel</button>` +
    `<button onclick="post(document.getElementById('k').value)" style="padding:6px 18px;border-radius:12px;border:0;background:#ff9d4d;color:#1a1200;font-weight:600;font:inherit">Save</button></div>` +
    `<script>function post(v){(window.webkit?.messageHandlers?.live||window.chrome?.webview).postMessage({method:'close_and_send',params:[v]})}</script></body>`;
  const entered = await live
    .showStudioDialog('data:text/html,' + encodeURIComponent(html), 460, 240)
    .catch(() => '');
  const key = (entered ?? '').trim();
  if (!key) return null;
  const dir = live.storageDirectory();
  if (dir) {
    await persistApiKey(dir, key).catch((e: unknown) => console.error('key persist failed:', e));
  }
  return key;
}

function tmpBase(): string {
  return process.env.TMPDIR ?? '/tmp';
}

function doneDialogUrl(deliveredPath: string): string {
  const send = (r: string) =>
    `(window.webkit?.messageHandlers?.live||window.chrome?.webview).postMessage({method:'close_and_send',params:['${r}']})`;
  const btn = (label: string, r: string, primary = false) =>
    `<button style="padding:6px 18px;border-radius:12px;border:1px solid hsl(0,0%,7%);font:inherit;cursor:pointer;` +
    `background:${primary ? '#ff9d4d' : 'hsl(0,0%,16%)'};color:${primary ? '#1a1200' : 'inherit'};` +
    `${primary ? 'font-weight:600' : ''}" onclick="${send(r)}">${label}</button>`;
  const html =
    `<!doctype html><meta charset=utf-8><body style="margin:0;background:hsl(0,0%,21%);color:hsl(0,0%,71%);` +
    `font:13px -apple-system,sans-serif;display:flex;flex-direction:column;gap:14px;padding:20px;` +
    `height:100vh;box-sizing:border-box">` +
    `<b style="color:#ff9d4d">Render complete</b>` +
    `<div style="flex:1;white-space:pre-line;word-break:break-all">Imported into your project:\n${escapeHtml(deliveredPath)}</div>` +
    `<div style="display:flex;gap:8px;justify-content:flex-end">` +
    `${btn('Close', 'ok')}${btn('Reveal in Finder', 'reveal')}${btn('Open', 'open', true)}</div></body>`;
  return 'data:text/html,' + encodeURIComponent(html);
}

function errorDialogUrl(message: string): string {
  return infoDialogUrl('Render failed', message);
}

function infoDialogUrl(heading: string, message: string): string {
  const html =
    `<!doctype html><meta charset=utf-8><body style="margin:0;background:hsl(0,0%,21%);` +
    `color:hsl(0,0%,71%);font:13px -apple-system,sans-serif;display:flex;flex-direction:column;` +
    `gap:14px;padding:20px;height:100vh;box-sizing:border-box">` +
    `<b style="color:#ff9d4d">${escapeHtml(heading)}</b>` +
    `<div style="flex:1;white-space:pre-line;word-break:break-all">${escapeHtml(message)}</div>` +
    `<button style="align-self:flex-end;padding:6px 18px;border-radius:12px;border:1px solid hsl(0,0%,7%);` +
    `background:hsl(0,0%,16%);color:inherit;font:inherit" onclick="(window.webkit?.messageHandlers?.live||window.chrome?.webview)` +
    `.postMessage({method:'close_and_send',params:['ok']})">Close</button></body>`;
  return 'data:text/html,' + encodeURIComponent(html);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
}

/** Enumerate templates/<dir>/template.json manifests for the mapping UI. */
async function loadStyles(): Promise<StyleInfo[]> {
  const styles: StyleInfo[] = [];
  for (const entry of await fs.readdir(TEMPLATES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(
        await fs.readFile(path.join(TEMPLATES_DIR, entry.name, 'template.json'), 'utf8'),
      );
      styles.push({ id: entry.name, manifest });
    } catch {
      // No manifest → not a selectable style (§8 makes the manifest mandatory).
    }
  }
  return styles;
}

