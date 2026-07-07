/**
 * feedback.ts — API #1: Anthropic.
 *
 * Sends the compact project summary to Claude and gets a structured review back.
 * The two things worth copying:
 *   1. `output_config.format` with a JSON Schema forces the model to return JSON
 *      that matches `FeedbackReport` — no parsing/repair guesswork.
 *   2. streaming (`.stream().finalMessage()`) avoids request timeouts on longer
 *      generations, and `stop_reason === 'refusal'` must be checked before reading
 *      content (a safety decline is a 200 with empty content, not an exception).
 */

import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ProjectSummary, FeedbackReport } from './feedbackTypes';
import { FEEDBACK_SCHEMA } from './feedbackTypes';

const MODEL = 'claude-opus-4-8';

const SYSTEM = `You are a seasoned music producer and mixing engineer giving a
short, candid review of a work-in-progress Ableton Live selection. You get a
structured summary of the selected tracks over a time range — track roles,
instrumentation, rhythmic density, register spread, sections — NOT the audio.
Base your feedback only on what the structure tells you. Be specific and
constructive, name tracks where relevant, mix strengths with actionable
suggestions, and keep each point to one or two sentences. Return 3 to 6 points.
The score is your honest overall rating out of 100.`;

/** Call Claude and return a validated FeedbackReport. */
export async function generateReview(summary: ProjectSummary, apiKey: string): Promise<FeedbackReport> {
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
        content: 'Review this Ableton Live project and return your feedback as JSON.\n\n' +
          JSON.stringify(summary, null, 2),
      },
    ],
  });

  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') throw new Error('The model declined to review this project.');
  const block = message.content.find((b: Anthropic.ContentBlock) => b.type === 'text');
  const text = block && block.type === 'text' ? block.text : undefined;
  if (!text) throw new Error('No feedback returned.');

  const report = JSON.parse(text) as FeedbackReport;
  // Defensive clamp/trim — the composition assumes these bounds.
  report.score = Math.max(0, Math.min(100, Math.round(report.score)));
  report.points = (report.points ?? []).slice(0, 6);
  return report;
}

// --------------------------------------------------------------- key storage

/** Resolve an API key from an env var, then a file in the extension's storage dir. */
export async function resolveKey(
  which: 'anthropic' | 'heygen',
  storageDir?: string,
): Promise<string | null> {
  const env =
    which === 'anthropic'
      ? process.env.ANTHROPIC_API_KEY
      : process.env.HEYGEN_API_KEY ?? process.env.HYPERFRAMES_API_KEY;
  if (env) return env.trim();
  if (storageDir) {
    try {
      const k = await fs.readFile(path.join(storageDir, `${which}-key`), 'utf8');
      if (k.trim()) return k.trim();
    } catch {
      /* none stored */
    }
  }
  return null;
}

/** Persist a key to the extension's storage dir (the only writable place). */
export async function persistKey(which: 'anthropic' | 'heygen', storageDir: string, key: string): Promise<void> {
  await fs.mkdir(storageDir, { recursive: true });
  await fs.writeFile(path.join(storageDir, `${which}-key`), key.trim(), { mode: 0o600 });
}
