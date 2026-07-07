// esbuild's `text` loader turns these imports into strings (see tools/build.mjs).
declare module '*.html' { const s: string; export default s; }
declare module '*.txt' { const s: string; export default s; }
