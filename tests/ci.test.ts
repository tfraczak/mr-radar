import { describe, expect, it } from 'vitest';
import {
  countUnverifiedCommits,
  detectRepoRoles,
  gitlabCheckFor,
  newestCompletedRun,
  newestPipelinePerSha,
  pipelineRunsTests,
  resolveTestGate,
  rwxChecksFor,
  rwxRunsFor,
} from '../src/core/ci';
import { isCompleted } from '../src/core/sources/rwx';
import type { GitlabCommit, GitlabJob, GitlabPipeline, RepoCiRoles, RwxRun } from '../src/core/types';
import rwxEng118 from './fixtures/rwx-eng118.json';
import commitsEng118 from './fixtures/commits-eng118.json';
import pipelinesGadget from './fixtures/pipelines-gadget.json';
import pipelinesRocket from './fixtures/pipelines-rocket.json';

const RWX_RUNS = rwxEng118 as unknown as RwxRun[];
const COMMITS = commitsEng118 as unknown as GitlabCommit[];
const GADGET_PIPELINES = pipelinesGadget as unknown as GitlabPipeline[];
const ROCKET_PIPELINES = pipelinesRocket as unknown as GitlabPipeline[];

const NOW = '2026-07-29T00:00:00.000Z';
const CI_YML = '.rwx/ci.yml';

/** Real job names, kept literal so the classification contract is readable. */
const ROCKET_JOBS: GitlabJob[] = [
  { id: 1, name: 'ruby::lint::report', stage: 'lint', status: 'success', web_url: '' },
  { id: 2, name: 'ruby::lint', stage: 'lint', status: 'success', web_url: '' },
];
const GADGET_JOBS: GitlabJob[] = [
  { id: 1, name: 'ruby::lint::report', stage: 'test', status: 'success', web_url: '' },
  { id: 2, name: 'ruby::lint::rubocop', stage: 'test', status: 'success', web_url: '' },
  { id: 3, name: 'ruby::rspec::3.3.7', stage: 'test', status: 'success', web_url: '' },
  { id: 4, name: 'ruby::rspec::3.2.8', stage: 'test', status: 'success', web_url: '' },
  { id: 5, name: 'ruby::rspec::current', stage: 'test', status: 'success', web_url: '' },
];

const roles = (over: Partial<RepoCiRoles> = {}): RepoCiRoles => ({
  testGate: 'rwx',
  gitlabIsLintOnly: false,
  detectedAt: NOW,
  ...over,
});

describe('pipelineRunsTests', () => {
  it('classifies by job name, not stage', () => {
    // gadget puts ruby::lint::rubocop in a stage literally called "test", so
    // classifying by stage would call its lint jobs tests.
    expect(GADGET_JOBS.every((j) => j.stage === 'test')).toBe(true);
    expect(pipelineRunsTests(GADGET_JOBS)).toBe(true);
    expect(pipelineRunsTests(ROCKET_JOBS)).toBe(false);
  });

  it('treats a pipeline with zero jobs as running no tests', () => {
    // ops-scripts reports `success` with no jobs at all. A green pipeline
    // that ran nothing must never count as verification.
    expect(pipelineRunsTests([])).toBe(false);
  });

  it('does not mistake type-check or lint for tests', () => {
    const jobs: GitlabJob[] = [
      { id: 1, name: 'type-check', stage: 'x', status: 'success', web_url: '' },
      { id: 2, name: 'lint', stage: 'x', status: 'success', web_url: '' },
      { id: 3, name: 'audit', stage: 'x', status: 'success', web_url: '' },
    ];
    expect(pipelineRunsTests(jobs)).toBe(false);
  });
});

