#!/usr/bin/env node
/**
 * Headless resident poller — the ThreatLocker-friendly way to run MR Radar.
 *
 * The Electron menu bar app is a locally-built, unrecognized binary, so
 * ThreatLocker's application control SIGKILLs it on launch. This poller is the
 * same core pipeline (`pollOnce` and friends have zero Electron imports) run
 * under plain `node` — which ThreatLocker allows — delivering notifications
 * through pre-signed system helpers (terminal-notifier or osascript) and
 * serving the popover UI as a localhost web page (see web-server.ts):
 *
 *   http://127.0.0.1:8942   ← "open MR Radar" on this machine
 *
 * Runs under launchd (see scripts/install-poller.mjs) or directly:
 *
 *   yarn poller           run in the foreground, ctrl-C to stop
 *
 * If security ever approves the Electron app, this poller and the app are
 * interchangeable — same config, same DB, same Keychain token. Just don't run
 * both at once (the pidfile below guards against double-notifying).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { Db } from './core/db';
import { DB_PATH, ensureConfig, loadConfig, type Config } from './core/config';
import { toNotifications } from './core/events';
import { pollOnce } from './core/poll';
import { afterCycle, nextIntervalSeconds, pausedBecause } from './core/schedule';
import { readJiraToken } from './core/secrets';
import type { AppEvent } from './core/types';
import { createForge, resolveForgeName } from './core/sources/forge';
import { JiraSource } from './core/sources/jira';
import { RwxSource } from './core/sources/rwx';
import { fixPath } from './main/fix-path';
import { dedupeUnread, initialUiState, type UiState } from './main/state';
import { resolveSystemMethod, systemNotify } from './main/sys-notify';
import { makeWebHandlers } from './main/web-handlers';
import { startWebServer } from './web-server';

const log = (msg: string): void => {
  console.log(`[mr-radar] ${new Date().toISOString()} ${msg}`);
};

/** Re-check this often while outside active hours, instead of the poll ladder. */
const OFF_HOURS_RECHECK_SECONDS = 300;

/** The radar PNG, shipped in the repo; banner thumbnail + web tab icon. */
const ICON_PATH = process.env.MR_RADAR_ICON ?? join(__dirname, '..', 'assets', 'app-icon.png');

// ---------------------------------------------------------------------------
// Single-instance guard
// ---------------------------------------------------------------------------

const PID_PATH = join(dirname(DB_PATH), 'poller.pid');

