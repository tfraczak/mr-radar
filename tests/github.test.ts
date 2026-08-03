import { describe, expect, it } from 'vitest';
import { aggregateCheckState, checksCheckFor, detectRepoRoles, resolveTestGate } from '../src/core/ci';
import {
  refFull,
  toForgeApprovals,
  toForgeCheckRuns,
  toForgeCommits,
  toForgeDiscussions,
  toForgeMrFromRest,
  toForgeMrFromSearch,
  toForgeTodo,
} from '../src/core/sources/github';
import type { ForgeCheckRun } from '../src/core/types';

const gqlPr = (over: Partial<Record<string, unknown>> = {}) => ({
  fullDatabaseId: '9001',
  number: 42,
  title: 'ENG-42: Add widget flow',
  state: 'OPEN' as const,
  isDraft: false,
  mergeable: 'MERGEABLE' as const,
  headRefOid: 'abc123def4567890abc123def4567890abc123de',
  headRefName: 'ENG-42',
  baseRefName: 'main',
  url: 'https://github.com/acme/rocket/pull/42',
  updatedAt: '2026-08-01T10:00:00Z',
  createdAt: '2026-07-30T10:00:00Z',
  author: { login: 'mira.dev' },
  repository: { nameWithOwner: 'acme/rocket', databaseId: 555 },
  comments: { totalCount: 3 },
  reviewRequests: { nodes: [] },
  latestReviews: { nodes: [] },
  ...over,
});

describe('github search mapper', () => {
  it('maps a PR into the Forge vocabulary', () => {
    const mr = toForgeMrFromSearch(gqlPr() as never);
    expect(mr.iid).toBe(42);
    expect(mr.project_id).toBe(555);
    expect(mr.source_branch).toBe('ENG-42');
    expect(mr.sha).toBe('abc123def4567890abc123def4567890abc123de');
    expect(mr.state).toBe('opened');
    expect(mr.references.full).toBe('acme/rocket#42');
    expect(mr.user_notes_count).toBe(3);
  });

  it('UNKNOWN mergeability is not a conflict', () => {
    expect(toForgeMrFromSearch(gqlPr({ mergeable: 'UNKNOWN' }) as never).has_conflicts).toBe(false);
    expect(toForgeMrFromSearch(gqlPr({ mergeable: 'CONFLICTING' }) as never).has_conflicts).toBe(true);
  });
});

describe('key byte-identity contract', () => {
  it('search MRs, REST pulls, and mention todos produce identical keys', () => {
    const searchKey = toForgeMrFromSearch(gqlPr() as never).references.full;
    const restKey = toForgeMrFromRest({
      id: 9001,
      number: 42,
      title: 't',
      state: 'open',
      merged: false,
      draft: false,
      mergeable: true,
      head: { sha: 'a'.repeat(40), ref: 'ENG-42' },
      base: { ref: 'main', repo: { full_name: 'acme/rocket', id: 555 } },
      html_url: 'https://github.com/acme/rocket/pull/42',
      updated_at: '',
      created_at: '',
      comments: 0,
      review_comments: 0,
    } as never).references.full;
    const todoKey = toForgeTodo({
      id: '77',
      reason: 'mention',
      updated_at: '2026-08-01T10:00:00Z',
      subject: { title: 't', url: 'https://api.github.com/repos/acme/rocket/pulls/42', type: 'PullRequest' },
      repository: { id: 555, full_name: 'acme/rocket' },
    } as never)?.target.references.full;
    expect(searchKey).toBe(refFull('acme/rocket', 42));
    expect(restKey).toBe(searchKey);
    expect(todoKey).toBe(searchKey);
  });
});

describe('github todos (notifications)', () => {
  const notification = (over: Partial<Record<string, unknown>> = {}) => ({
    id: '5',
    reason: 'mention',
    updated_at: '2026-08-01T10:00:00Z',
    subject: { title: 't', url: 'https://api.github.com/repos/acme/rocket/pulls/7', type: 'PullRequest' },
    repository: { id: 1, full_name: 'acme/rocket' },
    ...over,
  });

  it('keeps PR mentions only', () => {
    expect(toForgeTodo(notification() as never)?.action_name).toBe('mentioned');
    expect(toForgeTodo(notification({ reason: 'review_requested' }) as never)).toBeUndefined();
    expect(
      toForgeTodo(notification({ subject: { title: 't', url: null, type: 'Issue' } }) as never),
    ).toBeUndefined();
  });

  it('drops notifications whose subject url has no PR number', () => {
    expect(
      toForgeTodo(notification({ subject: { title: 't', url: null, type: 'PullRequest' } }) as never),
    ).toBeUndefined();
  });
});

describe('github approvals', () => {
  const reviews = (states: [string, string][]) => ({
    latestReviews: { nodes: states.map(([login, state]) => ({ author: { login }, state })) },
  });

  it('decision matrix', () => {
    const approved = toForgeApprovals({ reviewDecision: 'APPROVED', ...reviews([['sam.rios', 'APPROVED']]) } as never);
    expect(approved.approved).toBe(true);
    expect(approved.approvals_left).toBe(0);
    expect(approved.approved_by.map((a) => a.user.username)).toEqual(['sam.rios']);

    const required = toForgeApprovals({ reviewDecision: 'REVIEW_REQUIRED', ...reviews([]) } as never);
    expect(required.approved).toBe(false);
    expect(required.approvals_left).toBe(1);
    expect(required.approvals_required).toBeUndefined();

    // No protection rules: null decision, an approval still counts.
    const informal = toForgeApprovals({ reviewDecision: null, ...reviews([['jo.keller', 'APPROVED']]) } as never);
    expect(informal.approved).toBe(true);
    expect(informal.approvals_left).toBeUndefined();
  });
});

