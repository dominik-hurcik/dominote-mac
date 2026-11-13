// Bundles main.jsx and Excalidraw's fonts into ../ui/sketch. The CJK font (Xiaolai, 12 MB) is left out.
import { build } from 'esbuild';
import { cpSync, rmSync } from 'node:fs';

const out = '../ui/sketch';
rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: ['main.jsx'],
  outdir: out,
  bundle: true,
  format: 'esm',
  splitting: true,
  minify: true,
  target: 'safari15',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.IS_PREACT': '"false"' },
  loader: { '.woff2': 'file', '.ttf': 'file', '.png': 'file', '.svg': 'file' },
  conditions: ['production'],
  logLevel: 'warning',
});
const fonts = 'node_modules/@excalidraw/excalidraw/dist/prod/fonts';
cpSync(fonts, out + '/fonts', { recursive: true, filter: src => !src.includes('Xiaolai') });
