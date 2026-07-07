/**
 * webglobals.ts — imported before undici. Live's Extension Host strips some
 * "global only" web globals (no requireable Node source), which undici touches
 * at load. Install pure-JS shims. The esbuild banner (tools/build.mjs) covers
 * the globals that ARE restorable from Node built-ins.
 */
import { EventTarget, Event } from 'event-target-shim';
import { AbortController, AbortSignal } from 'abort-controller';

const g = globalThis as any;

if (!g.EventTarget) g.EventTarget = EventTarget;
if (!g.Event) g.Event = Event;
if (!g.AbortController) g.AbortController = AbortController;
if (!g.AbortSignal) g.AbortSignal = AbortSignal;

if (!g.DOMException) {
  g.DOMException = class DOMException extends Error {
    constructor(message?: string, name = 'Error') {
      super(message);
      this.name = name;
    }
  };
}
if (!g.structuredClone) {
  g.structuredClone = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
}
