import { beforeEach, describe, expect, it } from 'vitest';
import { Db } from '../src/core/db';
import { DEFAULT_CONFIG, type Config } from '../src/core/config';
import { ruleTarget } from '../src/core/rules';
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

describe('non-active tickets between Jira refreshes', () => {
  // An authored MR in scope via recentDaysFallback, whose ticket is NOT in an
  // active status — so its ticket comes from the by-key harvest, which only
  // runs on a Jira refresh. On the cycles in between, the ticket is rebuilt
  // from the MR row; if that rebuild is status-only, fixVersions reads as
  // UNKNOWN and every `empty` rule quietly takes its else branch.
  const mr = (): ForgeMr =>
    ({
      id: 1,
      iid: 7690,
      project_id: 1,
      title: 'ENG-121: Capture callback timeouts',
      state: 'opened',
      sha: 'abc',
      source_branch: 'ENG-121',
      target_branch: 'main',
      web_url: '#',
      updated_at: '2026-07-30T11:00:00Z',
      created_at: '2026-07-29T11:00:00Z',
      user_notes_count: 0,
      draft: false,
      has_conflicts: false,
      author: { id: 1, username: 'me', name: 'Me' },
      references: { full: 'acme/rocket!7690' },
    }) as ForgeMr;

  const devComplete: JiraTicket = {
    key: 'ENG-121',
    summary: 'Capture callback timeouts',
    status: 'Dev Complete',
    updated: '2026-07-30T10:00:00Z',
    url: '#',
    issueType: 'Story',
    fixVersions: [], // known-empty: the ticket has none assigned
  };
  // One genuinely active ticket, so the cached set is non-empty and the next
  // cycle is a real cadence miss rather than another refresh.
  const active: JiraTicket = { key: 'ENG-1', summary: '', status: 'Code Review', updated: '', url: '#' };

  const cfg = (): Config => ({
    ...config(),
    recentDaysFallback: 14, // what puts an MR with no active ticket in scope
  });

  const jira = (over: Partial<Record<string, unknown>> = {}) => ({
    configured: true,
    search: async () => [active],
    searchByKeys: async () => [devComplete],
    ...over,
  });

  const ticketOf = (result: Awaited<ReturnType<typeof pollOnce>>) =>
    result.snapshot.items.find((i) => i.iid === 7690)?.ticket;

  it('carries the full ticket on the refreshing cycle', async () => {
    const forge = fakeForge({ authoredMrs: async () => [mr()] });
    const result = await pollOnce(deps({ db, forge: forge as never, jira: jira() as never, config: cfg() }), {});
    expect(ticketOf(result)?.status).toBe('Dev Complete');
    expect(ticketOf(result)?.fixVersions).toEqual([]);
  });

  it('still knows fixVersions is empty on the next cycle, without asking Jira', async () => {
    const forge = fakeForge({ authoredMrs: async () => [mr()] });
    await pollOnce(deps({ db, forge: forge as never, jira: jira() as never, config: cfg() }), {});
    // Same clock → inside refreshMinutes → no Jira refresh, no harvest. A
    // searchByKeys call here is a bug in its own right, so make it fatal.
    const offline = jira({
      search: async () => {
        throw new Error('should not refresh inside the TTL');
      },
      searchByKeys: async () => {
        throw new Error('should not harvest on a cadence miss');
      },
    });
    const second = await pollOnce(deps({ db, forge: forge as never, jira: offline as never, config: cfg() }), {});
    const ticket = ticketOf(second);
    expect(ticket?.status).toBe('Dev Complete'); // grouping preserved, as before
    expect(ticket?.fixVersions).toEqual([]); // ...and the field is KNOWN-empty
    expect(ticket?.issueType).toBe('Story'); // the other rule fields survive too
    // The symptom this fixes: the default Dev Complete rule must reach its
    // needs-value branch on a miss cycle, not fall through to Verification.
    expect(ruleTarget(DEFAULT_CONFIG.statusRules, ticket, new Date('2026-07-30T12:00:00Z'), 'acme/rocket'))
      .toBe('needs-value');
  });

  it('falls back to status-only for a row written before this column existed', async () => {
    const at = '2026-07-30T12:00:00Z';
    // An upgraded install: a cached active set (so the cycle is a miss) and an
    // MR row carrying only the ticket's status, exactly as older builds wrote it.
    db.replaceJiraTickets([active], at);
    db.upsertMr(
      {
        key: 'acme/rocket!7690',
        project_path: 'acme/rocket',
        project_id: 1,
        iid: 7690,
        branch: 'ENG-121',
        title: 'ENG-121: Capture callback timeouts',
        head_sha: 'abc',
        web_url: '#',
        updated_at: '2026-07-30T11:00:00Z',
        user_notes_count: 0,
        unresolved: 0,
        approvals_left: null,
        approvals_required: null,
        approvals_by: null,
        has_conflicts: 0,
        in_scope: 1,
        reason: 'authored',
        ticket_key: 'ENG-121',
        ticket_status: 'Dev Complete',
        ticket_json: null, // the pre-migration state
        unverified_count: null,
        unverified_sha: null,
      },
      at,
    );
    const forge = fakeForge({ authoredMrs: async () => [mr()] });
    const offline = jira({
      searchByKeys: async () => {
        throw new Error('should not harvest on a cadence miss');
      },
    });
    const result = await pollOnce(deps({ db, forge: forge as never, jira: offline as never, config: cfg() }), {});
    const ticket = ticketOf(result);
    expect(ticket?.status).toBe('Dev Complete'); // still grouped by status
    expect(ticket?.fixVersions).toBeUndefined(); // and honestly unknown, not []
  });
});

