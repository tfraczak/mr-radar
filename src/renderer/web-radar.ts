/**
 * Web shim for `window.radar` — the poller's localhost status page.
 *
 * The popover renderer talks to `window.radar`, normally provided by the
 * Electron preload over IPC. On a ThreatLocker-managed Mac the Electron app is
 * blocked, so the headless poller serves this same UI over 127.0.0.1 and this
 * file implements the identical surface over HTTP instead.
 *
 * Deliberately a CLASSIC script (no imports/exports): it must run before the
 * renderer module evaluates, and classic scripts always execute ahead of
 * deferred module scripts. Types come from the renderer's global declaration.
 *
 * Auth: every API call carries the per-process token embedded in the page by
 * the server, which also enforces a localhost Host header — together blocking
 * CSRF and DNS-rebinding from non-local origins.
 */

type RadarApiT = Window['radar'];
type SnapshotT = Awaited<ReturnType<RadarApiT['getSnapshot']>>;

const radarToken =
  document.querySelector('meta[name="radar-token"]')?.getAttribute('content') ?? '';

const api = async <T>(path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'x-radar-token': radarToken,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
};

let lastSnapshot: SnapshotT | undefined;
const listeners = new Set<(s: SnapshotT) => void>();

const refresh = async (): Promise<void> => {
  try {
    const snap = await api<SnapshotT>('snapshot');
    lastSnapshot = snap;
    for (const fn of listeners) fn(snap);
  } catch {
    // Poller restarting or asleep — keep showing the last snapshot.
  }
};

// The web page pulls (no IPC push): a light poll, plus an immediate refresh
// whenever the tab regains focus so it feels live when you switch to it.
setInterval(() => void refresh(), 5000);
window.addEventListener('focus', () => void refresh());

window.radar = {
  getSnapshot: async () => {
    if (lastSnapshot) return lastSnapshot;
    return api<SnapshotT>('snapshot');
  },
  onSnapshot: (fn) => {
    listeners.add(fn);
    void refresh();
    return () => listeners.delete(fn);
  },
  pollNow: async () => {
    await api('poll-now', {});
    void refresh();
  },
  togglePause: async () => {
    await api('toggle-pause', {});
    void refresh();
  },
  markAllRead: async () => {
    await api('mark-all-read', {});
    void refresh();
  },
  markRead: async (mrKey) => {
    await api('mark-read', { mrKey });
    void refresh();
  },
  openUrl: async (url) => {
    // In a real browser there is no shell to delegate to; enforce the same
    // https-only rule the Electron main process applies.
    if (/^https:\/\//.test(url)) window.open(url, '_blank', 'noopener');
  },
  startRun: async (mrKey) => {
    // The confirm lives shell-side by design (Electron shows a native dialog).
    const items = [
      ...(lastSnapshot?.groups ?? []),
      ...(lastSnapshot?.needsGroups ?? []),
      ...(lastSnapshot?.verificationGroups ?? []),
      ...(lastSnapshot?.doneGroups ?? []),
      ...(lastSnapshot?.otherGroups ?? []),
    ].flatMap((g) => g.items);
    const item = items.find((i) => i.key === mrKey);
    const what = item ? `${item.branch} @ ${item.headSha.slice(0, 8)}` : mrKey;
    const ok = window.confirm(
      `Start an RWX run for ${what}?\n\n` +
        'This creates a new run for that commit and consumes CI minutes. ' +
        'Any run already waiting for this commit stays waiting.',
    );
    if (!ok) return { started: false, message: 'Cancelled.' };
    const result = await api<{ started: boolean; message: string; url?: string }>('start-run', {
      mrKey,
    });
    void refresh();
    return result;
  },
  setJiraToken: (token) => api('jira-token', { token }),
  listFixVersions: (ticketKey) => api('fix-versions', { ticketKey }),
  listStatuses: () => api('statuses'),
  exportSettings: () => api('export-settings'),
  importSettings: async (shared) => {
    const result = await api<{ ok: boolean; message: string }>('import-settings', { shared });
    void refresh();
    return result;
  },
  becomeReviewer: async (mrKey) => {
    const result = await api<{ ok: boolean; message: string }>('become-reviewer', { mrKey });
    void refresh();
    return result;
  },
  setIgnored: async (mrKey, ignored) => {
    const result = await api<{ ok: boolean; message?: string }>('set-ignored', { mrKey, ignored });
    void refresh();
    return result;
  },
  checkReviewReady: async (mrKey) => {
    const result = await api<{ ok: boolean; eligible?: boolean; reasons?: string[]; message?: string }>(
      'review-ready',
      { mrKey },
    );
    void refresh(); // the check refreshed the item server-side; show it
    return result;
  },
  copyText: async (text, html) => {
    try {
      if (html && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([text], { type: 'text/plain' }),
            'text/html': new Blob([html], { type: 'text/html' }),
          }),
        ]);
        return true;
      }
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Rich write refused (permissions vary by browser) — plain is better
      // than nothing, and failing that the caller offers click-to-copy.
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    }
  },
  setFixVersion: async (ticketKey, versionId) => {
    const result = await api<{ ok: boolean; message: string }>('set-fix-version', {
      ticketKey,
      versionId,
    });
    void refresh();
    return result;
  },
  getSettings: () => api('settings'),
  saveSettings: async (settings) => {
    const result = await api<{ ok: boolean; message: string }>('settings', settings);
    void refresh();
    return result;
  },
  // Login items belong to the launchd agent, not this page.
  getLaunchAtLogin: async () => false,
  setLaunchAtLogin: async () => false,
  revealConfig: async () => {
    window.alert('Config lives at ~/.config/mr-radar/config.json');
  },
  onShowSettings: () => () => {},
  close: async () => {
    window.close();
  },
};
