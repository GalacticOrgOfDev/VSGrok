// esbuild.mjs (or esbuild.mjs if you prefer)

import * as esbuild from 'esbuild';
import { argv } from 'node:process';


const isWatch = argv.includes('--watch');
const isProduction = argv.includes('--production');


  const buildOptions = {
    entryPoints: ['src/extension.ts'],  // Your main entry file
    bundle: true,
    outfile: 'dist/extension.js',  // Output to dist/
    platform: 'node',  // For Node.js runtime (VSCode extensions)
    target: 'es2020',  // Matches your tsconfig
    format: 'cjs',  // CommonJS, as per tsconfig
    sourcemap: !isProduction,  // Generate sourcemaps in dev
    minify: isProduction,  // Minify in production
    external: ['vscode'],  // Exclude vscode module (provided by VSCode)
    logLevel: 'info',  // Show build logs
  };

  if (isWatch) {
    buildOptions.watch = {
      onRebuild(error, result) {
        if (error) console.error('Watch build failed:', error);
        else console.log('Watch build succeeded:', result);
      },
    };
  }

  try {
    await esbuild.build(buildOptions);
  } catch (error) {
  console.error(error);
  process.exit(1);
}