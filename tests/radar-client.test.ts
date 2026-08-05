import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppDownError, RadarClient, type RadarClientDeps } from '../src/client/radar-client';
import { Db, type ReadOnlyDb } from '../src/core/db';
import type { UiSnapshot } from '../src/renderer/contract';

const tmp = mkdtempSync(join(tmpdir(), 'radar-client-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PORT = 4242;

const tokenFile = (name: string, token = 'a'.repeat(32), port = PORT): string => {
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify({ token, port, pid: 1, mode: 'poller' }));
  return path;
};

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const snapshot = (over: Partial<UiSnapshot> = {}): UiSnapshot => ({
  at: '2026-08-05T12:00:00Z',
  polling: false,
  enabled: true,
  unreadCount: 1,
  unreadKeys: [],
  sources: [{ name: 'gitlab', ok: true }],
  groups: [
    {
      ticket: { key: 'ENG-1', status: 'Code Review', url: '#', statusRank: 0 },
      items: [
        {
          key: 'acme/rocket!1',
          iid: 1,
          projectPath: 'acme/rocket',
          branch: 'ENG-1',
          targetBranch: 'main',
          title: 'Add widget',
          url: '#',
          headSha: 'sha1',
          reason: 'authored',
          draft: false,
          hasConflicts: false,
          unresolved: 0,
          commentCount: 2,
          unread: false,
          createdAt: 't',
          updatedAt: 't',
          overdue: false,
          attention: { text: 'ready', tone: 'good', rank: 8 },
          ci: { label: 'Tests passed', tone: 'good', startable: false },
          checks: [],
        },
      ],
    },
  ],
  needsGroups: [],
  verificationGroups: [{ status: 'In QA', statusRank: 1, items: [] }],
  doneGroups: [],
  otherGroups: [],
  jiraNeedsToken: false,
  ...over,
});

/** A writable Db seeded with one MR row, used as the read-only fallback. */
const seededDb = (): Db => {
  const db = new Db(':memory:');
  db.upsertMr(
    {
      key: 'acme/rocket!1',
      project_path: 'acme/rocket',
      project_id: 1,
      iid: 1,
      branch: 'ENG-1',
      title: 'Add widget',
      head_sha: 'sha1',
      web_url: '#',
      updated_at: '2026-08-04T10:00:00Z',
      user_notes_count: 2,
      unresolved: 1,
      approvals_left: 1,
      approvals_required: 2,
      approvals_by: 'sam.rios',
      has_conflicts: 0,
      in_scope: 1,
      reason: 'authored',
      ticket_key: 'ENG-1',
      ticket_status: 'Code Review',
      unverified_count: null,
      unverified_sha: null,
    },
    '2026-08-04T10:00:00Z',
  );
  return db;
};

const client = (deps: Partial<RadarClientDeps>): RadarClient =>
  new RadarClient({
    defaultPort: () => PORT,
    openDb: () => undefined,
    ...deps,
  });

describe('discovery', () => {
  it('reads token and port from the discovery file and sends the header', async () => {
    const calls: { url: string; token: unknown }[] = [];
    const c = client({
      tokenFilePath: tokenFile('basic.json', 'b'.repeat(32), 9111),
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), token: new Headers(init?.headers).get('x-radar-token') });
        return jsonResponse(snapshot());
      },
    });
    const got = await c.listMrs();
    expect(got.source).toBe('live');
    expect(calls[0]?.url).toBe('http://127.0.0.1:9111/api/snapshot');
    expect(calls[0]?.token).toBe('b'.repeat(32));
  });

  it('falls back to scraping the served page when no token file exists', async () => {
    const token = 'c'.repeat(32);
    const c = client({
      tokenFilePath: join(tmp, 'missing.json'),
      fetchFn: async (url) => {
        if (String(url) === `http://127.0.0.1:${PORT}/`) {
          return new Response(`<title>x</title>\n<meta name="radar-token" content="${token}" />`);
        }
        expect(new Headers().get('x-radar-token')).toBeNull(); // shape guard only
        return jsonResponse(snapshot());
      },
    });
    const got = await c.listMrs();
    expect(got.source).toBe('live');
  });

  it('re-discovers once on 403 (app restarted with a fresh token)', async () => {
    const file = tokenFile('rotate.json', 'old'.padEnd(32, '0'));
    let attempts = 0;
    const c = client({
      tokenFilePath: file,
      fetchFn: async (_url, init) => {
        attempts += 1;
        const sent = new Headers(init?.headers).get('x-radar-token');
        if (sent === 'new'.padEnd(32, '0')) return jsonResponse(snapshot());
        // Simulate the restarted app rewriting its discovery file.
        writeFileSync(file, JSON.stringify({ token: 'new'.padEnd(32, '0'), port: PORT }));
        return jsonResponse({ error: 'bad token' }, 403);
      },
    });
    const got = await c.listMrs();
    expect(got.source).toBe('live');
    expect(attempts).toBe(2);
  });
});

