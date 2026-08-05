import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostAllowed, injectShim, startWebServer, type WebHandlers } from '../src/web-server';

describe('hostAllowed (DNS-rebinding guard)', () => {
  it('accepts localhost forms for the bound port', () => {
    expect(hostAllowed('127.0.0.1:8942', 8942)).toBe(true);
    expect(hostAllowed('localhost:8942', 8942)).toBe(true);
    expect(hostAllowed('[::1]:8942', 8942)).toBe(true);
  });
  it('rejects foreign hosts — the DNS-rebinding vector', () => {
    expect(hostAllowed('evil.com:8942', 8942)).toBe(false);
    expect(hostAllowed('radar.attacker.dev', 8942)).toBe(false);
    expect(hostAllowed(undefined, 8942)).toBe(false);
  });
  it('rejects the right host on the wrong port', () => {
    expect(hostAllowed('127.0.0.1:9999', 8942)).toBe(false);
  });
});

describe('injectShim', () => {
  const html = [
    '<head>',
    '    <meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\'; img-src \'self\' data:;" />',
    '    <title>MR Radar</title>',
    '</head>',
    '<script type="module" src="renderer.js"></script>',
  ].join('\n');

  it('embeds the token, loads the shim before the renderer, widens CSP', () => {
    const out = injectShim(html, 'tok123', true);
    expect(out).toContain('<meta name="radar-token" content="tok123" />');
    expect(out).toContain("connect-src 'self'"); // fetch() must be allowed
    expect(out).toContain('<link rel="icon" type="image/png" href="app-icon.png" />');
    // Classic script first: it must define window.radar before the module runs.
    const shimAt = out.indexOf('web-radar.js');
    const rendererAt = out.indexOf('renderer.js');
    expect(shimAt).toBeGreaterThan(-1);
    expect(shimAt).toBeLessThan(rendererAt);
  });

  it('omits the icon link when no icon is available', () => {
    expect(injectShim(html, 't', false)).not.toContain('rel="icon"');
  });
});

// ---------------------------------------------------------------------------
// Live-server tests: token discovery file + the API surface, over real HTTP.
// ---------------------------------------------------------------------------

/** Minimal literal WebHandlers; tests assert what reaches each handler. */
const fakeHandlers = (): WebHandlers & { calls: unknown[][] } => {
  const calls: unknown[][] = [];
  return {
    calls,
    getSnapshot: () => ({ at: 't' }) as never,
    getItemDetail: async (mrKey) => {
      calls.push(['getItemDetail', mrKey]);
      return { ok: true };
    },
    getEvents: (limit, mrKey) => {
      calls.push(['getEvents', limit, mrKey]);
      return [];
    },
    health: () => ({ ok: true, app: 'mr-radar', version: '0', mode: 'poller', pid: process.pid, polling: false, enabled: true }),
    setPolling: (enabled) => {
      calls.push(['setPolling', enabled]);
      return { enabled, changed: true };
    },
    focusItem: (mrKey) => {
      calls.push(['focusItem', mrKey]);
      return { ok: true };
    },
    setIgnored: (mrKey, ignored) => {
      calls.push(['setIgnored', mrKey, ignored]);
      return { ok: true };
    },
    pollNow: () => {},
    togglePause: () => {},
    markAllRead: () => {},
    markRead: () => {},
    startRun: async () => ({ started: false, message: 'nope' }),
    getSettings: () => ({}) as never,
    saveSettings: async () => ({ ok: true, message: '' }),
    setJiraToken: async () => ({ ok: true, message: '' }),
    listFixVersions: async () => ({ ok: true, versions: [] }),
    setFixVersion: async () => ({ ok: true, message: '' }),
    becomeReviewer: async () => ({ ok: true, message: '' }),
    listStatuses: async () => ({ ok: true, statuses: [] }),
    exportSettings: async () => ({ ok: true, settings: {} }),
    importSettings: async () => ({ ok: true, message: '' }),
  };
};

const port = () => 20000 + Math.floor(Math.random() * 40000);

const listening = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

const closed = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

