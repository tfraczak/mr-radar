import { branchOfRun, isCompleted } from './sources/rwx';
import type {
  ForgeCheckRun,
  Check,
  CheckRole,
  CheckState,
  CiProvider,
  ForgeCommit,
  ForgeJob,
  ForgePipeline,
  RepoCiRoles,
  RwxRun,
  TestGate,
} from './types';

/**
 * Which commits have actually been verified, and by what.
 *
 * The subtlety this module exists for: **a repo can have checks from both
 * providers, meaning different things.** rocket has 100 GitLab pipelines and RWX
 * runs, but its pipeline only runs `ruby::lint` (its `build`/`sync` stages fire
 * on tags/main/OpenAPI changes only) while `.rwx/ci.yml` carries the specs.
 * gadget's pipeline runs `ruby::rspec::*` and it has no RWX at all.
 *
 * So "which provider" can't answer "did my tests pass" — only the check's
 * **role** can.
 */

/** Job names that indicate a pipeline actually runs tests. */
const TEST_JOB = /\b(rspec|jest|pytest|vitest|minitest|spec|tests?|cypress|playwright)\b/i;

/** Default RWX definition treated as the test gate. Others are informational. */
export const DEFAULT_RWX_TEST_DEFINITION = '.rwx/ci.yml';

/**
 * Match on job **name**, never stage. gadget puts `ruby::lint::rubocop` in a stage
 * literally called `test`, so classifying by stage would call its lint jobs
 * tests and defeat the whole point.
 *
 * An empty job list is deliberately `false`: ops-scripts produces
 * pipelines that report `success` with **zero jobs** (its config lives upstream
 * and nothing matches on a feature branch). A green pipeline that ran nothing is
 * not verification, and must not be reported as passing tests.
 */
export const pipelineRunsTests = (jobs: ForgeJob[]): boolean => {
  return jobs.some((j) => TEST_JOB.test(j.name));
}

export interface DetectRolesInput {
  projectPath: string;
  hasRwxRuns: boolean;
  /**
   * Jobs from the project's most recent pipeline — or, on the checks model,
   * the head sha's check runs adapted into the same {name, status} shape.
   * Absent = not inspected.
   */
  latestPipelineJobs?: ForgeJob[];
  hasPipelines: boolean;
  /** Which forge a detected CI gate belongs to. Defaults to gitlab. */
  forgeName?: 'gitlab' | 'github';
  /** An explicit config override pins the test gate but not the lint flag. */
  override?: CiProvider | 'none';
  now: string;
}

export const detectRepoRoles = (input: DetectRolesInput): RepoCiRoles => {
  const { hasRwxRuns, latestPipelineJobs, override, now } = input;
  const forgeName = input.forgeName ?? 'gitlab';
  const inspected = latestPipelineJobs !== undefined;
  const ciRunsTests = inspected && pipelineRunsTests(latestPipelineJobs);

  const testGate: RepoCiRoles['testGate'] =
    override ??
    // RWX presence wins: a repo that runs RWX does so because its specs live
    // there, and its forge CI is doing something else (lint, build).
    (hasRwxRuns ? 'rwx' : ciRunsTests ? forgeName : 'none');

  // "Lint-only" means the pipeline runs non-test jobs (rocket's ruby::lint) — not
  // that it runs nothing. A zero-job pipeline (ops-scripts) is empty, not
  // lint-only, so require that we saw at least one job. Guarding on `inspected`
  // also avoids the earlier contradiction where gadget reported
  // "test gate = gitlab (pipeline is lint-only)".
  const hasJobs = inspected && latestPipelineJobs.length > 0;
  const gitlabIsLintOnly = testGate !== forgeName && hasJobs && !ciRunsTests;

  return { testGate, gitlabIsLintOnly, detectedAt: now };
}

// ---------------------------------------------------------------------------
// GitLab pipelines
// ---------------------------------------------------------------------------

const GITLAB_SUCCESS = new Set(['success']);
const GITLAB_FAILED = new Set(['failed']);
const GITLAB_RUNNING = new Set(['running', 'pending', 'created', 'preparing', 'waiting_for_resource', 'scheduled']);

