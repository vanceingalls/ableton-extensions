/**
 * feedback.ts — asks Claude for production feedback on the Live Set, returned
 * as a validated FeedbackReport that drives the feedback video template.
 *
 * The extension runs on Node with outbound network, so it calls the Anthropic
 * API directly via the official SDK. The key is read from (in order): the
 * ANTHROPIC_API_KEY env var (dev), or a `key` file in the extension's
 * storageDirectory (the shipped path — written by a one-time settings dialog).
 */

import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ProjectSummary, FeedbackReport } from './feedbackTypes';
import { FEEDBACK_SCHEMA } from './feedbackTypes';

const MODEL = 'claude-opus-4-8';

const SYSTEM = `You are a seasoned music producer and mixing engineer giving a
short, candid review of a work-in-progress Ableton Live arrangement. You are
given a structured summary of a SELECTION from the Set — the selected tracks
over a chosen time range (which may be the whole song or a single section),
NOT the audio. Base your feedback only on what the structure tells you:
arrangement, instrumentation balance, rhythmic density, register spread,
section structure, and track roles across what was selected. Be specific and
constructive, name tracks where relevant, and avoid generic platitudes. Mix
strengths with actionable suggestions. Keep each point to one or two sentences.
Return 3 to 6 points. The score is your honest overall rating out of 100 for
the selected material's current state as a composition-in-progress.`;

export interface KeySource {
  /** Explicit key (e.g. from a dialog). */
  key?: string;
  /** Directory to look for a `key` file in (storageDirectory). */
  storageDir?: string;
}

export async function resolveApiKey(src: KeySource): Promise<string | null> {
  if (src.key) return src.key.trim();
  const env = process.env.ANTHROPIC_API_KEY;
  if (env) return env.trim();
  if (src.storageDir) {
    try {
      const k = await fs.readFile(path.join(src.storageDir, 'anthropic-key'), 'utf8');
      if (k.trim()) return k.trim();
    } catch {
      /* no stored key */
    }
  }
  return null;
}

export async function persistApiKey(storageDir: string, key: string): Promise<void> {
  await fs.mkdir(storageDir, { recursive: true });
  await fs.writeFile(path.join(storageDir, 'anthropic-key'), key.trim(), { mode: 0o600 });
}

/** HyperFrames Cloud (HeyGen) key — the render path that works under Live's
 *  sandbox (local render can't: Node children inherit the fs permission model). */
export async function resolveHeyGenKey(storageDir?: string): Promise<string | null> {
  const env = process.env.HEYGEN_API_KEY ?? process.env.HYPERFRAMES_API_KEY;
  if (env) return env.trim();
  if (storageDir) {
    try {
      const k = await fs.readFile(path.join(storageDir, 'heygen-key'), 'utf8');
      if (k.trim()) return k.trim();
    } catch {
      /* none stored */
    }
  }
  return null;
}

export async function persistHeyGenKey(storageDir: string, key: string): Promise<void> {
  await fs.mkdir(storageDir, { recursive: true });
  await fs.writeFile(path.join(storageDir, 'heygen-key'), key.trim(), { mode: 0o600 });
}

/** Remove a stored key file (used by the key-management dialog). */
export async function clearStoredKey(storageDir: string, which: 'anthropic' | 'heygen'): Promise<void> {
  const file = which === 'anthropic' ? 'anthropic-key' : 'heygen-key';
  await fs.rm(path.join(storageDir, file), { force: true });
}

/** Whether a key is currently available (env or stored) — for the settings UI. */
export async function keyStatus(storageDir?: string): Promise<{ anthropic: boolean; heygen: boolean }> {
  return {
    anthropic: !!(await resolveApiKey({ storageDir })),
    heygen: !!(await resolveHeyGenKey(storageDir)),
  };
}

/** Call Claude for feedback. Throws with a readable message on failure. */
export async function generateFeedback(
  summary: ProjectSummary,
  apiKey: string,
): Promise<FeedbackReport> {
  const client = new Anthropic({ apiKey });
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: FEEDBACK_SCHEMA as any } },
    messages: [
      {
        role: 'user',
        content:
          'Review this Ableton Live project and return your feedback as JSON.\n\n' +
          JSON.stringify(summary, null, 2),
      },
    ],
  });

  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') {
    throw new Error('The model declined to review this project.');
  }
  const text = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
  if (!text) throw new Error('No feedback returned.');

  let report: FeedbackReport;
  try {
    report = JSON.parse(text) as FeedbackReport;
  } catch {
    throw new Error('Feedback was not valid JSON.');
  }
  // Defensive clamp/trim — the video template assumes these bounds.
  report.score = Math.max(0, Math.min(100, Math.round(report.score)));
  report.points = (report.points ?? []).slice(0, 6);
  return report;
}
