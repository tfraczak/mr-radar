/**
 * The spine of the app. Everything else consumes these.
 *
 * Terminology, because two of these words are easy to conflate:
 *  - a **check** is one CI thing that ran (a GitLab pipeline, an RWX run)
 *  - the **test gate** is the single check per repo that answers "did my specs pass"
 *
 * A repo can have checks from both providers. rocket has GitLab pipelines (lint
 * only) *and* RWX runs (the specs), so provider alone can't tell you whether
 * tests passed — the role can.
 */

export type CiProvider = 'rwx' | 'gitlab' | 'github';

/** Normalized GitHub check run — the neutral "job with a verdict" shape. */
export interface ForgeCheckRun {
  id: string;
  /** Check-suite id: the per-push dedup key (≈ a GitLab pipeline id). */
  suiteId: string;
  name: string;
  state: 'succeeded' | 'failed' | 'in_progress' | 'waiting';
  url: string;
  createdAt: string;
}

/** What a check actually verifies. Only `tests` feeds the test gate. */
export type CheckRole = 'tests' | 'lint';

export type CheckState = 'succeeded' | 'failed' | 'in_progress' | 'waiting';

export interface Check {
  provider: CiProvider;
  role: CheckRole;
  /** `.rwx/ci.yml` for RWX, or the pipeline's failing/summary job name for GitLab. */
  name: string;
  sha: string;
  state: CheckState;
  url: string;
  /** RWX run id or GitLab pipeline id — the notification dedup key. */
  id: string;
  createdAt: string;
}

/**
 * The per-repo verdict on "have my tests run against this commit".
 *
 * `unverified.startable` is the crux: a missing GitLab pipeline is transient
 * (one is about to be created), but a missing RWX result is permanent until a
 * human starts it. Only startable gates produce a suggestion.
 */
export type TestGate =
  | { kind: 'verified'; provider: CiProvider; result: 'succeeded' | 'failed'; url: string; name: string }
  // url is optional: a run we know is in flight (e.g. a tracked trigger) should
  // suppress "Start run" even before we've captured its run URL.
  | { kind: 'in_progress'; provider: CiProvider; url?: string }
  | {
      kind: 'unverified';
      provider: CiProvider;
      /** `'many'` when the covered commit is beyond the commits page we fetched. */
      unverifiedCommits: number | 'many';
      startable: boolean;
      /** A `waiting` RWX run for this exact sha, if one exists. */
      url?: string;
      /**
       * The newest completed test-gate run on this branch (an older commit).
       * Absent = the branch has **never** produced a test result — "never run"
       * and "ran on an older commit" are very different urgencies.
       */
      lastResult?: {
        result: 'succeeded' | 'failed';
        sha: string;
        url: string;
        completedAt?: string | undefined;
      };
    }
  | { kind: 'none' };

/** How a project's checks map to roles. Detected once, cached, overridable. */
export interface RepoCiRoles {
  /** Which provider owns the test gate. `none` = repo has no tests in CI. */
  testGate: CiProvider | 'none';
  /** True when the GitLab pipeline exists but only runs lint (rocket). */
  gitlabIsLintOnly: boolean;
  detectedAt: string;
}

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

export interface ForgeUser {
  id: number;
  username: string;
  name: string;
}

/** Trimmed from the MR list response — only the fields we actually use. */
export interface ForgeMr {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  state: string;
  sha: string;
  source_branch: string;
  target_branch: string;
  web_url: string;
  updated_at: string;
  created_at: string;
  user_notes_count: number;
  draft: boolean;
  has_conflicts: boolean;
  author: ForgeUser;
  references: { full: string };
  /** Present on single-MR fetches; used to add (not clobber) a reviewer. */
  reviewers?: ForgeUser[];
}

export interface ForgeNote {
  id: number;
  body: string;
  author: ForgeUser;
  created_at: string;
  updated_at: string;
  system: boolean;
  resolvable: boolean;
  resolved?: boolean;
  position?: { new_path?: string; new_line?: number | null };
}

export interface ForgeDiscussion {
  id: string;
  individual_note: boolean;
  notes: ForgeNote[];
}

export interface ForgeApprovals {
  approved: boolean;
  /** Absent when the forge cannot report a requirement (GitHub often can't). */
  approvals_required?: number;
  approvals_left?: number;
  approved_by: { user: ForgeUser; approved_at?: string }[];
}

export interface ForgePipeline {
  id: number;
  iid?: number;
  status: string;
  source: string;
  ref: string;
  sha: string;
  web_url: string;
  created_at: string;
  updated_at: string;
}

