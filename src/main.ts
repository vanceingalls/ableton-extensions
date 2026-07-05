/**
 * main.ts — Clip2Video Extension entry point.
 *
 * Flow: right-click in Live → "Render Video…" → panel opens → user picks
 * style/aspect/mappings → export timeline + bounce audio → HyperFrames
 * renders → panel shows the finished MP4.
 *
 * ⚠️ SDK: registration and panel APIs below are placeholders — swap in the
 * real Extensions SDK equivalents (see liveAdapter.ts header for the plan).
 */

import * as path from 'node:path';
import { exportSelection } from './exporter';
import { renderLocal } from './render';
import type { RenderRequest } from './types';
import * as live from './liveAdapter';

declare const ableton: any; // SDK entry point

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

export function activate(): void {
  // SDK: register a context-menu action available on clips, tracks, and the
  // arrangement. The Extension then opens its panel UI (panel/index.html).
  ableton.contextMenu.register({
    label: 'Render Video…',
    appliesTo: ['clip', 'track', 'arrangement'],
    onInvoke: openPanel,
  });
}

async function openPanel(): Promise<void> {
  const sel = await live.getSelection();
  const automation = await live.getAutomation(sel);

  // SDK: open the HTML panel and get a message bridge to it.
  const panel = await ableton.ui.openPanel({
    entry: path.join(__dirname, '..', 'panel', 'index.html'),
    title: 'Clip2Video',
    width: 380,
    height: 560,
  });

  // Seed the panel with what we know: clip name/color for preview theming,
  // available automation lanes for the mapping rows.
  panel.postMessage({
    type: 'init',
    clipName: sel.clipName,
    clipColor: sel.clipColor,
    lanes: Object.entries(automation).map(([id, lane]) => ({ id, name: lane.name })),
  });

  panel.onMessage(async (msg: any) => {
    if (msg.type !== 'render') return;
    const req: RenderRequest = msg.request;

    panel.postMessage({ type: 'status', text: 'Exporting timeline from Live…' });
    const result = await exportSelection(req);

    if (!result.audioPath) {
      // Beta fallback: audio bounce not available via SDK yet.
      panel.postMessage({
        type: 'needAudio',
        text: 'Export audio manually (File > Export Audio/Video) and drop the WAV here.',
        workDir: result.workDir,
      });
      return; // panel re-sends 'render' with { audioFile } once the user drops it
    }

    panel.postMessage({ type: 'status', text: 'Rendering with HyperFrames…' });
    try {
      const mp4 = await renderLocal({
        workDir: result.workDir,
        templateDir: path.join(TEMPLATES_DIR, req.style),
        timeline: result.timeline,
      });
      panel.postMessage({ type: 'done', file: mp4 });
    } catch (err: any) {
      panel.postMessage({ type: 'error', text: String(err?.message ?? err) });
    }
  });
}
