/**
 * composer.ts — Claude authors a HyperFrames composition for the feedback
 * video, then lints and self-repairs it until clean (the roadmap's "make me a
 * video" path). The composition is a single self-contained index.html driven
 * by a paused GSAP timeline — the conventions come straight from the
 * HyperFrames authoring skills.
 *
 * Flow: author → write index.html + gsap.min.js → `hyperframes lint --json` →
 * feed any errors back to Claude → repeat (bounded). If it can't be made clean,
 * the caller falls back to the fixed project-feedback template.
 */

import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ProjectSummary, FeedbackReport } from './feedbackTypes';
import { GSAP_MIN } from './templateAssets.generated';

const MODEL = 'claude-opus-4-8';
const MAX_FIX_ROUNDS = 3;

const CONVENTIONS = `You author HyperFrames compositions. HyperFrames renders
video from ONE self-contained HTML file by seeking it frame-by-frame, so every
frame must be reproducible from its time value alone.

HARD RULES (violating these breaks the render):
- Root element: <div id="root" data-composition-id="main" data-start="0"
  data-width="W" data-height="H" data-duration="SECONDS"> sitting directly in
  <body> (NO <template> wrapper). data-start="0" is REQUIRED on the root. Give
  #root an explicit sized box (width/height in px) and overflow:hidden.
- Every timed element is a clip: class="clip" + data-start, data-duration,
  data-track-index (integer z-order). Clips are position:absolute; build their
  visible end-state in static HTML/CSS, then animate from/to it.
- Register EXACTLY ONE paused timeline built synchronously at load:
  window.__timelines["main"] = gsap.timeline({ paused: true }); (key === the
  root data-composition-id). Do NOT call tl.play(); do NOT build it inside
  async/Promise/setTimeout/event handlers.
- Load GSAP with <script src="./gsap.min.js"></script> (provided locally). Use
  NO other network, NO external fonts/images/CDN. Everything inline.
- FORBIDDEN: Date.now/performance.now/any clock; unseeded Math.random; network
  fetch; hover/scroll/pointer/focus; repeat:-1 (use a finite count).
- Animate ONLY: opacity, x, y, scale, rotation, color, backgroundColor,
  borderRadius, transforms. NEVER animate display or visibility.
- Transformed elements (scale/scaleX/scaleY) must be display:block/inline-block
  and have a real width/height, or they render invisible.
- No <br> in body text — let it wrap with max-width. Keep text inside its
  container.
- Render duration comes from the root data-duration (set it to cover all your
  clips), not from the timeline length.

Output ONLY the complete HTML document, nothing else — no markdown fences, no
commentary.`;

interface LintFinding {
  severity?: string;
  code?: string;
  message?: string;
  fixHint?: string;
  snippet?: string;
  line?: number;
}

export interface AuthoredComposition {
  html: string;
  durationSeconds: number;
}

/**
 * Author + lint-fix a feedback composition into `workDir`. Writes index.html
 * and gsap.min.js. Returns the composition, or throws if it can't be made
 * lint-clean within the round budget (caller should fall back).
 */
export async function authorFeedbackComposition(
  report: FeedbackReport,
  summary: ProjectSummary,
  apiKey: string,
  workDir: string,
  width: number,
  height: number,
  onProgress?: (msg: string) => void,
): Promise<AuthoredComposition> {
  const client = new Anthropic({ apiKey });
  await fs.writeFile(path.join(workDir, 'gsap.min.js'), GSAP_MIN, 'utf8');
  await fs.writeFile(
    path.join(workDir, 'meta.json'),
    JSON.stringify({ id: 'main', name: report.title || summary.title }),
    'utf8',
  );

  onProgress?.('Designing the video…');
  let html = await authorHtml(client, report, summary, width, height);
  await fs.writeFile(path.join(workDir, 'index.html'), html, 'utf8');

  let errors: LintFinding[] = [];
  for (let round = 1; round <= MAX_FIX_ROUNDS; round++) {
    errors = (await lint(workDir)).filter((f) => f.severity === 'error');
    if (!errors.length) break;
    onProgress?.(`Fixing ${errors.length} issue(s) (round ${round})…`);
    html = await fixHtml(client, html, errors);
    await fs.writeFile(path.join(workDir, 'index.html'), html, 'utf8');
  }
  if (errors.length) {
    throw new Error(`Composition still has ${errors.length} lint error(s) after ${MAX_FIX_ROUNDS} fixes.`);
  }
  // Backstop lint (a no-op under Live's sandbox) with an in-process check, so a
  // structurally broken composition still falls back to the fixed template.
  const problem = basicValidate(html);
  if (problem) throw new Error(`Authored composition rejected: ${problem}`);
  onProgress?.('Composition is clean.');
  return { html, durationSeconds: readDuration(html) };
}

