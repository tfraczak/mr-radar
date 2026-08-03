import { runJson, run } from '../exec';
import type { ForgeCi, ForgeSource } from './forge';
import { withRetries } from '../retry';
import type {
  ForgeApprovals,
  ForgeCommentEvent,
  ForgeCommit,
  ForgeDiscussion,
  ForgeJob,
  ForgeMr,
  ForgePipeline,
  ForgeTodo,
  ForgeUser,
} from '../types';

const GLAB = process.env.MR_RADAR_GLAB ?? 'glab';
const PER_PAGE = 100;

/**
 * GitLab access via the `glab` CLI rather than raw HTTP.
 *
 * This is deliberate: `glab` is authenticated with OAuth2 and refreshes its own
 * token (~2h expiry). Shelling out means this app never holds, stores, or
 * refreshes a GitLab credential.
 */
export class GitlabSource implements ForgeSource {
  readonly name = 'gitlab' as const;

  /** GitLab's CI capability: project-wide pipeline lists + a jobs lookup. */
  readonly ci: ForgeCi = {
    model: 'pipelines',
    pipelines: (projectPath) => this.pipelines(projectPath),
    pipelineJobs: (projectPath, pipelineId) => this.pipelineJobs(projectPath, pipelineId),
  };

  constructor(private readonly glab: string = GLAB) {}

  private queue: Promise<unknown> = Promise.resolve();