export interface ForgeJob {
  id: number;
  name: string;
  stage: string;
  status: string;
  web_url: string;
}

export interface ForgeCommit {
  id: string;
  title: string;
  committed_date: string;
}

/** One row from `GET /events?action=commented` — a note I authored somewhere. */
export interface ForgeCommentEvent {
  project_id: number;
  target_title?: string;
  created_at: string;
  note?: {
    noteable_type: string;
    noteable_iid: number;
  };
}

export interface ForgeTodo {
  id: number;
  action_name: string;
  target_type: string;
  author: ForgeUser;
  created_at: string;
  target?: {
    iid?: number;
    project_id?: number;
    state?: string;
    references?: { full?: string };
  };
  project?: { path_with_namespace?: string };
  target_url: string;
}

// ---------------------------------------------------------------------------
// RWX
// ---------------------------------------------------------------------------

export interface RwxRun {
  ID: string;
  Branch: string;
  CommitSha: string;
  DefinitionPath: string;
  RepositoryName: string;
  RunUrl: string;
  Title: string;
  Trigger: string;
  CreatedAt: string;
  StartedAt: string | null;
  CompletedAt: string | null;
  Status: {
    Execution: 'waiting' | 'in_progress' | 'finished' | 'aborted';
    Result: 'succeeded' | 'failed' | 'no_result' | 'debugged' | 'sandboxed';
    WaitingSubStatus?: string;
    AbortedSubStatus?: string;
    FinishedSubStatus?: string;
  };
}

export interface RwxRunsResponse {
  Runs: RwxRun[];
  Pagination?: { Limit: number; NextCursor?: string };
}

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

export interface JiraTicket {
  key: string;
  summary: string;
  status: string;
  updated: string;
  url: string;
  /** ISO date (YYYY-MM-DD) if the ticket has a due date; used for "overdue". */
  dueDate?: string;
  /** Jira status category: 'To Do' | 'In Progress' | 'Done'. 'Done' = closed-ish. */
  statusCategory?: string;
  /** ISO timestamp the ticket was resolved, if it has been. */
  resolutionDate?: string;
  /** Issue type name (Story, Bug, Data Fix, …) — data fixes skip fix versions. */
  issueType?: string;
  /** Assigned fix versions. Empty on a non-data-fix Dev Complete = actionable. */
  fixVersions?: { id: string; name: string }[];
}

// ---------------------------------------------------------------------------
// Normalized snapshot
// ---------------------------------------------------------------------------

/** One MR plus everything we know about it, after correlation. */
export interface WatchItem {
  /** `acme/rocket!7576` — the stable primary key everywhere. */
  key: string;
  projectPath: string;
  projectId: number;
  iid: number;
  branch: string;
  /** Where this MR merges to — usually main; release branches earn a warning. */
  targetBranch: string;
  title: string;
  headSha: string;
  webUrl: string;
  updatedAt: string;
  createdAt: string;
  userNotesCount: number;
  draft: boolean;
  hasConflicts: boolean;
  /**
   * Why this MR is tracked. `authored` = mine; `reviewer` = definitive reviewer
   * signal (requested reviewer ∪ already approved); `participating` = looser —
   * I commented on it (Events API) or was mentioned on it (pending todos),
   * without the formal reviewer role. Precedence when several apply:
   * authored > reviewer > participating.
   */
  reason: 'authored' | 'reviewer' | 'participating';
  /** How I'm participating, when reason is `participating`. Commented wins. */
  participation?: 'commented' | 'mentioned';
  ticket?: JiraTicket;
  inScope: boolean;
  /**
   * Per-MR manual ignore override, loaded from the DB row each cycle:
   * 'ignored' pins the MR into the Ignored bucket, 'shown' rescues it from an
   * ignore rule, absent defers to the status rules. Dies with the row when
   * the MR closes and is pruned.
   */
  ignoreOverride?: 'ignored' | 'shown';

  // Populated only for in-scope MRs whose details were fetched this cycle.
  threads?: ThreadSummary[];
  approvals?: { required?: number; left?: number; by: string[] };
  /** Last-known unresolved count, used when a cycle skips the discussions fetch. */
  unresolvedFallback?: number;
  checks?: Check[];
  testGate?: TestGate;
  /** Persisted so the commit list isn't refetched while the head is unchanged. */
  unverifiedCache?: { sha: string; count: number | 'many' };

