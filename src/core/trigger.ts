import { existsSync } from 'node:fs';
import { DEFAULT_RWX_TEST_DEFINITION } from './ci';
import type { Config } from './config';
import type { Db } from './db';
import type { RwxSource } from './sources/rwx';
import type { WatchItem } from './types';

/**
 * The Electron-free half of "start an RWX run".
 *
 * Confirmation is the caller's job — the Electron shell shows a native dialog,
 * the web UI a browser confirm — because starting a run is the only action here
 * with a real-world cost and must be confirmed every time, in whatever surface
 * the user is on. Everything below the confirm lives here so both shells share
 * one implementation.
 */

export interface TriggerDeps {
  db: Db;
  config: Config;
  rwx: RwxSource;
  log: (msg: string) => void;
}

export interface TriggerResult {
  started: boolean;
  message: string;
  /** The run's URL, so the UI can offer an on-demand link (not auto-opened). */
  url?: string;
}

export interface TriggerPlan {
  checkout: string;
  definition: string;
}

/**
 * An open (non-terminal) run we already started for this exact commit. Checked
 * before any confirm/start so a stale popover snapshot — where the button still
 * reads "Start run" seconds after a click — can't double-spend CI minutes.
 */
export const inFlightRun = (db: Db, item: WatchItem) => {
  return db.openWatchedRuns().find((w) => w.branch === item.branch && w.sha === item.headSha);
}

/** Validate that a run can be started; a string is the human-readable refusal. */
export const planTrigger = (config: Config, item: WatchItem): TriggerPlan | string => {
  const repo = config.repos[item.projectPath];
  const definition = repo?.rwxDefinition ?? DEFAULT_RWX_TEST_DEFINITION;
  if (!repo?.checkout) {
    return (
      `No local checkout configured for ${item.projectPath}. ` +
      'Set its checkout in Settings → General — the rwx CLI ' +
      'needs a working tree to resolve .rwx/ from.'
    );
  }
  if (!existsSync(repo.checkout)) return `Checkout not found: ${repo.checkout}`;
  return { checkout: repo.checkout, definition };
}

/**
 * Start the run (already confirmed) and record it in `watched_runs`, which is
 * what guarantees a result notification even if it scrolls out of RWX's
 * recent-runs window.
 */
export const executeTrigger = async (
  deps: TriggerDeps,
  item: WatchItem,
  plan: TriggerPlan,
): Promise<TriggerResult> => {
  const { db, config, rwx, log } = deps;
  const short = item.headSha.slice(0, 8);
  const email = config.jira.email || 'mr-radar';
  try {
    const { runId, url } = await rwx.startRun({
      checkout: plan.checkout,
      definition: plan.definition,
      branch: item.branch,
      commitSha: item.headSha,
      title: `${item.branch} - ${email}`,
    });

    if (!runId) {
      // The run may well have started even if we couldn't find its id in the
      // CLI output; say so rather than implying failure.
      log(`rwx run for ${item.branch} started but returned no parseable run id`);
      return {
        started: true,
        message: 'Run started, but no run id was returned — check RWX directly.',
      };
    }

    db.transaction(() =>
      db.addWatchedRun({
        run_id: runId,
        provider: 'rwx',
        mr_key: item.key,
        branch: item.branch,
        sha: item.headSha,
        definition: plan.definition,
        url: url ?? '',
        started_at: new Date().toISOString(),
        terminal: 0,
        result: null,
      }),
    );
    log(`started rwx run ${runId} for ${item.branch} @ ${short}`);

    // Deliberately no auto-open — the UI surfaces the run as a "Current run"
    // link the user opens on demand, rather than stealing focus on trigger.
    return {
      started: true,
      message: `Started run for ${item.branch} @ ${short}. Watching for the result.`,
      ...(url ? { url } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`rwx run for ${item.branch} failed: ${message}`);
    return { started: false, message: `Failed to start run: ${message}` };
  }
}