describe('detectRepoRoles', () => {
  it('picks RWX for rocket, whose pipeline is lint-only', () => {
    const r = detectRepoRoles({
      projectPath: 'acme/rocket',
      hasRwxRuns: true,
      hasPipelines: true,
      latestPipelineJobs: ROCKET_JOBS,
      now: NOW,
    });
    expect(r.testGate).toBe('rwx');
    expect(r.gitlabIsLintOnly).toBe(true);
  });

  it('picks GitLab for gadget, which has rspec jobs and no RWX', () => {
    const r = detectRepoRoles({
      projectPath: 'acme/gadget',
      hasRwxRuns: false,
      hasPipelines: true,
      latestPipelineJobs: GADGET_JOBS,
      now: NOW,
    });
    expect(r.testGate).toBe('gitlab');
    expect(r.gitlabIsLintOnly).toBe(false);
  });

  it('picks none for ops-scripts: pipelines exist but run nothing', () => {
    const r = detectRepoRoles({
      projectPath: 'acme/ops-scripts',
      hasRwxRuns: false,
      hasPipelines: true,
      latestPipelineJobs: [],
      now: NOW,
    });
    expect(r.testGate).toBe('none');
  });

  it('picks none when there is no CI at all', () => {
    const r = detectRepoRoles({
      projectPath: 'x/y',
      hasRwxRuns: false,
      hasPipelines: false,
      now: NOW,
    });
    expect(r.testGate).toBe('none');
    expect(r.gitlabIsLintOnly).toBe(false);
  });

  it('never reports lint-only alongside a gitlab test gate', () => {
    // This combination is a contradiction, and an earlier version emitted it by
    // guessing from jobs it had not fetched.
    const r = detectRepoRoles({
      projectPath: 'acme/gadget',
      hasRwxRuns: false,
      hasPipelines: true,
      override: 'gitlab',
      now: NOW,
    });
    expect(r.testGate).toBe('gitlab');
    expect(r.gitlabIsLintOnly).toBe(false);
  });

  it('does not claim lint-only without having inspected jobs', () => {
    const r = detectRepoRoles({
      projectPath: 'acme/rocket',
      hasRwxRuns: true,
      hasPipelines: true,
      override: 'rwx',
      now: NOW,
    });
    expect(r.gitlabIsLintOnly).toBe(false);
  });
});

