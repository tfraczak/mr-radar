#!/usr/bin/env node
/**
 * One-time Jira token setup.
 *
 * Accepts the token three ways, none of which put it in your shell history or
 * in `ps` output — deliberately NOT as a command-line argument, which would:
 *
 *   yarn jira:token                      # interactive prompt (paste, Enter)
 *   echo "$TOKEN" | yarn jira:token       # piped from stdin
 *   MR_RADAR_JIRA_TOKEN=… yarn jira:token # from the environment
 *
 * Create a token at https://id.atlassian.com/manage-profile/security/api-tokens
 */
import { createInterface } from 'node:readline';
import { ensureConfig, CONFIG_PATH } from './core/config';
import { JiraSource } from './core/sources/jira';
import { writeJiraToken } from './core/secrets';

const prompt = async (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

const readStdin = (): Promise<string> => {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

const main = async (): Promise<void> => {
  const config = ensureConfig();

  if (!config.jira.email) {
    console.error(
      `Set "jira.email" in ${CONFIG_PATH} to your Atlassian account email first, then rerun.`,
    );
    process.exit(1);
  }

  // A positional argument is intentionally rejected — it would leak the token
  // to `ps` and shell history.
  if (process.argv.slice(2).some((a) => !a.startsWith('-'))) {
    console.error(
      'Do not pass the token as an argument (it would be visible in `ps` and your\n' +
        'shell history). Pipe it, set MR_RADAR_JIRA_TOKEN, or run with no args to be prompted.',
    );
    process.exit(1);
  }

  let token = (process.env.MR_RADAR_JIRA_TOKEN ?? '').trim();
  let source = 'MR_RADAR_JIRA_TOKEN';
  if (!token && !process.stdin.isTTY) {
    token = (await readStdin()).trim();
    source = 'stdin';
  }
  if (!token) {
    console.log(`Site:  ${config.jira.baseUrl}`);
    console.log(`Email: ${config.jira.email}`);
    console.log('Create a token at https://id.atlassian.com/manage-profile/security/api-tokens\n');
    token = (await prompt('Paste Jira API token: ')).trim();
    source = 'prompt';
  }
  if (!token) {
    console.error('No token provided; nothing stored.');
    process.exit(1);
  }
  console.log(`Verifying token from ${source}…`);

  // Verify before storing, so a typo fails loudly here rather than silently
  // degrading every poll cycle.
  const jira = new JiraSource(config.jira.baseUrl, config.jira.email, token);
  const check = await jira.verify();
  if (!check.ok) {
    console.error(`\nToken rejected by ${config.jira.baseUrl}: ${check.error}`);
    console.error('Nothing stored.');
    process.exit(1);
  }

  await writeJiraToken(token);
  console.log(`\nStored in the macOS Keychain (service "mr-radar", account "jira").`);
  console.log(`Verified as accountId ${check.accountId}.`);
}

main().catch((err) => {
  console.error(`failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
