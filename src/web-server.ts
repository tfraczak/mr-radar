import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { STATE_DIR } from './core/config';
import type { EditableSettings, UiSnapshot } from './renderer/contract';
import type { Check, JiraTicket, TestGate, ThreadSummary, WatchItem } from './core/types';
import type { TriggerResult } from './core/trigger';

/**
 * The poller's localhost status page.
 *
 * Serves the popover renderer (dist/renderer) to a normal browser with
 * web-radar.js standing in for the Electron preload. This is the MR Radar UI
 * on a ThreatLocker-managed Mac: plain HTML served by the already-running
 * `node` poller — nothing new to execute, nothing for app control to block.
 *
 * Security posture (localhost single-user, but browsers are promiscuous):
 *  - binds 127.0.0.1 only — never reachable off the machine;
 *  - every request must carry a localhost Host header, killing DNS rebinding;
 *  - every /api call must carry a per-process random token, which only the
 *    served page knows — cross-origin pages can't read it (no CORS headers)
 *    and can't send it (custom headers require a preflight we never answer);
 *  - static paths are an allowlist, so there is no traversal surface.
 */

/**
 * One MR straight from the live snapshot — the fields `present()` flattens
 * away (thread bodies, the raw test gate) preserved verbatim for API clients.
 */
export interface ItemDetail {
  key: string;
  projectPath: string;
  iid: number;
  branch: string;
  targetBranch: string;
  title: string;
  url: string;
  headSha: string;
  draft: boolean;
  hasConflicts: boolean;
  reason: WatchItem['reason'];
  participation?: WatchItem['participation'];
  createdAt: string;
  updatedAt: string;
  ticket?: JiraTicket;
  approvals?: WatchItem['approvals'];
  unresolved: number;
  testGate?: TestGate;
  checks?: (Check & { stale: boolean })[];
  threads?: ThreadSummary[];
  /** The snapshot timestamp this detail was read from. */
  dataAsOf: string;
}

/** One row of durable event history, payload pre-parsed for clients. */
export interface EventView {
  id: number;
  at: string;
  type: string;
  mrKey: string;
  branch?: string;
  provider?: string;
  notified: boolean;
  payload: unknown;
}

/**
 * Unauthenticated liveness probe — no MR or ticket data, ever. That rule is
 * why there is no lastError here: cycle-failure text can quote project paths;
 * the tokened /api/snapshot carries it instead.
 */
export interface HealthInfo {
  ok: true;
  app: 'mr-radar';
  version: string;
  mode: 'tray' | 'poller';
  pid: number;
  polling: boolean;
  enabled: boolean;
  paused?: string;
  lastPollAt?: string;
  nextPollAt?: string;
}

export interface WebHandlers {
  getSnapshot: () => UiSnapshot;
  getItemDetail: (mrKey: string) => Promise<{ ok: boolean; message?: string; item?: ItemDetail }>;
  getEvents: (limit: number, mrKey?: string) => EventView[];
  health: () => HealthInfo;
  setPolling: (enabled: boolean) => { enabled: boolean; changed: boolean };
  /** Bring the UI to the user and flash mrKey's row (notification click-through). */
  focusItem: (mrKey?: string) => { ok: boolean };
  /** Manual per-MR ignore; un-ignoring a rule-ignored MR pins it visible. */
  setIgnored: (mrKey: string, ignored: boolean) => { ok: boolean; message?: string };
  /** Fresh single-MR re-check for the Copy-for-Slack flow: re-fetches the MR,
   *  its ticket, and its CI, then reports announce-eligibility with reasons. */
  checkReviewReady: (
    mrKey: string,
  ) => Promise<{ ok: boolean; eligible?: boolean; reasons?: string[]; message?: string }>;
  pollNow: () => void;
  togglePause: () => void;
  markAllRead: () => void;
  markRead: (mrKey: string) => void;
  startRun: (mrKey: string) => Promise<TriggerResult>;
  getSettings: () => EditableSettings;
  saveSettings: (s: EditableSettings) => Promise<{ ok: boolean; message: string }>;
  setJiraToken: (token: string) => Promise<{ ok: boolean; message: string }>;
  listFixVersions: (
    ticketKey: string,
  ) => Promise<{ ok: boolean; versions?: { id: string; name: string }[]; message?: string }>;
  setFixVersion: (ticketKey: string, versionId: string) => Promise<{ ok: boolean; message: string }>;
  becomeReviewer: (mrKey: string) => Promise<{ ok: boolean; message: string }>;
  listStatuses: () => Promise<{ ok: boolean; statuses?: string[]; message?: string }>;
  exportSettings: () => Promise<{ ok: boolean; settings?: Record<string, unknown>; message?: string }>;
  importSettings: (shared: Record<string, unknown>) => Promise<{ ok: boolean; message: string }>;
}