export const gitlabStateOf = (status: string): CheckState | undefined => {
  if (GITLAB_SUCCESS.has(status)) return 'succeeded';
  if (GITLAB_FAILED.has(status)) return 'failed';
  if (GITLAB_RUNNING.has(status)) return 'in_progress';
  // canceled / skipped / manual — real states, but not a verdict on the code.
  return undefined;
}

/**
 * Newest pipeline per commit sha.
 *
 * Group by **sha, not ref**. One push creates two pipelines: `source: push`
 * with `ref` = branch name, and `source: merge_request_event` with
 * `ref: refs/merge-requests/<iid>/head`. Grouping by ref would split them and
 * never match a branch name against the MR pipeline.
 */
export const newestPipelinePerSha = (pipelines: ForgePipeline[]): Map<string, ForgePipeline> => {
  const bySha = new Map<string, ForgePipeline>();
  for (const p of pipelines) {
    const prev = bySha.get(p.sha);
    if (!prev || p.id > prev.id) bySha.set(p.sha, p);
  }
  return bySha;
}

export const gitlabCheckFor = (
  pipelines: ForgePipeline[],
  headSha: string,
  role: CheckRole,
  failingJobName?: string,
): Check | undefined => {
  const p = newestPipelinePerSha(pipelines).get(headSha);
  if (!p) return undefined;
  const state = gitlabStateOf(p.status);
  if (!state) return undefined;
  return {
    provider: 'gitlab',
    role,
    name: failingJobName ?? (role === 'lint' ? 'lint pipeline' : 'pipeline'),
    sha: p.sha,
    state,
    url: p.web_url,
    id: String(p.id),
    createdAt: p.created_at,
  };
}

/** Names of the jobs that failed, for a far more useful notification. */
export const failedJobNames = (jobs: ForgeJob[]): string[] => {
  return jobs.filter((j) => j.status === 'failed').map((j) => j.name);
}

// ---------------------------------------------------------------------------
// RWX
// ---------------------------------------------------------------------------

export const rwxStateOf = (run: RwxRun): CheckState => {
  const { Execution, Result } = run.Status;
  if (Execution === 'waiting') return 'waiting';
  if (Execution === 'in_progress') return 'in_progress';
  if (Execution === 'aborted') return 'failed';
  return Result === 'succeeded' ? 'succeeded' : 'failed';
}

export const rwxRunsFor = (runs: RwxRun[], branch: string, definition?: string): RwxRun[] => {
  // branchOfRun, not r.Branch: CLI-triggered runs carry an empty Branch and are
  // attributable only via the "<branch> - <email>" title convention.
  return runs
    .filter((r) => branchOfRun(r) === branch && (!definition || r.DefinitionPath === definition))
    .sort((a, b) => b.CreatedAt.localeCompare(a.CreatedAt));
}

/**
 * The newest run that actually produced a result.
 *
 * `waiting` runs are excluded on purpose — see `isCompleted`. This is what makes
 * ENG-118 report "never verified" instead of "a run exists".
 */
export const newestCompletedRun = (runs: RwxRun[]): RwxRun | undefined => {
  return runs.find(isCompleted);
}