describe('a hand-pressed poll refreshes Jira', () => {
  // "Poll now" that re-reads GitLab but serves a ten-minute-old ticket status
  // is indistinguishable from a broken poll — you press it precisely because
  // you just moved a ticket in Jira.
  const inDev: JiraTicket = { key: 'ENG-1', summary: '', status: 'In Development', updated: '', url: '#' };
  const inReview: JiraTicket = { ...inDev, status: 'Code Review' };
  const at = '2026-07-30T11:59:00Z'; // one minute old: well inside refreshMinutes

  // A refresh runs two queries: the scope query, plus the status-name harvest.
  // Count the scope one so the assertions say what they mean.
  const jira = () => {
    const jqls: string[] = [];
    return {
      source: {
        configured: true,
        search: async (jql: string) => {
          jqls.push(jql);
          return [inReview];
        },
        searchByKeys: async () => [],
      },
      scopeQueries: () => jqls.filter((q) => q.includes('status IN')).length,
    };
  };

  it('serves the cached status on a timer cycle', async () => {
    db.replaceJiraTickets([inDev], at);
    const j = jira();
    const result = await pollOnce(deps({ db, jira: j.source as never }), {});
    expect(result.snapshot.activeTickets[0]?.status).toBe('In Development');
    expect(j.scopeQueries()).toBe(0); // the cadence is the point of the cadence
  });

  it('re-reads Jira when the cycle was requested by hand', async () => {
    db.replaceJiraTickets([inDev], at);
    const j = jira();
    const result = await pollOnce(deps({ db, jira: j.source as never }), { forceJira: true });
    expect(result.snapshot.activeTickets[0]?.status).toBe('Code Review');
    expect(j.scopeQueries()).toBe(1);
    // ...and the refreshed set replaces the cache, so the next timer cycle
    // doesn't hand the stale status straight back.
    expect(db.cachedJiraTickets().tickets[0]?.status).toBe('Code Review');
  });
});