export interface WebServerOptions {
  port: number;
  /** dist/renderer — index.html, styles.css, renderer.js, contract.js, web-radar.js. */
  rendererDir: string;
  /** PNG used as the tab icon, if present. */
  iconPath?: string | undefined;
  log: (msg: string) => void;
  handlers: WebHandlers;
  /** Which shell is serving; recorded in the token file and /api/health. */
  mode: 'tray' | 'poller';
  /** Override for tests; defaults to `<STATE_DIR>/web-token.json`. */
  tokenFilePath?: string | undefined;
}

const STATIC_FILES: Record<string, string> = {
  '/styles.css': 'text/css',
  '/renderer.js': 'text/javascript',
  '/contract.js': 'text/javascript',
  '/web-radar.js': 'text/javascript',
  '/ui.js': 'text/javascript',
};

/** Reject any Host header that isn't this machine talking to this port. */
export const hostAllowed = (host: string | undefined, port: number): boolean => {
  if (!host) return false;
  return (
    host === `127.0.0.1:${port}` ||
    host === `localhost:${port}` ||
    host === `[::1]:${port}` ||
    // Default-port forms, in case a proxy strips :80-style suffixes.
    host === '127.0.0.1' ||
    host === 'localhost'
  );
};

/**
 * Prepare index.html for the browser: embed the API token, load the web shim
 * ahead of the renderer module, widen the CSP to allow same-origin fetch, and
 * give the tab the radar icon.
 */
export const injectShim = (html: string, token: string, withIcon: boolean): string => {
  return html
    .replace(
      /(content="default-src 'none';)/,
      `$1 connect-src 'self';`,
    )
    .replace(
      '</title>',
      `</title>\n    <meta name="radar-token" content="${token}" />` +
        (withIcon ? '\n    <link rel="icon" type="image/png" href="app-icon.png" />' : ''),
    )
    .replace(
      '<script type="module" src="renderer.js"></script>',
      '<script src="web-radar.js"></script>\n    <script type="module" src="renderer.js"></script>',
    );
};

const readBody = (req: IncomingMessage, maxBytes = 256 * 1024): Promise<string> => {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
};

const sendJson = (res: ServerResponse, status: number, value: unknown): void => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
};

/**
 * Token-file cleanups pending for this process, flushed on exit. Both shells
 * shut down via process.exit() right after web.close(), which preempts the
 * server's async 'close' event — a process 'exit' hook is the only reliable
 * place to remove the file. One shared hook, so tests that start many servers
 * don't stack listeners.
 */
const tokenCleanups = new Set<() => void>();
let exitHookInstalled = false;
const onExitCleanup = (cleanup: () => void): void => {
  tokenCleanups.add(cleanup);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const fn of tokenCleanups) fn();
  });
};