describe('startWebServer (live)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'radar-web-'));
  const servers: Server[] = [];
  afterEach(async () => {
    while (servers.length) await closed(servers.pop()!);
  });
  const start = (p: number, tokenFile: string, handlers = fakeHandlers()) => {
    const server = startWebServer({
      port: p,
      rendererDir: tmp, // never served in these tests
      log: () => {},
      mode: 'poller',
      tokenFilePath: tokenFile,
      handlers,
    });
    servers.push(server);
    return { server, handlers };
  };
  const readToken = (file: string) =>
    JSON.parse(readFileSync(file, 'utf8')) as { token: string; port: number; pid: number; mode: string };

  it('writes the 0600 token file on listen and removes it on close', async () => {
    const p = port();
    const file = join(tmp, 'token-lifecycle.json');
    const { server } = start(p, file);
    await listening(server);

    const info = readToken(file);
    expect(info.port).toBe(p);
    expect(info.pid).toBe(process.pid);
    expect(info.mode).toBe('poller');
    expect(info.token).toMatch(/^[0-9a-f]{32}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    await closed(servers.pop()!);
    expect(existsSync(file)).toBe(false);
  });

  it('does not write a token file when the bind fails (port taken)', async () => {
    const p = port();
    const fileA = join(tmp, 'winner.json');
    const fileB = join(tmp, 'loser.json');
    const { server: a } = start(p, fileA);
    await listening(a);
    const b = startWebServer({
      port: p,
      rendererDir: tmp,
      log: () => {},
      mode: 'poller',
      tokenFilePath: fileB,
      handlers: fakeHandlers(),
    });
    await new Promise((resolve) => b.once('error', resolve)); // EADDRINUSE, logged not thrown
    expect(existsSync(fileB)).toBe(false);
    expect(readToken(fileA).pid).toBe(process.pid); // winner untouched
  });

  it('serves /api/health without a token; everything else still requires one', async () => {
    const p = port();
    const file = join(tmp, 'health.json');
    const { server } = start(p, file);
    await listening(server);

    const health = await fetch(`http://127.0.0.1:${p}/api/health`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { app: string }).app).toBe('mr-radar');

    const snapshot = await fetch(`http://127.0.0.1:${p}/api/snapshot`);
    expect(snapshot.status).toBe(403);
  });

  it('accepts tokenless POST /api/focus (notification click-through)', async () => {
    const p = port();
    const file = join(tmp, 'focus.json');
    const { server, handlers } = start(p, file);
    await listening(server);

    const focus = await fetch(`http://127.0.0.1:${p}/api/focus`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' }, // deliberately no token
      body: JSON.stringify({ mrKey: 'acme/rocket!7576' }),
    });
    expect(focus.status).toBe(200);
    const noKey = await fetch(`http://127.0.0.1:${p}/api/focus`, { method: 'POST' });
    expect(noKey.status).toBe(200); // digest click: open the UI, no highlight
    expect(handlers.calls).toEqual([
      ['focusItem', 'acme/rocket!7576'],
      ['focusItem', undefined],
    ]);
  });

  it('routes item/events/set-polling with the token from the discovery file', async () => {
    const p = port();
    const file = join(tmp, 'routes.json');
    const { server, handlers } = start(p, file);
    await listening(server);
    const { token } = readToken(file);
    const h = { 'x-radar-token': token };

    const item = await fetch(`http://127.0.0.1:${p}/api/item?key=${encodeURIComponent('acme/rocket!7576')}`, { headers: h });
    expect(item.status).toBe(200);
    const noKey = await fetch(`http://127.0.0.1:${p}/api/item`, { headers: h });
    expect(noKey.status).toBe(400);

    const events = await fetch(`http://127.0.0.1:${p}/api/events?limit=7&mr=${encodeURIComponent('acme/rocket!1')}`, { headers: h });
    expect(events.status).toBe(200);
    const emptyMr = await fetch(`http://127.0.0.1:${p}/api/events?limit=3&mr=`, { headers: h });
    expect(emptyMr.status).toBe(200); // '?mr=' means no filter, not mr_key=''

    const pause = await fetch(`http://127.0.0.1:${p}/api/set-polling`, {
      method: 'POST',
      headers: { ...h, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(pause.status).toBe(200);
    const badPause = await fetch(`http://127.0.0.1:${p}/api/set-polling`, {
      method: 'POST',
      headers: { ...h, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(badPause.status).toBe(400);
    // JSON.parse('null') survives the truthy-raw check; must be a 400, not 500.
    const nullBody = await fetch(`http://127.0.0.1:${p}/api/set-polling`, {
      method: 'POST',
      headers: { ...h, 'content-type': 'application/json' },
      body: 'null',
    });
    expect(nullBody.status).toBe(400);

    const setIgnored = await fetch(`http://127.0.0.1:${p}/api/set-ignored`, {
      method: 'POST',
      headers: { ...h, 'content-type': 'application/json' },
      body: JSON.stringify({ mrKey: 'acme/rocket!7576', ignored: true }),
    });
    expect(setIgnored.status).toBe(200);
    const badIgnore = await fetch(`http://127.0.0.1:${p}/api/set-ignored`, {
      method: 'POST',
      headers: { ...h, 'content-type': 'application/json' },
      body: JSON.stringify({ mrKey: 'acme/rocket!7576' }),
    });
    expect(badIgnore.status).toBe(400);

    expect(handlers.calls).toEqual([
      ['getItemDetail', 'acme/rocket!7576'],
      ['getEvents', 7, 'acme/rocket!1'],
      ['getEvents', 3, undefined],
      ['setPolling', false],
      ['setIgnored', 'acme/rocket!7576', true],
    ]);
  });

  it('cleans the temp dir', () => {
    // Not a behavior test — just keeps repeated local runs tidy.
    rmSync(tmp, { recursive: true, force: true });
    expect(existsSync(tmp)).toBe(false);
  });
});