describe('re-running a failed suite (the in-flight bridge)', () => {
  // A branch whose newest RWX result for the head commit is a FAILURE, plus a
  // watched run we just started for that same commit. RWX's list is eventually
  // consistent, so it still reports only the old failure for a cycle or two.
  const HEAD = 'abc1234000000000';
  const mr = (): ForgeMr =>
    ({
      id: 3,
      iid: 7812,
      project_id: 1,
      title: 'ENG-140: Something',
      state: 'opened',
      sha: HEAD,
      source_branch: 'ENG-140',
      target_branch: 'main',
      web_url: '#',
      updated_at: '2026-07-30T11:00:00Z',
      created_at: '2026-07-29T11:00:00Z',
      user_notes_count: 0,
      draft: false,
      has_conflicts: false,
      author: { id: 1, username: 'me', name: 'Me' },
      references: { full: 'acme/rocket!7812' },
    }) as ForgeMr;

  const failedRun = (): RwxRun => ({
    ID: 'failed-run',
    Branch: 'ENG-140',
    CommitSha: HEAD,
    DefinitionPath: '.rwx/ci.yml',
    RepositoryName: 'rocket',
    RunUrl: 'https://cloud.rwx.com/acme/runs/failed-run',
    Title: 'ENG-140',
    Trigger: 'push',
    CreatedAt: '2026-07-30T10:00:00Z',
    StartedAt: '2026-07-30T10:00:00Z',
    CompletedAt: '2026-07-30T10:20:00Z',
    Status: { Execution: 'finished', Result: 'failed' },
  });

  const gateFor = async (withWatchedRun: boolean) => {
    const forge = fakeForge({ authoredMrs: async () => [mr()] });
    const rwx = fakeRwx({ recentRuns: async () => [failedRun()] });
    if (withWatchedRun) {
      db.addWatchedRun({
        run_id: 'fresh-run',
        provider: 'rwx',
        mr_key: 'acme/rocket!7812',
        branch: 'ENG-140',
        sha: HEAD,
        definition: '.rwx/ci.yml',
        url: 'https://cloud.rwx.com/acme/runs/fresh-run',
        started_at: '2026-07-30T11:59:00Z',
        terminal: 0,
        result: null,
      });
    }
    // recentDaysFallback puts the MR in scope without needing Jira at all.
    const cfg: Config = { ...config(), recentDaysFallback: 3650 };
    const result = await pollOnce(deps({ db, forge: forge as never, rwx: rwx as never, config: cfg }), {});
    return result.snapshot.items.find((i) => i.iid === 7812)?.testGate;
  };

  it('reports the failure when nothing is in flight', async () => {
    expect(await gateFor(false)).toMatchObject({ kind: 'verified', result: 'failed' });
  });

  it('shows the re-run as in flight instead of the old failure', async () => {
    // Without this the next cycle re-serves the stale failure, the row offers
    // Re-run again, and a second duplicate run is one click away.
    expect(await gateFor(true)).toMatchObject({
      kind: 'in_progress',
      provider: 'rwx',
      url: 'https://cloud.rwx.com/acme/runs/fresh-run',
    });
  });
});

