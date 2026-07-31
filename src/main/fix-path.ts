import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * Make `glab` and `rwx` resolvable when launched from Finder.
 *
 * A GUI app started by Finder/launchd inherits a bare PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) — not the shell PATH — so Homebrew binaries
 * like `glab` (/opt/homebrew/bin) are invisible. Run from a terminal via
 * `yarn dev`/`yarn start` the shell PATH is inherited and this is a no-op, but
 * the packaged .app needs it or every source call fails with ENOENT.
 *
 * Two-pronged: ask the login shell for its real PATH (covers wherever the user
 * actually installed things), and prepend the usual bin dirs as a fallback.
 */
export const fixPath = (): void => {
  const fromShell = loginShellPath();
  const known = [
    '/opt/homebrew/bin', // Apple Silicon Homebrew
    '/usr/local/bin', // Intel Homebrew
    `${homedir()}/.local/bin`,
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];

  const current = process.env.PATH ? process.env.PATH.split(':') : [];
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const dir of [...fromShell, ...current, ...known]) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      merged.push(dir);
    }
  }
  process.env.PATH = merged.join(':');
}

/** The login shell's PATH, or [] if it can't be read. */
const loginShellPath = (): string[] => {
  const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
  try {
    // -i -l -c so login/rc files that set PATH (Homebrew shellenv, etc.) run.
    const out = execFileSync(shell, ['-ilc', 'command -p printf "%s" "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return out.trim().split(':').filter(Boolean);
  } catch {
    return [];
  }
}
