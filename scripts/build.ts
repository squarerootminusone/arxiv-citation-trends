// Bundles src/*.ts into dist/ and copies static files. `--watch` rebuilds on change.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync('static', outdir, { recursive: true });

const options: esbuild.BuildOptions = {
  entryPoints: ['src/background.ts', 'src/content.ts', 'src/options.ts'],
  outdir,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