describe('reviewer freshness (commits since my last review)', () => {
  const HEAD = 'head1234';
  const MY_COMMENT = '2026-07-30T11:00:00Z';
  const mr = (over: Partial<ForgeMr> = {}): ForgeMr =>
    ({
      id: 4,
      iid: 7900,
      project_id: 1,
      title: 'ENG-150: Their work',
      state: 'opened',
      sha: HEAD,
      source_branch: 'ENG-150',
      target_branch: 'main',
      web_url: '#',
      updated_at: '2026-07-30T11:30:00Z',
      created_at: '2026-07-29T11:00:00Z',
      user_notes_count: 1,
      draft: false,
      has_conflicts: false,
      author: { id: 2, username: 'alex.harper', name: 'Alex' },
      references: { full: 'acme/rocket!7900' },
      ...over,
    }) as ForgeMr;

  /** One discussion holding a comment of mine at MY_COMMENT. */
  const myComment = () => [
    {
      id: 'T1',
      individual_note: false,
      notes: [
        {
          id: 1,
          body: 'please rename this',
          author: { id: 1, username: 'me', name: 'Me' },
          created_at: MY_COMMENT,
          updated_at: MY_COMMENT,
          system: false,
          resolvable: true,
          resolved: false,
        },
      ],
    },
  ];

  // `head` matters: head_committed_at is cached per sha, so two runs in one
  // test need different heads or the second reads the first's cached date.
  const run = async (opts: { committedDate: string; reviewer?: boolean; head?: string }) => {
    let commitCalls = 0;
    const rows = [mr({ sha: opts.head ?? HEAD })];
    const forge = fakeForge({
      ...(opts.reviewer === false ? { authoredMrs: async () => rows } : { reviewerMrs: async () => rows }),
      discussions: async () => myComment(),
      commits: async () => {
        commitCalls += 1;
        return [{ id: HEAD, title: 'their fix', committed_date: opts.committedDate }];
      },
    });
    const cfg: Config = { ...config(), recentDaysFallback: 3650 };
    const first = await pollOnce(deps({ db, forge: forge as never, config: cfg }), {});
    const again = await pollOnce(deps({ db, forge: forge as never, config: cfg }), {});
    const pick = (r: Awaited<ReturnType<typeof pollOnce>>) => r.snapshot.items.find((i) => i.iid === 7900);
    return { first: pick(first), again: pick(again), commitCalls: () => commitCalls };
  };

  it('flags an MR I review whose head is newer than my comment', async () => {
    const r = await run({ committedDate: '2026-07-30T11:20:00Z' });
    expect(r.first?.myLastCommentAt).toBe(MY_COMMENT);
    expect(r.first?.newCommits).toBe(1);
  });

  it('does not flag a head older than my comment', async () => {
    const r = await run({ committedDate: '2026-07-30T10:00:00Z' });
    expect(r.first?.newCommits).toBe(0);
  });

  it('compares instants, not strings, across timezone offsets', async () => {
    // 04:20-0700 IS 11:20Z — later than my 11:00Z comment. Lexically, '0' < '1'
    // puts it first, which would silently mark a fresh push as old.
    const later = await run({ committedDate: '2026-07-30T04:20:00-0700', head: 'h-later' });
    expect(later.first?.newCommits).toBe(1);
    // And 03:00-0700 IS 10:00Z — genuinely earlier, despite sorting later.
    const earlier = await run({ committedDate: '2026-07-30T03:00:00-0700', head: 'h-earlier' });
    expect(earlier.first?.newCommits).toBe(0);
  });

  it('fetches the commit list once per head, not once per cycle', async () => {
    const r = await run({ committedDate: '2026-07-30T11:20:00Z' });
    expect(r.again?.newCommits).toBe(1); // still right on the next cycle
    expect(r.commitCalls()).toBe(1); // ...without asking again
  });

  it('asks nothing of my own MRs', async () => {
    // "I pushed after I commented on my own MR" is just Tuesday.
    const r = await run({ committedDate: '2026-07-30T11:20:00Z', reviewer: false });
    expect(r.first?.newCommits).toBeFalsy();
    expect(r.commitCalls()).toBe(0);
  });

  it('claims nothing when the commit list is unavailable', async () => {
    const forge = fakeForge({
      reviewerMrs: async () => [mr()],
      discussions: async () => myComment(),
      commits: async () => {
        throw new Error('commits unavailable');
      },
    });
    const cfg: Config = { ...config(), recentDaysFallback: 3650 };
    const result = await pollOnce(deps({ db, forge: forge as never, config: cfg }), {});
    const item = result.snapshot.items.find((i) => i.iid === 7900);
    expect(item?.myLastCommentAt).toBe(MY_COMMENT); // known
    expect(item?.newCommits).toBe(0); // but never guessed
  });
});

describe('backfilling my comment history', () => {
  // A row written before my_last_comment_at existed: NULL means "never read".
  // One fetch settles it, and "read, none of mine" is recorded as '' so the
  // fetch does not repeat every cycle forever.
  const mr = (): ForgeMr =>
    ({
      id: 5,
      iid: 7950,
      project_id: 1,
      title: 'ENG-160: Their work',
      state: 'opened',
      sha: 'sha7950',
      source_branch: 'ENG-160',
      target_branch: 'main',
      web_url: '#',
      updated_at: '2026-07-30T11:00:00Z',
      created_at: '2026-07-29T11:00:00Z',
      user_notes_count: 2,
      draft: false,
      has_conflicts: false,
      author: { id: 2, username: 'alex.harper', name: 'Alex' },
      references: { full: 'acme/rocket!7950' },
    }) as ForgeMr;

  const discussion = (author: string) => [
    {
      id: 'T1',
      individual_note: false,
      notes: [
        {
          id: 7,
          body: 'a note',
          author: { id: 9, username: author, name: author },
          created_at: '2026-07-30T10:00:00Z',
          updated_at: '2026-07-30T10:00:00Z',
          system: false,
          resolvable: true,
          resolved: false,
        },
      ],
    },
  ];

  const cycles = async (author: string) => {
    let fetches = 0;
    const forge = fakeForge({
      reviewerMrs: async () => [mr()],
      discussions: async () => {
        fetches += 1;
        return discussion(author);
      },
      commits: async () => [{ id: 'sha7950', title: 'x', committed_date: '2026-07-30T11:30:00Z' }],
    });
    const cfg: Config = { ...config(), recentDaysFallback: 3650 };
    await pollOnce(deps({ db, forge: forge as never, config: cfg }), {});
    const after = fetches;
    await pollOnce(deps({ db, forge: forge as never, config: cfg }), {});
    await pollOnce(deps({ db, forge: forge as never, config: cfg }), {});
    return { firstCycleFetches: after, totalFetches: fetches, row: () => db.getMr('acme/rocket!7950') };
  };

  it('records my newest comment, then stops asking', async () => {
    const r = await cycles('me');
    expect(r.row()?.my_last_comment_at).toBe('2026-07-30T10:00:00Z');
    expect(r.totalFetches).toBe(r.firstCycleFetches); // quiet cycles ask nothing more
  });

  it("records 'read, none of mine' so the backfill fires once, not forever", async () => {
    const r = await cycles('alex.harper');
    expect(r.row()?.my_last_comment_at).toBe(''); // distinct from NULL
    expect(r.totalFetches).toBe(r.firstCycleFetches);
  });
});