export const rwxChecksFor = (runs: RwxRun[], branch: string, headSha: string): Check[] => {
  const out: Check[] = [];
  const byDefinition = new Map<string, RwxRun[]>();
  for (const r of rwxRunsFor(runs, branch)) {
    const list = byDefinition.get(r.DefinitionPath) ?? [];
    list.push(r);
    byDefinition.set(r.DefinitionPath, list);
  }
  for (const [definition, list] of byDefinition) {
    // Prefer the run for the current head; fall back to the newest so a stale
    // result is still visible (greyed) in the popover.
    const run = list.find((r) => r.CommitSha === headSha) ?? list[0];
    if (!run) continue;
    out.push({
      provider: 'rwx',
      role: definition === DEFAULT_RWX_TEST_DEFINITION ? 'tests' : 'lint',
      name: definition,
      sha: run.CommitSha,
      state: rwxStateOf(run),
      url: run.RunUrl,
      id: run.ID,
      createdAt: run.CreatedAt,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unverified commit counting
// ---------------------------------------------------------------------------

/**
 * How many commits sit on top of the newest verified one.
 *
 * Walks the MR's commit list, which GitLab returns newest-first in **ancestry
 * order**. Commit timestamps cannot be used: rebases produce identical
 * `committed_date` values (three ENG-118 commits all read
 * 2026-07-28T11:28:17), so sorting by date is ambiguous.
 *
 * Returns `'many'` when no covered sha appears in the page we fetched — either
 * nothing has ever been verified, or coverage is further back than 100 commits
 * (ENG-126 carries 288). Never pages further; an exact count that large has no
 * extra value.
 */
export const countUnverifiedCommits = (
  commits: ForgeCommit[],
  coveredShas: Set<string>,
): number | 'many' => {
  if (coveredShas.size === 0) return 'many';
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    if (c && coveredShas.has(c.id)) return i;
  }
  return 'many';
}

// ---------------------------------------------------------------------------
// Test gate
// ---------------------------------------------------------------------------

export interface ResolveGateInput {
  roles: RepoCiRoles;
  headSha: string;
  branch: string;
  /** All RWX runs (any branch); filtered here. */
  rwxRuns: RwxRun[];
  rwxTestDefinition: string;
  /** Pipelines for this MR's project. */
  pipelines: ForgePipeline[];
  /** Fetched lazily, only when the gate is unverified and startable. */
  commits?: ForgeCommit[];
  failingJobNames?: string[];
  /** Head-sha check runs (checks-model forges only). */
  headChecks?: ForgeCheckRun[];
}

export const resolveTestGate = (input: ResolveGateInput): TestGate => {
  const { roles } = input;
  if (roles.testGate === 'none') return { kind: 'none' };
  if (roles.testGate === 'rwx') return resolveRwxGate(input);
  if (roles.testGate === 'github') return resolveChecksGate(input);
  return resolveGitlabGate(input);
}

/** Aggregate verdict across a sha's check runs. */
export const aggregateCheckState = (
  runs: ForgeCheckRun[],
): 'succeeded' | 'failed' | 'in_progress' | 'waiting' => {
  if (runs.some((r) => r.state === 'failed')) return 'failed';
  if (runs.some((r) => r.state === 'in_progress')) return 'in_progress';
  if (runs.length > 0 && runs.every((r) => r.state === 'succeeded')) return 'succeeded';
  return 'waiting';
}

/** The checks-model twin of gitlabCheckFor: one aggregate Check per head sha. */
export const checksCheckFor = (
  runs: ForgeCheckRun[],
  headSha: string,
  role: CheckRole,
): Check | undefined => {
  if (runs.length === 0) return undefined;
  const state = aggregateCheckState(runs);
  if (state === 'waiting') return undefined; // no verdict yet, nothing to show
  const failing = runs.filter((r) => r.state === 'failed').map((r) => r.name);
  const newest = [...runs].sort((a, b) => b.suiteId.localeCompare(a.suiteId))[0];
  return {
    provider: 'github',
    role,
    name: failing.length ? failing.join(', ') : role === 'lint' ? 'checks (lint)' : 'checks',
    sha: headSha,
    state,
    url: runs.find((r) => r.state === 'failed')?.url ?? newest?.url ?? '',
    // Suite id ≈ pipeline id: a push creates a new suite (re-notifies), a
    // re-run within one keeps it (silent) — matching GitLab semantics.
    id: newest?.suiteId ?? '',
    createdAt: newest?.createdAt ?? '',
  };
}

const resolveChecksGate = (input: ResolveGateInput): TestGate => {
  const runs = input.headChecks ?? [];
  if (runs.length === 0) {
    // No check runs yet: on GitHub they are about to be created by the push —
    // transient, and **not startable** (never a suggest-run nudge).
    return { kind: 'unverified', provider: 'github', unverifiedCommits: 'many', startable: false };
  }
  const state = aggregateCheckState(runs);
  const failing = runs.filter((r) => r.state === 'failed');
  const url = failing[0]?.url ?? runs[0]?.url ?? '';
  if (state === 'in_progress') return { kind: 'in_progress', provider: 'github', url };
  if (state === 'succeeded') {
    return { kind: 'verified', provider: 'github', result: 'succeeded', url, name: 'checks' };
  }
  if (state === 'failed') {
    const name = failing.map((r) => r.name).join(', ') || 'checks';
    return { kind: 'verified', provider: 'github', result: 'failed', url, name };
  }
  // Only neutral/skipped/queued runs: no verdict, nothing to start.
  return { kind: 'unverified', provider: 'github', unverifiedCommits: 'many', startable: false };
}

const resolveGitlabGate = (input: ResolveGateInput): TestGate => {
  const { pipelines, headSha, failingJobNames } = input;
  const p = newestPipelinePerSha(pipelines).get(headSha);
  if (!p) {
    // No pipeline for this commit yet. On a GitLab-CI repo one is almost
    // certainly about to be created, so this is transient and **not startable**
    // — it must never produce a suggest-run nudge.
    return { kind: 'unverified', provider: 'gitlab', unverifiedCommits: 'many', startable: false };
  }
  const state = gitlabStateOf(p.status);
  if (state === 'in_progress') return { kind: 'in_progress', provider: 'gitlab', url: p.web_url };
  if (state === 'succeeded') {
    return { kind: 'verified', provider: 'gitlab', result: 'succeeded', url: p.web_url, name: 'pipeline' };
  }
  if (state === 'failed') {
    const name = failingJobNames?.length ? failingJobNames.join(', ') : 'pipeline';
    return { kind: 'verified', provider: 'gitlab', result: 'failed', url: p.web_url, name };
  }
  // canceled / skipped / manual: no verdict, and nothing for us to start.
  return { kind: 'unverified', provider: 'gitlab', unverifiedCommits: 'many', startable: false };
}

const resolveRwxGate = (input: ResolveGateInput): TestGate => {
  const { rwxRuns, branch, headSha, rwxTestDefinition, commits } = input;
  const runs = rwxRunsFor(rwxRuns, branch, rwxTestDefinition);

  const headCompleted = runs.find((r) => r.CommitSha === headSha && isCompleted(r));
  if (headCompleted) {
    return {
      kind: 'verified',
      provider: 'rwx',
      result: headCompleted.Status.Result === 'succeeded' ? 'succeeded' : 'failed',
      url: headCompleted.RunUrl,
      name: rwxTestDefinition,
    };
  }

  const headRunning = runs.find(
    (r) => r.CommitSha === headSha && r.Status.Execution === 'in_progress',
  );
  if (headRunning) return { kind: 'in_progress', provider: 'rwx', url: headRunning.RunUrl };

  // Unverified. Count how far ahead of the last real result we are, and link
  // the waiting run for this sha if one exists so it's one click to start.
  const covered = new Set(runs.filter(isCompleted).map((r) => r.CommitSha));
  const unverifiedCommits = commits ? countUnverifiedCommits(commits, covered) : 'many';
  const waiting = runs.find((r) => r.CommitSha === headSha && r.Status.Execution === 'waiting');

  // "Never run" and "ran on an older commit" are different urgencies, so carry
  // the newest completed run (if any) for the stale case.
  const last = newestCompletedRun(runs);

  return {
    kind: 'unverified',
    provider: 'rwx',
    unverifiedCommits,
    startable: true,
    ...(waiting ? { url: waiting.RunUrl } : {}),
    ...(last
      ? {
          lastResult: {
            result: last.Status.Result === 'succeeded' ? ('succeeded' as const) : ('failed' as const),
            sha: last.CommitSha,
            url: last.RunUrl,
            ...(last.CompletedAt ? { completedAt: last.CompletedAt } : {}),
          },
        }
      : {}),
  };
}
