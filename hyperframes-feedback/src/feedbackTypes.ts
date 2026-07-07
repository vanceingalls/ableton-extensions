/**
 * feedbackTypes.ts — shared shapes for the LLM feedback feature.
 * The ProjectSummary is what we send to Claude; the FeedbackReport is what
 * comes back (validated by structured output) and drives the video template.
 */

/** Compact, LLM-friendly description of the Live Set (no audio, no raw notes). */
export interface ProjectSummary {
  title: string;
  tempoBpm: number;
  timeSignature: string; // e.g. "4/4"
  durationBeats: number;
  scope: 'clip' | 'track' | 'arrangement';
  sections: { beat: number; label: string }[]; // from cue points
  tracks: TrackSummary[];
  totalNotes: number;
  pitchRange: { min: number; max: number } | null; // MIDI note numbers
}

export interface TrackSummary {
  name: string;
  kind: 'midi' | 'audio';
  color?: string; // "#rrggbb" derived from clips
  noteCount: number;
  devices: string[]; // instrument/effect names
  /** Coarse rhythmic density: notes per beat over the region. */
  density: number;
}

export type Sentiment = 'strength' | 'suggestion' | 'watch';

export interface FeedbackPoint {
  heading: string; // short, e.g. "Strong low-end foundation"
  detail: string; // 1-2 sentences of specific feedback
  sentiment: Sentiment;
  /** Optional track this point is about, for color-coding. */
  track?: string;
}

export interface FeedbackReport {
  title: string; // headline for the video, e.g. "Track Review"
  overall: string; // 1-2 sentence overall impression
  points: FeedbackPoint[]; // 3-6 points
  score: number; // 0-100 overall, used as a visual gauge
}

/** JSON Schema for Anthropic structured outputs — keep in lockstep with the
 *  FeedbackReport interface above. */
export const FEEDBACK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'overall', 'points', 'score'],
  properties: {
    title: { type: 'string' },
    overall: { type: 'string' },
    score: { type: 'integer' },
    points: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['heading', 'detail', 'sentiment'],
        properties: {
          heading: { type: 'string' },
          detail: { type: 'string' },
          sentiment: { type: 'string', enum: ['strength', 'suggestion', 'watch'] },
          track: { type: 'string' },
        },
      },
    },
  },
} as const;
