import { app, clipboard, dialog, ipcMain, nativeTheme, powerMonitor, shell } from 'electron';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { Db } from '../core/db';
import {
  CONFIG_PATH,
  DB_PATH,
  ensureConfig,
  loadConfig,
  readRawConfig,
  writeRawConfig,
  type Config,
} from '../core/config';
import { applyEditable, knownRepos, knownStatuses, mergeSharedSettings, shareableSettings, toEditable, validateEditable } from './settings';
import { fixPath } from './fix-path';
import type { EditableSettings } from '../renderer/contract';
import { pollOnce } from '../core/poll';
import { afterCycle, nextIntervalSeconds, pausedBecause } from '../core/schedule';
import { readJiraToken, writeJiraToken } from '../core/secrets';
import { createForge, resolveForgeName, type ForgeSource } from '../core/sources/forge';
import { JiraSource } from '../core/sources/jira';
import { RwxSource } from '../core/sources/rwx';
import { notify, sendTestNotification } from './notify';
import { openExternalSafe } from './open';
import { Popover } from './popover';
import { present } from './present';
import { dedupeUnread, initialUiState, type UiState } from './state';
import { TrayController } from './tray';
import { startRunFor } from './trigger';
import { makeWebHandlers } from './web-handlers';
import { startWebServer, type WebHandlers } from '../web-server';

/**
 * Menu bar app entry point.
 *
 * Owns the poll loop, the tray, and the popover. All the interesting logic lives
 * in ../core, which has no Electron imports at all — that's what lets `yarn cli`
 * exercise the whole pipeline headlessly.
 */

const state: UiState = initialUiState();
let config: Config = ensureConfig();
/** Radar PNG: web tab icon + terminal-notifier thumbnail. dist/main → repo. */
const ICON_PATH = join(__dirname, '..', '..', 'assets', 'app-icon.png');
let db: Db;
let forge: ForgeSource;
let rwx: RwxSource;
let jira: JiraSource | undefined;
let tray: TrayController;
let popover: Popover;
let timer: NodeJS.Timeout | undefined;
let web: Server | undefined;
/** Shared handler surface: the web API serves it, and new IPC delegates to it. */
let webHandlers: WebHandlers | undefined;

const log = (msg: string): void => {
  console.log(`[mr-radar] ${new Date().toISOString()} ${msg}`);
};

const main = async (): Promise<void> => {
  // Must run before any glab/rwx subprocess, or a Finder-launched .app can't
  // find them on its bare PATH.
  fixPath();
  db = new Db(DB_PATH);
  forge = createForge(await resolveForgeName(config, db));
  rwx = new RwxSource();
  await refreshJira();

  popover = new Popover(() => pushToRenderer());
  tray = new TrayController({
    onToggle: togglePause,
    onPollNow: () => void runCycle('manual'),
    onOpen: () => popover.open(trayHandle()),
    onSettings: () => popover.open(trayHandle(), { showSettings: true }),
    onRevealConfig: () => shell.showItemInFolder(CONFIG_PATH),
    onMarkAllRead: markAllRead,
    onTestNotification: testNotification,
    onNotificationSettings: openNotificationSettings,
    onQuit: () => app.quit(),
  });
  tray.init();
  webHandlers = makeWebHandlers({
    state,
    db,
    rwx,
    log,
    mode: 'tray',
    getConfig: () => config,
    setConfig: (c) => {
      config = c;
    },
    getForge: () => forge,
    setForge: (f) => {
      forge = f;
    },
    getJira: () => jira,
    reconnectJira: () => refreshJira(),
    requestCycle: () => {
      state.schedule = { ...state.schedule, quietCycles: 0 };
      // Re-arm the timer under the (possibly new) config even when a poll
      // is in flight — same order as the IPC ui:save-settings path.
      scheduleNext();
      void runCycle('manual');
    },
    togglePause,
    onStateChanged: () => {
      tray.update(state);
      pushToRenderer();
    },
    openUi: () => popover.open(trayHandle()),
  });
  registerIpc();
  registerPowerMonitor();
  // The alert badge icon's polarity depends on the menu bar theme, so re-render
  // the tray when the system appearance changes.
  nativeTheme.on('updated', () => tray.update(state));

  // The same localhost API the poller serves, so local clients (browser tab,
  // radar CLI, MCP server) work regardless of which shell is running.
  if (config.web.enabled) {
    web = startWebServer({
      port: config.web.port,
      rendererDir: join(__dirname, '..', 'renderer'),
      iconPath: ICON_PATH,
      log,
      mode: 'tray',
      handlers: webHandlers,
    });
  }

  tray.update(state);
  await runCycle('startup');
}

