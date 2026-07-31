#!/usr/bin/env node
/**
 * Copy non-TypeScript renderer files into dist/, since `tsc` only emits .js.
 * Keeps the build a plain `tsc` with no bundler.
 */
import { copyFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'renderer');
const out = join(root, 'dist', 'renderer');

mkdirSync(out, { recursive: true });

if (!existsSync(src)) {
  console.error('  no src/renderer to copy');
  process.exit(1);
}

let copied = 0;
for (const file of readdirSync(src)) {
  // tsc owns .ts (source) and emits the .js; don't copy either or the
  // tsconfig.json, or we'd clobber the compiled renderer.
  if (/\.(ts|js|map)$/.test(file) || file === 'tsconfig.json') continue;
  copyFileSync(join(src, file), join(out, file));
  copied += 1;
}
console.log(`  copied ${copied} renderer asset(s) to dist/renderer`);
