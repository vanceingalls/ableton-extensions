// Bundle src/main.ts → dist/extension.js for Live's Extension Host (Node, CJS).
// The banner restores web globals the host omits; the `.html` text loader
// inlines the composition so we never read our own install dir at runtime.
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const production = process.argv.includes('--production');

const banner = `(() => {
  const g = globalThis;
  const pick = (mod, names) => { try { const m = require(mod);
    for (const n of names) if (!g[n] && m[n]) g[n] = m[n]; } catch {} };
  pick('node:util', ['TextEncoder','TextDecoder']);
  pick('node:url', ['URL','URLSearchParams']);
  pick('node:buffer', ['Blob','File','atob','btoa']);
  pick('node:stream/web', ['ReadableStream','WritableStream','TransformStream',
    'ByteLengthQueuingStrategy','CountQueuingStrategy']);
  pick('node:perf_hooks', ['performance','PerformanceObserver']);
  pick('node:worker_threads', ['MessageChannel','MessagePort','BroadcastChannel']);
})();`;

await esbuild.build({
  entryPoints: ['src/main.ts'],
  outfile: manifest.entry,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  minify: production,
  sourcemap: !production,
  loader: { '.html': 'text' }, // import composition.html as a string
  banner: { js: banner },
  logLevel: 'info',
});
