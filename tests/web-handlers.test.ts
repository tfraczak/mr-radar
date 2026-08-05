import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/core/config';
import { Db } from '../src/core/db';
import type { ForgeSource } from '../src/core/sources/forge';
import type { RwxSource } from '../src/core/sources/rwx';
import type { AppEvent, TestGate, ThreadSummary, WatchItem } from '../src/core/types';
import { makeWebHandlers, type WebHandlerDeps } from '../src/main/web-handlers';
import { initialUiState, type UiState } from '../src/main/state';

const NOW = new Date('2026-08-05T12:00:00Z');

let n = 0;
const item = (over: Partial<WatchItem> = {}): WatchItem => {
  n += 1;
  return {
    key: `acme/rocket!${7000 + n}`,
    projectPath: 'acme/rocket',
    projectId: 1,
    iid: 7000 + n,
    branch: `ENG-${n}`,
    targetBranch: 'main',
    title: `MR ${n}`,
    headSha: `sha${n}`,
    webUrl: '#',
    updatedAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    userNotesCount: 0,
    draft: false,
    hasConflicts: false,
    reason: 'authored',
    inScope: true,
    ...over,
  };
};

const stateWith = (items: WatchItem[]): UiState => ({
  ...initialUiState(),
  snapshot: { at: NOW.toISOString(), items, activeTickets: [], sources: {} },
});

/** Literal fake deps; individual tests override what they observe. */
const deps = (over: Partial<WebHandlerDeps> = {}): WebHandlerDeps => ({
  state: initialUiState(),
  db: new Db(':memory:'),
  rwx: {} as RwxSource,
  log: () => {},
  mode: 'poller',
  getConfig: () => DEFAULT_CONFIG as Config,
  setConfig: () => {},
  getForge: () => ({ name: 'gitlab' }) as ForgeSource,
  setForge: () => {},
  getJira: () => undefined,
  reconnectJira: async () => {},
  requestCycle: () => {},
  togglePause: () => {},
  onStateChanged: () => {},
  ...over,
});

describe('getItemDetail', () => {
  it('returns the raw WatchItem fields present() flattens away', async () => {
    const threads: ThreadSummary[] = [
      {
        id: 'T1',
        resolved: false,
        resolvable: true,
        filePath: 'a.rb',
        line: 5,
        notes: [{ id: 1, author: 'mira.dev', body: 'please rename', createdAt: NOW.toISOString() }],
      },
      { id: 'T2', resolved: true, resolvable: true, notes: [] },
    ];
    const gate: TestGate = { kind: 'verified', provider: 'rwx', result: 'succeeded', url: 'u', name: '.rwx/ci.yml' };
    const it1 = item({
      threads,
      testGate: gate,
      checks: [
        { provider: 'rwx', role: 'tests', name: '.rwx/ci.yml', sha: 'old-sha', state: 'succeeded', url: 'u', id: '9', createdAt: NOW.toISOString() },
      ],
    });
    const handlers = makeWebHandlers(deps({ state: stateWith([it1]) }));

    const got = await handlers.getItemDetail(it1.key);
    expect(got.ok).toBe(true);
    expect(got.item?.threads).toEqual(threads); // bodies verbatim
    expect(got.item?.testGate).toEqual(gate); // gate verbatim, not a chip
    expect(got.item?.unresolved).toBe(1); // T1 open, T2 resolved
    expect(got.item?.checks?.[0]?.stale).toBe(true); // sha differs from head
    expect(got.item?.dataAsOf).toBe(NOW.toISOString());
  });

  it('mirrors the existing not-found wording', async () => {
    const handlers = makeWebHandlers(deps({ state: stateWith([]) }));
    expect(await handlers.getItemDetail('acme/rocket!404')).toEqual({
      ok: false,
      message: 'That MR is no longer in scope.',
    });
  });

  it('distinguishes "no poll yet" from "MR gone" (fresh restart)', async () => {
    const handlers = makeWebHandlers(deps()); // initialUiState: no snapshot
    const got = await handlers.getItemDetail('acme/rocket!1');
    expect(got.ok).toBe(false);
    expect(got.message).toContain('not completed a poll yet');
  });

  it('fetches thread bodies on demand when the cycle skipped them, and caches', async () => {
    const it1 = item({ unresolvedFallback: 3 });
    delete it1.threads;
    let fetches = 0;
    const forge = {
      name: 'gitlab',
      discussions: async (projectPath: string, iid: number) => {
        fetches += 1;
        expect(projectPath).toBe('acme/rocket');
        expect(iid).toBe(it1.iid);
        return [
          {
            id: 'D1',
            individual_note: false,
            notes: [
              {
                id: 11,
                body: 'fetched on demand',
                author: { id: 1, username: 'mira.dev', name: 'Mira' },
                created_at: NOW.toISOString(),
                updated_at: NOW.toISOString(),
                system: false,
                resolvable: true,
                resolved: false,
              },
            ],
          },
        ];
      },
    } as unknown as ForgeSource;
    const handlers = makeWebHandlers(deps({ state: stateWith([it1]), getForge: () => forge }));

    const got = await handlers.getItemDetail(it1.key);
    expect(got.item?.threads?.[0]?.notes[0]?.body).toBe('fetched on demand');
    expect(got.item?.unresolved).toBe(1); // recomputed from the fetched threads
    await handlers.getItemDetail(it1.key);
    expect(fetches).toBe(1); // cached on the item until the next cycle
  });

  it('omits threads (rather than faking them) when the on-demand fetch fails', async () => {
    const it1 = item({ unresolvedFallback: 3 });
    delete it1.threads;
    const forge = {
      name: 'gitlab',
      discussions: async () => {
        throw new Error('glab exploded');
      },
    } as unknown as ForgeSource;
    const handlers = makeWebHandlers(deps({ state: stateWith([it1]), getForge: () => forge }));
    const got = await handlers.getItemDetail(it1.key);
    expect(got.ok).toBe(true);
    expect(got.item?.threads).toBeUndefined();
    expect(got.item?.unresolved).toBe(3); // the fallback count still stands
  });
});

