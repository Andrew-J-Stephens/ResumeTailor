import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');

mkdirSync(dist, { recursive: true });

function copyStatic() {
  for (const f of ['manifest.json', 'popup.html', 'options.html', 'print.html', 'popup.css', 'options.css']) {
    const src = join(root, f);
    if (existsSync(src)) {
      copyFileSync(src, join(dist, f));
    }
  }
}

const base = {
  bundle: true,
  platform: 'browser',
  target: 'chrome114',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  loader: {
    '.html': 'text',
  },
};

async function run() {
  copyStatic();
  const ctx = await esbuild.context({
    ...base,
    entryPoints: {
      background: join(root, 'src/background.ts'),
      popup: join(root, 'src/popup.ts'),
      options: join(root, 'src/options.ts'),
      print: join(root, 'src/print.ts'),
    },
    outdir: dist,
    format: 'iife',
  });
  if (watch) {
    await ctx.watch();
    console.log('Watching…');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
