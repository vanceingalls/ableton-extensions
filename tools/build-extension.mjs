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
const banner = `(() => {
  const g = globalThis;
  const util = require('node:util');
  if (!g.TextEncoder) g.TextEncoder = util.TextEncoder;
  if (!g.TextDecoder) g.TextDecoder = util.TextDecoder;
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
