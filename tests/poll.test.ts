import { beforeEach, describe, expect, it } from 'vitest';
import { Db } from '../src/core/db';
import { DEFAULT_CONFIG, type Config } from '../src/core/config';
import { pollOnce, refreshItem, type PollDeps } from '../src/core/poll';
import type { ForgeMr, JiraTicket, RwxRun } from '../src/core/types';

// Lightweight in-memory fakes. Only the methods pollOnce actually calls are
// implemented; each is cast to its source type at the call site.
const fakeForge = (over: Partial<Record<string, unknown>> = {}) => ({
  name: 'gitlab' as const,
  ci: {
    model: 'pipelines' as const,
    pipelines: (over.pipelines as () => Promise<unknown[]>) ?? (async () => []),
    pipelineJobs: (over.pipelineJobs as () => Promise<unknown[]>) ?? (async () => []),
  },
  currentUser: async () => ({ id: 1, username: 'me', name: 'Me' }),
  authoredMrs: async (): Promise<ForgeMr[]> => [],
  reviewerMrs: async (): Promise<ForgeMr[]> => [],
  approvedMrs: async (): Promise<ForgeMr[]> => [],
  commentEvents: async () => [],
  mrByProjectId: async (): Promise<ForgeMr> => {
    throw new Error('no such MR');
  },
  todos: async () => [],
  pipelines: async () => [],
  pipelineJobs: async () => [],
  discussions: async () => [],
  approvals: async () => undefined,
  commits: async () => [],
  ...over,
});

const fakeRwx = (over: Partial<Record<string, unknown>> = {}) => ({
  recentRuns: async (): Promise<RwxRun[]> => [],
  runsForBranch: async (): Promise<RwxRun[]> => [],
  branchHistory: async (): Promise<{ runs: RwxRun[]; fetched: boolean }> => ({
    runs: [],
    fetched: false,
  }),
  myRuns: async (): Promise<{ runs: RwxRun[]; fetched: boolean }> => ({
    runs: [],
    fetched: false,
  }),
  showRun: async (): Promise<RwxRun> => {
    throw new Error('no such run');
  },
  ...over,
});

const config = (): Config => ({
  ...DEFAULT_CONFIG,
  gitlab: { userId: 1, username: 'me' },
  jira: { ...DEFAULT_CONFIG.jira, email: 'me@co.com', refreshMinutes: 10 },
  // The open-source default ships no repos; pin the RWX gate the way a real
  // install does once the user sets up the repo in Settings → General.
  repos: { 'acme/rocket': { rwxDefinition: '.rwx/ci.yml' } },
});

const deps = (over: Partial<PollDeps>): PollDeps =>
  ({
    db: over.db as Db,
    config: over.config ?? config(),
    forge: (over.forge ?? fakeForge()) as never,
    rwx: (over.rwx ?? fakeRwx()) as never,
    ...(over.jira ? { jira: over.jira } : {}),
    now: over.now ?? (() => new Date('2026-07-30T12:00:00Z')),
    log: () => {},
  }) as PollDeps;

let db: Db;
beforeEach(() => {
  db = new Db(':memory:');
});

describe('Jira scope gating', () => {
  it('reuses the cached ticket set (marked stale) when a Jira fetch fails', async () => {
    const cached: JiraTicket = { key: 'ENG-1', summary: '', status: 'Code Review', updated: '', url: '#' };
    // Seed a cache with a stale fetched-at so the cycle attempts a refresh.
    db.replaceJiraTickets([cached], '2000-01-01T00:00:00Z');
    const jira = {
      configured: true,
      search: async () => {
        throw new Error('jira down');
      },
      searchByKeys: async () => [],
    };
    const result = await pollOnce(deps({ db, jira: jira as never }), { dryRun: true });
    expect(result.snapshot.sources.jira.ok).toBe(false);
    expect(result.snapshot.sources.jira.stale).toBe(true);
    expect(result.snapshot.activeTickets).toEqual([cached]); // fell back, not emptied
  });

  it('completes the cycle when the GitLab list source fails', async () => {
    const gitlab = fakeForge({
      authoredMrs: async () => {
        throw new Error('glab boom');
      },
    });
    const result = await pollOnce(deps({ db, forge: gitlab as never }), { dryRun: true });
    expect(result.snapshot.sources.gitlab.ok).toBe(false);
    expect(result.snapshot.sources.rwx.ok).toBe(true); // other sources still ran
    expect(result.events).toEqual([]);
  });
});

