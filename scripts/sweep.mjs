#!/usr/bin/env node
/**
 * Org-identifier sweep: fail if any org-specific vocabulary reaches the
 * committable tree. The fixture cast is `acme`/`ENG-*`/`mira.dev` & co — real
 * org names, project prefixes, or usernames must never appear in app copy,
 * tests, or docs. (A local config or DB holding real values is user data and
 * lives outside the repo; this guards only what ships.)
 *
 * Extend PATTERNS for your org before publishing a fork. Exit 1 on any hit,
 * so `set -e` chains and CI actually stop — a sweep that only prints is a
 * sweep that gets scrolled past (learned the hard way).
 */
import { execFileSync } from 'node:child_process';

const PATTERNS = [
  // Example entries — replace with your org's real identifiers:
  // 'your-org-name',
  // 'REALPREFIX-[0-9]',
  // 'real\\.username',
];

const patterns = process.env.SWEEP_PATTERNS
  ? process.env.SWEEP_PATTERNS.split(',').map((s) => s.trim()).filter(Boolean)
  : PATTERNS;

if (patterns.length === 0) {
  console.log('sweep: no patterns configured (set SWEEP_PATTERNS or edit scripts/sweep.mjs) — skipped');
  process.exit(0);
}

try {
  const out = execFileSync(
    'git',
    ['grep', '-n', '-i', '-E', patterns.join('|'), '--', 'src/', 'tests/', 'scripts/', 'README.md', 'package.json'],
    { encoding: 'utf8' },
  );
  console.error('sweep: org-specific identifiers found in the committable tree:\n' + out);
  process.exit(1);
} catch (err) {
  if (err.status === 1) {
    console.log('sweep: clean');
    process.exit(0);
  }
  throw err; // a real git failure, not "no matches"
}