describe('RWX coverage on ENG-118', () => {
  const HEAD = '98f705d475d9c2baf1d25006cc93e084c2650cea';

  it('has a waiting ci.yml run for the head commit', () => {
    const ciRuns = rwxRunsFor(RWX_RUNS, 'ENG-118', CI_YML);
    const head = ciRuns.find((r) => r.CommitSha === HEAD);
    expect(head?.Status.Execution).toBe('waiting');
  });

  it('treats waiting as NOT coverage', () => {
    // The crux of the whole model. Every .rwx/ci.yml run on this branch is
    // waiting, so the spec suite has never actually run.
    const ciRuns = rwxRunsFor(RWX_RUNS, 'ENG-118', CI_YML);
    expect(ciRuns.length).toBeGreaterThan(5);
    expect(ciRuns.every((r) => !isCompleted(r))).toBe(true);
    expect(newestCompletedRun(ciRuns)).toBeUndefined();
  });

  it('reports the gate as unverified and startable, never verified', () => {
    const gate = resolveTestGate({
      roles: roles({ testGate: 'rwx' }),
      headSha: HEAD,
      branch: 'ENG-118',
      rwxRuns: RWX_RUNS,
      rwxTestDefinition: CI_YML,
      pipelines: [],
      commits: COMMITS,
    });
    expect(gate.kind).toBe('unverified');
    if (gate.kind !== 'unverified') throw new Error('unreachable');
    expect(gate.provider).toBe('rwx');
    expect(gate.startable).toBe(true);
    expect(gate.unverifiedCommits).toBe('many'); // never verified
    expect(gate.url).toContain('cloud.rwx.com'); // links the waiting run
  });

  it('carries no lastResult when the suite has never produced a result', () => {
    const gate = resolveTestGate({
      roles: roles({ testGate: 'rwx' }),
      headSha: HEAD,
      branch: 'ENG-118',
      rwxRuns: RWX_RUNS,
      rwxTestDefinition: CI_YML,
      pipelines: [],
      commits: COMMITS,
    });
    if (gate.kind !== 'unverified') throw new Error('unreachable');
    expect(gate.lastResult).toBeUndefined(); // truly never run — not merely stale
  });

  it('distinguishes a stale run: completed on an older commit, counted by sha', () => {
    // A run that finished on the 3rd-newest commit. Identity is CommitSha, not
    // timestamps — rebases make ENG-118's commit dates collide.
    const older = (COMMITS[2] as GitlabCommit).id;
    const staleRun: RwxRun = {
      ...(RWX_RUNS[0] as RwxRun),
      ID: 'stale-run',
      CommitSha: older,
      DefinitionPath: CI_YML,
      Status: {
        Execution: 'finished',
        Result: 'succeeded',
        WaitingSubStatus: 'not_applicable',
        AbortedSubStatus: 'not_applicable',
        FinishedSubStatus: 'not_applicable',
      },
      CreatedAt: '2026-07-20T00:00:00.000Z',
      CompletedAt: '2026-07-20T01:00:00.000Z',
    };
    const gate = resolveTestGate({
      roles: roles({ testGate: 'rwx' }),
      headSha: HEAD,
      branch: 'ENG-118',
      rwxRuns: [staleRun, ...RWX_RUNS],
      rwxTestDefinition: CI_YML,
      pipelines: [],
      commits: COMMITS,
    });
    if (gate.kind !== 'unverified') throw new Error('unreachable');
    expect(gate.lastResult).toMatchObject({ result: 'succeeded', sha: older });
    expect(gate.lastResult?.completedAt).toBe('2026-07-20T01:00:00.000Z');
    expect(gate.unverifiedCommits).toBe(2); // head + 1 sit on top of the covered sha
    expect(gate.startable).toBe(true); // stale still wants a fresh run
  });

  it('carries a stale FAILED verdict so it can be surfaced as urgent', () => {
    const older = (COMMITS[1] as GitlabCommit).id;
    const failedRun: RwxRun = {
      ...(RWX_RUNS[0] as RwxRun),
      ID: 'stale-failed',
      CommitSha: older,
      DefinitionPath: CI_YML,
      Status: {
        Execution: 'finished',
        Result: 'failed',
        WaitingSubStatus: 'not_applicable',
        AbortedSubStatus: 'not_applicable',
        FinishedSubStatus: 'not_applicable',
      },
      CreatedAt: '2026-07-20T00:00:00.000Z',
      CompletedAt: null,
    };
    const gate = resolveTestGate({
      roles: roles({ testGate: 'rwx' }),
      headSha: HEAD,
      branch: 'ENG-118',
      rwxRuns: [failedRun, ...RWX_RUNS],
      rwxTestDefinition: CI_YML,
      pipelines: [],
      commits: COMMITS,
    });
    if (gate.kind !== 'unverified') throw new Error('unreachable');
    expect(gate.lastResult?.result).toBe('failed');
    expect(gate.lastResult?.completedAt).toBeUndefined(); // null stays absent
    expect(gate.unverifiedCommits).toBe(1);
  });

  it('attributes CLI-triggered runs by title when Branch is empty', () => {
    // A run started via script/rwx (or our Start-run button): RWX records NO
    // branch metadata — only the "<branch> - <email>" title convention.
    // Verified live on ENG-132: a green run invisible to every --branch filter.
    const cliRun: RwxRun = {
      ...(RWX_RUNS[0] as RwxRun),
      ID: 'cli-run',
      Branch: '',
      CommitSha: HEAD, // as hydrated from `runs show` Init["Commit-sha"]
      DefinitionPath: CI_YML,
      Title: 'ENG-118 - mira.dev@acme.com',
      Trigger: 'cli',
      Status: {
        Execution: 'finished',
        Result: 'succeeded',
        WaitingSubStatus: 'not_applicable',
        AbortedSubStatus: 'not_applicable',
        FinishedSubStatus: 'not_applicable',
      },
      CreatedAt: '2026-07-30T00:00:00.000Z',
    };
    expect(rwxRunsFor([cliRun], 'ENG-118', CI_YML)).toHaveLength(1);
    const gate = resolveTestGate({
      roles: roles({ testGate: 'rwx' }),
      headSha: HEAD,
      branch: 'ENG-118',
      rwxRuns: [cliRun, ...RWX_RUNS],
      rwxTestDefinition: CI_YML,
      pipelines: [],
      commits: COMMITS,
    });
    expect(gate.kind).toBe('verified');
    if (gate.kind !== 'verified') throw new Error('unreachable');
    expect(gate.result).toBe('succeeded');
  });

  it('still sees frontend-ci.yml succeeding, and does not let it count', () => {
    // The MR looks healthy precisely because this one is green.
    const flow = rwxRunsFor(RWX_RUNS, 'ENG-118', '.rwx/frontend-ci.yml');
    expect(flow.some(isCompleted)).toBe(true);

    const checks = rwxChecksFor(RWX_RUNS, 'ENG-118', HEAD);
    const testsCheck = checks.find((c) => c.role === 'tests');
    const otherCheck = checks.find((c) => c.name === '.rwx/frontend-ci.yml');
    expect(testsCheck?.name).toBe(CI_YML);
    expect(testsCheck?.state).toBe('waiting');
    expect(otherCheck?.role).toBe('lint'); // informational, not the gate
    expect(otherCheck?.state).toBe('succeeded');
  });

  it('reports verified once a completed run exists for the head', () => {
    const completed: RwxRun = {
      ...(RWX_RUNS[0] as RwxRun),
      ID: 'synthetic',
      CommitSha: HEAD,
      DefinitionPath: CI_YML,
      Status: {
        Execution: 'finished',
        Result: 'succeeded',
        WaitingSubStatus: 'not_applicable',
        AbortedSubStatus: 'not_applicable',
        FinishedSubStatus: 'not_applicable',
      },
      CreatedAt: '2026-07-29T00:00:00.000Z',
    };
    const gate = resolveTestGate({
      roles: roles({ testGate: 'rwx' }),
      headSha: HEAD,
      branch: 'ENG-118',
      rwxRuns: [completed, ...RWX_RUNS],
      rwxTestDefinition: CI_YML,
      pipelines: [],
      commits: COMMITS,
    });
    expect(gate.kind).toBe('verified');
    if (gate.kind !== 'verified') throw new Error('unreachable');
    expect(gate.result).toBe('succeeded');
  });

  it('ignores runs for other branches', () => {
    expect(rwxRunsFor(RWX_RUNS, 'ENG-999', CI_YML)).toEqual([]);
  });
});

