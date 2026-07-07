// Offline check: simulate the Extension Host by stripping the web globals it
// omits, then require the built bundle. Green = your polyfills are complete,
// no Ableton restart needed to catch a missing shim. Run: node tools/load-check.cjs
const BUNDLE = require('node:path').join(__dirname, '..', 'dist', 'extension.js');
for (const k of [
  'TextEncoder', 'TextDecoder', 'Blob', 'File', 'ReadableStream', 'WritableStream',
  'TransformStream', 'URL', 'URLSearchParams', 'atob', 'btoa', 'performance',
  'MessageChannel', 'MessagePort', 'AbortController', 'AbortSignal', 'Event',
  'EventTarget', 'DOMException', 'structuredClone',
]) delete globalThis[k];

try {
  const mod = require(BUNDLE);
  console.log('LOADED OK; exports:', Object.keys(mod).join(',') || '(none)');
} catch (e) {
  console.log('LOAD FAILED:', e.message);
  process.exit(1);
}
