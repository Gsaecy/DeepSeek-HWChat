import * as esbuild from 'esbuild';
import { readdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const testEntries = (await readdir('src/test', { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
  .map((entry) => `src/test/${entry.name}`);

const shared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const builds = [
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'out/extension.js',
    external: ['vscode'],
  },
  ...(testEntries.length > 0
    ? [{ ...shared, entryPoints: testEntries, outdir: 'out/test' }]
    : []),
];

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('HWChat build watcher is running.');
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
