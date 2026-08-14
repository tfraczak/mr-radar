#!/usr/bin/env node
/**
 * Org-identifier sweep: fail if any org-specific vocabulary reaches the
 * committable tree. The fixture cast is `acme`/`ENG-*`/`mira.dev` & co — real
 * org names, project prefixes, or usernames must never appear in app copy,
 * tests, or docs. (A local config or DB holding real values is user data and
 * lives outside the repo; this guards only what ships.)
 *
 * Patterns come from, in order: `SWEEP_PATTERNS` (comma-separated), a
 * gitignored `.sweep-patterns` file (one regex per line, `#` comments — the
 * ergonomic spot for real org names, since writing them into THIS file would
 * be the very leak it guards), then the empty built-in list. Exit 1 on any
 * hit, so `set -e` chains and CI actually stop — a sweep that only prints is a
 * sweep that gets scrolled past (learned the hard way).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PATTERNS = [
  // Example entries — replace with your org's real identifiers:
  // 'your-org-name',
  // 'REALPREFIX-[0-9]',
  // 'real\\.username',
];

/** Gitignored, so real org identifiers stay out of the committed tree. */
const localPatterns = () => {
  const file = join(dirname(dirname(fileURLToPath(import.meta.url))), '.sweep-patterns');
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch {
    return [];
  }
};

const fromEnv = (process.env.SWEEP_PATTERNS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const patterns = fromEnv.length ? fromEnv : localPatterns().length ? localPatterns() : PATTERNS;

if (patterns.length === 0) {
  console.log(
    'sweep: no patterns configured — add them to .sweep-patterns (gitignored, one regex per line) or set SWEEP_PATTERNS; skipped',
  );
  process.exit(0);
}

// A pattern that CANNOT match is worse than no pattern: it reports "clean"
// while the identifier sits in the tree. `git grep -E` is POSIX ERE, where
// \b, \d, \w and friends are not supported — reject them loudly instead of
// sweeping past a silent no-op. (Yes, this guard exists because it happened.)
const unsupported = patterns.filter((p) => /\\[bBdDwWsS]/.test(p));
if (unsupported.length) {
  console.error(
    'sweep: these patterns use PCRE escapes that git grep -E cannot match, so they would never fire:\n' +
      unsupported.map((p) => `  ${p}`).join('\n') +
      '\nRewrite them in POSIX ERE: `widget` or `[^a-z]abc[^a-z]`, never `\\bwidget\\b`.',
  );
  process.exit(2);
}

// `--message <file>` scans a commit message instead of the tree. Commit
// messages are part of a public repo just as much as its files, and scanning
// only the tree let an internal ticket id ship in one — the tree was clean, the
// message was not. Wired to a commit-msg hook (scripts/hooks/commit-msg), which
// is why this lives here rather than in a second script with a second copy of
// the pattern loading and the ERE guard.
const msgFlag = process.argv.indexOf('--message');
if (msgFlag !== -1) {
  const file = process.argv[msgFlag + 1];
  if (!file) {
    console.error('sweep: --message needs a file path');
    process.exit(2);
  }
  const body = readFileSync(file, 'utf8');
  // Comment lines are git's own commentary, not part of the message.
  const lines = body.split('\n').filter((l) => !l.startsWith('#'));
  const re = new RegExp(patterns.join('|'), 'i');
  const hits = lines
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => re.test(line));
  if (hits.length) {
    console.error(
      'sweep: org-specific identifiers in the commit message:\n' +
        hits.map(({ line, n }) => `  ${n}: ${line}`).join('\n') +
        '\nRewrite the message — a public commit message is as public as the code.',
    );
    process.exit(1);
  }
  console.log('sweep: commit message clean');
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