/** macOS Ventura+ deep link to the Notifications settings pane. */
const NOTIFICATION_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Notifications-Settings.extension';

const openNotificationSettings = (): void => {
  void shell.openExternal(NOTIFICATION_SETTINGS_URL);
};

/**
 * Fire a test banner, then explain what to expect — because macOS silently
 * drops notifications from an app it hasn't authorized, so a no-op looks like a
 * broken button. The dialog names the actual cause (dev build vs. permission)
 * and offers to jump straight to the settings pane.
 */
const testNotification = (): void => {
  const method = sendTestNotification(config.notifications.sound, config.notifications.method);
  // The system methods (osascript / terminal-notifier) are pre-signed and always
  // deliver, so they don't depend on the app appearing in Notification settings.
  // Only the native path needs that registration, which an ad-hoc build may lack.
  const detail =
    method === null
      ? 'Notifications are not supported on this platform.'
      : method === 'osascript'
        ? 'Sent via osascript — you should see a banner now. For click-to-open and the MR Radar icon, set notifications.method to "terminal-notifier" — but only after security approves it in ThreatLocker, or each send pops an Application Blocked banner.'
        : method === 'terminal-notifier'
          ? 'Sent via terminal-notifier — you should see a banner now, and clicking it opens the MR. If an "Application Blocked" banner appeared instead, ThreatLocker blocks it; delivery fell back to osascript.'
          : 'Sent via the native path. If you did NOT see it, an ad-hoc-signed app often fails to register with macOS — use "auto" (osascript) for reliable delivery.';
  const buttons = method === 'native' ? ['OK', 'Open Notification settings'] : ['OK'];
  void dialog
    .showMessageBox({
      type: method ? 'info' : 'warning',
      title: 'Test notification',
      message: method ? `Test notification sent (${method})` : 'Notifications unavailable',
      detail,
      buttons,
      defaultId: 0,
      cancelId: 0,
    })
    .then(({ response }) => {
      if (method === 'native' && response === 1) openNotificationSettings();
    });
};

