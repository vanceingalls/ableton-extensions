// esbuild's `text` loader turns `import x from './file.html'` into a string.
// This tells TypeScript that's allowed. See tools/build.mjs (loader config).
declare module '*.html' {
  const contents: string;
  export default contents;
}