async function authorHtml(
  client: Anthropic,
  report: FeedbackReport,
  summary: ProjectSummary,
  width: number,
  height: number,
): Promise<string> {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: CONVENTIONS,
    messages: [
      {
        role: 'user',
        content:
          `Author a ${width}×${height} feedback video that presents this production review of an ` +
          `Ableton Live project. Open with the project title and an overall score gauge, then reveal ` +
          `each feedback point in turn (color-code by sentiment: strength=green, suggestion=amber, ` +
          `watch=red), and use the project's accent color where you can. Make it feel like a polished ` +
          `music-app "track review". Aim for roughly ${2 + report.points.length * 2.6}s.\n\n` +
          `REVIEW (JSON):\n${JSON.stringify(report, null, 2)}\n\n` +
          `PROJECT CONTEXT (JSON):\n${JSON.stringify(summary, null, 2)}`,
      },
    ],
  });
  return stripFences(await finalText(stream));
}

async function fixHtml(client: Anthropic, html: string, errors: LintFinding[]): Promise<string> {
  const list = errors
    .map((e) => {
      let s = `- [${e.code ?? 'error'}] ${e.message ?? ''}`;
      if (e.fixHint) s += `\n  Fix: ${e.fixHint}`;
      if (e.snippet) s += `\n  At: ${e.snippet}`;
      return s;
    })
    .join('\n');
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: CONVENTIONS,
    messages: [
      {
        role: 'user',
        content:
          `This HyperFrames composition failed lint. Fix ONLY these errors and return the complete ` +
          `corrected HTML (no commentary, no fences):\n\n${list}\n\n--- CURRENT HTML ---\n${html}`,
      },
    ],
  });
  return stripFences(await finalText(stream));
}

async function finalText(stream: ReturnType<Anthropic['messages']['stream']>): Promise<string> {
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('The model declined to author the composition.');
  // A truncated composition (unclosed tags/script) would render broken. Treat it
  // as a failure so the caller falls back to the fixed template.
  if (msg.stop_reason === 'max_tokens') throw new Error('The composition hit max_tokens and was truncated.');
  const block = msg.content.find((b: Anthropic.ContentBlock) => b.type === 'text');
  const text = block && block.type === 'text' ? block.text : undefined;
  if (!text) throw new Error('No composition returned.');
  return text;
}

/**
 * In-process sanity check (no subprocess). `hyperframes lint` is a child Node
 * process and can't run under Live's sandbox, so lint() returns [] there and
 * catches nothing — this backstops it for the failure modes that make a render
 * blank or frozen, so a broken authored composition still falls back to the
 * fixed template instead of being rendered. Returns a reason string, or null.
 */
function basicValidate(html: string): string | null {
  if (!/data-composition-id\s*=\s*["']main["']/.test(html)) return 'missing root data-composition-id="main"';
  if (!/window\.__timelines\s*\[\s*['"]main['"]\s*\]\s*=/.test(html))
    return "no window.__timelines['main'] registration (would render frozen)";
  if (!/gsap\.timeline\s*\(/.test(html)) return 'no GSAP timeline';
  return null;
}

function stripFences(s: string): string {
  const t = s.trim();
  const m = t.match(/^```(?:html)?\s*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : t).trim();
}

function readDuration(html: string): number {
  const m = html.match(/data-duration="([\d.]+)"/);
  return m ? Number(m[1]) : 12;
}

/** Run `hyperframes lint --json` on the work dir and return its findings. */
async function lint(workDir: string): Promise<LintFinding[]> {
  const out = await runCapture('npx', ['-y', 'hyperframes', 'lint', workDir, '--json'], workDir);
  try {
    const parsed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
    return (parsed.findings ?? []) as LintFinding[];
  } catch {
    return []; // if lint output can't be parsed, don't block the render
  }
}

function runCapture(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const extra = [
      `${process.env.HOME}/.local/bin`,
      `${process.env.HOME}/.local/node/node-v24.18.0-darwin-arm64/bin`,
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ].join(':');
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${extra}:${process.env.PATH ?? ''}` };
    delete env.NODE_OPTIONS; // don't inherit the host's Node permission flags into children
    let out = '';
    const child = spawn(cmd, args, { cwd, env });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', () => resolve(out));
    child.on('exit', () => resolve(out));
  });
}
