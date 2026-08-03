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
import {
  CONFIG_PATH,
  DB_PATH,
  ensureConfig,
  loadConfig,
  readRawConfig,
  writeRawConfig,
  type Config,
} from './core/config';
import { toNotifications } from './core/events';
import { pollOnce } from './core/poll';
import { afterCycle, nextIntervalSeconds, pausedBecause } from './core/schedule';
import { readJiraToken, writeJiraToken } from './core/secrets';
import { executeTrigger, inFlightRun, planTrigger } from './core/trigger';
import type { AppEvent } from './core/types';
import { createForge, resolveForgeName } from './core/sources/forge';
import { JiraSource } from './core/sources/jira';
import { RwxSource } from './core/sources/rwx';
import { fixPath } from './main/fix-path';
import { present } from './main/present';
import { applyEditable, knownRepos, knownStatuses, mergeSharedSettings, shareableSettings, toEditable, validateEditable } from './main/settings';
import { dedupeUnread, initialUiState, type UiState } from './main/state';
import { resolveSystemMethod, systemNotify } from './main/sys-notify';
import { startWebServer } from './web-server';
import type { EditableSettings } from './renderer/contract';

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

const cycle = async (config: Config): Promise<void> => {
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
    const result = await pollOnce({
      db,
      config,
      forge,
      rwx,
      ...(jira ? { jira } : {}),
      log,
    });
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
const tick = async (): Promise<void> => {
  config = currentConfig(config);
  await cycle(config);
};

/** A user action wants a cycle now (unless one is already running). */
const requestCycle = (): void => {
  if (state.polling) return;
  state.schedule = { ...state.schedule, quietCycles: 0 };
  void tick();
};

// ---------------------------------------------------------------------------
// Web UI handlers — the browser-side twin of the Electron IPC surface.
// ---------------------------------------------------------------------------

const webHandlers = () => ({
  getSnapshot: () => present(state, config.jira.activeStatuses, new Date(), config.git.updateStyle, config.statusSections, config.statusRules),
  pollNow: () => requestCycle(),
  togglePause: () => {
    state.schedule = { ...state.schedule, enabled: !state.schedule.enabled };
    state.pausedReason = pausedBecause(state.schedule, config, new Date());
    if (state.schedule.enabled) {
      log('resumed (web)');
      requestCycle();
    } else {
      log('paused by user (web)');
      scheduleNext(undefined, config);
    }
  },
  markAllRead: () => {
    state.unread = [];
  },
  markRead: (mrKey: string) => {
    state.unread = state.unread.filter((e) => e.mrKey !== mrKey);
  },
  startRun: async (mrKey: string) => {
    // The web page already confirmed with the user; validate and execute.
    const item = state.snapshot?.items.find((i) => i.key === mrKey);
    if (!item) return { started: false, message: 'That MR is no longer in scope.' };
    const plan = planTrigger(config, item);
    if (typeof plan === 'string') return { started: false, message: plan };
    const inFlight = inFlightRun(db, item);
    if (inFlight) {
      return {
        started: true,
        message: 'A run for this commit is already in flight.',
        ...(inFlight.url ? { url: inFlight.url } : {}),
      };
    }
    const result = await executeTrigger({ db, config, rwx, log }, item, plan);
    if (result.started) requestCycle();
    return result;
  },
  getSettings: () => toEditable(config, knownRepos(db, config), forge.name),
  saveSettings: async (s: EditableSettings) => {
    const invalid = validateEditable(s);
    if (invalid) return { ok: false, message: invalid };
    try {
      const raw = applyEditable(readRawConfig(CONFIG_PATH), s);
      writeRawConfig(raw, CONFIG_PATH); // validates the merged result too
      config = loadConfig(CONFIG_PATH);
      const forgeName = await resolveForgeName(config, db);
      if (forgeName !== forge.name) forge = createForge(forgeName);
      jira = undefined; // email may have changed; reconnect on the next cycle
      await refreshJira(config);
      requestCycle();
      return { ok: true, message: 'Settings saved.' };
    } catch (err) {
      return { ok: false, message: `Could not save: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
  listFixVersions: async (ticketKey: string) => {
    if (!jira) return { ok: false, message: 'Jira is not connected.' };
    try {
      const versions = await jira.projectVersions(ticketKey.split('-')[0] ?? '');
      return { ok: true, versions };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },
  setFixVersion: async (ticketKey: string, versionId: string) => {
    if (!jira) return { ok: false, message: 'Jira is not connected.' };
    try {
      await jira.setFixVersion(ticketKey, versionId);
      requestCycle(); // move the ticket out of its 'Needs fix version' section
      return { ok: true, message: `Fix version set on ${ticketKey}.` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },
  listStatuses: async () => ({ ok: true, statuses: knownStatuses(db, config) }),
  exportSettings: async () => ({ ok: true, settings: shareableSettings(readRawConfig(CONFIG_PATH)) }),
  importSettings: async (shared: Record<string, unknown>) => {
    try {
      const merged = mergeSharedSettings(readRawConfig(CONFIG_PATH), shared);
      writeRawConfig(merged, CONFIG_PATH); // validates before persisting
      config = loadConfig(CONFIG_PATH);
      requestCycle();
      return { ok: true, message: 'Settings imported. Your email and tokens were kept.' };
    } catch (err) {
      return { ok: false, message: `Import rejected: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
  becomeReviewer: async (mrKey: string) => {
    const item = state.snapshot?.items.find((i) => i.key === mrKey);
    if (!item) return { ok: false, message: 'That MR is no longer in scope.' };
    try {
      const userId = config.gitlab.userId ?? (await forge.currentUser()).id;
      await forge.addReviewer(item.projectId, item.iid, userId);
      requestCycle(); // the row migrates to My reviews next cycle
      return { ok: true, message: `You are now a reviewer on ${mrKey}.` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },
  setJiraToken: async (token: string) => {
    if (!token.trim()) return { ok: false, message: 'Enter a token.' };
    if (!config.jira.baseUrl) return { ok: false, message: 'Set the Atlassian URL in Settings → Jira first.' };
    if (!config.jira.email) return { ok: false, message: 'Set your Jira email in Settings → Jira first.' };
    // Verify against Jira before storing, so a wrong paste fails here rather
    // than silently degrading every poll. Only a valid token is written.
    const probe = new JiraSource(config.jira.baseUrl, config.jira.email, token.trim());
    const check = await probe.verify();
    if (!check.ok) return { ok: false, message: `Rejected by Jira: ${check.error ?? 'unauthorized'}` };
    try {
      await writeJiraToken(token.trim());
    } catch (err) {
      return { ok: false, message: `Could not save to Keychain: ${err instanceof Error ? err.message : String(err)}` };
    }
    jira = undefined;
    await refreshJira(config);
    requestCycle();
    return { ok: true, message: 'Jira connected.' };
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
