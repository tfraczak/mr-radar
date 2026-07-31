#!/usr/bin/env node
/**
 * Kill any already-running MR Radar instance before launching a new one.
 *
 * Without this, a prior instance holds the single-instance lock, the new launch
 * exits immediately, and you keep interacting with the OLD (pre-rebuild) code.
 * Covers both the dev run (`electron dist/main/index.js`) and the packaged app
 * (`MR Radar.app/.../MR Radar`). The patterns can't match this script's own args
 * (`node scripts/kill-stale.mjs`) or the launcher shell, so there's no self-kill.
 */
import { execFileSync } from 'node:child_process';

const patterns = [
  ['Electron.app', 'Contents', 'MacOS', 'Electron dist/main/index.js'].join('/'),
  ['MR Radar.app', 'Contents', 'MacOS', 'MR Radar'].join('/'),
];

let killed = false;
for (const pattern of patterns) {
  try {
    execFileSync('pkill', ['-f', pattern]);
    killed = true;
  } catch {
    // pkill exits non-zero when nothing matched — the common, fine case.
  }
}
console.log(killed ? '  killed a running MR Radar instance' : '  no running instance to replace');
