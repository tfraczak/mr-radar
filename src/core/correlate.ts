import { mrKey } from './sources/gitlab';
import { ticketKeyFromBranch } from './sources/jira';
import type {
  ForgeDiscussion,
  ForgeMr,
  JiraTicket,
  ThreadSummary,
  WatchItem,
} from './types';

/**
 * Join the three systems on the branch name.
 *
 * The branch name **is** the Jira ticket key (`ENG-126`, `APP-19615`), and RWX
 * reports the same string as its run `Branch`, so one key ties everything
 * together with no mapping table.
 */

export interface CorrelateInput {
  authored: ForgeMr[];
  /** Definitive reviewer signal: requested reviewer ∪ approved by me. */
  reviewer: ForgeMr[];
  /** Looser signal: MRs I commented on (Events API), open, not mine. */
  commented?: ForgeMr[];
  /** Loosest signal: MRs with a pending mention todo for me. */
  mentioned?: ForgeMr[];
  activeTickets: JiraTicket[];
  /** Include MRs updated within this many days even if their ticket is idle. */
  recentDaysFallback: number;
  now: Date;
}

type Reason = WatchItem['reason'];

export const correlate = (input: CorrelateInput): WatchItem[] => {
  const {
    authored,
    reviewer,
    commented = [],
    mentioned = [],
    activeTickets,
    recentDaysFallback,
    now,
  } = input;
  const ticketByKey = new Map(activeTickets.map((t) => [t.key, t]));
  const items = new Map<string, WatchItem>();

  const add = (mr: ForgeMr, reason: Reason, participation?: 'commented' | 'mentioned'): void => {
    const projectPath = projectPathOf(mr);
    // The forge's own reference IS the key (GitLab `group/repo!7633`, GitHub
    // `owner/repo#123`) — events.ts looks todos up by this string verbatim.
    const key = mr.references?.full ?? mrKey(projectPath, mr.iid);
    // An MR can carry several relationships; the strongest wins. Authored is
    // primary (drives trigger actions); reviewer beats participating; a comment
    // (engagement) beats a mention (someone else's ping). Callers add in that
    // order, so any existing entry outranks this one.
    if (items.has(key) && reason !== 'authored') return;

    const branch = mr.source_branch;
    const tKey = ticketKeyFromBranch(branch);
    const ticket = tKey ? ticketByKey.get(tKey) : undefined;

    items.set(key, {
      key,
      projectPath,
      projectId: mr.project_id,
      iid: mr.iid,
      branch,
      targetBranch: mr.target_branch,
      title: mr.title,
      headSha: mr.sha,
      webUrl: mr.web_url,
      updatedAt: mr.updated_at,
      createdAt: mr.created_at,
      userNotesCount: mr.user_notes_count ?? 0,
      draft: Boolean(mr.draft),
      hasConflicts: Boolean(mr.has_conflicts),
      reason,
      ...(participation ? { participation } : {}),
      ...(ticket ? { ticket } : {}),
      inScope: inScope({
        reason,
        ...(ticket ? { ticket } : {}),
        updatedAt: mr.updated_at,
        recentDaysFallback,
        now,
      }),
    });
  };

  for (const mr of authored) add(mr, 'authored');
  for (const mr of reviewer) add(mr, 'reviewer');
  for (const mr of commented) add(mr, 'participating', 'commented');
  for (const mr of mentioned) add(mr, 'participating', 'mentioned');
  return [...items.values()];
}

/**
 * Scope decides which MRs get expensive detail fetches and can notify.
 *
 * Jira is what makes this useful: of 42 open authored MRs, only ~13 map to a
 * ticket in an active status. The rest are stale and stay silent.
 *
 * Review requests are always in scope — a review you owe someone is blocking
 * them, regardless of what your own ticket board says. Participating MRs are
 * in scope too: having commented, you want the replies — and the set is
 * already bounded by the comment-events window.
 */
export const inScope = (args: {
  reason: Reason;
  ticket?: JiraTicket;
  updatedAt: string;
  recentDaysFallback: number;
  now: Date;
}): boolean => {
  if (args.reason === 'reviewer' || args.reason === 'participating') return true;
  if (args.ticket) return true;
  if (args.recentDaysFallback > 0) {
    const age = args.now.getTime() - new Date(args.updatedAt).getTime();
    if (age <= args.recentDaysFallback * 86_400_000) return true;
  }
  return false;
}

/**
 * `references.full` is `acme/rocket!7576`, so the project path is everything
 * before the `!`. Preferred over reconstructing from `web_url`, which also
 * contains `/-/merge_requests/`.
 */
export const projectPathOf = (mr: ForgeMr): string => {
  const full = mr.references?.full;
  if (full) {
    // Separator is forge-specific: GitLab `!`, GitHub `#`.
    const idx = Math.max(full.lastIndexOf('!'), full.lastIndexOf('#'));
    if (idx > 0) return full.slice(0, idx);
  }
  const m =
    /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/\d+/.exec(mr.web_url) ??
    /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(mr.web_url);
  return m?.[1] ?? String(mr.project_id);
}

/**
 * Flatten discussions into threads, dropping GitLab's system notes.
 *
 * System notes are the bulk of the volume ("added 288 commits", "changed the
 * description", "approved this merge request") and are not comments. Note that
 * approvals *do* generate one, which is why an approval still bumps the MR's
 * `updated_at` and our cheap change gate stays correct.
 */
export const summarizeThreads = (discussions: ForgeDiscussion[]): ThreadSummary[] => {
  const out: ThreadSummary[] = [];
  for (const d of discussions) {
    const human = d.notes.filter((n) => !n.system);
    if (human.length === 0) continue;
    const first = human[0];
    if (!first) continue;
    const pos = first.position;
    out.push({
      id: d.id,
      resolved: Boolean(first.resolved),
      resolvable: Boolean(first.resolvable),
      ...(pos?.new_path ? { filePath: pos.new_path } : {}),
      ...(typeof pos?.new_line === 'number' ? { line: pos.new_line } : {}),
      notes: human.map((n) => ({
        id: n.id,
        author: n.author.username,
        body: n.body,
        createdAt: n.created_at,
      })),
    });
  }
  return out;
}

export const unresolvedCount = (threads: ThreadSummary[]): number => {
  return threads.filter((t) => t.resolvable && !t.resolved).length;
}

/**
 * Whether an MR needs its expensive details refetched.
 *
 * `updated_at` alone is the documented signal, but `user_notes_count` is checked
 * too as a cheap belt-and-braces: both come free with the list response.
 * A periodic full reconcile covers anything both miss.
 */
export const detailsChanged = (
  prev: { updated_at: string; user_notes_count: number } | undefined,
  next: { updatedAt: string; userNotesCount: number },
): boolean => {
  if (!prev) return true;
  return prev.updated_at !== next.updatedAt || prev.user_notes_count !== next.userNotesCount;
}
