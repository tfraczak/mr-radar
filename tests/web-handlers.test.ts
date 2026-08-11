import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/core/config';
import { Db, cachedTicket } from '../src/core/db';
import type { ForgeSource } from '../src/core/sources/forge';
import type { RwxSource } from '../src/core/sources/rwx';
import type { AppEvent, JiraTicket, TestGate, ThreadSummary, WatchItem } from '../src/core/types';
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
  openUi: () => {},
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

describe('setIgnored', () => {
  const seedRow = (db: Db, key: string): void => {
    db.upsertMr(
      {
        key,
        project_path: 'acme/rocket',
        project_id: 1,
        iid: 1,
        branch: 'b',
        title: 't',
        head_sha: 's',
        web_url: '#',
        updated_at: 'u',
        user_notes_count: 0,
        unresolved: 0,
        approvals_left: null,
        approvals_required: null,
        approvals_by: null,
        has_conflicts: 0,
        in_scope: 1,
        reason: 'authored',
        ticket_key: null,
        ticket_status: null,
        unverified_count: null,
        unverified_sha: null,
      },
      'now',
    );
  };

  it('ignores: persists the override, mutates the live item, purges unread', () => {
    const it1 = item();
    const state = stateWith([it1]);
    state.unread = [{ type: 'comment', mrKey: it1.key, branch: 'b' } as unknown as AppEvent];
    const db = new Db(':memory:');
    seedRow(db, it1.key);
    const handlers = makeWebHandlers(deps({ state, db }));

    expect(handlers.setIgnored(it1.key, true)).toEqual({ ok: true });
    expect(db.getMr(it1.key)?.ignore_override).toBe('ignored');
    expect(it1.ignoreOverride).toBe('ignored');
    expect(state.unread).toHaveLength(0);
  });

  it("un-ignoring a rule-ignored MR pins it 'shown'; a manual one reverts to rules", () => {
    const ticketless = item(); // matched by the (no ticket) ignore rule
    const state = stateWith([ticketless]);
    const db = new Db(':memory:');
    seedRow(db, ticketless.key);
    const cfg = {
      ...DEFAULT_CONFIG,
      statusRules: [{ status: '(no ticket)', op: 'always', then: 'ignore' }],
    } as Config;
    const handlers = makeWebHandlers(deps({ state, db, getConfig: () => cfg }));

    handlers.setIgnored(ticketless.key, false);
    expect(db.getMr(ticketless.key)?.ignore_override).toBe('shown'); // rule would re-catch it

    handlers.setIgnored(ticketless.key, true);
    expect(db.getMr(ticketless.key)?.ignore_override).toBe('ignored');
  });

  it('reports untracked keys instead of pretending', () => {
    const handlers = makeWebHandlers(deps());
    expect(handlers.setIgnored('acme/rocket!404', true).ok).toBe(false);
  });
});

