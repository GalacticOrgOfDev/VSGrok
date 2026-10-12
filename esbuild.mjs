import * as esbuild from 'esbuild';
import { argv } from 'node:process';

const watch = argv.includes('--watch');
const production = argv.includes('--production');

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  external: ['vscode'],
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('esbuild watching…');
} else {
  try { await esbuild.build(options); } catch { process.exit(1); }
}
