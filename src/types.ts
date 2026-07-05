/**
 * Clip2Video — shared types for the timeline contract.
 * These mirror schema/timeline.schema.json exactly. If you change one, change both
 * (or generate these from the schema with json-schema-to-typescript).
 */

export interface Timeline {
  formatVersion: string;
  meta: Meta;
  timing: Timing;
  audio: AudioRef;
  notes: Note[];
  automation: Record<string, AutomationLane>;
  markers: Marker[];
  tracks?: TrackInfo[];
  video: VideoSpec;
}

export interface Meta {
  title: string;
  artist?: string;
  clipColor?: string; // "#rrggbb"
  liveVersion?: string;
  extensionVersion?: string;
  exportedAt?: string; // ISO 8601
  sourceScope?: 'clip' | 'track' | 'arrangement';
}

export interface Timing {
  durationBeats: number;
  tempoMap: TempoPoint[];
  timeSignatures: TimeSignature[];
}

export interface TempoPoint {
  beat: number;
  bpm: number;
  /** If true, tempo ramps linearly to the next point; otherwise holds. */
  ramp?: boolean;
}

export interface TimeSignature {
  beat: number;
  numerator: number;
  denominator: 1 | 2 | 4 | 8 | 16 | 32;
}

export interface AudioRef {
  file: string; // relative to timeline.json
  sampleRate?: number;
  channels?: number;
  durationSeconds: number;
  offsetBeats?: number;
}

export interface Note {
  pitch: number; // 0–127
  startBeat: number;
  lengthBeats: number;
  velocity: number; // 1–127
  muted?: boolean;
  probability?: number; // 0–1
  trackId?: string;
}

export interface AutomationLane {
  name: string;
  unit?: string;
  min: number;
  max: number;
  points: AutomationPoint[];
}

export interface AutomationPoint {
  beat: number;
  value: number;
  curve?: 'linear' | 'hold' | 'sCurve';
}

export interface Marker {
  beat: number;
  label: string;
  kind?: 'section' | 'cue';
}

export interface TrackInfo {
  id: string;
  name: string;
  color?: string;
  kind?: 'midi' | 'audio' | 'return' | 'master' | 'group';
}

export interface VideoSpec {
  width: number;
  height: number;
  fps: 24 | 25 | 30 | 50 | 60;
  style: string; // template folder name
  mappings?: AutomationMapping[];
}

export interface AutomationMapping {
  lane: string; // key into Timeline.automation
  target: string; // template-defined visual param, e.g. "glow"
  invert?: boolean;
  range?: [number, number];
}

/** Options the panel UI sends to the render pipeline. */
export interface RenderRequest {
  aspect: '9:16' | '1:1' | '16:9';
  fps: VideoSpec['fps'];
  style: string;
  mappings: AutomationMapping[];
  outputDir?: string;
  useCloud?: boolean;
}