describe('watched runs', () => {
  const finishedRun = (result: 'succeeded' | 'failed'): RwxRun => ({
    ID: 'run-1',
    Branch: 'ENG-9',
    CommitSha: 'deadbeef',
    DefinitionPath: '.rwx/ci.yml',
    RepositoryName: 'rocket',
    RunUrl: 'https://cloud.rwx.com/mint/acme/runs/run-1',
    Title: '',
    Trigger: 'cli',
    CreatedAt: '2026-07-30T11:00:00Z',
    StartedAt: '2026-07-30T11:00:00Z',
    CompletedAt: '2026-07-30T11:05:00Z',
    Status: {
      Execution: 'finished',
      Result: result,
      WaitingSubStatus: 'not_applicable',
      AbortedSubStatus: 'not_applicable',
      FinishedSubStatus: 'not_applicable',
    },
  });

  const seedWatched = () =>
    db.addWatchedRun({
      run_id: 'run-1',
      provider: 'rwx',
      mr_key: 'acme/rocket!9',
      branch: 'ENG-9',
      sha: 'deadbeef',
      definition: '.rwx/ci.yml',
      url: 'https://cloud.rwx.com/mint/acme/runs/run-1',
      started_at: '2026-07-30T11:00:00Z',
      terminal: 0,
      result: null,
    });

  it('emits a result event when a watched run finishes, and marks it terminal', async () => {
    seedWatched();
    const rwx = fakeRwx({ showRun: async () => ({ ...finishedRun('failed'), Branch: '' }) });
    const result = await pollOnce(deps({ db, rwx: rwx as never }), {});
    const ciEvent = result.events.find((e) => e.type === 'ci_failed');
    expect(ciEvent).toBeDefined();
    expect(db.openWatchedRuns()).toHaveLength(0); // resolved
  });

  it('mutes every event for a manually-ignored MR — even watched-run results', async () => {
    seedWatched();
    db.upsertMr(
      {
        key: 'acme/rocket!9',
        project_path: 'acme/rocket',
        project_id: 1,
        iid: 9,
        branch: 'ENG-9',
        title: 't',
        head_sha: 'deadbeef',
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
      '2026-07-30T11:00:00Z',
    );
    db.setIgnoreOverride('acme/rocket!9', 'ignored');
    const rwx = fakeRwx({ showRun: async () => ({ ...finishedRun('failed'), Branch: '' }) });
    const result = await pollOnce(deps({ db, rwx: rwx as never }), {});
    expect(result.events).toEqual([]); // silent: no notification, no unread
    expect(db.recentEvents(10)).toEqual([]); // and no durable history either
    expect(db.openWatchedRuns()).toHaveLength(0); // the run still resolves
  });

  it('does not re-emit a watched run result on the next cycle', async () => {
    seedWatched();
    const rwx = fakeRwx({ showRun: async () => ({ ...finishedRun('succeeded'), Branch: '' }) });
    await pollOnce(deps({ db, rwx: rwx as never }), {});
    const second = await pollOnce(deps({ db, rwx: rwx as never }), {});
    expect(second.events.filter((e) => e.type === 'ci_succeeded')).toHaveLength(0);
  });
});

describe('CLI-run attribution (the ENG-132 case)', () => {
  // The MR whose branch has only waiting push-runs — plus a finished CLI run
  // that RWX recorded with NO branch and NO sha, only the title convention.
  const mr = (): ForgeMr =>
    ({
      id: 2,
      iid: 7723,
      project_id: 1,
      title: 'ENG-132: Clear cached token',
      state: 'opened',
      sha: '181d7763aaaaaaaa',
      source_branch: 'ENG-132',
      target_branch: 'main',
      web_url: '#',
      updated_at: '2026-07-30T11:00:00Z',
      created_at: '2026-07-28T11:00:00Z',
      user_notes_count: 0,
      draft: false,
      has_conflicts: false,
      author: { id: 1, username: 'me', name: 'Me' },
      references: { full: 'acme/rocket!7723' },
    }) as ForgeMr;

  const bareRun = (over: Partial<RwxRun>): RwxRun => ({
    ID: 'x',
    Branch: '',
    CommitSha: '',
    DefinitionPath: '.rwx/ci.yml',
    RepositoryName: 'rocket',
    RunUrl: '',
    Title: '',
    Trigger: 'cli',
    CreatedAt: '2026-07-30T10:00:00Z',
    StartedAt: null,
    CompletedAt: null,
    Status: {
      Execution: 'finished',
      Result: 'succeeded',
      WaitingSubStatus: 'not_applicable',
      AbortedSubStatus: 'not_applicable',
      FinishedSubStatus: 'not_applicable',
    },
    ...over,
  });

  it('finds a finished CLI run via --mine, hydrates its sha, and verifies the gate', async () => {
    const cliRun = bareRun({ ID: 'cli-1', Title: 'ENG-132 - mira.dev@acme.com' });
    const waiting = bareRun({
      ID: 'push-1',
      Branch: 'ENG-132',
      CommitSha: '181d7763aaaaaaaa',
      Trigger: 'push',
      Status: { Execution: 'waiting', Result: 'no_result' },
    });
    const rwx = fakeRwx({
      recentRuns: async () => [waiting], // makes rocket detect as RWX-gated
      myRuns: async () => ({ runs: [cliRun], fetched: true }),
      showRun: async (id: string) =>
        id === 'cli-1'
          ? bareRun({ ID: 'cli-1', CommitSha: '181d7763aaaaaaaa', RunUrl: 'https://cloud.rwx.com/mint/acme/runs/cli-1' })
          : Promise.reject(new Error('unknown run')),
    });
    const g = fakeForge({ authoredMrs: async () => [mr()] });
    const cfg: Config = { ...config(), recentDaysFallback: 3650 };

    const result = await pollOnce(deps({ db, forge: g as never, rwx: rwx as never, config: cfg }), {});
    const item = result.snapshot.items.find((i) => i.key === 'acme/rocket!7723');
    expect(item?.testGate?.kind).toBe('verified');
    if (item?.testGate?.kind !== 'verified') throw new Error('unreachable');
    expect(item.testGate.result).toBe('succeeded');
  });

  it('an app-started run still in flight flips the gate to in_progress', async () => {
    // The chip must say "RWX running" the moment Start run fires — the open
    // watched run is hydrated by id each cycle and joins coverage, even when
    // an older completed run would otherwise read as stale.
    db.addWatchedRun({
      run_id: 'app-run-2',
      provider: 'rwx',
      mr_key: 'acme/rocket!7723',
      branch: 'ENG-132',
      sha: '181d7763aaaaaaaa',
      definition: '.rwx/ci.yml',
      url: 'https://cloud.rwx.com/mint/acme/runs/app-run-2',
      started_at: '2026-07-30T10:00:00Z',
      terminal: 0,
      result: null,
    });
    const rwx = fakeRwx({
      // The API attributes nothing: the CLI run has no branch/sha, and the
      // only attributed history is a FAILED run on an older commit (stale).
      recentRuns: async () => [
        bareRun({ ID: 'old-1', Branch: 'ENG-132', CommitSha: 'aaaa000011112222', Trigger: 'push', Status: { Execution: 'finished', Result: 'failed', WaitingSubStatus: 'not_applicable', AbortedSubStatus: 'not_applicable', FinishedSubStatus: 'not_applicable' } }),
      ],
      showRun: async () =>
        bareRun({ ID: 'app-run-2', Trigger: 'cli', Status: { Execution: 'in_progress', Result: 'no_result', WaitingSubStatus: 'not_applicable', AbortedSubStatus: 'not_applicable', FinishedSubStatus: 'not_applicable' }, CompletedAt: null }),
    });
    const g = fakeForge({ authoredMrs: async () => [mr()] });
    const cfg: Config = { ...config(), recentDaysFallback: 3650 };
    const result = await pollOnce(deps({ db, forge: g as never, rwx: rwx as never, config: cfg }), {});
    const item = result.snapshot.items.find((i) => i.key === 'acme/rocket!7723');
    expect(item?.testGate?.kind).toBe('in_progress');
  });

  it('counts a run started FROM THE APP as coverage, with no RWX list at all', async () => {
    // The app recorded branch/sha/url at trigger time; RWX never attributes
    // CLI runs — so the DB record is the only source, and it must be enough.
    db.addWatchedRun({
      run_id: 'app-run-1',
      provider: 'rwx',
      mr_key: 'acme/rocket!7723',
      branch: 'ENG-132',
      sha: '181d7763aaaaaaaa',
      definition: '.rwx/ci.yml',
      url: 'https://cloud.rwx.com/mint/acme/runs/app-run-1',
      started_at: '2026-07-30T10:00:00Z',
      terminal: 0,
      result: null,
    });
    db.resolveWatchedRun('app-run-1', 'succeeded'); // as checkWatchedRuns does
    const rwx = fakeRwx({
      // One waiting push run so rocket still detects as RWX-gated.
      recentRuns: async () => [
        bareRun({ ID: 'push-1', Branch: 'ENG-132', CommitSha: '181d7763aaaaaaaa', Trigger: 'push', Status: { Execution: 'waiting', Result: 'no_result' } }),
      ],
    });
    const g = fakeForge({ authoredMrs: async () => [mr()] });
    const cfg: Config = { ...config(), recentDaysFallback: 3650 };
    const result = await pollOnce(deps({ db, forge: g as never, rwx: rwx as never, config: cfg }), {});
    const item = result.snapshot.items.find((i) => i.key === 'acme/rocket!7723');
    expect(item?.testGate?.kind).toBe('verified');
  });

  it('remembers the result in ci_runs so scroll-out cannot regress to never-run', async () => {
    const cliRun = bareRun({ ID: 'cli-1', Title: 'ENG-132 - mira.dev@acme.com' });
    const rwxFirst = fakeRwx({
      recentRuns: async () => [bareRun({ ID: 'push-1', Branch: 'ENG-132', Trigger: 'push', Status: { Execution: 'waiting', Result: 'no_result' } })],
      myRuns: async () => ({ runs: [cliRun], fetched: true }),
      showRun: async () => bareRun({ ID: 'cli-1', CommitSha: '181d7763aaaaaaaa' }),
    });
    const g = fakeForge({ authoredMrs: async () => [mr()] });
    const cfg: Config = { ...config(), recentDaysFallback: 3650 };
    await pollOnce(deps({ db, forge: g as never, rwx: rwxFirst as never, config: cfg }), {});

    // Next cycle: every RWX window is empty — the run scrolled out entirely.
    const rwxEmpty = fakeRwx();
    const result = await pollOnce(deps({ db, forge: g as never, rwx: rwxEmpty as never, config: cfg }), {});
    const item = result.snapshot.items.find((i) => i.key === 'acme/rocket!7723');
    expect(item?.testGate?.kind).toBe('verified'); // remembered, not "never run"
  });
});

describe('participating MRs (commented, not reviewer)', () => {
  const otherMr = (state: string): ForgeMr =>
    ({
      id: 7591,
      iid: 7591,
      project_id: 42,
      title: 'CORE-169 monitoring',
      state,
      sha: 'ddd',
      source_branch: 'CORE-169',
      target_branch: 'main',
      web_url: '#',
      updated_at: '2026-07-30T11:00:00Z',
      created_at: '2026-07-29T11:00:00Z',
      user_notes_count: 5,
      draft: false,
      has_conflicts: false,
      author: { id: 9, username: 'colleague', name: 'C' },
      references: { full: 'acme/rocket!7591' },
    }) as ForgeMr;

  const commented = [
    { project_id: 42, created_at: '2026-07-30', note: { noteable_type: 'MergeRequest', noteable_iid: 7591 } },
    // Noise: a comment on an issue must be ignored.
    { project_id: 42, created_at: '2026-07-30', note: { noteable_type: 'Issue', noteable_iid: 1 } },
  ];

  it('hydrates commented refs into participating items', async () => {
    const g = fakeForge({
      commentEvents: async () => commented,
      mrByProjectId: async () => otherMr('opened'),
    });
    const result = await pollOnce(deps({ db, forge: g as never }), { dryRun: true });
    const item = result.snapshot.items.find((i) => i.key === 'acme/rocket!7591');
    expect(item?.reason).toBe('participating');
    expect(item?.inScope).toBe(true);
  });

  it('drops closed MRs and caches the ref so it is not refetched next cycle', async () => {
    let fetches = 0;
    const g = fakeForge({
      commentEvents: async () => commented,
      mrByProjectId: async () => {
        fetches += 1;
        return otherMr('merged');
      },
    });
    const first = await pollOnce(deps({ db, forge: g as never }), { dryRun: true });
    expect(first.snapshot.items.find((i) => i.key === 'acme/rocket!7591')).toBeUndefined();
    expect(fetches).toBe(1);
    await pollOnce(deps({ db, forge: g as never }), { dryRun: true });
    expect(fetches).toBe(1); // closed-ref cache held
  });

  it('unions approved MRs into the reviewer set', async () => {
    const g = fakeForge({ approvedMrs: async () => [otherMr('opened')] });
    const result = await pollOnce(deps({ db, forge: g as never }), { dryRun: true });
    expect(result.snapshot.items.find((i) => i.key === 'acme/rocket!7591')?.reason).toBe('reviewer');
  });

  it('hydrates pending mention todos into participating/mentioned items', async () => {
    const g = fakeForge({
      todos: async () => [
        {
          id: 1,
          action_name: 'directly_addressed',
          target_type: 'MergeRequest',
          author: { id: 9, username: 'colleague', name: 'C' },
          created_at: '2026-07-30',
          target: { iid: 7591, project_id: 42, state: 'opened', references: { full: 'acme/rocket!7591' } },
          target_url: '#',
        },
        // A mention on an already-merged MR must not be hydrated at all.
        {
          id: 2,
          action_name: 'mentioned',
          target_type: 'MergeRequest',
          author: { id: 9, username: 'colleague', name: 'C' },
          created_at: '2026-07-30',
          target: { iid: 999, project_id: 42, state: 'merged', references: { full: 'acme/rocket!999' } },
          target_url: '#',
        },
      ],
      mrByProjectId: async () => otherMr('opened'),
    });
    const result = await pollOnce(deps({ db, forge: g as never }), { dryRun: true });
    const item = result.snapshot.items.find((i) => i.key === 'acme/rocket!7591');
    expect(item?.reason).toBe('participating');
    expect(item?.participation).toBe('mentioned');
    expect(result.snapshot.items.find((i) => i.key === 'acme/rocket!999')).toBeUndefined();
  });
});

describe('quiet-cycle carry-forward (C2)', () => {
  const mr = (): ForgeMr =>
    ({
      id: 1,
      iid: 9,
      project_id: 1,
      title: 'MR',
      state: 'opened',
      sha: 'abc',
      source_branch: 'FOO-9',
      target_branch: 'main',
      web_url: '#',
      updated_at: '2026-07-30T11:00:00Z',
      created_at: '2026-07-29T11:00:00Z',
      user_notes_count: 3,
      draft: false,
      has_conflicts: false,
      author: { id: 1, username: 'me', name: 'Me' },
      references: { full: 'acme/rocket!9' },
    }) as ForgeMr;

  const gitlab = () =>
    fakeForge({
      authoredMrs: async () => [mr()],
      discussions: async () => [
        {
          id: 'd1',
          individual_note: false,
          notes: [
            {
              id: 1,
              body: 'fix this',
              author: { id: 2, username: 'reviewer', name: 'R' },
              created_at: '2026-07-30',
              updated_at: '2026-07-30',
              system: false,
              resolvable: true,
              resolved: false,
            },
          ],
        },
      ],
      approvals: async () => ({ approvals_required: 2, approvals_left: 1, approved_by: [{ user: { id: 3, username: 'a', name: 'A' } }] }),
    });

  // Include the MR by recency (no Jira), so scope doesn't depend on tickets.
  const cfg = (): Config => ({ ...config(), recentDaysFallback: 3650 });

  it('keeps unresolved + approvals on a cycle that skips the detail fetch', async () => {
    const g = gitlab();
    const now = () => new Date('2026-07-30T12:00:00Z');
    // Cycle 1 fetches details (new MR); cycle 2 sees unchanged updated_at → skip.
    await pollOnce(deps({ db, forge: g as never, config: cfg(), now }), {});
    const second = await pollOnce(deps({ db, forge: g as never, config: cfg(), now }), {});
    const item = second.snapshot.items.find((i) => i.key === 'acme/rocket!9');
    expect(item).toBeDefined();
    expect(item?.threads).toBeUndefined(); // detail fetch was skipped
    expect(item?.unresolvedFallback).toBe(1); // carried forward, not lost
    expect(item?.approvals).toEqual({ required: 2, left: 1, by: ['a'] });
  });
});


describe('refreshItem (the Copy-for-Slack freshness pass)', () => {
  it('re-fetches the MR row, forces the discussions fetch, and re-resolves CI', async () => {
    db.setRepoRoles('acme/rocket', { testGate: 'none', gitlabIsLintOnly: false, detectedAt: 'now' });
    const item = {
      key: 'acme/rocket!5',
      projectPath: 'acme/rocket',
      projectId: 1,
      iid: 5,
      branch: 'ENG-5',
      targetBranch: 'main',
      title: 'stale title',
      headSha: 'stale-sha',
      webUrl: '#',
      updatedAt: 'old',
      createdAt: 'old',
      userNotesCount: 0,
      draft: true, // stale: the fresh fetch says otherwise
      hasConflicts: false,
      reason: 'authored' as const,
      inScope: true,
      unresolvedFallback: 4, // stale count that fresh threads must supersede
    };
    const forge = fakeForge({
      mrByProjectId: async () => ({
        id: 5,
        iid: 5,
        project_id: 1,
        title: 'ENG-5: fresh title',
        state: 'opened',
        sha: 'fresh-sha',
        source_branch: 'ENG-5',
        target_branch: 'main',
        web_url: '#',
        updated_at: 'new',
        created_at: 'old',
        user_notes_count: 2,
        draft: false,
        has_conflicts: false,
        author: { id: 1, username: 'me', name: 'Me' },
        references: { full: 'acme/rocket!5' },
      }),
      discussions: async () => [],
    });
    await refreshItem(deps({ db, forge: forge as never }) , item as never);
    expect(item.title).toBe('ENG-5: fresh title');
    expect(item.headSha).toBe('fresh-sha');
    expect(item.draft).toBe(false);
    expect((item as { threads?: unknown[] }).threads).toEqual([]); // forced fetch
    expect((item as { testGate?: { kind: string } }).testGate?.kind).toBe('none');
  });
});
