import { runJson } from '../exec';
import { withRetries } from '../retry';
import type {
  ForgeApprovals,
  ForgeCommentEvent,
  ForgeCommit,
  ForgeDiscussion,
  ForgeMr,
  ForgeNote,
  ForgeTodo,
  ForgeUser,
} from '../types';
import type { ForgeCheckRun, ForgeCi, ForgeSource } from './forge';

const GH = process.env.MR_RADAR_GH ?? 'gh';
const PER_PAGE = 100;

/**
 * GitHub access via the `gh` CLI, which manages its own token — as with
 * `glab`, this app holds no credential. The twin of GitlabSource: it adapts
 * GitHub's wire formats into the Forge* types (GitLab's field vocabulary),
 * so everything downstream of the ForgeSource interface is forge-blind.
 *
 * Calls are serialized through one queue like the GitLab twin. gh has no
 * OAuth-refresh race (tokens are long-lived), but serialization keeps rate
 * usage smooth and the two sources behaviorally identical.
 */

/** `owner/repo` + PR number → the canonical key, e.g. `acme/rocket#123`.
 * EVERY mapper must build references.full through this one helper: the todo
 * lookup in events.ts compares these strings byte-for-byte with WatchItem.key. */
export const refFull = (nameWithOwner: string, n: number): string => `${nameWithOwner}#${n}`;

/** PR web url, synthesized when the payload doesn't carry one. */
const prUrl = (nameWithOwner: string, n: number): string =>
  `https://github.com/${nameWithOwner}/pull/${n}`;

// ---------------------------------------------------------------------------
// GraphQL shapes (only the fields the mappers read)
// ---------------------------------------------------------------------------

interface GqlPr {
  fullDatabaseId: string;
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  updatedAt: string;
  createdAt: string;
  author?: { login: string } | null;
  repository: { nameWithOwner: string; databaseId: number };
  comments: { totalCount: number };
  reviewRequests?: { nodes: { requestedReviewer?: { databaseId?: number; login?: string; name?: string } | null }[] } | null;
  latestReviews?: { nodes: { author?: { login: string } | null; state: string }[] } | null;
}

const PR_FRAGMENT = `
  fragment prFields on PullRequest {
    fullDatabaseId number title state isDraft mergeable
    headRefOid headRefName baseRefName url updatedAt createdAt
    author { login }
    repository { nameWithOwner databaseId }
    comments { totalCount }
    reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { databaseId login name } } } }
    latestReviews(first: 30) { nodes { author { login } state } }
  }`;

const SEARCH_QUERY = `
  query ($q: String!, $after: String) {
    search(type: ISSUE, query: $q, first: ${PER_PAGE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ...prFields }
    }
  }
  ${PR_FRAGMENT}`;

// ---------------------------------------------------------------------------
// Pure mappers (exported for fixture-driven tests)
// ---------------------------------------------------------------------------

const ghUser = (u?: { databaseId?: number; login?: string; name?: string } | null): ForgeUser => ({
  id: u?.databaseId ?? 0,
  username: u?.login ?? '',
  name: u?.name ?? u?.login ?? '',
});

export const toForgeMrFromSearch = (pr: GqlPr): ForgeMr => ({
  id: Number(pr.fullDatabaseId),
  iid: pr.number,
  project_id: pr.repository.databaseId,
  title: pr.title,
  state: pr.state === 'OPEN' ? 'opened' : pr.state === 'MERGED' ? 'merged' : 'closed',
  sha: pr.headRefOid,
  source_branch: pr.headRefName,
  target_branch: pr.baseRefName,
  web_url: pr.url || prUrl(pr.repository.nameWithOwner, pr.number),
  updated_at: pr.updatedAt,
  created_at: pr.createdAt,
  user_notes_count: pr.comments.totalCount,
  draft: pr.isDraft,
  // UNKNOWN means GitHub is still computing mergeability — not a conflict.
  has_conflicts: pr.mergeable === 'CONFLICTING',
  author: { id: 0, username: pr.author?.login ?? '', name: pr.author?.login ?? '' },
  references: { full: refFull(pr.repository.nameWithOwner, pr.number) },
  reviewers: (pr.reviewRequests?.nodes ?? [])
    .map((n) => n.requestedReviewer)
    .filter((r): r is NonNullable<typeof r> => Boolean(r?.login))
    .map((r) => ghUser(r)),
});

/** REST pull shape (subset). */
interface RestPull {
  id: number;
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  mergeable: boolean | null;
  head: { sha: string; ref: string };
  base: { ref: string; repo: { full_name: string; id: number } };
  html_url: string;
  updated_at: string;
  created_at: string;
  comments: number;
  review_comments: number;
  user?: { id: number; login: string } | null;
  requested_reviewers?: { id: number; login: string; name?: string | null }[];
}

