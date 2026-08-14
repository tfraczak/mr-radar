import { contextBridge, ipcRenderer } from 'electron';
import type { EditableSettings, RadarApi, UiSnapshot, UiTab } from '../renderer/contract';

/**
 * The only bridge between the popover and the main process.
 *
 * Context isolation stays on and the renderer gets no Node access — it renders
 * data and sends intents, nothing more. Notably it cannot start a CI run
 * directly: `startRun` asks the main process, which is where the confirmation
 * dialog lives, so a compromised or buggy renderer can't spend CI minutes
 * silently.
 */
const api = {
  getSnapshot: (): Promise<UiSnapshot> => ipcRenderer.invoke('ui:snapshot'),
  onSnapshot: (fn: (snapshot: UiSnapshot) => void): (() => void) => {
    const handler = (_e: unknown, snapshot: UiSnapshot) => fn(snapshot);
    ipcRenderer.on('ui:snapshot', handler);
    return () => ipcRenderer.removeListener('ui:snapshot', handler);
  },
  pollNow: (): Promise<void> => ipcRenderer.invoke('ui:poll-now'),
  togglePause: (): Promise<void> => ipcRenderer.invoke('ui:toggle-pause'),
  markAllRead: (): Promise<void> => ipcRenderer.invoke('ui:mark-all-read'),
  markRead: (mrKey: string): Promise<void> => ipcRenderer.invoke('ui:mark-read', mrKey),
  openUrl: (url: string): Promise<void> => ipcRenderer.invoke('ui:open-url', url),
  /** Resolves to true only if the user confirmed and the run actually started. */
  startRun: (mrKey: string): Promise<{ started: boolean; message: string; url?: string }> =>
    ipcRenderer.invoke('ui:start-run', mrKey),
  setJiraToken: (token: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('ui:set-jira-token', token),
  listFixVersions: (
    ticketKey: string,
  ): Promise<{ ok: boolean; versions?: { id: string; name: string }[]; message?: string }> =>
    ipcRenderer.invoke('ui:list-fix-versions', ticketKey),
  setFixVersion: (ticketKey: string, versionId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('ui:set-fix-version', ticketKey, versionId),
  becomeReviewer: (mrKey: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('ui:become-reviewer', mrKey),
  setIgnored: (mrKey: string, ignored: boolean): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('ui:set-ignored', mrKey, ignored),
  checkReviewReady: (
    mrKey: string,
  ): Promise<{
    ok: boolean;
    eligible?: boolean;
    reasons?: string[];
    message?: string;
    messageHtml?: string;
    copied?: boolean;
  }> => ipcRenderer.invoke('ui:check-review-ready', mrKey),
  copyText: (text: string, html?: string): Promise<boolean> =>
    ipcRenderer.invoke('ui:copy-text', text, html),
  listStatuses: (): Promise<{ ok: boolean; statuses?: string[]; message?: string }> =>
    ipcRenderer.invoke('ui:list-statuses'),
  listOwnerFields: (): Promise<{ ok: boolean; fields?: { clause: string; label: string }[]; message?: string }> =>
    ipcRenderer.invoke('ui:list-owner-fields'),
  exportSettings: (): Promise<{ ok: boolean; settings?: Record<string, unknown>; message?: string }> =>
    ipcRenderer.invoke('ui:export-settings'),
  importSettings: (shared: Record<string, unknown>): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('ui:import-settings', shared),
  getSettings: (): Promise<EditableSettings> => ipcRenderer.invoke('ui:get-settings'),
  saveSettings: (settings: EditableSettings): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('ui:save-settings', settings),
  getLaunchAtLogin: (): Promise<boolean> => ipcRenderer.invoke('ui:get-login-item'),
  setLaunchAtLogin: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('ui:set-login-item', enabled),
  revealConfig: (): Promise<void> => ipcRenderer.invoke('ui:reveal-config'),
  onShowSettings: (fn: () => void): (() => void) => {
    const handler = (): void => fn();
    ipcRenderer.on('ui:show-settings', handler);
    return () => ipcRenderer.removeListener('ui:show-settings', handler);
  },
  onShowTab: (fn: (tab: UiTab) => void): (() => void) => {
    const handler = (_e: unknown, tab: UiTab): void => fn(tab);
    ipcRenderer.on('ui:show-tab', handler);
    return () => ipcRenderer.removeListener('ui:show-tab', handler);
  },
  close: (): Promise<void> => ipcRenderer.invoke('ui:close'),
};

// Compile-time check that the exposed surface matches the shared contract.
const _typecheck: RadarApi = api;
void _typecheck;

contextBridge.exposeInMainWorld('radar', api);