  // Reviewer-side freshness: has the author pushed since I last spoke?
  /** ISO timestamp of my newest comment on this MR, if I have commented. */
  myLastCommentAt?: string;
  /**
   * Commit dates for the current head, cached per head sha.
   *
   * The dates rather than just the newest one, because `newCommits` has to be
   * recomputable without a refetch: commenting again moves my comment forward
   * and must drop the count to zero on the very next cycle, and a single
   * "newest commit" date can only answer "any?", never "how many?".
   */
  headCommitDates?: string[];
  /**
   * How many commits landed after my newest comment — the ball is back in my
   * court, and by how much. Only computed for MRs I did not author: on my own
   * MR, "I pushed after I commented" is just Tuesday.
   */
  newCommits?: number;
}

export interface ThreadSummary {
  id: string;
  resolved: boolean;
  resolvable: boolean;
  filePath?: string;
  line?: number;
  notes: { id: number; author: string; body: string; createdAt: string }[];
}

export interface Snapshot {
  at: string;
  items: WatchItem[];
  activeTickets: JiraTicket[];
  /** Per-source health for the footer; a degraded source is not a fatal cycle. */
  sources: Partial<Record<SourceName, SourceHealth>>;
}

export type SourceName = 'jira' | 'gitlab' | 'github' | 'rwx';

export interface SourceHealth {
  ok: boolean;
  at: string;
  error?: string;
  /** Set when we fell back to cached data rather than a live fetch. */
  stale?: boolean;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EventBase {
  /** MR key, e.g. `acme/rocket!7576`. */
  mrKey: string;
  mrTitle: string;
  branch: string;
  url: string;
  ticket?: string;
}

export type AppEvent =
  | (EventBase & {
      type: 'comment';
      /** Coalesced: one event per MR per cycle, however many notes arrived. */
      authors: string[];
      count: number;
      preview: string;
      noteIds: number[];
    })
  | (EventBase & { type: 'approval'; by: string; left?: number; required?: number })
  | (EventBase & { type: 'review_submitted'; by: string })
  | (EventBase & { type: 'thread_resolved'; by: string; count: number })
  | (EventBase & { type: 'unmergeable' })
  | (EventBase & {
      /** New commits on an MR I review, pushed after my newest comment. */
      type: 'review_updated';
      headSha: string;
      /** My newest comment's timestamp — what "since" means here. */
      since: string;
      /** How many commits landed after it. */
      count: number;
    })
  | (EventBase & {
      type: 'ci_failed';
      provider: CiProvider;
      role: CheckRole;
      name: string;
      checkId: string;
      ciUrl: string;
    })
  | (EventBase & {
      type: 'ci_succeeded';
      provider: CiProvider;
      role: CheckRole;
      name: string;
      checkId: string;
      ciUrl: string;
    })
  | (EventBase & {
      type: 'ci_aborted';
      provider: CiProvider;
      role: CheckRole;
      name: string;
      checkId: string;
      ciUrl: string;
    })
  | (EventBase & {
      type: 'ci_suggest_run';
      provider: CiProvider;
      unverifiedCommits: number | 'many';
      headSha: string;
      /** The waiting run's URL, when one exists for this sha. */
      ciUrl?: string;
      /** The stale verdict, when the branch ran before on an older commit. */
      lastResult?: 'succeeded' | 'failed';
    });

export type AppEventType = AppEvent['type'];

/**
 * Every event type, as data — the notification matrix validates against this
 * and the settings grid renders a row per entry.
 */
export const EVENT_TYPES = [
  'comment',
  'approval',
  'review_submitted',
  'thread_resolved',
  'unmergeable',
  'review_updated',
  'ci_failed',
  'ci_succeeded',
  'ci_aborted',
  'ci_suggest_run',
] as const satisfies readonly AppEventType[];

// Compile-time exhaustiveness: a new event type that isn't listed above fails
// here rather than silently becoming un-notifiable.
const _everyTypeListed: Record<AppEventType, true> = {
  comment: true,
  approval: true,
  review_submitted: true,
  thread_resolved: true,
  unmergeable: true,
  review_updated: true,
  ci_failed: true,
  ci_succeeded: true,
  ci_aborted: true,
  ci_suggest_run: true,
};
void _everyTypeListed;

/**
 * Why an MR is tracked — and, because the popover's tabs are exactly this, the
 * bucket a notification belongs to: authored = My work, reviewer = My reviews,
 * participating = Participating.
 */
export type EventAudience = WatchItem['reason'];

export const EVENT_AUDIENCES = ['authored', 'reviewer', 'participating'] as const satisfies readonly EventAudience[];
