#!/usr/bin/env node
/**
 * Headless one-shot cycle. The main verification tool — it exercises the whole
 * pipeline against live GitLab/Jira/RWX with no Electron involved.
 *
 *   yarn cli --dry-run         run a real cycle, print what WOULD fire, touch nothing
 *   yarn cli                   run for real and persist (still no notifications)
 *   yarn cli --stats           print event history from the DB and exit
 *   yarn cli --runs <branch>   dump the branch's RWX history as polling sees it
 */
import { DEFAULT_RWX_TEST_DEFINITION } from './core/ci';
import { Db } from './core/db';
import { DB_PATH, ensureConfig } from './core/config';
import { toNotifications } from './core/events';
import { pollOnce } from './core/poll';
import { createForge, resolveForgeName } from './core/sources/forge';
import { JiraSource } from './core/sources/jira';
import { RwxSource, isCompleted } from './core/sources/rwx';
import { readJiraToken } from './core/secrets';

const RESET = '[0m';
const c = (code: string, s: string) => (process.stdout.isTTY ? `${code}${s}${RESET}` : s);
const dim = (s: string) => c('[2m', s);
const bold = (s: string) => c('[1m', s);
const red = (s: string) => c('[31m', s);
const green = (s: string) => c('[32m', s);
const yellow = (s: string) => c('[33m', s);

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const dryRun = args.has('--dry-run');

  if (args.has('--runs')) {
    const branch = argv[argv.indexOf('--runs') + 1];
    if (!branch || branch.startsWith('--')) {
      console.error(red('usage: yarn cli --runs <branch>'));
      process.exit(1);
    }
    await printBranchRuns(branch);
    return;
  }

  const config = ensureConfig();
  const db = new Db(process.env.MR_RADAR_DB ?? DB_PATH);
  const forge = createForge(await resolveForgeName(config, db));

  if (args.has('--stats')) {
    printStats(db);
    db.close();
    return;
  }

  const token = await readJiraToken();
  const jira =
    config.jira.email && token
      ? new JiraSource(config.jira.baseUrl, config.jira.email, token)
      : undefined;

  if (!jira) {
    console.log(
      yellow(
        'jira not configured — scope will fall back to the cached ticket set.\n' +
          `  set "jira.email" in ~/.config/mr-radar/config.json and store a token:\n` +
          '  MR_RADAR_JIRA_TOKEN=<token> yarn cli\n',
      ),
    );
  }

  const started = Date.now();
  const result = await pollOnce(
    {
      db,
      config,
      forge,
      rwx: new RwxSource(),
      ...(jira ? { jira } : {}),
      log: (m) => console.log(dim(`  ${m}`)),
    },
    { dryRun, forceJira: true }, // a hand-run cycle should never serve stale tickets
  );
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log();
  printSources(result.snapshot);
  console.log();
  printItems(result.snapshot);
  console.log();
  printEvents(result.events, dryRun);
  console.log();
  console.log(
    dim(
      `${elapsed}s · ${result.stats.apiCalls} api calls · ` +
        `${result.stats.detailFetches} detail fetches · ${result.stats.commitFetches} commit fetches` +
        (dryRun ? ' · dry run, nothing persisted' : ''),
    ),
  );
  db.close();
}

const printSources = (snapshot: { sources: Record<string, { ok: boolean; error?: string; stale?: boolean }> }): void => {
  console.log(bold('Sources'));
  for (const [name, health] of Object.entries(snapshot.sources)) {
    const mark = health.ok ? green('ok') : red('degraded');
    const note = health.stale ? yellow(' (using cached data)') : '';
    console.log(`  ${name.padEnd(8)} ${mark}${note}${health.error ? dim(` — ${health.error}`) : ''}`);
  }
}

const printItems = (snapshot: {
  items: {
    key: string;
    inScope: boolean;
    branch: string;
    title: string;
    ticket?: { key: string; status: string };
    threads?: unknown[];
    approvals?: { left?: number; required?: number; by?: string[] };
    testGate?: { kind: string; provider?: string; result?: string; unverifiedCommits?: number | string; startable?: boolean };
    reason: string;
  }[];
}): void => {
  const inScope = snapshot.items.filter((i) => i.inScope);
  console.log(bold(`In scope (${inScope.length} of ${snapshot.items.length} open MRs)`));
  if (inScope.length === 0) {
    console.log(dim('  nothing in scope — is jira configured, and are any tickets active?'));
    return;
  }
  for (const i of inScope) {
    const ticket = i.ticket ? `${i.ticket.key} [${i.ticket.status}]` : dim('no active ticket');
    const appr = i.approvals
      ? i.approvals.required !== undefined && i.approvals.left !== undefined
        ? ` appr ${i.approvals.required - i.approvals.left}/${i.approvals.required}`
        : ` appr ${i.approvals.by?.length ?? 0} approved`
      : '';
    console.log(`  ${bold(i.key.padEnd(30))} ${ticket}${appr}`);
    console.log(`    ${dim(i.title.slice(0, 88))}`);
    console.log(`    tests: ${gateLabel(i.testGate)}`);
  }
}

