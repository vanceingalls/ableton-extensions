// Bundle the extension entry for Live's Extension Host (Node, CJS) — same
// shape as the SDK examples' build.ts. The SDK is bundled in.
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const production = process.argv.includes('--production');

// Live's Extension Host evaluates the bundle in a context that omits some Web
// globals the Node runtime normally provides (TextEncoder/TextDecoder, and the
// fetch family the Anthropic SDK needs). Polyfill them from Node's built-ins at
// the top of the bundle so the SDK loads and can make requests.
// Live's Extension Host evaluates the bundle in a Node context that omits a
// number of Web globals the Anthropic SDK + undici need. These all exist in
// Node built-ins, so we install them from there before any bundled module runs.
const banner = `(() => {
  const g = globalThis;
  const pick = (mod, names) => {
    try {
      const m = require(mod);
      for (const n of names) if (!g[n] && m[n]) g[n] = m[n];
    } catch {}
  };
  pick('node:util', ['TextEncoder', 'TextDecoder']);
  pick('node:buffer', ['Blob', 'File']);
  pick('node:stream/web', ['ReadableStream', 'WritableStream', 'TransformStream',
    'ByteLengthQueuingStrategy', 'CountQueuingStrategy']);
  pick('node:perf_hooks', ['performance']);
  pick('node:worker_threads', ['MessageChannel', 'MessagePort']);
})();`;

await esbuild.build({
  entryPoints: ['src/main.ts'],
  outfile: manifest.entry,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  sourcesContent: false,
  logLevel: 'info',
  minify: production,
  sourcemap: !production,
  banner: { js: banner },
});
