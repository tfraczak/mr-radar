import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_PATH, loadConfig, readRawConfig, writeRawConfig, type Config } from '../core/config';
import { summarizeThreads, unresolvedCount } from '../core/correlate';
import type { Db } from '../core/db';
import { writeJiraToken } from '../core/secrets';
import { createForge, resolveForgeName, type ForgeSource } from '../core/sources/forge';
import { JiraSource } from '../core/sources/jira';
import type { RwxSource } from '../core/sources/rwx';
import { executeTrigger, inFlightRun, planTrigger } from '../core/trigger';
import type { EditableSettings } from '../renderer/contract';
import type { EventView, HealthInfo, ItemDetail, WebHandlers } from '../web-server';
import { present } from './present';
import {
  applyEditable,
  knownRepos,
  knownStatuses,
  mergeSharedSettings,
  shareableSettings,
  toEditable,
  validateEditable,
} from './settings';
import type { UiState } from './state';

/**
 * The web API's handler bodies, shared by both shells (tray and poller) so the
 * surface is implemented exactly once. Everything shell-specific — how a cycle
 * is requested, how pause flips, how the tray repaints — comes in through deps.
 *
 * This module must stay Electron-free: the poller imports it under plain node.
 */
export interface WebHandlerDeps {
  state: UiState;
  db: Db;
  rwx: RwxSource;
  log: (msg: string) => void;
  /** Which shell is serving; reported by /api/health. */
  mode: 'tray' | 'poller';
  getConfig: () => Config;
  setConfig: (c: Config) => void;
  getForge: () => ForgeSource;
  setForge: (f: ForgeSource) => void;
  getJira: () => JiraSource | undefined;
  /** Drop and re-establish the Jira connection (email or token changed). */
  reconnectJira: () => Promise<void>;
  /** Ask the shell for a poll cycle soon (each shell keeps its own semantics). */
  requestCycle: () => void;
  /** The shell's pause/resume flip, including its own timers and UI refresh. */
  togglePause: () => void;
  /** Called after direct state mutations so the tray can repaint icon+popover. */
  onStateChanged: () => void;
}

/** Read once; the version only changes with a rebuild, which restarts us. */
const appVersion = (): string => {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
};

