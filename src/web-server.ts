import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { EditableSettings, UiSnapshot } from './renderer/contract';
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

export interface WebHandlers {
  getSnapshot: () => UiSnapshot;
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

export const startWebServer = (opts: WebServerOptions): Server => {
  const { port, rendererDir, iconPath, log, handlers } = opts;
  const token = randomBytes(16).toString('hex');
  const hasIcon = Boolean(iconPath && existsSync(iconPath));

  const handleApi = async (
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<void> => {
    if (req.headers['x-radar-token'] !== token) {
      sendJson(res, 403, { error: 'bad token' });
      return;
    }
    const method = req.method ?? 'GET';

    if (method === 'GET') {
      if (path === 'snapshot') return sendJson(res, 200, handlers.getSnapshot());
      if (path === 'settings') return sendJson(res, 200, handlers.getSettings());
      if (path === 'statuses') return sendJson(res, 200, await handlers.listStatuses());
      if (path === 'export-settings') return sendJson(res, 200, await handlers.exportSettings());
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
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
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
          await handleApi(req, res, path.slice('/api/'.length));
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

  server.listen(port, '127.0.0.1', () => {
    log(`web ui at http://127.0.0.1:${port}`);
  });
  server.on('error', (err) => {
    log(`web: server error: ${err.message} — status page unavailable`);
  });
  return server;
};
