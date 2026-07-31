#!/usr/bin/env node
/**
 * Install MR Radar as a single, clean copy in ~/Applications.
 *
 * The "2 apps in Spotlight" problem comes from having two .app bundles on disk
 * that share one bundle id (`com.mr-radar.app`): the installed copy AND the
 * electron-builder output under release/. LaunchServices indexes both. This
 * script guarantees exactly one copy survives:
 *
 *   1. kill any running instance (it holds the single-instance lock)
 *   2. copy the freshly packaged bundle to ~/Applications, replacing the old one
 *   3. delete the release/ build copy so only the installed one remains
 *   4. re-register with LaunchServices so the stale duplicate drops from the index
 *   5. launch it
 *
 * Run `yarn package` first (or use `yarn install:app`, which chains them).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_NAME = 'MR Radar.app';
const built = join('release', 'mac-arm64', APP_NAME);
const destDir = join(homedir(), 'Applications');
const dest = join(destDir, APP_NAME);

if (!existsSync(built)) {
  console.error(`  ✗ ${built} not found — run \`yarn package\` first.`);
  process.exit(1);
}

const run = (cmd, args) => {
  try {
    execFileSync(cmd, args, { stdio: 'inherit' });
  } catch {
    // Non-fatal for the kill/register steps; each logs its own context below.
  }
};

console.log('  • stopping any running instance…');
run('node', ['scripts/kill-stale.mjs']);

console.log(`  • installing to ${dest}…`);
mkdirSync(destDir, { recursive: true });
rmSync(dest, { recursive: true, force: true });
// ditto preserves bundle metadata/signatures better than cp -R for .app bundles.
execFileSync('ditto', [built, dest], { stdio: 'inherit' });

console.log('  • removing the release/ build copy (leaves one copy on disk)…');
rmSync('release', { recursive: true, force: true });

console.log('  • refreshing LaunchServices…');
const lsregister =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
run(lsregister, ['-f', dest]);

console.log('  • launching…');
execFileSync('open', [dest], { stdio: 'inherit' });
console.log('  ✓ installed one copy at ~/Applications/MR Radar.app and launched it.');