const gateLabel = (gate?: {
  kind: string;
  provider?: string;
  result?: string;
  unverifiedCommits?: number | string;
  startable?: boolean;
  lastResult?: { result: string };
}): string => {
  if (!gate) return dim('not evaluated');
  const p = gate.provider ? gate.provider.toUpperCase() : '';
  switch (gate.kind) {
    case 'verified':
      return gate.result === 'succeeded' ? green(`${p} passed`) : red(`${p} FAILED`);
    case 'in_progress':
      return yellow(`${p} running`);
    case 'unverified': {
      const n = gate.unverifiedCommits;
      const count = n === 'many' ? undefined : `${n} commit(s) unverified`;
      const how = gate.lastResult
        ? `stale — last ${gate.lastResult.result}${count ? `, ${count}` : ''}`
        : (count ?? 'never run');
      return gate.startable ? red(`${p} ${how} — startable`) : yellow(`${p} ${how}`);
    }
    default:
      return dim('no CI');
  }
}

const printEvents = (events: { type: string }[], dryRun: boolean): void => {
  const notifications = toNotifications(events as never);
  const heading = dryRun ? 'Would notify' : 'Notified';
  const collapsed =
    events.length > notifications.length
      ? dim(` — ${events.length} events collapsed into ${notifications.length}`)
      : '';
  console.log(bold(`${heading} (${notifications.length})`) + collapsed);
  if (notifications.length === 0) {
    console.log(dim('  nothing new — expected on a second consecutive run'));
    return;
  }
  for (const n of notifications) {
    console.log(`  ${bold(n.title)}`);
    console.log(`    ${dim(n.body)}`);
  }
}

/**
 * The "why does the app say never run?" tool: every RWX run for a branch,
 * exactly as the poller sees it, with what counts as coverage and why not.
 * Coverage = Execution finished AND Result succeeded/failed — a `waiting` run
 * (rocket's manual-start spec suite) or an auto-started sibling suite is not it.
 */
const printBranchRuns = async (branch: string): Promise<void> => {
  const rwx = new RwxSource();
  const runs = await rwx.runsForBranch(branch);
  if (runs.length === 0) {
    console.log(dim(`no RWX runs at all for branch ${branch}`));
    return;
  }

  const config = ensureConfig();
  const gateDefinition =
    Object.values(config.repos).find((r) => r.rwxDefinition)?.rwxDefinition ??
    DEFAULT_RWX_TEST_DEFINITION;

  console.log(bold(`RWX runs for ${branch}`) + dim(` — test gate: ${gateDefinition}`));
  const byDefinition = new Map<string, typeof runs>();
  for (const r of runs) {
    const list = byDefinition.get(r.DefinitionPath) ?? [];
    list.push(r);
    byDefinition.set(r.DefinitionPath, list);
  }

  for (const [definition, list] of byDefinition) {
    const covered = list.filter(isCompleted);
    const isGate = definition === gateDefinition;
    const role = isGate ? bold('TEST GATE') : dim('secondary — never counts as verification');
    console.log(`\n  ${bold(definition)}  ${role}`);
    for (const r of list) {
      const s = r.Status;
      const counts = isCompleted(r)
        ? green('← counts as a result')
        : s.Execution === 'waiting'
          ? dim('waiting (never started)')
          : dim(`${s.Execution}/${s.Result} (no verdict)`);
      console.log(
        `    ${dim(r.CreatedAt.slice(0, 16))}  ${r.CommitSha.slice(0, 8)}  ${s.Execution.padEnd(11)} ${s.Result.padEnd(10)} ${counts}`,
      );
    }
    if (isGate) {
      console.log(
        covered.length === 0
          ? `    ${red(`verdict: NEVER RUN — 0 of ${list.length} runs produced a result`)}`
          : `    ${green(`verdict: has results (${covered.length} of ${list.length} runs)`)}` +
              dim(' — stale vs verified depends on the MR head sha'),
      );
    }
  }
}

const printStats = (db: Db): void => {
  console.log(bold('Event history'));
  const stats = db.eventStats();
  if (stats.length === 0) {
    console.log(dim('  no events recorded yet'));
    return;
  }
  for (const s of stats) console.log(`  ${s.type.padEnd(18)} ${s.n}`);
  console.log();
  console.log(bold('Most recent'));
  for (const e of db.recentEvents(15)) {
    console.log(`  ${dim(e.at.slice(0, 19))} ${e.type.padEnd(16)} ${e.mr_key}`);
  }

  const runs = db.allWatchedRuns(20);
  console.log();
  console.log(bold('Runs I started'));
  if (runs.length === 0) {
    console.log(dim('  none yet'));
    return;
  }
  for (const r of runs) {
    const status = r.terminal
      ? r.result === 'succeeded'
        ? green('succeeded')
        : red(r.result ?? 'finished')
      : yellow('running');
    console.log(
      `  ${dim(r.started_at.slice(0, 19))} ${r.branch.padEnd(12)} ${r.sha.slice(0, 8)} ${status}`,
    );
  }
}

main().catch((err) => {
  console.error(red(`\nfailed: ${err instanceof Error ? err.stack : String(err)}`));
  process.exit(1);
});