describe('github commits', () => {
  it('reverses REST oldest-first into newest-first ancestry order', () => {
    const commits = toForgeCommits([
      { sha: 'old', commit: { message: 'first\nbody', committer: { date: '2026-01-01' } } },
      { sha: 'new', commit: { message: 'second', committer: { date: '2026-01-02' } } },
    ] as never);
    expect(commits.map((c) => c.id)).toEqual(['new', 'old']);
    expect(commits[1]?.title).toBe('first');
  });
});

describe('github discussions', () => {
  it('maps review threads with resolution and positions', () => {
    const discussions = toForgeDiscussions({
      reviewThreads: {
        nodes: [
          {
            id: 'T1',
            isResolved: false,
            comments: {
              nodes: [
                { databaseId: 11, body: 'nit', createdAt: '2026-08-01', author: { login: 'jo.keller' }, path: 'a.rb', line: 5 },
              ],
            },
          },
        ],
      },
      comments: { nodes: [{ databaseId: 12, body: 'lgtm-ish', createdAt: '2026-08-01', author: { login: 'sam.rios' } }] },
      reviews: { nodes: [{ databaseId: 13, body: '', state: 'APPROVED', createdAt: '2026-08-01', author: { login: 'sam.rios' } }] },
    } as never);
    expect(discussions).toHaveLength(2); // empty review bodies are invisible
    const thread = discussions[0];
    expect(thread?.notes[0]?.resolvable).toBe(true);
    expect(thread?.notes[0]?.resolved).toBe(false);
    expect(thread?.notes[0]?.position?.new_path).toBe('a.rb');
    expect(discussions[1]?.individual_note).toBe(true);
  });
});

describe('github check runs', () => {
  const run = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 1,
    name: 'rspec',
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/acme/rocket/runs/1',
    started_at: '2026-08-01T10:00:00Z',
    completed_at: '2026-08-01T10:05:00Z',
    check_suite: { id: 900 },
    ...over,
  });

  it('state table', () => {
    const states = (over: Record<string, unknown>) =>
      toForgeCheckRuns({ check_runs: [run(over) as never] })[0]?.state;
    expect(states({})).toBe('succeeded');
    expect(states({ conclusion: 'failure' })).toBe('failed');
    expect(states({ conclusion: 'timed_out' })).toBe('failed');
    expect(states({ conclusion: 'neutral' })).toBe('waiting');
    expect(states({ conclusion: 'skipped' })).toBe('waiting');
    expect(states({ status: 'in_progress', conclusion: null })).toBe('in_progress');
    expect(states({ status: 'queued', conclusion: null })).toBe('waiting');
  });

  it('aggregates: any failure wins, then running, then all-green', () => {
    const mk = (state: ForgeCheckRun['state']): ForgeCheckRun => ({
      id: '1', suiteId: '9', name: 'x', state, url: '', createdAt: '',
    });
    expect(aggregateCheckState([mk('succeeded'), mk('failed'), mk('in_progress')])).toBe('failed');
    expect(aggregateCheckState([mk('succeeded'), mk('in_progress')])).toBe('in_progress');
    expect(aggregateCheckState([mk('succeeded'), mk('succeeded')])).toBe('succeeded');
    expect(aggregateCheckState([])).toBe('waiting');
  });

  it('gate: failing checks name the failures; empty checks are never startable', () => {
    const roles = { testGate: 'github' as const, gitlabIsLintOnly: false, detectedAt: '' };
    const failed = resolveTestGate({
      roles,
      headSha: 'h',
      branch: 'ENG-1',
      rwxRuns: [],
      rwxTestDefinition: '.rwx/ci.yml',
      pipelines: [],
      headChecks: [
        { id: '1', suiteId: '9', name: 'jest', state: 'failed', url: 'u', createdAt: '' },
        { id: '2', suiteId: '9', name: 'lint', state: 'succeeded', url: '', createdAt: '' },
      ],
    });
    expect(failed.kind).toBe('verified');
    if (failed.kind === 'verified') {
      expect(failed.result).toBe('failed');
      expect(failed.name).toBe('jest');
    }
    const empty = resolveTestGate({
      roles,
      headSha: 'h',
      branch: 'ENG-1',
      rwxRuns: [],
      rwxTestDefinition: '.rwx/ci.yml',
      pipelines: [],
      headChecks: [],
    });
    expect(empty.kind).toBe('unverified');
    if (empty.kind === 'unverified') expect(empty.startable).toBe(false);
  });

  it('detection: check runs with test names make github the gate', () => {
    const roles = detectRepoRoles({
      projectPath: 'acme/rocket',
      hasRwxRuns: false,
      hasPipelines: true,
      forgeName: 'github',
      latestPipelineJobs: [{ id: 0, name: 'jest', status: 'succeeded', stage: '', web_url: '' }],
      now: '2026-08-01',
    });
    expect(roles.testGate).toBe('github');
  });

  it('checksCheckFor keys the aggregate on the newest suite id', () => {
    const check = checksCheckFor(
      [
        { id: '1', suiteId: '900', name: 'a', state: 'succeeded', url: '', createdAt: '' },
        { id: '2', suiteId: '901', name: 'b', state: 'succeeded', url: 'u', createdAt: 't' },
      ],
      'headsha',
      'tests',
    );
    expect(check?.id).toBe('901');
    expect(check?.provider).toBe('github');
    expect(check?.state).toBe('succeeded');
  });
});