describe('checkReviewReady', () => {
  const freshMr = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 1,
    iid: 7001,
    project_id: 1,
    title: 'ENG-42: widget',
    state: 'opened',
    sha: 'sha1',
    source_branch: 'ENG-42',
    target_branch: 'main',
    web_url: '#',
    updated_at: 'u2',
    created_at: 'c',
    user_notes_count: 0,
    draft: false,
    has_conflicts: false,
    author: { id: 1, username: 'me', name: 'Me' },
    references: { full: 'acme/rocket!7001' },
    ...over,
  });

  const reviewDeps = (over: Partial<WebHandlerDeps> = {}, forgeOver: Record<string, unknown> = {}) => {
    const it1 = item({
      ticket: {
        key: 'ENG-42',
        summary: 's',
        status: 'Code Review',
        updated: '',
        url: 'https://acme.atlassian.net/browse/ENG-42',
      },
      unresolvedFallback: 5, // stale count; the fresh fetch must supersede it
    });
    delete it1.threads;
    delete it1.testGate;
    const state = stateWith([it1]);
    const db = new Db(':memory:');
    db.setRepoRoles('acme/rocket', { testGate: 'none', gitlabIsLintOnly: false, detectedAt: 'now' });
    const forge = {
      name: 'gitlab',
      ci: { model: 'pipelines', pipelines: async () => [], pipelineJobs: async () => [] },
      mrByProjectId: async () => freshMr({ iid: it1.iid, references: { full: it1.key } }),
      discussions: async () => [], // fresh truth: nothing open
      approvals: async () => undefined,
      commits: async () => [],
      ...forgeOver,
    } as unknown as ForgeSource;
    const rwx = { available: async () => false } as unknown as RwxSource;
    return {
      it1,
      deps: deps({
        state,
        db,
        rwx,
        getForge: () => forge,
        getConfig: () => ({ ...DEFAULT_CONFIG, slack: { ...DEFAULT_CONFIG.slack }, jira: { ...DEFAULT_CONFIG.jira, baseUrl: 'https://acme.atlassian.net' } }) as Config,
        ...over,
      }),
    };
  };

  it('re-fetches fresh data and composes the message when eligible', async () => {
    const { it1, deps: d } = reviewDeps();
    const handlers = makeWebHandlers(d);
    const got = await handlers.checkReviewReady(it1.key);
    expect(got.ok).toBe(true);
    expect(got.reasons).toEqual([]);
    expect(got.eligible).toBe(true); // stale unresolvedFallback=5 was superseded
    expect(got.message).toContain('https://acme.atlassian.net/browse/ENG-42');
    expect(got.message).toContain('is ready for review');
  });

  it('reports the concrete refusal reasons from the FRESH data', async () => {
    const { it1, deps: d } = reviewDeps({}, {
      mrByProjectId: async () => freshMr({ draft: true, references: { full: 'x' } }),
    });
    const handlers = makeWebHandlers(d);
    const got = await handlers.checkReviewReady(it1.key);
    expect(got.ok).toBe(true);
    expect(got.eligible).toBe(false);
    expect(got.reasons?.join(' ')).toMatch(/draft/);
    expect(got.message).toBeUndefined();
  });

  it('a freshly-merged MR is refused outright', async () => {
    const { it1, deps: d } = reviewDeps({}, {
      mrByProjectId: async () => freshMr({ state: 'merged', references: { full: 'x' } }),
    });
    const handlers = makeWebHandlers(d);
    const got = await handlers.checkReviewReady(it1.key);
    expect(got.ok).toBe(true);
    expect(got.eligible).toBe(false);
    expect(got.reasons).toEqual(['The MR is already merged.']);
  });

  it('a failed refresh is an honest error, not a stale verdict', async () => {
    const { it1, deps: d } = reviewDeps({}, {
      mrByProjectId: async () => {
        throw new Error('glab exploded');
      },
    });
    const handlers = makeWebHandlers(d);
    const got = await handlers.checkReviewReady(it1.key);
    expect(got.ok).toBe(false);
    expect(got.message).toContain('glab exploded');
  });
});

