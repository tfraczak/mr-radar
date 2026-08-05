#!/usr/bin/env node
/**
 * App-client CLI — the agent-friendly way to read and drive a running
 * MR Radar (tray or poller). Not to be confused with `yarn cli` (cli.ts),
 * which runs its own poll cycle against the live services.
 *
 *   node --no-warnings dist/radar-cli.js status --json
 *   node --no-warnings dist/radar-cli.js list --section active
 *   node --no-warnings dist/radar-cli.js show 'acme/rocket!7576'
 *   node --no-warnings dist/radar-cli.js run 'acme/rocket!7576'
 *
 * Read commands work even when the app is closed (data from the last poll,
 * flagged stale). Actions need the live app and exit 2 with guidance if it
 * is not running. `--json` emits stable machine-readable shapes.
 */
import { AppDownError, NoDataError, RadarClient, type Section } from './client/radar-client';

export interface CliDeps {
  client: RadarClient;
  out: (line: string) => void;
  err: (line: string) => void;
  isTTY: boolean;
}

const RESET = '[0m';

const HELP = `mr-radar CLI — query and drive the local MR Radar app

usage: node --no-warnings dist/radar-cli.js <command> [options] [--json]

read commands (work even when the app is closed; stale data is flagged):
  status                       app health, polling state, section counts
  list [--section S] [--ticket KEY]
                               watched MRs; S: active|needs|verification|done|
                               other|ignored
  show <mr-key>                one MR in full (test gate, checks, approvals)
  events [--limit N] [--mr KEY]
                               notification history, newest first (default 30)
  tickets                      active Jira tickets as of the last Jira fetch

live-only read:
  discussions <mr-key> [--all] review threads with comment bodies
                               (default: unresolved only)
  slack <mr-key>               fresh ready-for-review check; prints the
                               announce message on success (pipe to pbcopy),
                               or the blocking reasons on failure

actions (need the running app; exit 2 otherwise):
  run <mr-key>                 start an RWX run for the MR's head commit
                               (safe to retry: in-flight runs are detected)
  ignore <mr-key>              mute an MR until it closes (no notifications,
                               no counts; it moves to the Ignored section)
  unignore <mr-key>            restore an MR (pins it visible if a rule
                               ignores it)
  pause | resume               polling on/off (idempotent)
  poll                         request a poll cycle now

options:
  --json                       stable machine output: {source, dataAsOf,
                               stale?, staleNote?, ...payload}
  --help                       this text

MR keys are verbatim references: 'group/repo!123' (GitLab), 'owner/repo#123'
(GitHub). Quote them — ! and # are shell metacharacters.`;

/** Parse argv into {command, positional, flags}; unknown flags are errors. */
const parse = (
  argv: string[],
): { command: string; positional: string[]; flags: Map<string, string | true> } | { error: string } => {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const valueFlags = new Set(['--section', '--ticket', '--limit', '--mr']);
  const boolFlags = new Set(['--json', '--all', '--help']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    if (boolFlags.has(arg)) {
      flags.set(arg, true);
      continue;
    }
    if (valueFlags.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      flags.set(arg, value);
      i += 1;
      continue;
    }
    return { error: `unknown option ${arg}` };
  }
  const command = positional.shift() ?? 'help';
  return { command, positional, flags };
};

const SECTIONS: Section[] = ['active', 'needs', 'verification', 'done', 'other', 'ignored'];