export const makeWebHandlers = (deps: WebHandlerDeps): WebHandlers => {
  const { state, db, rwx, log } = deps;
  const cfg = deps.getConfig;
  const version = appVersion();

  return {
    getSnapshot: () =>
      present(state, cfg().jira.activeStatuses, new Date(), cfg().git.updateStyle, cfg().statusSections, cfg().statusRules),

    getItemDetail: async (mrKey: string) => {
      const snapshot = state.snapshot;
      if (!snapshot) {
        return { ok: false, message: 'MR Radar has not completed a poll yet — try again shortly.' };
      }
      const item = snapshot.items.find((i) => i.key === mrKey);
      if (!item) return { ok: false, message: 'That MR is no longer in scope.' };
      // Cycles skip the discussions fetch for unchanged MRs (unresolvedFallback
      // keeps the count right), so thread bodies may be absent from memory.
      // An API client asking for one MR is worth one on-demand fetch; cache it
      // on the item so repeats are free until the next cycle rebuilds it.
      if (!item.threads) {
        try {
          item.threads = summarizeThreads(
            await deps.getForge().discussions(item.projectPath, item.iid),
          );
        } catch (err) {
          log(`item-detail: discussions fetch failed for ${mrKey}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const detail: ItemDetail = {
        key: item.key,
        projectPath: item.projectPath,
        iid: item.iid,
        branch: item.branch,
        targetBranch: item.targetBranch,
        title: item.title,
        url: item.webUrl,
        headSha: item.headSha,
        draft: item.draft,
        hasConflicts: item.hasConflicts,
        reason: item.reason,
        ...(item.participation ? { participation: item.participation } : {}),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        ...(item.ticket ? { ticket: item.ticket } : {}),
        ...(item.approvals ? { approvals: item.approvals } : {}),
        unresolved: item.threads ? unresolvedCount(item.threads) : (item.unresolvedFallback ?? 0),
        ...(item.testGate ? { testGate: item.testGate } : {}),
        ...(item.checks
          ? { checks: item.checks.map((c) => ({ ...c, stale: c.sha !== item.headSha })) }
          : {}),
        ...(item.threads ? { threads: item.threads } : {}),
        dataAsOf: snapshot.at,
      };
      return { ok: true, item: detail };
    },

    getEvents: (limit: number, mrKey?: string): EventView[] => {
      const clamped = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
      return db.recentEvents(clamped, mrKey).map((r) => {
        let payload: unknown = r.payload;
        try {
          payload = JSON.parse(r.payload);
        } catch {
          /* keep the raw string for a malformed row */
        }
        return {
          id: r.id,
          at: r.at,
          type: r.type,
          mrKey: r.mr_key,
          ...(r.branch ? { branch: r.branch } : {}),
          ...(r.provider ? { provider: r.provider } : {}),
          notified: r.notified === 1,
          payload,
        };
      });
    },

    health: (): HealthInfo => ({
      ok: true,
      app: 'mr-radar',
      version,
      mode: deps.mode,
      pid: process.pid,
      polling: state.polling,
      enabled: state.schedule.enabled,
      ...(state.pausedReason ? { paused: state.pausedReason } : {}),
      ...(state.lastPollAt ? { lastPollAt: state.lastPollAt } : {}),
      ...(state.nextPollAt ? { nextPollAt: state.nextPollAt } : {}),
      // No lastError here: this endpoint is tokenless and error text can quote
      // project paths. The tokened snapshot carries it.
    }),

    setPolling: (enabled: boolean) => {
      if (state.schedule.enabled === enabled) return { enabled, changed: false };
      deps.togglePause();
      return { enabled: state.schedule.enabled, changed: true };
    },

    pollNow: () => deps.requestCycle(),

    togglePause: () => deps.togglePause(),

    markAllRead: () => {
      state.unread = [];
      deps.onStateChanged();
    },

    markRead: (mrKey: string) => {
      state.unread = state.unread.filter((e) => e.mrKey !== mrKey);
      deps.onStateChanged();
    },

    startRun: async (mrKey: string) => {
      // The caller (web page, CLI, or an agent's permission prompt) already
      // confirmed with the user; validate and execute.
      const item = state.snapshot?.items.find((i) => i.key === mrKey);
      if (!item) return { started: false, message: 'That MR is no longer in scope.' };
      const plan = planTrigger(cfg(), item);
      if (typeof plan === 'string') return { started: false, message: plan };
      const inFlight = inFlightRun(db, item);
      if (inFlight) {
        return {
          started: true,
          message: 'A run for this commit is already in flight.',
          ...(inFlight.url ? { url: inFlight.url } : {}),
        };
      }
      const result = await executeTrigger({ db, config: cfg(), rwx, log }, item, plan);
      if (result.started) {
        // Optimistic flip so the next snapshot fetch already shows the run in
        // flight; the requested cycle confirms it.
        item.testGate = { kind: 'in_progress', provider: 'rwx', ...(result.url ? { url: result.url } : {}) };
        if (state.snapshot) state.snapshot.at = new Date().toISOString();
        deps.onStateChanged();
        deps.requestCycle();
      }
      return result;
    },

    getSettings: () => toEditable(cfg(), knownRepos(db, cfg()), deps.getForge().name),

    saveSettings: async (s: EditableSettings) => {
      const invalid = validateEditable(s);
      if (invalid) return { ok: false, message: invalid };
      try {
        const raw = applyEditable(readRawConfig(CONFIG_PATH), s);
        writeRawConfig(raw, CONFIG_PATH); // validates the merged result too
        deps.setConfig(loadConfig(CONFIG_PATH));
        // The forge choice may have changed; swap the source before polling.
        const forgeName = await resolveForgeName(cfg(), db);
        if (forgeName !== deps.getForge().name) {
          deps.setForge(createForge(forgeName));
          log(`forge switched to ${forgeName}`);
        }
        await deps.reconnectJira(); // email may have changed
        deps.requestCycle();
        deps.onStateChanged();
        return { ok: true, message: 'Settings saved.' };
      } catch (err) {
        return { ok: false, message: `Could not save: ${err instanceof Error ? err.message : String(err)}` };
      }
    },

    setJiraToken: async (token: string) => {
      if (!token.trim()) return { ok: false, message: 'Enter a token.' };
      if (!cfg().jira.baseUrl) return { ok: false, message: 'Set the Atlassian URL in Settings → Jira first.' };
      if (!cfg().jira.email) return { ok: false, message: 'Set your Jira email in Settings → Jira first.' };
      // Verify against Jira before storing, so a wrong paste fails here rather
      // than silently degrading every poll. Only a valid token is written.
      const probe = new JiraSource(cfg().jira.baseUrl, cfg().jira.email, token.trim());
      const check = await probe.verify();
      if (!check.ok) return { ok: false, message: `Rejected by Jira: ${check.error ?? 'unauthorized'}` };
      try {
        await writeJiraToken(token.trim());
      } catch (err) {
        return { ok: false, message: `Could not save to Keychain: ${err instanceof Error ? err.message : String(err)}` };
      }
      await deps.reconnectJira();
      deps.requestCycle();
      deps.onStateChanged();
      return { ok: true, message: 'Jira connected.' };
    },

    listFixVersions: async (ticketKey: string) => {
      const jira = deps.getJira();
      if (!jira) return { ok: false, message: 'Jira is not connected.' };
      try {
        const versions = await jira.projectVersions(ticketKey.split('-')[0] ?? '');
        return { ok: true, versions };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    setFixVersion: async (ticketKey: string, versionId: string) => {
      const jira = deps.getJira();
      if (!jira) return { ok: false, message: 'Jira is not connected.' };
      try {
        await jira.setFixVersion(ticketKey, versionId);
        deps.requestCycle(); // move the ticket out of its 'Needs fix version' section
        return { ok: true, message: `Fix version set on ${ticketKey}.` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    becomeReviewer: async (mrKey: string) => {
      const item = state.snapshot?.items.find((i) => i.key === mrKey);
      if (!item) return { ok: false, message: 'That MR is no longer in scope.' };
      try {
        const userId = cfg().gitlab.userId ?? (await deps.getForge().currentUser()).id;
        await deps.getForge().addReviewer(item.projectId, item.iid, userId);
        deps.requestCycle(); // the row migrates to My reviews next cycle
        return { ok: true, message: `You are now a reviewer on ${mrKey}.` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    listStatuses: async () => ({ ok: true, statuses: knownStatuses(db, cfg()) }),

    exportSettings: async () => ({ ok: true, settings: shareableSettings(readRawConfig(CONFIG_PATH)) }),

    importSettings: async (shared: Record<string, unknown>) => {
      try {
        const merged = mergeSharedSettings(readRawConfig(CONFIG_PATH), shared);
        writeRawConfig(merged, CONFIG_PATH); // validates before persisting
        deps.setConfig(loadConfig(CONFIG_PATH));
        deps.requestCycle();
        return { ok: true, message: 'Settings imported. Your email and tokens were kept.' };
      } catch (err) {
        return { ok: false, message: `Import rejected: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
};