/** True if another live poller owns the pidfile. Claims it otherwise. */
const anotherInstanceRunning = (): boolean => {
  try {
    const pid = Number(readFileSync(PID_PATH, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      process.kill(pid, 0); // throws if the process is gone
      return true;
    }
  } catch {
    // No pidfile, unreadable, or a stale pid — ours to claim.
  }
  mkdirSync(dirname(PID_PATH), { recursive: true });
  writeFileSync(PID_PATH, `${process.pid}\n`);
  return false;
};

const releasePidfile = (): void => {
  try {
    const pid = Number(readFileSync(PID_PATH, 'utf8').trim());
    if (pid === process.pid) rmSync(PID_PATH, { force: true });
  } catch {
    /* already gone */
  }
};

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const state: UiState = initialUiState();
let db: Db;
let timer: NodeJS.Timeout | undefined;
let stopping = false;
let web: Server | undefined;

let forge = createForge('gitlab'); // re-resolved in main() and on saves
const rwx = new RwxSource();
let jira: JiraSource | undefined;
let warnedNoJira = false;

/** Config is re-read every cycle so edits to config.json apply on the next poll. */
const currentConfig = (fallback: Config): Config => {
  try {
    return loadConfig();
  } catch (err) {
    log(`config reload failed (${err instanceof Error ? err.message : String(err)}) — keeping previous`);
    return fallback;
  }
};

/** The Jira token can be added mid-run (`yarn jira:token`); pick it up lazily. */
const refreshJira = async (config: Config): Promise<void> => {
  if (jira) return;
  const token = await readJiraToken();
  if (config.jira.baseUrl && config.jira.email && token) {
    jira = new JiraSource(config.jira.baseUrl, config.jira.email, token);
    state.jiraConfigured = true;
    state.jiraEmail = config.jira.email;
    log('jira connected');
    return;
  }
  state.jiraConfigured = false;
  state.jiraEmail = config.jira.email || undefined;
  if (!warnedNoJira) {
    warnedNoJira = true;
    const why = config.jira.email
      ? 'no Jira token stored — run `yarn jira:token` or paste one in the web UI'
      : 'jira.email not set in config.json';
    log(`jira not configured (${why}); scope falls back to the cached ticket set`);
  }
};

const deliver = (events: AppEvent[], config: Config): number => {
  if (!config.notifications.enabled || events.length === 0) return 0;
  // Headless runtime: 'native'/'auto' both resolve to the best system helper.
  const method = resolveSystemMethod(config.notifications.method);
  const icon = existsSync(ICON_PATH) ? ICON_PATH : undefined;
  const notifications = toNotifications(events);
  for (const n of notifications) {
    systemNotify(method, {
      title: n.title,
      body: n.body,
      url: n.url,
      sound: config.notifications.sound,
      icon,
    });
  }
  return notifications.length;
};

const cycle = async (config: Config, opts: { manual?: boolean } = {}): Promise<void> => {
  const paused = pausedBecause(state.schedule, config, new Date());
  state.pausedReason = paused;
  if (paused) {
    log(`skipping cycle (${paused})`);
    scheduleNext(paused === 'user' ? undefined : OFF_HOURS_RECHECK_SECONDS, config);
    return;
  }
  if (state.polling) return;
  state.polling = true;

  await refreshJira(config);
  try {
    const result = await pollOnce(
      {
        db,
        config,
        forge,
        rwx,
        ...(jira ? { jira } : {}),
        log,
      },
      // A hand-pressed poll refreshes Jira too, cadence or not.
      { forceJira: opts.manual ?? false },
    );
    state.snapshot = result.snapshot;
    state.lastPollAt = result.snapshot.at;
    state.lastError = undefined;
    state.schedule = afterCycle(state.schedule, result.events.length);
    if (result.events.length > 0) {
      state.unread = dedupeUnread([...result.events, ...state.unread]);
      const shown = deliver(result.events, config);
      log(`${result.events.length} events → ${shown} notification(s)`);
    }
    log(
      `cycle ok · ${result.stats.apiCalls} api calls · ` +
        `${result.stats.detailFetches} detail fetches · ${result.stats.commitFetches} commit fetches`,
    );
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    log(`cycle failed: ${state.lastError}`);
  } finally {
    state.polling = false;
    scheduleNext(nextIntervalSeconds(state.schedule, config), config);
  }
};

/** Undefined seconds = paused by the user: no timer until they resume. */
const scheduleNext = (seconds: number | undefined, _config: Config): void => {
  if (stopping) return;
  if (timer) clearTimeout(timer);
  if (seconds === undefined) {
    timer = undefined;
    state.nextPollAt = undefined;
    return;
  }
  state.nextPollAt = new Date(Date.now() + seconds * 1000).toISOString();
  timer = setTimeout(() => void tick(), seconds * 1000);
};

let config: Config;
const tick = async (opts: { manual?: boolean } = {}): Promise<void> => {
  config = currentConfig(config);
  await cycle(config, opts);
};

/** A user action wants a cycle now (unless one is already running). */
const requestCycle = (): void => {
  if (state.polling) return;
  state.schedule = { ...state.schedule, quietCycles: 0 };
  void tick({ manual: true }); // asked for by hand: refresh Jira too
};

// ---------------------------------------------------------------------------
// Web UI handlers — shared with the tray (see main/web-handlers.ts); only the
// shell-specific glue lives here.
// ---------------------------------------------------------------------------

const togglePause = (): void => {
  state.schedule = { ...state.schedule, enabled: !state.schedule.enabled };
  state.pausedReason = pausedBecause(state.schedule, config, new Date());
  if (state.schedule.enabled) {
    log('resumed');
    requestCycle();
  } else {
    log('paused by user');
    scheduleNext(undefined, config);
  }
};

const webHandlers = () =>
  makeWebHandlers({
    state,
    db,
    rwx,
    log,
    mode: 'poller',
    getConfig: () => config,
    setConfig: (c) => {
      config = c;
    },
    getForge: () => forge,
    setForge: (f) => {
      forge = f;
    },
    getJira: () => jira,
    reconnectJira: async () => {
      jira = undefined; // email may have changed; reconnect from the Keychain
      await refreshJira(config);
    },
    requestCycle,
    togglePause,
    onStateChanged: () => {
      /* headless: the web page pulls its snapshot on its own cadence */
    },
    openUi: () => {
      /* the web page IS the UI here; the highlight rides the next snapshot poll */
    },
  });

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const shutdown = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  log(`${signal} — shutting down`);
  if (timer) clearTimeout(timer);
  web?.close();
  try {
    db?.close();
  } catch {
    /* closing a closed db is fine */
  }
  releasePidfile();
  process.exit(0);
};

const main = async (): Promise<void> => {
  if (anotherInstanceRunning()) {
    // Exit 0: launchd's KeepAlive only restarts unsuccessful exits, so a clean
    // exit here stops a duplicate agent from respawn-looping against the lock.
    console.error('another mr-radar poller is already running — exiting');
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // launchd starts us with a bare PATH; glab/rwx live in /opt/homebrew/bin.
  fixPath();
  config = ensureConfig();
  db = new Db(process.env.MR_RADAR_DB ?? DB_PATH);
  forge = createForge(await resolveForgeName(config, db));
  log(`poller started (pid ${process.pid}, forge ${forge.name}, icon ${existsSync(ICON_PATH) ? 'found' : 'missing'})`);

  if (config.web.enabled) {
    web = startWebServer({
      port: config.web.port,
      rendererDir: join(__dirname, 'renderer'),
      iconPath: ICON_PATH,
      log,
      mode: 'poller',
      handlers: webHandlers(),
    });
  }

  await tick();
};

main().catch((err) => {
  console.error(`[mr-radar] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  releasePidfile();
  process.exit(1);
});
