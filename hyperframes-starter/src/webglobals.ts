/**
 * webglobals.ts — MUST be imported before undici / the Anthropic SDK.
 *
 * Live's Extension Host strips even the older web-platform globals that Node
 * normally provides but exposes through no requireable module (probed: Event,
 * EventTarget, AbortController, AbortSignal, DOMException, structuredClone are
 * all "global only"). undici references them at module-load, so we install
 * pure-JS shims here. The banner (build-extension.mjs) covers the globals that
 * ARE restorable from Node built-ins; this covers the rest.
 */
import { EventTarget, Event } from 'event-target-shim';
import { AbortController, AbortSignal } from 'abort-controller';

const g = globalThis as any;

if (!g.EventTarget) g.EventTarget = EventTarget;
if (!g.Event) g.Event = Event;
if (!g.AbortController) g.AbortController = AbortController;
if (!g.AbortSignal) g.AbortSignal = AbortSignal;

// DOMException: a minimal Error subclass is enough for undici's use.
if (!g.DOMException) {
  g.DOMException = class DOMException extends Error {
    constructor(message?: string, name = 'Error') {
      super(message);
      this.name = name;
    }
  };
}

// structuredClone: undici uses it for a few request/response paths; a JSON-based
// deep clone covers the plain-data cases we hit (JSON request bodies).
if (!g.structuredClone) {
  g.structuredClone = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
}