export const toForgeMrFromRest = (pull: RestPull): ForgeMr => ({
  id: pull.id,
  iid: pull.number,
  project_id: pull.base.repo.id,
  title: pull.title,
  state: pull.state === 'open' ? 'opened' : pull.merged ? 'merged' : 'closed',
  sha: pull.head.sha,
  source_branch: pull.head.ref,
  target_branch: pull.base.ref,
  web_url: pull.html_url,
  updated_at: pull.updated_at,
  created_at: pull.created_at,
  user_notes_count: pull.comments + pull.review_comments,
  draft: pull.draft,
  has_conflicts: pull.mergeable === false,
  author: { id: pull.user?.id ?? 0, username: pull.user?.login ?? '', name: pull.user?.login ?? '' },
  references: { full: refFull(pull.base.repo.full_name, pull.number) },
  reviewers: (pull.requested_reviewers ?? []).map((r) => ({
    id: r.id,
    username: r.login,
    name: r.name ?? r.login,
  })),
});

/** Notification (subset) — GitHub's closest thing to a pending mention todo. */
interface RestNotification {
  id: string;
  reason: string;
  updated_at: string;
  subject: { title: string; url: string | null; type: string };
  repository: { id: number; full_name: string };
}

/**
 * Unread mention notifications → 'mentioned' todos. Semantics differ from
 * GitLab deliberately (v1 decision): reading the PR on github.com clears the
 * notification, so the mention row drops on the next cycle rather than when
 * the MR is visited from the app.
 */
export const toForgeTodo = (n: RestNotification): ForgeTodo | undefined => {
  if (n.subject.type !== 'PullRequest' || n.reason !== 'mention') return undefined;
  const iid = Number(/\/pulls\/(\d+)$/.exec(n.subject.url ?? '')?.[1]);
  if (!Number.isFinite(iid) || iid <= 0) return undefined;
  return {
    id: Number(n.id),
    action_name: 'mentioned',
    target_type: 'MergeRequest',
    // Notifications carry no actor; author is only read on the
    // review_submitted path, which GitHub never produces (no such todos).
    author: { id: 0, username: '', name: '' },
    target: {
      iid,
      project_id: n.repository.id,
      references: { full: refFull(n.repository.full_name, iid) },
    },
    target_url: prUrl(n.repository.full_name, iid),
    created_at: n.updated_at,
    project: { path_with_namespace: n.repository.full_name },
  };
};

/** GraphQL review threads + comments → ForgeDiscussion[]. */
interface GqlDiscussionsPr {
  reviewThreads: {
    nodes: {
      id: string;
      isResolved: boolean;
      comments: { nodes: GqlComment[] };
    }[];
  };
  comments: { nodes: GqlComment[] };
  reviews: { nodes: (GqlComment & { state: string })[] };
}
interface GqlComment {
  databaseId: number;
  body: string;
  createdAt: string;
  updatedAt?: string;
  author?: { login: string } | null;
  path?: string;
  line?: number | null;
}

const toNote = (c: GqlComment, over: Partial<ForgeNote> = {}): ForgeNote => ({
  id: c.databaseId,
  body: c.body,
  author: { id: 0, username: c.author?.login ?? '', name: c.author?.login ?? '' },
  created_at: c.createdAt,
  updated_at: c.updatedAt ?? c.createdAt,
  system: false,
  resolvable: false,
  ...over,
});

export const toForgeDiscussions = (pr: GqlDiscussionsPr): ForgeDiscussion[] => {
  const out: ForgeDiscussion[] = [];
  for (const t of pr.reviewThreads.nodes) {
    if (t.comments.nodes.length === 0) continue;
    out.push({
      id: t.id,
      individual_note: false,
      notes: t.comments.nodes.map((c) =>
        toNote(c, {
          resolvable: true,
          resolved: t.isResolved,
          ...(c.path ? { position: { new_path: c.path, ...(c.line != null ? { new_line: c.line } : {}) } } : {}),
        }),
      ),
    });
  }
  for (const c of pr.comments.nodes) {
    out.push({ id: `ic${c.databaseId}`, individual_note: true, notes: [toNote(c)] });
  }
  for (const r of pr.reviews.nodes) {
    // Review bodies (the summary comment) count as comments; empty ones are
    // pure state changes and stay invisible here.
    if (!r.body?.trim()) continue;
    out.push({ id: `rv${r.databaseId}`, individual_note: true, notes: [toNote(r)] });
  }
  return out;
};