describe('countUnverifiedCommits', () => {
  it('uses ancestry order, not timestamps', () => {
    // ENG-118 was rebased, so several commits share an identical
    // committed_date — 19 commits across only 14 distinct timestamps. Any
    // date-based ordering is therefore ambiguous; list position is not.
    const dates = COMMITS.map((c) => c.committed_date);
    expect(new Set(dates).size).toBeLessThan(COMMITS.length);

    // Take the *second* commit of a same-timestamp pair. Sorting by date could
    // legitimately place it either side of its twin; ancestry order cannot.
    const twinIndex = COMMITS.findIndex(
      (c, i) => i > 0 && COMMITS[i - 1]?.committed_date === c.committed_date,
    );
    expect(twinIndex).toBeGreaterThan(0);

    const twin = COMMITS[twinIndex];
    if (!twin) throw new Error('fixture too short');
    expect(countUnverifiedCommits(COMMITS, new Set([twin.id]))).toBe(twinIndex);

    // And its twin, one position earlier, must count one fewer despite the
    // identical timestamp.
    const earlier = COMMITS[twinIndex - 1];
    if (!earlier) throw new Error('fixture too short');
    expect(countUnverifiedCommits(COMMITS, new Set([earlier.id]))).toBe(twinIndex - 1);
  });

  it('returns 0 when the head itself is covered', () => {
    const head = COMMITS[0];
    if (!head) throw new Error('fixture too short');
    expect(countUnverifiedCommits(COMMITS, new Set([head.id]))).toBe(0);
  });

  it('returns "many" when nothing is covered', () => {
    expect(countUnverifiedCommits(COMMITS, new Set())).toBe('many');
  });

  it('returns "many" rather than paging when coverage is off the page', () => {
    // ENG-126 carries 288 commits; an exact count that far back is worthless.
    expect(countUnverifiedCommits(COMMITS, new Set(['sha-not-in-page']))).toBe('many');
  });
});