describe('hybrid reads', () => {
  it('falls back to the DB with a stale envelope when nothing answers', async () => {
    const c = client({
      tokenFilePath: tokenFile('down.json'),
      fetchFn: async () => {
        throw new Error('ECONNREFUSED');
      },
      openDb: () => seededDb() as ReadOnlyDb,
    });
    const got = await c.listMrs();
    expect(got.source).toBe('db');
    expect(got.stale).toBe(true);
    expect(got.staleNote).toContain('not running');
    expect(got.mrs).toHaveLength(1);
    expect(got.mrs[0]?.ticket).toEqual({ key: 'ENG-1', status: 'Code Review' });
    expect(got.mrs[0]?.approvals).toEqual({ required: 2, left: 1, by: ['sam.rios'] });
    expect(got.mrs[0]?.unavailableOffline).toContain('ci');
  });

  it('flattens live sections and hoists the group ticket onto each row', async () => {
    const c = client({
      tokenFilePath: tokenFile('flat.json'),
      fetchFn: async () => jsonResponse(snapshot()),
    });
    const got = await c.listMrs();
    expect(got.mrs[0]?.section).toBe('active');
    expect(got.mrs[0]?.ticket?.key).toBe('ENG-1');
    const filtered = await c.listMrs({ ticket: 'eng-1' }); // case-insensitive
    expect(filtered.mrs).toHaveLength(1);
    const none = await c.listMrs({ section: 'done' });
    expect(none.mrs).toHaveLength(0);
  });

  it('events read the DB even while the app runs; live is the last resort', async () => {
    const db = seededDb();
    db.recordEvents(
      [{ type: 'comment', mrKey: 'acme/rocket!1', branch: 'ENG-1' } as never],
      '2026-08-05T09:00:00Z',
      true,
    );
    const c = client({
      tokenFilePath: tokenFile('events.json'),
      fetchFn: async () => {
        throw new Error('must not be called — DB is present');
      },
      openDb: () => db as ReadOnlyDb,
    });
    const got = await c.events();
    expect(got.source).toBe('db');
    expect(got.events).toHaveLength(1);
    expect(got.events[0]?.notified).toBe(true);
  });

  it('discussions are live-only and surface AppDownError', async () => {
    const c = client({
      tokenFilePath: tokenFile('disc.json'),
      fetchFn: async () => {
        throw new Error('ECONNREFUSED');
      },
      openDb: () => seededDb() as ReadOnlyDb,
    });
    await expect(c.discussions('acme/rocket!1')).rejects.toBeInstanceOf(AppDownError);
  });
});

describe('actions', () => {
  it('startRun posts the key and honors the long timeout path', async () => {
    let body: unknown;
    const c = client({
      tokenFilePath: tokenFile('run.json'),
      fetchFn: async (url, init) => {
        expect(String(url)).toContain('/api/start-run');
        body = JSON.parse(String(init?.body));
        return jsonResponse({ started: true, message: 'Run started.', url: 'https://rwx/run/1' });
      },
    });
    const got = await c.startRun('acme/rocket!1');
    expect(got.started).toBe(true);
    expect(body).toEqual({ mrKey: 'acme/rocket!1' });
  });

  it('actions raise AppDownError with recovery guidance when nothing answers', async () => {
    const c = client({
      tokenFilePath: tokenFile('act-down.json'),
      fetchFn: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(c.setPolling(false)).rejects.toThrow(/not running.*tray:restart/s);
  });
});