interface GqlApprovalsPr {
  reviewDecision: 'APPROVED' | 'REVIEW_REQUIRED' | 'CHANGES_REQUESTED' | null;
  latestReviews: { nodes: { author?: { login: string } | null; state: string; submittedAt?: string }[] };
}

export const toForgeApprovals = (pr: GqlApprovalsPr): ForgeApprovals => {
  const approvedBy = pr.latestReviews.nodes
    .filter((r) => r.state === 'APPROVED' && r.author?.login)
    .map((r) => ({
      user: { id: 0, username: r.author?.login ?? '', name: r.author?.login ?? '' },
      ...(r.submittedAt ? { approved_at: r.submittedAt } : {}),
    }));
  const decision = pr.reviewDecision;
  return {
    approved: decision === 'APPROVED' || (decision === null && approvedBy.length > 0),
    // GitHub reports a decision, not a count — required stays unknown, and
    // left is the minimum knowable (0 when satisfied, 1 when more is needed).
    ...(decision === 'APPROVED' ? { approvals_left: 0 } : {}),
    ...(decision === 'REVIEW_REQUIRED' || decision === 'CHANGES_REQUESTED' ? { approvals_left: 1 } : {}),
    approved_by: approvedBy,
  };
};

/** REST check run (subset). */
interface RestCheckRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending';
  conclusion: string | null;
  html_url: string | null;
  started_at: string | null;
  completed_at: string | null;
  check_suite: { id: number };
}

export const toForgeCheckRuns = (payload: { check_runs?: RestCheckRun[] }): ForgeCheckRun[] =>
  (payload.check_runs ?? []).map((r) => ({
    id: String(r.id),
    suiteId: String(r.check_suite.id),
    name: r.name,
    state:
      r.status !== 'completed'
        ? r.status === 'in_progress'
          ? 'in_progress'
          : 'waiting'
        : r.conclusion === 'success'
          ? 'succeeded'
          : r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'action_required'
            ? 'failed'
            : 'waiting', // neutral / skipped / cancelled: not a verdict
    url: r.html_url ?? '',
    createdAt: r.started_at ?? r.completed_at ?? '',
  }));

/** REST commit (subset); the list arrives OLDEST-first. */
interface RestCommit {
  sha: string;
  commit: { message: string; committer?: { date?: string } | null };
}

export const toForgeCommits = (commits: RestCommit[]): ForgeCommit[] =>
  commits
    .map((c) => ({
      id: c.sha,
      title: c.commit.message.split('\n')[0] ?? '',
      committed_date: c.commit.committer?.date ?? '',
    }))
    // The ForgeSource contract is newest-first ancestry order.
    .reverse();

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

export class GithubSource implements ForgeSource {
  readonly name = 'github' as const;

  /** GitHub's CI capability: per-sha check runs (pipeline + jobs in one). */
  readonly ci: ForgeCi = {
    model: 'checks',
    checksForSha: async (projectPath, sha) => {
      const payload = await this.api<{ check_runs?: RestCheckRun[] }>(
        `repos/${projectPath}/commits/${sha}/check-runs?per_page=${PER_PAGE}`,
      );
      return toForgeCheckRuns(payload);
    },
  };

  constructor(private readonly gh: string = GH) {}

  private queue: Promise<unknown> = Promise.resolve();

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private api<T>(path: string): Promise<T> {
    return this.enqueue(() => withRetries(() => runJson<T>(this.gh, ['api', path], { timeoutMs: 45_000 })));
  }

