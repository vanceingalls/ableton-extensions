// Simulate Live's ExtensionHost eval context: strip the web globals it omits,
// then require the built bundle and confirm it loads (banner + undici polyfill
// must restore everything the SDK touches at module-load time).
// Only the load-time globals the host is confirmed/likely to omit. Deleting
// the fetch family triggers Node's own internal-undici reinit (harness noise),
// so leave those — polyfill.ts installs them from bundled undici after load.
const strip = [
  'TextEncoder', 'TextDecoder', 'Blob', 'File', 'ReadableStream', 'WritableStream',
  'TransformStream', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy',
];
const saved = {};
for (const k of strip) { saved[k] = globalThis[k]; delete globalThis[k]; }

try {
  const mod = require('../dist/extension.js');
  console.log('LOADED OK; exports:', Object.keys(mod).join(',') || '(none)');
} catch (e) {
  console.log('LOAD FAILED:', e.message);
}
