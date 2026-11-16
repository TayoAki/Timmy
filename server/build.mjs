// Bundles the API into dist/index.js. The server's own dependencies stay as
// imports; the frontend code it shares (the reducer and its helpers, and React
// which they import) is bundled in, so the image doesn't need the frontend's node_modules.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  jsx: 'automatic',
  sourcemap: true,
  external: Object.keys(pkg.dependencies),
  // The shared reducer imports a stylesheet-free slice of the frontend; anything else is a mistake worth failing on.
  loader: { '.css': 'empty' },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});