  private graphql<T>(query: string, vars: Record<string, string | null>): Promise<T> {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [k, v] of Object.entries(vars)) {
      if (v !== null) args.push('-f', `${k}=${v}`);
    }
    return this.enqueue(() =>
      withRetries(() => runJson<{ data: T }>(this.gh, args, { timeoutMs: 45_000 })).then((r) => r.data),
    );
  }

  private me: Promise<ForgeUser> | undefined;

  currentUser(): Promise<ForgeUser> {
    this.me ??= this.api<{ id: number; login: string; name?: string | null }>('user').then((u) => ({
      id: u.id,
      username: u.login,
      name: u.name ?? u.login,
    }));
    return this.me;
  }

  /** Search-based PR list; cursor-paginates up to 3 pages (≈ GitLab's cap). */
  private async searchPrs(q: string): Promise<ForgeMr[]> {
    const out: ForgeMr[] = [];
    let after: string | null = null;
    for (let page = 0; page < 3; page++) {
      const data: { search: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: GqlPr[] } } =
        await this.graphql(SEARCH_QUERY, { q, after });
      out.push(...data.search.nodes.filter((n) => n && n.repository).map(toForgeMrFromSearch));
      if (!data.search.pageInfo.hasNextPage) break;
      after = data.search.pageInfo.endCursor;
    }
    return out;
  }

  authoredMrs(): Promise<ForgeMr[]> {
    return this.searchPrs('is:pr is:open author:@me archived:false');
  }

  reviewerMrs(): Promise<ForgeMr[]> {
    return this.searchPrs('is:pr is:open review-requested:@me archived:false');
  }

  async approvedMrs(): Promise<ForgeMr[]> {
    // reviewed-by is broader than "approved by"; filter to my APPROVED review.
    const me = (await this.currentUser()).username;
    const prs = await this.graphqlSearchRaw('is:pr is:open reviewed-by:@me archived:false');
    return prs
      .filter((pr) =>
        (pr.latestReviews?.nodes ?? []).some((r) => r.author?.login === me && r.state === 'APPROVED'),
      )
      .map(toForgeMrFromSearch);
  }

  private async graphqlSearchRaw(q: string): Promise<GqlPr[]> {
    const out: GqlPr[] = [];
    let after: string | null = null;
    for (let page = 0; page < 3; page++) {
      const data: { search: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: GqlPr[] } } =
        await this.graphql(SEARCH_QUERY, { q, after });
      out.push(...data.search.nodes.filter((n) => n && n.repository));
      if (!data.search.pageInfo.hasNextPage) break;
      after = data.search.pageInfo.endCursor;
    }
    return out;
  }

  async commentEvents(after: string): Promise<ForgeCommentEvent[]> {
    const prs = await this.graphqlSearchRaw(`is:pr commenter:@me updated:>${after} archived:false`);
    return prs.map((pr) => ({
      project_id: pr.repository.databaseId,
      target_title: pr.title,
      created_at: pr.updatedAt,
      note: { noteable_type: 'MergeRequest' as const, noteable_iid: pr.number },
    }));
  }

  async mrByProjectId(projectId: number, iid: number): Promise<ForgeMr> {
    const pull = await this.api<RestPull>(`repositories/${projectId}/pulls/${iid}`);
    return toForgeMrFromRest(pull);
  }

  async addReviewer(projectId: number, iid: number): Promise<void> {
    // GitHub's endpoint is additive and takes logins — no read-modify-write.
    const login = (await this.currentUser()).username;
    await this.enqueue(() =>
      withRetries(() =>
        runJson<unknown>(
          this.gh,
          ['api', '-X', 'POST', `repositories/${projectId}/pulls/${iid}/requested_reviewers`, '-f', `reviewers[]=${login}`],
          { timeoutMs: 45_000 },
        ),
      ),
    ).then(() => undefined);
  }

  async todos(): Promise<ForgeTodo[]> {
    const notifications = await this.api<RestNotification[]>(`notifications?per_page=${PER_PAGE}`);
    return notifications.map(toForgeTodo).filter((t): t is ForgeTodo => t !== undefined);
  }

  async discussions(projectPath: string, iid: number): Promise<ForgeDiscussion[]> {
    const [owner, name] = splitPath(projectPath);
    const data = await this.graphql<{ repository: { pullRequest: GqlDiscussionsPr } }>(
      `query ($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: ${iid}) {
            reviewThreads(first: 100) {
              nodes { id isResolved comments(first: 50) { nodes { databaseId body createdAt updatedAt author { login } path line } } }
            }
            comments(first: 100) { nodes { databaseId body createdAt updatedAt author { login } } }
            reviews(first: 50) { nodes { databaseId body state createdAt: submittedAt author { login } } }
          }
        }
      }`,
      { owner, name },
    );
    return toForgeDiscussions(data.repository.pullRequest);
  }

  async approvals(projectPath: string, iid: number): Promise<ForgeApprovals> {
    const [owner, name] = splitPath(projectPath);
    const data = await this.graphql<{ repository: { pullRequest: GqlApprovalsPr } }>(
      `query ($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: ${iid}) {
            reviewDecision
            latestReviews(first: 30) { nodes { author { login } state submittedAt } }
          }
        }
      }`,
      { owner, name },
    );
    return toForgeApprovals(data.repository.pullRequest);
  }

  async commits(projectPath: string, iid: number): Promise<ForgeCommit[]> {
    const commits = await this.api<RestCommit[]>(
      `repos/${projectPath}/pulls/${iid}/commits?per_page=${PER_PAGE}`,
    );
    return toForgeCommits(commits);
  }
}

const splitPath = (projectPath: string): [string, string] => {
  const idx = projectPath.indexOf('/');
  return idx > 0 ? [projectPath.slice(0, idx), projectPath.slice(idx + 1)] : [projectPath, ''];
};
