/**
 * polyfill.ts — must be imported FIRST (see main.ts line 1).
 *
 * The Extension Host omits the WHATWG fetch globals the cloud render needs.
 * Install them from bundled undici (the library Node's own fetch is built on).
 */
import './webglobals'; // installs Event/AbortController/... first
import { fetch, Headers, Request, Response, FormData } from 'undici';
import { Blob, File } from 'node:buffer';

const g = globalThis as any;
for (const [name, impl] of Object.entries({ fetch, Headers, Request, Response, FormData, Blob, File })) {
  if (!g[name] && impl) g[name] = impl;
}