describe('GitLab pipeline coverage', () => {
  it('groups by sha, since one push yields two pipelines with different refs', () => {
    const mrEvent = ROCKET_PIPELINES.find((p) => p.source === 'merge_request_event');
    const push = ROCKET_PIPELINES.find((p) => p.source === 'push');
    expect(mrEvent?.ref).toMatch(/^refs\/merge-requests\/\d+\/head$/);
    expect(push?.ref).not.toMatch(/^refs\//);

    // Same sha, two refs — grouping by ref would split them.
    const shared = ROCKET_PIPELINES.filter((p) => p.sha === mrEvent?.sha);
    if (shared.length > 1) {
      expect(new Set(shared.map((p) => p.ref)).size).toBeGreaterThan(1);
      const picked = newestPipelinePerSha(shared).get(mrEvent?.sha ?? '');
      expect(picked?.id).toBe(Math.max(...shared.map((p) => p.id)));
    }
  });

  it('maps a successful head pipeline to verified', () => {
    const success = GADGET_PIPELINES.find((p) => p.status === 'success');
    if (!success) throw new Error('fixture has no successful pipeline');
    const gate = resolveTestGate({
      roles: roles({ testGate: 'gitlab' }),
      headSha: success.sha,
      branch: 'ENG-116',
      rwxRuns: [],
      rwxTestDefinition: CI_YML,
      pipelines: GADGET_PIPELINES,
    });
    expect(gate.kind).toBe('verified');
  });

  it('maps a running head pipeline to in_progress and notifies nothing', () => {
    const running: GitlabPipeline = {
      id: 999,
      status: 'running',
      source: 'push',
      ref: 'ENG-116',
      sha: 'abc123',
      web_url: 'https://gitlab.com/p/-/pipelines/999',
      created_at: NOW,
      updated_at: NOW,
    };
    const gate = resolveTestGate({
      roles: roles({ testGate: 'gitlab' }),
      headSha: 'abc123',
      branch: 'ENG-116',
      rwxRuns: [],
      rwxTestDefinition: CI_YML,
      pipelines: [running],
    });
    expect(gate.kind).toBe('in_progress');
  });

  it('names the failing jobs on a failure', () => {
    const failed: GitlabPipeline = {
      id: 1000,
      status: 'failed',
      source: 'push',
      ref: 'ENG-116',
      sha: 'def456',
      web_url: 'https://gitlab.com/p/-/pipelines/1000',
      created_at: NOW,
      updated_at: NOW,
    };
    const gate = resolveTestGate({
      roles: roles({ testGate: 'gitlab' }),
      headSha: 'def456',
      branch: 'ENG-116',
      rwxRuns: [],
      rwxTestDefinition: CI_YML,
      pipelines: [failed],
      failingJobNames: ['ruby::rspec::3.2.8'],
    });
    expect(gate.kind).toBe('verified');
    if (gate.kind !== 'verified') throw new Error('unreachable');
    expect(gate.result).toBe('failed');
    expect(gate.name).toBe('ruby::rspec::3.2.8');
  });

  it('treats a missing pipeline as unverified but NOT startable', () => {
    // On a GitLab-CI repo one is about to be created; nagging would be wrong.
    const gate = resolveTestGate({
      roles: roles({ testGate: 'gitlab' }),
      headSha: 'no-such-sha',
      branch: 'ENG-116',
      rwxRuns: [],
      rwxTestDefinition: CI_YML,
      pipelines: GADGET_PIPELINES,
    });
    expect(gate.kind).toBe('unverified');
    if (gate.kind !== 'unverified') throw new Error('unreachable');
    expect(gate.startable).toBe(false);
  });

  it('does not treat canceled or skipped as a verdict', () => {
    for (const status of ['canceled', 'skipped']) {
      const p: GitlabPipeline = {
        id: 1,
        status,
        source: 'push',
        ref: 'b',
        sha: 's',
        web_url: '',
        created_at: NOW,
        updated_at: NOW,
      };
      expect(gitlabCheckFor([p], 's', 'tests')).toBeUndefined();
    }
  });

  it('reports no CI when the test gate is none', () => {
    const gate = resolveTestGate({
      roles: roles({ testGate: 'none' }),
      headSha: 'x',
      branch: 'b',
      rwxRuns: RWX_RUNS,
      rwxTestDefinition: CI_YML,
      pipelines: GADGET_PIPELINES,
    });
    expect(gate.kind).toBe('none');
  });
});