export const startWebServer = (opts: WebServerOptions): Server => {
  const { port, rendererDir, iconPath, log, handlers, mode } = opts;
  const token = randomBytes(16).toString('hex');
  const hasIcon = Boolean(iconPath && existsSync(iconPath));
  const tokenFilePath = opts.tokenFilePath ?? join(STATE_DIR, 'web-token.json');

  const handleApi = async (
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    params: URLSearchParams,
  ): Promise<void> => {
    const method = req.method ?? 'GET';

    // Liveness probe for local clients (CLI/MCP) validating a possibly-stale
    // token file. Deliberately tokenless: it discloses a strict subset of what
    // the unauthenticated GET / page already exposes, and no MR/ticket data.
    if (path === 'health' && method === 'GET') {
      return sendJson(res, 200, handlers.health());
    }

    // Notification click-through (terminal-notifier -execute → curl). Also
    // tokenless, on purpose: any local process can already scrape the token
    // from GET /, so requiring it here adds nothing — and the action is benign
    // (open the popover, flash a row; discloses nothing). Browsers can't reach
    // it cross-origin: a JSON body forces a CORS preflight we never answer,
    // and a form-encoded body fails the JSON parse below.
    if (path === 'focus' && method === 'POST') {
      let key: string | undefined;
      try {
        const raw = await readBody(req);
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const k = (parsed as { mrKey?: unknown }).mrKey;
          if (typeof k === 'string') key = k;
        }
      } catch {
        /* focus with no key still opens the UI */
      }
      return sendJson(res, 200, handlers.focusItem(key));
    }

    if (req.headers['x-radar-token'] !== token) {
      sendJson(res, 403, { error: 'bad token' });
      return;
    }

    if (method === 'GET') {
      if (path === 'snapshot') return sendJson(res, 200, handlers.getSnapshot());
      if (path === 'settings') return sendJson(res, 200, handlers.getSettings());
      if (path === 'statuses') return sendJson(res, 200, await handlers.listStatuses());
      if (path === 'export-settings') return sendJson(res, 200, await handlers.exportSettings());
      if (path === 'item') {
        const key = params.get('key');
        if (!key) return sendJson(res, 400, { error: 'key required' });
        return sendJson(res, 200, await handlers.getItemDetail(key));
      }
      if (path === 'events') {
        const rawLimit = Number(params.get('limit') ?? '50');
        const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
        // '?mr=' (present but empty) means no filter, not mr_key = ''.
        const mr = params.get('mr');
        return sendJson(res, 200, handlers.getEvents(limit, mr || undefined));
      }
      sendJson(res, 404, { error: 'unknown endpoint' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    let body: Record<string, unknown>;
    try {
      const raw = await readBody(req);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      // JSON.parse('null') and scalars survive the truthy-raw check; only an
      // object body is a valid request.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendJson(res, 400, { error: 'bad body' });
        return;
      }
      body = parsed as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'bad body' });
      return;
    }

    switch (path) {
      case 'poll-now':
        handlers.pollNow();
        return sendJson(res, 200, { ok: true });
      case 'toggle-pause':
        handlers.togglePause();
        return sendJson(res, 200, { ok: true });
      // 'set-polling', not 'set-pause': {enabled: true} means polling ON, and
      // an endpoint named set-pause would read as the inverse.
      case 'set-polling':
        if (typeof body.enabled !== 'boolean') {
          return sendJson(res, 400, { error: 'enabled (boolean) required' });
        }
        return sendJson(res, 200, handlers.setPolling(body.enabled));
      case 'set-ignored':
        if (typeof body.mrKey !== 'string' || typeof body.ignored !== 'boolean') {
          return sendJson(res, 400, { error: 'mrKey (string) and ignored (boolean) required' });
        }
        return sendJson(res, 200, handlers.setIgnored(body.mrKey, body.ignored));
      case 'review-ready':
        if (typeof body.mrKey !== 'string') return sendJson(res, 400, { error: 'mrKey required' });
        return sendJson(res, 200, await handlers.checkReviewReady(body.mrKey));
      case 'mark-all-read':
        handlers.markAllRead();
        return sendJson(res, 200, { ok: true });
      case 'mark-read':
        if (typeof body.mrKey !== 'string') return sendJson(res, 400, { error: 'mrKey required' });
        handlers.markRead(body.mrKey);
        return sendJson(res, 200, { ok: true });
      case 'start-run':
        if (typeof body.mrKey !== 'string') return sendJson(res, 400, { error: 'mrKey required' });
        return sendJson(res, 200, await handlers.startRun(body.mrKey));
      case 'jira-token':
        if (typeof body.token !== 'string') return sendJson(res, 400, { error: 'token required' });
        return sendJson(res, 200, await handlers.setJiraToken(body.token));
      case 'fix-versions':
        if (typeof body.ticketKey !== 'string') return sendJson(res, 400, { error: 'ticketKey required' });
        return sendJson(res, 200, await handlers.listFixVersions(body.ticketKey));
      case 'set-fix-version':
        if (typeof body.ticketKey !== 'string' || typeof body.versionId !== 'string') {
          return sendJson(res, 400, { error: 'ticketKey and versionId required' });
        }
        return sendJson(res, 200, await handlers.setFixVersion(body.ticketKey, body.versionId));
      case 'import-settings':
        if (!body.shared || typeof body.shared !== 'object' || Array.isArray(body.shared)) {
          return sendJson(res, 400, { error: 'shared settings object required' });
        }
        return sendJson(res, 200, await handlers.importSettings(body.shared as Record<string, unknown>));
      case 'become-reviewer':
        if (typeof body.mrKey !== 'string') return sendJson(res, 400, { error: 'mrKey required' });
        return sendJson(res, 200, await handlers.becomeReviewer(body.mrKey));
      case 'settings':
        return sendJson(res, 200, await handlers.saveSettings(body as unknown as EditableSettings));
      default:
        sendJson(res, 404, { error: 'unknown endpoint' });
    }
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (!hostAllowed(req.headers.host, port)) {
          res.writeHead(403);
          res.end('forbidden');
          return;
        }
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        const path = url.pathname;

        if (path.startsWith('/api/')) {
          await handleApi(req, res, path.slice('/api/'.length), url.searchParams);
          return;
        }
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }
        if (path === '/') {
          const html = readFileSync(join(rendererDir, 'index.html'), 'utf8');
          res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
          res.end(injectShim(html, token, hasIcon));
          return;
        }
        if (path === '/app-icon.png' && hasIcon && iconPath) {
          res.writeHead(200, { 'content-type': 'image/png' });
          res.end(readFileSync(iconPath));
          return;
        }
        const mime = STATIC_FILES[path];
        if (mime) {
          res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' });
          res.end(readFileSync(join(rendererDir, path.slice(1))));
          return;
        }
        res.writeHead(404);
        res.end('not found');
      } catch (err) {
        log(`web: request failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    })();
  });

  // Same claim-check as the poller pidfile: only delete a file we wrote.
  // Idempotent — runs on server 'close' AND on process exit (whichever first).
  const removeTokenFile = (): void => {
    try {
      const owner = (JSON.parse(readFileSync(tokenFilePath, 'utf8')) as { pid?: number }).pid;
      if (owner === process.pid) rmSync(tokenFilePath, { force: true });
    } catch {
      /* not ours, unreadable, or already gone */
    }
  };

  server.listen(port, '127.0.0.1', () => {
    log(`web ui at http://127.0.0.1:${port}`);
    // Discovery file for local clients (CLI/MCP): token + port in one read.
    // Written only after a successful bind, so a second instance that loses
    // the port race can never clobber the live instance's token. Any local
    // process can already scrape this token from the unauthenticated GET /
    // page, so the same-user 0600 file adds no attack surface — it's stricter.
    try {
      mkdirSync(dirname(tokenFilePath), { recursive: true });
      writeFileSync(
        tokenFilePath,
        `${JSON.stringify({ token, port, pid: process.pid, mode, startedAt: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
      // writeFileSync's mode only applies on creation; re-assert on overwrite
      // (e.g. a stale file left by a crash) so the perms can't drift wider.
      chmodSync(tokenFilePath, 0o600);
      onExitCleanup(removeTokenFile);
    } catch (err) {
      log(`web: could not write token file: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  server.on('close', removeTokenFile);
  server.on('error', (err) => {
    log(`web: server error: ${err.message} — status page unavailable`);
  });
  return server;
};