describe('focusItem', () => {
  it('highlights a known item and opens the UI; unknown keys still open it', () => {
    const it1 = item();
    const state = stateWith([it1]);
    let opened = 0;
    const handlers = makeWebHandlers(deps({ state, openUi: () => (opened += 1) }));

    expect(handlers.focusItem(it1.key)).toEqual({ ok: true });
    expect(state.highlight?.key).toBe(it1.key);
    handlers.focusItem('acme/rocket!404');
    expect(state.highlight?.key).toBe(it1.key); // unknown key doesn't clobber
    expect(opened).toBe(2); // but the UI still opens
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

describe('listOwnerFields', () => {
  it('prepends Watcher, dedupes by clause, and requires Jira', async () => {
    const jira = {
      userFields: async () => [
        { clause: 'assignee', label: 'Assignee' },
        { clause: 'cf[10123]', label: 'Dev Resource' },
        { clause: 'watcher', label: 'Shadow Watcher' }, // hypothetical dupe loses
      ],
    };
    const handlers = makeWebHandlers(deps({ getJira: () => jira as never }));
    const got = await handlers.listOwnerFields();
    expect(got.ok).toBe(true);
    expect(got.fields).toEqual([
      { clause: 'watcher', label: 'Watcher' },
      { clause: 'assignee', label: 'Assignee' },
      { clause: 'cf[10123]', label: 'Dev Resource' },
    ]);

    const off = makeWebHandlers(deps());
    expect(await off.listOwnerFields()).toEqual({ ok: false, message: 'Jira is not connected.' });
  });
});

describe('setFixVersion', () => {
  const assigned: JiraTicket = {
    key: 'ENG-9',
    summary: 'A thing',
    status: 'Dev Complete',
    updated: NOW.toISOString(),
    url: '#',
    issueType: 'Story',
    fixVersions: [{ id: '77', name: '2026.31' }],
  };
  const before: JiraTicket = { ...assigned, fixVersions: [] };

  const jira = (over: Partial<Record<string, unknown>> = {}) => ({
    configured: true,
    setFixVersion: async () => {},
    searchByKeys: async () => [assigned],
    ...over,
  });

  it('folds the re-read ticket into the live snapshot instead of waiting for a poll', async () => {
    const state = stateWith([item({ ticket: before })]);
    let cycles = 0;
    let repaints = 0;
    const h = makeWebHandlers(
      deps({ state, getJira: () => jira() as never, requestCycle: () => { cycles += 1; }, onStateChanged: () => { repaints += 1; } }),
    );
    const at = state.snapshot?.at;
    const res = await h.setFixVersion('ENG-9', '77');
    expect(res.ok).toBe(true);
    expect(res.message).toContain('2026.31'); // confirms WHAT was assigned
    // The whole point: the rule now sees a non-empty fixVersions immediately.
    expect(state.snapshot?.items[0]?.ticket?.fixVersions).toEqual([{ id: '77', name: '2026.31' }]);
    expect(state.snapshot?.at).not.toBe(at); // or the renderer skips the rebuild
    expect(repaints).toBe(1);
    expect(cycles).toBe(0); // one targeted re-read, not a whole cycle
  });

  it('persists the change so the next cycle does not serve the stale ticket', async () => {
    const db = new Db(':memory:');
    // An MR row carrying the pre-assignment ticket, as a poll would have left it.
    db.upsertMr(
      {
        key: 'acme/rocket!1', project_path: 'acme/rocket', project_id: 1, iid: 1, branch: 'ENG-9',
        title: 'ENG-9: thing', head_sha: 'abc', web_url: '#', updated_at: NOW.toISOString(),
        user_notes_count: 0, unresolved: 0, approvals_left: null, approvals_required: null,
        approvals_by: null, has_conflicts: 0, in_scope: 1, reason: 'authored',
        ticket_key: 'ENG-9', ticket_status: 'Dev Complete', ticket_json: JSON.stringify(before),
        unverified_count: null, unverified_sha: null,
      },
      NOW.toISOString(),
    );
    const h = makeWebHandlers(deps({ state: stateWith([]), db, getJira: () => jira() as never }));
    await h.setFixVersion('ENG-9', '77');
    expect(cachedTicket(db.getMr('acme/rocket!1')?.ticket_json ?? null, 'ENG-9')?.fixVersions).toEqual([
      { id: '77', name: '2026.31' },
    ]);
  });

  it('never inserts a non-active ticket into the active-set cache', async () => {
    const db = new Db(':memory:');
    db.replaceJiraTickets([{ key: 'ENG-1', summary: '', status: 'Code Review', updated: '', url: '#' }], NOW.toISOString());
    const h = makeWebHandlers(deps({ state: stateWith([]), db, getJira: () => jira() as never }));
    await h.setFixVersion('ENG-9', '77'); // ENG-9 is Dev Complete: not active
    expect(db.cachedJiraTickets().tickets.map((t) => t.key)).toEqual(['ENG-1']);
  });

  it('updates the active-set cache when the ticket IS in it', async () => {
    const db = new Db(':memory:');
    db.replaceJiraTickets([before], NOW.toISOString());
    const h = makeWebHandlers(deps({ state: stateWith([]), db, getJira: () => jira() as never }));
    await h.setFixVersion('ENG-9', '77');
    expect(db.cachedJiraTickets().tickets[0]?.fixVersions).toEqual([{ id: '77', name: '2026.31' }]);
  });

  it('falls back to the poll cadence — and says so — when the re-read fails', async () => {
    const state = stateWith([item({ ticket: before })]);
    let cycles = 0;
    const h = makeWebHandlers(
      deps({
        state,
        getJira: () => jira({ searchByKeys: async () => { throw new Error('jira flaked'); } }) as never,
        requestCycle: () => { cycles += 1; },
      }),
    );
    const res = await h.setFixVersion('ENG-9', '77');
    expect(res.ok).toBe(true); // the write DID land
    expect(res.message).toMatch(/catch up/);
    expect(cycles).toBe(1);
    expect(state.snapshot?.items[0]?.ticket?.fixVersions).toEqual([]); // unchanged, not guessed
  });

  it('reports the write failing without touching any cache', async () => {
    const state = stateWith([item({ ticket: before })]);
    const h = makeWebHandlers(
      deps({ state, getJira: () => jira({ setFixVersion: async () => { throw new Error('403 forbidden'); } }) as never }),
    );
    const res = await h.setFixVersion('ENG-9', '77');
    expect(res).toEqual({ ok: false, message: '403 forbidden' });
    expect(state.snapshot?.items[0]?.ticket?.fixVersions).toEqual([]);
  });

  it('refuses when Jira is not connected', async () => {
    const h = makeWebHandlers(deps({ state: stateWith([]) }));
    expect(await h.setFixVersion('ENG-9', '77')).toEqual({ ok: false, message: 'Jira is not connected.' });
  });
});
