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
import { exportSelection, type ExportResult } from './exporter';
import { renderCloud } from './render';
import { startStudioServer } from './studioServer';
import {
  STUDIO_PROTOCOL_VERSION,
  type NodeToWebView,
  type StyleInfo,
  type RequestRenderMsg,
} from './studioProtocol';
import type { RenderRequest } from './types';
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
  live.bindActivation(activation);
  // Registers the command + context-menu action on all six scopes that map
  // to our clip/track/arrangement model (see liveAdapter.registerStudioAction).
  await live.registerStudioAction(
    'Open HyperFrames Studio…',
    'clip2video.openStudio',
    (targetArg) => void runStudioSession(targetArg),
  );
}

/**
 * One right-click → one studio session → done.
 *
 * The dialog only loads a URL and reports back when it closes (VERIFY 5
 * evidence), so all live traffic rides the loopback studio server: SSE for
 * Node→WebView pushes, POST for WebView→Node messages. The server serves the
 * studio HTML and the bounced audio, and lives exactly as long as the dialog.
 */
async function runStudioSession(targetHandle: unknown): Promise<void> {
  const sel = await live.getSelection(targetHandle);
  let result = await exportSelection(sel, DEFAULT_REQUEST);
  const styles = await loadStyles();

  const server = await startStudioServer({
    studioDir: path.dirname(STUDIO_HTML),
    extraFiles: result.audioPath ? { 'audio.wav': result.audioPath } : {},
  });
  const send = (msg: NodeToWebView) => server.send(msg);

  server.onMessage(async (msg) => {
    switch (msg.type) {
      case 'ready':
        send({
          type: 'init',
          protocolVersion: STUDIO_PROTOCOL_VERSION,
          timeline: result.timeline,
          audioUrl: result.audioPath ? './audio.wav' : '',
          availableStyles: styles,
        });
        break;

      case 'refreshFromSet':
        // The signature interaction (§7): re-read the Set through the live
        // handles and push a fresh timeline; the producer's loop is seconds.
        result = await exportSelection(sel, DEFAULT_REQUEST);
        send({ type: 'timelineUpdated', timeline: result.timeline });
        break;

      case 'requestRender':
        await handleRender(msg, sel, send);
        break;

      case 'cancelRender':
        // TODO(M2): thread an AbortSignal through renderCloud.
        break;

      case 'closeStudio':
        // The WebView can't close its own dialog via the server; the studio
        // UI instructs the user, and the SDK close payload ends the session.
        break;
    }
  });

  try {
    // Blocks until the user closes the dialog (the close payload is unused
    // for now; final settings travel over the server instead).
    await live.showStudioDialog(server.url, 960, 640);
  } finally {
    await server.close();
  }
}

async function handleRender(
  msg: RequestRenderMsg,
  sel: live.SelectionContext,
  send: (m: NodeToWebView) => void,
): Promise<void> {
  try {
    const req: RenderRequest = {
      aspect: msg.aspect,
      fps: msg.fps,
      style: msg.style,
      mappings: msg.mappings,
      useCloud: true,
    };
    const result = await exportSelection(sel, req);
    if (!result.audioPath) {
      send({
        type: 'renderError',
        message:
          'Audio bounce is not available in this SDK build — export audio ' +
          'manually (File > Export Audio/Video) and retry. (VERIFY item 1)',
      });
      return;
    }

    const mp4 = await live.withProgress('Rendering with HyperFrames…', (report, signal) =>
      renderCloud(
        {
          workDir: result.workDir,
          templateDir: path.join(TEMPLATES_DIR, msg.style),
          timeline: result.timeline,
        },
        requireApiKey(),
        (phase, pct) => {
          report(pct, phase);
          send({ type: 'renderProgress', phase, pct });
        },
        signal, // user cancel in Live's progress dialog aborts the cloud job
      ),
    );

    // VERIFY 7: import the MP4 into the Live project so the user owns it.
    const delivered = await live.deliverIntoProject(mp4);
    send({ type: 'renderDone', deliveredAs: 'imported', ref: delivered });
  } catch (err) {
    send({ type: 'renderError', message: String((err as Error)?.message ?? err) });
  }
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

function requireApiKey(): string {
  // Same resolution order as the hyperframes CLI. TODO(M3): read
  // ~/.heygen/credentials too, and offer an account-link flow in the studio.
  const key = process.env.HEYGEN_API_KEY ?? process.env.HYPERFRAMES_API_KEY;
  if (!key) throw new Error('HyperFrames Cloud API key not configured (set HEYGEN_API_KEY).');
  return key;
}
