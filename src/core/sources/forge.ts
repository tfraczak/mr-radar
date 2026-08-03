import type {
  ForgeApprovals,
  ForgeCheckRun,
  ForgeCommentEvent,
  ForgeCommit,
  ForgeDiscussion,
  ForgeJob,
  ForgeMr,
  ForgePipeline,
  ForgeTodo,
  ForgeUser,
} from '../types';
import { execFile } from 'node:child_process';
import type { Config } from '../config';
import type { Db } from '../db';
import { GithubSource } from './github';
import { GitlabSource } from './gitlab';

export type ForgeName = 'gitlab' | 'github';

export type { ForgeCheckRun } from '../types';

/**
 * How a forge reports CI. GitLab exposes one project-wide pipeline list (plus
 * a jobs call to name failures); GitHub exposes per-sha check runs where
 * "pipeline" and "jobs" collapse into a single fetch. Modeling the asymmetry
 * as a discriminated capability forces every consumer to handle both instead
 * of leaving one forge with unimplementable methods.
 */
export type ForgeCi =
  | {
      model: 'pipelines';
      pipelines(projectPath: string): Promise<ForgePipeline[]>;
      pipelineJobs(projectPath: string, pipelineId: number): Promise<ForgeJob[]>;
    }
  | {
      model: 'checks';
      checksForSha(projectPath: string, sha: string): Promise<ForgeCheckRun[]>;
    };

/**
 * The forge contract: everything the poll cycle needs from GitLab or GitHub.
 * Implementations adapt their wire formats into the Forge* types (which keep
 * GitLab's field names — `iid`, `references.full`, `source_branch` — as the
 * neutral vocabulary). See src/core/sources/gitlab.ts and github.ts.
 */
export interface ForgeSource {
  readonly name: ForgeName;
  readonly ci: ForgeCi;
  currentUser(): Promise<ForgeUser>;
  authoredMrs(userId: number): Promise<ForgeMr[]>;
  reviewerMrs(userId: number): Promise<ForgeMr[]>;
  approvedMrs(userId: number): Promise<ForgeMr[]>;
  /** Comment activity by me since `after` (YYYY-MM-DD) — feeds Participating. */
  commentEvents(after: string): Promise<ForgeCommentEvent[]>;
  mrByProjectId(projectId: number, iid: number): Promise<ForgeMr>;
  addReviewer(projectId: number, iid: number, userId: number): Promise<void>;
  todos(): Promise<ForgeTodo[]>;
  discussions(projectPath: string, iid: number): Promise<ForgeDiscussion[]>;
  approvals(projectPath: string, iid: number): Promise<ForgeApprovals>;
  /**
   * Newest-first in ANCESTRY order. Never timestamp-sorted — rebased commits
   * share identical committed_date values.
   */
  commits(projectPath: string, iid: number): Promise<ForgeCommit[]>;
}

export const createForge = (name: ForgeName): ForgeSource =>
  name === 'github' ? new GithubSource() : new GitlabSource();

/** Exit-code probe: is this CLI installed and authenticated? */
const cliAuthed = (cmd: string): Promise<boolean> =>
  new Promise((resolve) => {
    execFile(cmd, ['auth', 'status'], { timeout: 10_000 }, (err) => resolve(!err));
  });

/**
 * Resolve which forge this install watches. An explicit config choice wins;
 * 'auto' prefers a forge we already have an identity for (someone has been
 * using it), then whichever CLI is authenticated, then GitLab (the incumbent).
 */
export const resolveForgeName = async (config: Config, db: Db): Promise<ForgeName> => {
  if (config.forge !== 'auto') return config.forge;
  const known = (['gitlab', 'github'] as const).filter((f) => db.getMeta(`${f}_user_id`));
  if (known.length === 1) return known[0] as ForgeName;
  const [glab, gh] = await Promise.all([cliAuthed('glab'), cliAuthed('gh')]);
  if (glab && !gh) return 'gitlab';
  if (gh && !glab) return 'github';
  return 'gitlab';
};
