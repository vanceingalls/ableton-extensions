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
short, candid review of a work-in-progress Ableton Live project. You are given
a structured summary of the Set (tracks, instruments, note densities, tempo,
sections) — NOT the audio. Base your feedback only on what the structure tells
you: arrangement, instrumentation balance, rhythmic density, register spread,
section structure, and track roles. Be specific and constructive, name tracks
where relevant, and avoid generic platitudes. Mix strengths with actionable
suggestions. Keep each point to one or two sentences. Return 3 to 6 points.
The score is your honest overall rating out of 100 for the project's current
state as a composition-in-progress.`;

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
