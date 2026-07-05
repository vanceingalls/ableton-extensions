/**
 * studioProtocol.ts — the Node ↔ WebView message contract for the studio
 * dialog (AGENT_INSTRUCTIONS §7). Both sides import these types; the wire
 * format is the discriminated union on `type`.
 *
 * Versioning: bump PATCH for additive optional fields, MINOR for new message
 * types, MAJOR for anything that changes an existing message's shape. The
 * WebView receives the version in `init` and must refuse a MAJOR mismatch.
 */

import type { Timeline, AutomationMapping, VideoSpec } from './types';

export const STUDIO_PROTOCOL_VERSION = '1.0.0';

/** A renderable style: template folder name + its declared manifest. */
export interface StyleInfo {
  /** Template folder name under templates/ (== VideoSpec.style). */
  id: string;
  manifest: TemplateManifest;
}

/** Mirror of templates/<name>/template.json (§8). */
export interface TemplateManifest {
  formatVersion: string;
  name: string;
  displayName?: string;
  params: TemplateParam[];
}

/** A visual parameter the template exposes as an automation-mapping target. */
export interface TemplateParam {
  id: string;
  label: string;
  description?: string;
}

// ---------- Node → WebView ----------

export type NodeToWebView =
  | InitMsg
  | TimelineUpdatedMsg
  | RenderProgressMsg
  | RenderDoneMsg
  | RenderErrorMsg;

export interface InitMsg {
  type: 'init';
  protocolVersion: string; // STUDIO_PROTOCOL_VERSION of the Node side
  timeline: Timeline;
  /** Whatever the WebView can load from the sandbox: file/data/blob URL (VERIFY item 7). */
  audioUrl: string;
  availableStyles: StyleInfo[];
}

/** Pushed after a refreshFromSet re-read of notes/tempo/markers/automation. */
export interface TimelineUpdatedMsg {
  type: 'timelineUpdated';
  timeline: Timeline;
}

export interface RenderProgressMsg {
  type: 'renderProgress';
  phase: 'uploading' | 'rendering' | 'downloading';
  /** 0–100 within the current phase. */
  pct: number;
}

export interface RenderDoneMsg {
  type: 'renderDone';
  /** How the MP4 was delivered — resolved by VERIFY item 7 (sandbox escape hatch). */
  deliveredAs: 'path' | 'imported' | 'url';
  ref: string;
}

export interface RenderErrorMsg {
  type: 'renderError';
  message: string;
}

// ---------- WebView → Node ----------

export type WebViewToNode =
  | ReadyMsg
  | RefreshFromSetMsg
  | RequestRenderMsg
  | CancelRenderMsg
  | CloseStudioMsg;

/** First message; Node must not send `init` until it arrives. */
export interface ReadyMsg {
  type: 'ready';
}

export interface RefreshFromSetMsg {
  type: 'refreshFromSet';
}

export interface RequestRenderMsg {
  type: 'requestRender';
  style: string;
  aspect: '9:16' | '1:1' | '16:9';
  fps: VideoSpec['fps'];
  mappings: AutomationMapping[];
}

export interface CancelRenderMsg {
  type: 'cancelRender';
}

export interface CloseStudioMsg {
  type: 'closeStudio';
}
