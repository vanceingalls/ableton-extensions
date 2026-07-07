/**
 * polyfill.ts — must be imported FIRST, before the Anthropic SDK.
 *
 * Live's Extension Host evaluates the bundle in a Node context that omits the
 * WHATWG fetch globals (fetch/Headers/Request/Response/FormData) the SDK needs.
 * Unlike TextEncoder (available via node:util and polyfilled in the esbuild
 * banner), there's no built-in require for fetch — so we bundle undici (the
 * library Node's own fetch is built on) and install the globals here.
 */
import './webglobals'; // installs Event/EventTarget/AbortController/AbortSignal/... first
import { fetch, Headers, Request, Response, FormData } from 'undici';
import { Blob, File } from 'node:buffer';

const g = globalThis as any;
for (const [name, impl] of Object.entries({ fetch, Headers, Request, Response, FormData, Blob, File })) {
  if (!g[name] && impl) g[name] = impl;
}
