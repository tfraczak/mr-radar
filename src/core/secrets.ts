import { run } from './exec';

/**
 * The Jira API token — the only credential this app handles at all.
 *
 * GitLab and RWX are reached through their own CLIs, which manage their own
 * auth, so there is deliberately nothing to store for them.
 *
 * Stored in the macOS login Keychain via the `security` CLI rather than
 * Electron's `safeStorage`. `safeStorage` would be the obvious choice for an
 * Electron app, but the headless `yarn cli` path has no Electron runtime and
 * still needs to read the token — `security` works from both.
 */

const SERVICE = 'mr-radar';
const ACCOUNT = 'jira';

/** Reading uses `-w`, which writes only to stdout — the token never hits argv. */
export const readJiraToken = async (): Promise<string | undefined> => {
  const fromEnv = process.env.MR_RADAR_JIRA_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const out = await run(
      'security',
      ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'],
      { timeoutMs: 10_000 },
    );
    const token = out.trim();
    return token.length > 0 ? token : undefined;
  } catch {
    // Not found in the Keychain — an expected state before first-time setup.
    return undefined;
  }
}

/**
 * Store the token.
 *
 * Caveat worth knowing: `security` takes the password as an argument, so it is
 * briefly visible to `ps` on this machine during this one call. Reads are not
 * affected. Set the token once at setup and it stays in the Keychain.
 */
export const writeJiraToken = async (token: string): Promise<void> => {
  if (!token.trim()) throw new Error('refusing to store an empty token');
  await run(
    'security',
    ['add-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w', token, '-U'],
    { timeoutMs: 10_000 },
  );
}

export const deleteJiraToken = async (): Promise<void> => {
  try {
    await run('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT], {
      timeoutMs: 10_000,
    });
  } catch {
    /* already absent */
  }
}

export const hasJiraToken = async (): Promise<boolean> => {
  return (await readJiraToken()) !== undefined;
}