export const runCommand = async (argv: string[], deps: CliDeps): Promise<number> => {
  const { out, err, client } = deps;
  const c = (code: string, s: string): string => (deps.isTTY ? `${code}${s}${RESET}` : s);
  const dim = (s: string): string => c('[2m', s);
  const bold = (s: string): string => c('[1m', s);
  const red = (s: string): string => c('[31m', s);
  const green = (s: string): string => c('[32m', s);
  const yellow = (s: string): string => c('[33m', s);

  const parsed = parse(argv);
  if ('error' in parsed) {
    err(red(parsed.error));
    return 1;
  }
  const { command, positional, flags } = parsed;
  const json = flags.get('--json') === true;
  const emit = (payload: unknown): void => out(JSON.stringify(payload, null, json ? 0 : 2));

  const staleBanner = (r: { stale?: boolean; staleNote?: string }): void => {
    if (r.stale && r.staleNote) out(yellow(`⚠ ${r.staleNote}`));
  };

  try {
    if (command === 'help' || flags.get('--help') === true) {
      out(HELP);
      return 0;
    }

    if (command === 'status') {
      const s = await client.status();
      if (json) return (emit(s), 0);
      staleBanner(s);
      out(bold(s.appRunning ? `MR Radar is running (${s.mode ?? '?'}, v${s.version ?? '?'})` : 'MR Radar is not running'));
      if (s.appRunning) {
        out(`  polling: ${s.polling ? 'in progress' : 'idle'} · ${s.enabled ? 'enabled' : 'paused'}${s.paused ? ` (${s.paused})` : ''}`);
        if (s.lastPollAt) out(`  last poll: ${s.lastPollAt}${s.nextPollAt ? ` · next: ${s.nextPollAt}` : ''}`);
        if (s.lastError) out(red(`  last error: ${s.lastError}`));
        out(`  unread: ${s.unreadCount ?? 0}`);
        for (const src of s.sources ?? []) {
          out(`  ${src.ok ? green('●') : red('●')} ${src.name}${src.error ? dim(` — ${src.error}`) : ''}${src.stale ? dim(' (stale)') : ''}`);
        }
      }
      const counts = Object.entries(s.counts)
        .filter(([, n]) => n !== undefined)
        .map(([k, n]) => `${k} ${n}`)
        .join(' · ');
      if (counts) out(`  MRs: ${counts}`);
      return 0;
    }

    if (command === 'list') {
      const section = flags.get('--section');
      if (typeof section === 'string' && !SECTIONS.includes(section as Section)) {
        err(red(`--section must be one of: ${SECTIONS.join(', ')}`));
        return 1;
      }
      const ticket = flags.get('--ticket');
      const r = await client.listMrs({
        ...(typeof section === 'string' ? { section: section as Section } : {}),
        ...(typeof ticket === 'string' ? { ticket } : {}),
      });
      if (json) return (emit(r), 0);
      staleBanner(r);
      if (r.mrs.length === 0) {
        out(dim('no MRs match'));
        return 0;
      }
      for (const mr of r.mrs) {
        const ticketBit = mr.ticket?.key ? `${mr.ticket.key}${mr.ticket.status ? ` (${mr.ticket.status})` : ''}` : (mr.ticket?.status ?? '');
        out(`${bold(mr.key)}  ${mr.title}`);
        out(
          `  ${[
            mr.section,
            ticketBit || undefined,
            mr.reason,
            mr.draft ? 'draft' : undefined,
            mr.conflicts ? red('conflicts') : undefined,
            mr.unresolved > 0 ? `${mr.unresolved} open thread${mr.unresolved === 1 ? '' : 's'}` : undefined,
            mr.attention ? mr.attention.text : undefined,
            mr.ci ? mr.ci.label : undefined,
          ]
            .filter(Boolean)
            .join(' · ')}`,
        );
      }
      return 0;
    }

    if (command === 'show' || command === 'discussions') {
      const key = positional[0];
      if (!key) {
        err(red(`usage: ${command} <mr-key>`));
        return 1;
      }
      if (command === 'show') {
        const r = await client.itemDetail(key);
        if (json) return (emit(r), 0);
        staleBanner(r);
        if (!r.item) {
          err(red(r.message ?? 'not found'));
          return 1;
        }
        emit(r.item); // full detail is a JSON-shaped object either way
        return 0;
      }
      const r = await client.discussions(key, flags.get('--all') !== true);
      if (json) return (emit(r), 0);
      if (!r.threads) {
        err(red(r.message ?? 'not found'));
        return 1;
      }
      if (r.threads.length === 0) {
        out(dim('no matching threads'));
        return 0;
      }
      for (const t of r.threads) {
        out(bold(`thread ${t.id}${t.filePath ? ` — ${t.filePath}${t.line ? `:${t.line}` : ''}` : ''}${t.resolved ? dim(' (resolved)') : ''}`));
        for (const note of t.notes) {
          out(`  ${green(note.author)} ${dim(note.createdAt)}`);
          for (const line of note.body.split('\n')) out(`    ${line}`);
        }
      }
      return 0;
    }

    if (command === 'events') {
      const limit = Number(flags.get('--limit') ?? '30');
      const mr = flags.get('--mr');
      const r = await client.events(Number.isFinite(limit) ? limit : 30, typeof mr === 'string' ? mr : undefined);
      if (json) return (emit(r), 0);
      staleBanner(r);
      for (const e of r.events) {
        out(`${dim(e.at)}  ${bold(e.type)}  ${e.mrKey}${e.notified ? '' : dim(' (silent)')}`);
      }
      if (r.events.length === 0) out(dim('no events recorded'));
      return 0;
    }

    if (command === 'tickets') {
      const r = await client.tickets();
      if (json) return (emit(r), 0);
      staleBanner(r);
      for (const t of r.tickets) {
        out(`${bold(t.key)}  ${t.status}${t.dueDate ? ` · due ${t.dueDate}` : ''}  ${t.summary}`);
      }
      if (r.tickets.length === 0) out(dim('no cached tickets'));
      return 0;
    }

    if (command === 'run') {
      const key = positional[0];
      if (!key) {
        err(red('usage: run <mr-key>'));
        return 1;
      }
      const r = await client.startRun(key);
      if (json) return (emit(r), r.started ? 0 : 1);
      out(r.started ? green(r.message) : red(r.message));
      if (r.url) out(`  ${r.url}`);
      return r.started ? 0 : 1;
    }

    if (command === 'slack') {
      const key = positional[0];
      if (!key) {
        err(red('usage: slack <mr-key>'));
        return 1;
      }
      const r = await client.reviewReady(key);
      if (json) return (emit(r), r.ok && r.eligible ? 0 : 1);
      if (r.ok && r.eligible && r.message) {
        out(r.message);
        return 0;
      }
      err(red('Not ready to announce:'));
      for (const why of r.reasons?.length ? r.reasons : [r.message ?? 'could not verify']) {
        err(red(`  - ${why}`));
      }
      return 1;
    }

    if (command === 'ignore' || command === 'unignore') {
      const key = positional[0];
      if (!key) {
        err(red(`usage: ${command} <mr-key>`));
        return 1;
      }
      const r = await client.setIgnored(key, command === 'ignore');
      if (json) return (emit(r), r.ok ? 0 : 1);
      if (!r.ok) {
        err(red(r.message ?? 'failed'));
        return 1;
      }
      out(command === 'ignore' ? `ignored ${key} until it closes` : `restored ${key}`);
      if (r.message) out(dim(r.message));
      return 0;
    }

    if (command === 'pause' || command === 'resume') {
      const r = await client.setPolling(command === 'resume');
      if (json) return (emit(r), 0);
      out(`polling ${r.enabled ? 'enabled' : 'paused'}${r.changed ? '' : dim(' (already was)')}`);
      return 0;
    }

    if (command === 'poll') {
      const r = await client.pollNow();
      if (json) return (emit(r), 0);
      out('poll requested — check `status` shortly to see the result');
      return 0;
    }

    err(red(`unknown command '${command}' — try --help`));
    return 1;
  } catch (e) {
    if (e instanceof AppDownError) {
      if (json) out(JSON.stringify({ error: 'app_not_running', message: e.message }));
      else err(red(e.message));
      return 2;
    }
    if (e instanceof NoDataError) {
      if (json) out(JSON.stringify({ error: 'no_data', message: e.message }));
      else err(yellow(e.message));
      return 1;
    }
    const message = e instanceof Error ? e.message : String(e);
    if (json) out(JSON.stringify({ error: 'failed', message }));
    else err(red(message));
    return 1;
  }
};

/* istanbul ignore next -- process wiring, exercised manually */
if (require.main === module) {
  void runCommand(process.argv.slice(2), {
    client: new RadarClient(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    isTTY: process.stdout.isTTY === true,
  }).then((code) => {
    process.exitCode = code;
  });
}