describe('getEvents', () => {
  const seed = (db: Db, count: number, mrKey = 'acme/rocket!1'): void => {
    const events = Array.from({ length: count }, (_, i) => ({
      type: 'comment',
      mrKey,
      branch: 'ENG-1',
      author: 'mira.dev',
      body: `c${i}`,
    })) as unknown as AppEvent[];
    db.recordEvents(events, NOW.toISOString(), false);
  };

  it('parses payloads and clamps the limit to 1–200', () => {
    const db = new Db(':memory:');
    seed(db, 5);
    const handlers = makeWebHandlers(deps({ db }));
    const got = handlers.getEvents(3);
    expect(got).toHaveLength(3);
    expect(got[0]?.mrKey).toBe('acme/rocket!1');
    expect((got[0]?.payload as { type?: string }).type).toBe('comment');
    expect(handlers.getEvents(0)).toHaveLength(5); // 0 is not a limit — default 50
    expect(handlers.getEvents(-5)).toHaveLength(1); // clamped up to 1
  });

  it('filters by MR key in the query, not post-hoc', () => {
    const db = new Db(':memory:');
    seed(db, 2, 'acme/rocket!1');
    seed(db, 2, 'acme/gadget!9');
    const handlers = makeWebHandlers(deps({ db }));
    const got = handlers.getEvents(50, 'acme/gadget!9');
    expect(got).toHaveLength(2);
    expect(got.every((e) => e.mrKey === 'acme/gadget!9')).toBe(true);
  });
});

describe('health', () => {
  it('reports liveness without any MR, ticket, or error text', () => {
    const state = initialUiState();
    // Error text can quote project paths; the tokenless probe must drop it.
    state.lastError = 'gitlab: acme/rocket fetch failed';
    const handlers = makeWebHandlers(deps({ state, mode: 'tray' }));
    const got = handlers.health();
    expect(got.ok).toBe(true);
    expect(got.app).toBe('mr-radar');
    expect(got.mode).toBe('tray');
    expect(got.pid).toBe(process.pid);
    expect(got.enabled).toBe(true);
    expect(JSON.stringify(got)).not.toContain('rocket'); // no data leakage
  });
});

describe('setPolling', () => {
  it('is idempotent: only flips when the desired state differs', () => {
    const state = initialUiState();
    let toggles = 0;
    const handlers = makeWebHandlers(
      deps({
        state,
        togglePause: () => {
          toggles += 1;
          state.schedule = { ...state.schedule, enabled: !state.schedule.enabled };
        },
      }),
    );
    expect(handlers.setPolling(true)).toEqual({ enabled: true, changed: false }); // already running
    expect(toggles).toBe(0);
    expect(handlers.setPolling(false)).toEqual({ enabled: false, changed: true });
    expect(handlers.setPolling(false)).toEqual({ enabled: false, changed: false });
    expect(toggles).toBe(1);
  });
});

describe('state mutations notify the shell', () => {
  it('markRead and markAllRead call onStateChanged so the tray repaints', () => {
    const state = initialUiState();
    state.unread = [
      { type: 'comment', mrKey: 'acme/rocket!1', branch: 'b' } as unknown as AppEvent,
      { type: 'comment', mrKey: 'acme/rocket!2', branch: 'b' } as unknown as AppEvent,
    ];
    let repaints = 0;
    const handlers = makeWebHandlers(deps({ state, onStateChanged: () => (repaints += 1) }));
    handlers.markRead('acme/rocket!1');
    expect(state.unread).toHaveLength(1);
    handlers.markAllRead();
    expect(state.unread).toHaveLength(0);
    expect(repaints).toBe(2);
  });
});

describe('startRun', () => {
  it('refuses when the MR is gone (no snapshot at all)', async () => {
    const handlers = makeWebHandlers(deps());
    expect(await handlers.startRun('acme/rocket!1')).toEqual({
      started: false,
      message: 'That MR is no longer in scope.',
    });
  });
});