describe('counting new commits since my last review', () => {
  // The count exists so the wording can be singular or plural, so it has to be
  // exact — and it has to fall to zero when I comment again, on the very next
  // cycle, without another commit fetch.
  const HEAD = 'countinghead';
  const mr = (): ForgeMr =>
    ({
      id: 6,
      iid: 7970,
      project_id: 1,
      title: 'ENG-170: Their work',
      state: 'opened',
      sha: HEAD,
      source_branch: 'ENG-170',
      target_branch: 'main',
      web_url: '#',
      updated_at: '2026-07-30T12:00:00Z',
      created_at: '2026-07-29T11:00:00Z',
      user_notes_count: 1,
      draft: false,
      has_conflicts: false,
      author: { id: 2, username: 'alex.harper', name: 'Alex' },
      references: { full: 'acme/rocket!7970' },
    }) as ForgeMr;

  const myCommentAt = (at: string) => [
    {
      id: 1,
      individual_note: false,
      notes: [
        {
          id: 1,
          body: 'take another look at this',
          author: { id: 1, username: 'me', name: 'Me' },
          created_at: at,
          updated_at: at,
          system: false,
          resolvable: true,
          resolved: false,
        },
      ],
      // discussion id must be a string for summarizeThreads
      ...{ id: 'T1' },
    },
  ];

  /** Three commits: two after my 11:00 comment, one before. */
  const commits = () => [
    { id: 'c3', title: 'third', committed_date: '2026-07-30T11:40:00Z' },
    { id: 'c2', title: 'second', committed_date: '2026-07-30T11:20:00Z' },
    { id: 'c1', title: 'first', committed_date: '2026-07-30T10:00:00Z' },
  ];

  const run = async (commentAt: string) => {
    let commitCalls = 0;
    const forge = fakeForge({
      reviewerMrs: async () => [mr()],
      discussions: async () => myCommentAt(commentAt),
      commits: async () => {
        commitCalls += 1;
        return commits();
      },
    });
    const cfg: Config = { ...config(), recentDaysFallback: 3650 };
    const first = await pollOnce(deps({ db, forge: forge as never, config: cfg }), {});
    const again = await pollOnce(deps({ db, forge: forge as never, config: cfg }), {});
    const pick = (r: Awaited<ReturnType<typeof pollOnce>>) => r.snapshot.items.find((i) => i.iid === 7970);
    return { first: pick(first), again: pick(again), commitCalls: () => commitCalls };
  };

  it('counts only the commits newer than my comment', async () => {
    const r = await run('2026-07-30T11:00:00Z');
    expect(r.first?.newCommits).toBe(2); // 11:20 and 11:40, not 10:00
  });

  it('keeps the exact count on a cycle that does not refetch', async () => {
    const r = await run('2026-07-30T11:00:00Z');
    expect(r.again?.newCommits).toBe(2);
    expect(r.commitCalls()).toBe(1);
  });

  it('falls to zero once I comment after the newest commit', async () => {
    // Recomputed from the cached dates, so a later comment settles it with no
    // extra fetch — the reason the dates are cached rather than a single flag.
    const r = await run('2026-07-30T12:00:00Z');
    expect(r.first?.newCommits).toBe(0);
    expect(r.again?.newCommits).toBe(0);
  });
});
