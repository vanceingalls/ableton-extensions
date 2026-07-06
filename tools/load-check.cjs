// Offline check: simulate Live's ExtensionHost eval context by stripping the
// web-platform globals it omits, then require the built bundle. If it loads,
// the esbuild banner + bundled undici polyfill cover every load-time global —
// no Ableton / dev-mode reset needed to catch a missing polyfill.
const path = require('node:path');
const BUNDLE = path.join(__dirname, '..', 'dist', 'extension.js');

// The newer web globals Live's host omits (all cleanly restorable from Node
// built-ins, all covered by the esbuild banner). Longer-standing globals like
// AbortController/Event/crypto are treated as core and left in place.
const strip = [
  'TextEncoder', 'TextDecoder', 'Blob', 'File', 'ReadableStream', 'WritableStream',
  'TransformStream', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy',
  'URL', 'URLSearchParams', 'atob', 'btoa', 'performance', 'PerformanceObserver',
  'MessageChannel', 'MessagePort', 'BroadcastChannel',
];
for (const k of strip) delete globalThis[k];

try {
  const mod = require(BUNDLE);
  console.log('LOADED OK; exports:', Object.keys(mod).join(',') || '(none)');
} catch (e) {
  console.log('LOAD FAILED:', e.message);
  process.exit(1);
}