  /**
   * All glab invocations are serialized through one chain, on purpose.
   *
   * `glab` refreshes its OAuth token on demand, and gitlab.com rotates refresh
   * tokens: two *concurrent* glab processes that both find the token expired
   * will both try to refresh, and the loser presents an already-rotated refresh
   * token — Oauth2 "invalid_grant", a degraded cycle, and in the worst case a
   * revoked grant needing `glab auth login` again. Serializing costs ~300ms per
   * call; the refresh race disappears because only the first call refreshes.
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    // Keep the chain alive after failures; each caller still sees its own error.
    this.queue = next.catch(() => {});
    return next;
  }

  private api<T>(path: string): Promise<T> {
    return this.enqueue(() =>
      withRetries(() => runJson<T>(this.glab, ['api', path], { timeoutMs: 45_000 })),
    );
  }

  /**
   * Fetch every page of a list endpoint.
   *
   * NOTE: `glab api --paginate` is unusable — it concatenates each page's JSON
   * array back to back (`][`), producing invalid JSON. Verified against a real
   * MR's notes: 9 concatenation points in one response. So page by hand.
   */
  private async apiPaged<T>(path: string, maxPages = 10): Promise<T[]> {
    const sep = path.includes('?') ? '&' : '?';
    const out: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const chunk = await this.api<T[]>(`${path}${sep}per_page=${PER_PAGE}&page=${page}`);
      if (!Array.isArray(chunk)) break;
      out.push(...chunk);
      if (chunk.length < PER_PAGE) break;
    }
    return out;
  }

  async currentUser(): Promise<ForgeUser> {
    return this.api<ForgeUser>('user');
  }

  /**
   * All open MRs authored by `userId`, across every project. Paged (P5): at 42
   * open MRs today, a single 100-cap page silently truncating at 100 would be
   * an invisible failure mode — three pages covers 300.
   */
  authoredMrs(userId: number): Promise<ForgeMr[]> {
    return this.apiPaged<ForgeMr>(`merge_requests?scope=all&author_id=${userId}&state=opened`, 3);
  }

  /** Open MRs where `userId` is a requested reviewer. */
  reviewerMrs(userId: number): Promise<ForgeMr[]> {
    return this.apiPaged<ForgeMr>(
      `merge_requests?scope=all&reviewer_id=${userId}&state=opened`,
      3,
    );
  }

  /**
   * Open MRs `userId` has approved. Union with `reviewerMrs` for the definitive
   * "I am reviewing this" signal: a requested review OR an approval given.
   */
  approvedMrs(userId: number): Promise<ForgeMr[]> {
    return this.apiPaged<ForgeMr>(
      `merge_requests?scope=all&approved_by_ids[]=${userId}&state=opened`,
      3,
    );
  }

  /**
   * My own comment events since `after` (YYYY-MM-DD) — the looser
   * "participating" signal: MRs I've commented on without being the formal
   * reviewer (drive-by reviews like rocket!7591). Callers filter to
   * `note.noteable_type === 'MergeRequest'`.
   */
  commentEvents(after: string): Promise<ForgeCommentEvent[]> {
    return this.api<ForgeCommentEvent[]>(
      `events?action=commented&after=${after}&per_page=${PER_PAGE}`,
    );
  }

  /** One MR by numeric project id — used to hydrate comment-event refs. */
  mrByProjectId(projectId: number, iid: number): Promise<ForgeMr> {
    return this.api<ForgeMr>(`projects/${projectId}/merge_requests/${iid}`);
  }

  /**
   * Add `userId` as a reviewer, preserving the existing reviewers — GitLab's
   * `reviewer_ids` is a full replacement, so read-modify-write. Promotes a
   * "participating" drive-by into the formal reviewer role.
   */
  async addReviewer(projectId: number, iid: number, userId: number): Promise<void> {
    const mr = await this.mrByProjectId(projectId, iid);
    const ids = reviewerIdsAfterAdding(mr, userId);
    const fields = ids.flatMap((id) => ['-f', `reviewer_ids[]=${id}`]);
    await this.enqueue(() =>
      withRetries(() =>
        runJson<unknown>(
          this.glab,
          ['api', '-X', 'PUT', `projects/${projectId}/merge_requests/${iid}`, ...fields],
          { timeoutMs: 45_000 },
        ),
      ),
    );
  }

  todos(): Promise<ForgeTodo[]> {
    return this.api<ForgeTodo[]>(`todos?per_page=${PER_PAGE}`);
  }

  discussions(projectPath: string, iid: number): Promise<ForgeDiscussion[]> {
    return this.apiPaged<ForgeDiscussion>(
      `projects/${enc(projectPath)}/merge_requests/${iid}/discussions`,
    );
  }

  approvals(projectPath: string, iid: number): Promise<ForgeApprovals> {
    return this.api<ForgeApprovals>(`projects/${enc(projectPath)}/merge_requests/${iid}/approvals`);
  }

  /**
   * Commits on the MR, newest first in ancestry order.
   *
   * Ordering matters and timestamps can't provide it: rebased commits share
   * identical `committed_date` values (three ENG-118 commits all read
   * 2026-07-28T11:28:17). Use the position in this list, not the dates.
   */
  commits(projectPath: string, iid: number): Promise<ForgeCommit[]> {
    return this.api<ForgeCommit[]>(
      `projects/${enc(projectPath)}/merge_requests/${iid}/commits?per_page=${PER_PAGE}`,
    );
  }

  /** Recent pipelines for a whole project — covers every branch in one call. */
  pipelines(projectPath: string): Promise<ForgePipeline[]> {
    return this.api<ForgePipeline[]>(
      `projects/${enc(projectPath)}/pipelines?per_page=${PER_PAGE}`,
    );
  }

  /** Only called for pipelines that failed, to name the failing job. */
  pipelineJobs(projectPath: string, pipelineId: number): Promise<ForgeJob[]> {
    return this.api<ForgeJob[]>(
      `projects/${enc(projectPath)}/pipelines/${pipelineId}/jobs?per_page=${PER_PAGE}`,
    );
  }

  async version(): Promise<string> {
    const out = await run(this.glab, ['--version'], { timeoutMs: 10_000 });
    return out.trim();
  }
}

/** GitLab wants the project path URL-encoded, slashes included. */
export const enc = (projectPath: string): string => {
  return encodeURIComponent(projectPath);
}

/** Existing reviewer ids plus mine, deduped — never clobber the current set. */
export const reviewerIdsAfterAdding = (mr: ForgeMr, userId: number): number[] => {
  return [...new Set([...(mr.reviewers ?? []).map((r) => r.id), userId])];
}

/** `acme/rocket!7576` — matches `references.full` and is our primary key. */
export const mrKey = (projectPath: string, iid: number): string => {
  return `${projectPath}!${iid}`;
}

export const projectPathFromKey = (key: string): string => {
  const idx = key.lastIndexOf('!');
  return idx === -1 ? key : key.slice(0, idx);
}

/**
 * A bot author, e.g. `project_1111111_bot_aaaaaa...` (review bots).
 *
 * Exposed for labeling only — bots notify the same as humans by design, so
 * nothing filters on this.
 */
export const isBot = (username: string): boolean => {
  return /^project_\d+_bot_/.test(username) || /(^|[-_])bot([-_]|$)/i.test(username);
}