/** The Jira token can be added while the app runs; pick it up without a restart. */
const refreshJira = async (): Promise<void> => {
  const token = await readJiraToken();
  jira =
    config.jira.baseUrl && config.jira.email && token
      ? new JiraSource(config.jira.baseUrl, config.jira.email, token)
      : undefined;
  state.jiraConfigured = jira !== undefined;
  state.jiraEmail = config.jira.email || undefined;
  if (!jira) {
    const why = !config.jira.baseUrl
      ? 'Atlassian URL not set — add it in Settings → Jira'
      : config.jira.email
        ? 'no Jira token stored — paste one in the popover or run `yarn jira:token`'
        : 'Jira email not set — add it in Settings → Jira, then connect a token';
    log(`jira not configured (${why}); MR scope will use the cached ticket set`);
  }
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

const runCycle = async (reason: 'startup' | 'manual' | 'timer'): Promise<void> => {
  const paused = pausedBecause(state.schedule, config, new Date());
  state.pausedReason = paused;

  // A manual "Poll now" overrides an automatic pause but never a user pause.
  const skip = paused !== undefined && !(reason === 'manual' && paused !== 'user');
  if (skip) {
    log(`skipping cycle (${paused})`);
    tray.update(state);
    pushToRenderer();
    scheduleNext();
    return;
  }

  if (state.polling) return;
  state.polling = true;
  tray.update(state);
  pushToRenderer();

  try {
    const result = await pollOnce({
      db,
      config,
      forge,
      rwx,
      ...(jira ? { jira } : {}),
      log: (m) => log(m),
    });

    state.snapshot = result.snapshot;
    state.lastPollAt = result.snapshot.at;
    state.lastError = undefined;
    state.schedule = afterCycle(state.schedule, result.events.length);

    if (result.events.length > 0) {
      state.unread = dedupeUnread([...result.events, ...state.unread]);
      const shown = notify(result.events, {
        enabled: config.notifications.enabled,
        sound: config.notifications.sound,
        method: config.notifications.method,
        onOpenPopover: () => popover.open(trayHandle()),
        onHighlight: (mrKey) => {
          state.highlight = { key: mrKey, at: new Date().toISOString() };
          popover.open(trayHandle());
          pushToRenderer();
        },
        // terminal-notifier click-through goes via our own web API.
        webPort: config.web.enabled ? config.web.port : undefined,
        iconPath: ICON_PATH,
      });
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
    tray.update(state);
    pushToRenderer();
    scheduleNext();
  }
}

const scheduleNext = (): void => {
  if (timer) clearTimeout(timer);
  const seconds = nextIntervalSeconds(state.schedule, config);
  state.nextPollAt = new Date(Date.now() + seconds * 1000).toISOString();
  timer = setTimeout(() => void runCycle('timer'), seconds * 1000);
  // Don't let a pending poll hold the process open during quit.
  timer.unref?.();
}

// ---------------------------------------------------------------------------
// State changes
// ---------------------------------------------------------------------------

const togglePause = (): void => {
  state.schedule = { ...state.schedule, enabled: !state.schedule.enabled };
  state.pausedReason = pausedBecause(state.schedule, config, new Date());

  if (state.schedule.enabled) {
    log('resumed');
    // Reset the backoff ladder so resuming feels immediate.
    state.schedule = { ...state.schedule, quietCycles: 0 };
    void runCycle('manual');
    return;
  }

  log('paused by user');
  if (timer) clearTimeout(timer);
  timer = undefined;
  state.nextPollAt = undefined;
  tray.update(state);
  pushToRenderer();
}

const markAllRead = (): void => {
  state.unread = [];
  tray.update(state);
  pushToRenderer();
}

const pushToRenderer = (): void => {
  popover?.send('ui:snapshot', present(state, config.jira.activeStatuses, new Date(), config.git.updateStyle, config.statusSections, config.statusRules, config.slack, config.ui.tabCounts));
}

/**
 * The popover only needs the icon's rectangle to position itself, not the Tray
 * itself. Undefined falls back to the cursor's display.
 */
const trayHandle = (): Electron.Rectangle | undefined => {
  return tray?.bounds();
}

// ---------------------------------------------------------------------------
// Power and session gating
// ---------------------------------------------------------------------------

const registerPowerMonitor = (): void => {
  const set = (patch: Partial<typeof state.schedule>, why: string): void => {
    state.schedule = { ...state.schedule, ...patch };
    state.pausedReason = pausedBecause(state.schedule, config, new Date());
    log(why);
    tray.update(state);
    pushToRenderer();
  };

  // No point polling a sleeping or locked Mac.
  powerMonitor.on('suspend', () => set({ asleep: true }, 'system suspended'));
  powerMonitor.on('lock-screen', () => set({ locked: true }, 'screen locked'));

  powerMonitor.on('resume', () => {
    set({ asleep: false, quietCycles: 0 }, 'system resumed');
    void runCycle('timer');
  });
  powerMonitor.on('unlock-screen', () => {
    set({ locked: false, quietCycles: 0 }, 'screen unlocked');
    void runCycle('timer');
  });

  const readBattery = (): void => {
    const onBattery = powerMonitor.isOnBatteryPower();
    if (onBattery !== state.schedule.onBattery) {
      set({ onBattery }, onBattery ? 'on battery — slowing polls' : 'on AC power');
    }
  };
  powerMonitor.on('on-battery', readBattery);
  powerMonitor.on('on-ac', readBattery);
  readBattery();
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

const registerIpc = (): void => {
  ipcMain.handle('ui:snapshot', () => {
    // The renderer requesting its snapshot is the proof its listeners exist —
    // the safe moment to deliver a settings intent from the tray menu.
    if (popover.consumePendingShowSettings()) popover.send('ui:show-settings', undefined);
    return present(state, config.jira.activeStatuses, new Date(), config.git.updateStyle, config.statusSections, config.statusRules, config.slack, config.ui.tabCounts);
  });
  ipcMain.handle('ui:poll-now', () => void runCycle('manual'));
  ipcMain.handle('ui:toggle-pause', () => togglePause());
  ipcMain.handle('ui:mark-all-read', () => markAllRead());
  ipcMain.handle('ui:close', () => popover.close());

  ipcMain.handle('ui:mark-read', (_e, mrKey: unknown) => {
    if (typeof mrKey !== 'string') return;
    state.unread = state.unread.filter((ev) => ev.mrKey !== mrKey);
    tray.update(state);
    pushToRenderer();
  });

  ipcMain.handle('ui:open-url', (_e, url: unknown) => {
    // Only ever open our own GitLab/Jira/RWX links; never arbitrary schemes.
    if (typeof url === 'string') openExternalSafe(url);
  });

  ipcMain.handle('ui:start-run', async (_e, mrKey: unknown) => {
    if (typeof mrKey !== 'string') return { started: false, message: 'Bad request.' };
    const item = state.snapshot?.items.find((i) => i.key === mrKey);
    if (!item) return { started: false, message: 'That MR is no longer in scope.' };

    const result = await startRunFor({ db, config, rwx, log }, item);
    if (result.started) {
      // Flip the gate in the live snapshot RIGHT NOW — a poll cycle can take
      // a minute, and "I clicked and nothing changed" is worse than a flip
      // the next cycle merely confirms. `at` must move or the renderer's
      // listKey guard skips the rebuild that repaints the chip.
      item.testGate = { kind: 'in_progress', provider: 'rwx', ...(result.url ? { url: result.url } : {}) };
      if (state.snapshot) state.snapshot.at = new Date().toISOString();
      tray.update(state);
      pushToRenderer();
      // Then poll for real. scheduleNext() alone is not enough: on battery
      // the ladder pins to its slowest rung regardless of quiet-cycle resets.
      state.schedule = { ...state.schedule, quietCycles: 0 };
      void runCycle('manual');
    }
    return result;
  });

  ipcMain.handle('ui:set-jira-token', async (_e, token: unknown) => {
    if (typeof token !== 'string' || token.trim().length === 0) {
      return { ok: false, message: 'Enter a token.' };
    }
    if (!config.jira.baseUrl) {
      return { ok: false, message: 'Set the Atlassian URL in Settings → Jira first.' };
    }
    if (!config.jira.email) {
      return { ok: false, message: 'Set your Jira email in Settings → Jira first.' };
    }
    // Verify against Jira before storing, so a wrong paste fails here rather
    // than silently degrading every poll. Only a valid token is written.
    const probe = new JiraSource(config.jira.baseUrl, config.jira.email, token.trim());
    const check = await probe.verify();
    if (!check.ok) {
      return { ok: false, message: `Rejected by Jira: ${check.error ?? 'unauthorized'}` };
    }
    try {
      await writeJiraToken(token.trim());
    } catch (err) {
      return { ok: false, message: `Could not save to Keychain: ${msg(err)}` };
    }
    await refreshJira();
    state.schedule = { ...state.schedule, quietCycles: 0 };
    void runCycle('manual');
    tray.update(state);
    pushToRenderer();
    return { ok: true, message: 'Jira connected.' };
  });

  ipcMain.handle('ui:list-fix-versions', async (_e, ticketKey: unknown) => {
    if (typeof ticketKey !== 'string') return { ok: false, message: 'Bad request.' };
    if (!jira) return { ok: false, message: 'Jira is not connected.' };
    try {
      const projectKey = ticketKey.split('-')[0] ?? '';
      const versions = await jira.projectVersions(projectKey);
      return { ok: true, versions };
    } catch (err) {
      return { ok: false, message: msg(err) };
    }
  });

  ipcMain.handle('ui:set-fix-version', async (_e, ticketKey: unknown, versionId: unknown) => {
    if (typeof ticketKey !== 'string' || typeof versionId !== 'string') {
      return { ok: false, message: 'Bad request.' };
    }
    if (!jira) return { ok: false, message: 'Jira is not connected.' };
    try {
      await jira.setFixVersion(ticketKey, versionId);
      // Re-poll so the ticket moves out of its 'Needs fix version' section.
      state.schedule = { ...state.schedule, quietCycles: 0 };
      void runCycle('manual');
      return { ok: true, message: `Fix version set on ${ticketKey}.` };
    } catch (err) {
      return { ok: false, message: msg(err) };
    }
  });

  ipcMain.handle('ui:set-ignored', (_e, mrKey: unknown, ignored: unknown) => {
    if (typeof mrKey !== 'string' || typeof ignored !== 'boolean') {
      return { ok: false, message: 'Bad request.' };
    }
    return webHandlers?.setIgnored(mrKey, ignored) ?? { ok: false, message: 'Not ready yet.' };
  });

  /**
   * The check AND the copy, in one main-process round trip.
   *
   * The renderer used to do the copy after awaiting this: click → await a
   * multi-second re-check → call back into `ui:copy-text`. The popover does not
   * reliably survive that gap (it is destroyed on close, and the wait is long
   * enough to lose focus), and when its JS context dies the pending promise
   * dies with it — no copy, no error, and a clipboard still holding whatever
   * was there before. Proven by the log: the refresh line appears, the
   * copy-text line never does.
   *
   * Writing the pasteboard here removes the renderer from the critical path
   * entirely: by the time this resolves the message IS copied, and the button
   * only has to report it. `copied` is verified against a read-back, so the UI
   * can never claim success over an unchanged clipboard.
   */
  ipcMain.handle('ui:check-review-ready', async (_e, mrKey: unknown) => {
    if (typeof mrKey !== 'string') return { ok: false, message: 'Bad request.' };
    // Keep the popover alive across the check so its result is actually seen.
    popover.setBusy(true);
    const result = await (async () => {
      try {
        return (await webHandlers?.checkReviewReady(mrKey)) ?? { ok: false, message: 'Not ready yet.' };
      } finally {
        popover.setBusy(false);
      }
    })();
    if (result.ok && result.eligible && result.message) {
      const copied = writeClipboard(result.message, result.messageHtml);
      log(`clipboard: ${copied ? 'copied' : 'FAILED to copy'} the ${mrKey} announcement (${result.message.length} chars)`);
      return { ...result, copied };
    }
    return result;
  });

  /**
   * Write and then VERIFY. A copy that silently no-ops is worse than a failed
   * one: the button says "Copied ✓" and the user pastes whatever was on the
   * pasteboard before. So read the text flavor back, fall back to a plain
   * write if the rich write did not stick, and report what actually happened
   * — the button's success state is only as honest as this return value.
   */
  ipcMain.handle('ui:copy-text', (_e, text: unknown, html: unknown) => {
    if (typeof text !== 'string' || !text) return false;
    return writeClipboard(text, typeof html === 'string' ? html : undefined);
  });

  ipcMain.handle('ui:become-reviewer', async (_e, mrKey: unknown) => {
    if (typeof mrKey !== 'string') return { ok: false, message: 'Bad request.' };
    const item = state.snapshot?.items.find((i) => i.key === mrKey);
    if (!item) return { ok: false, message: 'That MR is no longer in scope.' };
    try {
      const userId = config.gitlab.userId ?? (await forge.currentUser()).id;
      await forge.addReviewer(item.projectId, item.iid, userId);
      state.schedule = { ...state.schedule, quietCycles: 0 };
      void runCycle('manual'); // the row migrates to My reviews next cycle
      return { ok: true, message: `You are now a reviewer on ${mrKey}.` };
    } catch (err) {
      return { ok: false, message: msg(err) };
    }
  });

  ipcMain.handle('ui:list-statuses', () => ({ ok: true, statuses: knownStatuses(db, config) }));

  ipcMain.handle('ui:list-owner-fields', async () => {
    return (await webHandlers?.listOwnerFields()) ?? { ok: false, message: 'Not ready yet.' };
  });

  ipcMain.handle('ui:export-settings', () => ({
    ok: true,
    settings: shareableSettings(readRawConfig(CONFIG_PATH)),
  }));

  ipcMain.handle('ui:import-settings', async (_e, shared: unknown) => {
    if (!shared || typeof shared !== 'object' || Array.isArray(shared)) {
      return { ok: false, message: 'Not a settings object.' };
    }
    try {
      const merged = mergeSharedSettings(readRawConfig(CONFIG_PATH), shared as Record<string, unknown>);
      writeRawConfig(merged, CONFIG_PATH); // validates before persisting
      config = loadConfig(CONFIG_PATH);
      state.schedule = { ...state.schedule, quietCycles: 0 };
      void runCycle('manual');
      return { ok: true, message: 'Settings imported. Your email and tokens were kept.' };
    } catch (err) {
      return { ok: false, message: `Import rejected: ${msg(err)}` };
    }
  });

  ipcMain.handle('ui:get-settings', () => toEditable(config, knownRepos(db, config), forge.name));

  ipcMain.handle('ui:get-login-item', () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle('ui:set-login-item', (_e, enabled: unknown) => {
    const openAtLogin = enabled === true;
    // On a packaged .app this registers the bundle with the OS login items; from
    // a dev run it's best-effort and may not persist, which is fine.
    app.setLoginItemSettings({ openAtLogin });
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle('ui:reveal-config', () => shell.showItemInFolder(CONFIG_PATH));

  ipcMain.handle('ui:save-settings', async (_e, incoming: unknown) => {
    const s = incoming as EditableSettings;
    const invalid = validateEditable(s);
    if (invalid) return { ok: false, message: invalid };
    try {
      const raw = applyEditable(readRawConfig(CONFIG_PATH), s);
      writeRawConfig(raw, CONFIG_PATH); // validates the merged result too
      config = loadConfig(CONFIG_PATH);
      // The forge choice may have changed; swap the source before polling.
      const forgeName = await resolveForgeName(config, db);
      if (forgeName !== forge.name) {
        forge = createForge(forgeName);
        log(`forge switched to ${forgeName}`);
      }
      await refreshJira(); // email may have changed
      state.schedule = { ...state.schedule, quietCycles: 0 };
      scheduleNext();
      void runCycle('manual');
      tray.update(state);
      pushToRenderer();
      return { ok: true, message: 'Settings saved.' };
    } catch (err) {
      return { ok: false, message: `Could not save: ${msg(err)}` };
    }
  });
}

/**
 * Write and then VERIFY. A copy that silently no-ops is worse than a failed
 * one: the button says "Copied ✓" and the user pastes whatever was on the
 * pasteboard before. Read the text flavor back, fall back to a plain write if
 * the rich one did not stick, and return what actually happened.
 */
const writeClipboard = (text: string, html?: string): boolean => {
  try {
    if (html) clipboard.write({ text, html });
    else clipboard.writeText(text);
    if (clipboard.readText() === text) return true;
    clipboard.writeText(text); // rich write did not land — plain beats nothing
    const ok = clipboard.readText() === text;
    if (!ok) log('clipboard: neither rich nor plain write stuck');
    return ok;
  } catch (err) {
    log(`clipboard: write failed: ${msg(err)}`);
    return false;
  }
};

const msg = (err: unknown): string => {
  return err instanceof Error ? err.message : String(err);
}

app.on('window-all-closed', () => {
  // Expected — the popover is destroyed on close. Staying alive is the point.
});

app.on('before-quit', () => {
  if (timer) clearTimeout(timer);
  web?.close(); // also removes the web-token file (pid claim-check)
  tray?.destroy();
  try {
    db?.close();
  } catch {
    /* closing a closed db is fine */
  }
});

// Bootstrap last, once every top-level `const` (main, handlers) is initialized.
// A menu bar utility has no business in the Dock or the app switcher.
if (process.platform === 'darwin') app.dock?.hide();

// A second instance would double every notification and fight over the DB.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => popover?.open(undefined));
  void app.whenReady().then(main);
}
