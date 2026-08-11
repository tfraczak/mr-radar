import { unresolvedCount } from './correlate';
import { ticketKeyCandidates, titleKeyCandidate } from './sources/jira';
import type { Db } from './db';
import type { AppEvent, Check, ForgeTodo, WatchItem } from './types';

/** Does this MR's branch or title still carry `key`? Guards stale pinning. */
const stillClaims = (item: WatchItem, key: string | null | undefined): boolean => {
  if (!key) return false;
  return (
    ticketKeyCandidates(item.branch).some((c) => c.key === key) ||
    titleKeyCandidate(item.title)?.key === key
  );
};

/**
 * Turn "what changed since last cycle" into notifications.
 *
 * The rule that keeps this app usable, applied uniformly to MRs and CI runs:
 * **anything not already recorded is seeded silently and never notified on the
 * cycle it first appears.** One rule covers first launch, a brand-new MR
 * appearing mid-life, and a deleted or corrupted database — otherwise any of
 * those three would fire hundreds of banners at once.
 */

export interface DiffInput {
  db: Db;
  items: WatchItem[];
  todos: ForgeTodo[];
  /** Our own username; we don't notify ourselves for comments. */
  me: string;
  now: string;
}

export interface DiffResult {
  events: AppEvent[];
  /** Mutations to apply inside the cycle's transaction, after notifying. */
  commit: (db: Db) => void;
}

export const diff = (input: DiffInput): DiffResult => {
  const { db, items, todos, me, now } = input;
  const events: AppEvent[] = [];
  const pending: ((db: Db) => void)[] = [];
  // An empty MR table means a first launch or a wiped DB. Todos carry no
  // per-item history to diff against, so they need this explicit signal to stay
  // quiet on that first cycle.
  const seedingAll = db.allMrs().length === 0;

  for (const item of items) {
    if (!item.inScope) continue;
    const prev = db.getMr(item.key);
    // First sighting of this MR: record everything we can see, notify nothing.
    const seeding = prev === undefined;

    if (item.threads) {
      const seen = db.seenNoteIds(item.key);
      const fresh: { id: number; author: string; body: string; createdAt: string }[] = [];
      for (const thread of item.threads) {
        for (const note of thread.notes) {
          if (seen.has(note.id)) continue;
          fresh.push(note);
        }
      }
      const ids = fresh.map((n) => n.id);
      if (ids.length) pending.push((d) => d.markNotesSeen(item.key, ids));

      // Bots (automated reviewers) notify the same as humans by design — only our own
      // comments are filtered out.
      const fromOthers = fresh.filter((n) => n.author !== me);
      if (!seeding && fromOthers.length > 0) {
        events.push({
          type: 'comment',
          ...base(item),
          authors: [...new Set(fromOthers.map((n) => n.author))],
          count: fromOthers.length,
          preview: previewOf(fromOthers[fromOthers.length - 1]?.body ?? ''),
          noteIds: fromOthers.map((n) => n.id),
        });
      }

      // Thread resolutions, which arrive as a state change rather than a note.
      const prevThreads = db.seenThreads(item.key);
      const newlyResolved = item.threads.filter(
        (t) => t.resolved && prevThreads.get(t.id) === false,
      );
      if (!seeding && newlyResolved.length > 0) {
        events.push({
          type: 'thread_resolved',
          ...base(item),
          by: me,
          count: newlyResolved.length,
        });
      }
      pending.push((d) =>
        d.setThreads(
          item.key,
          (item.threads ?? []).map((t) => ({ id: t.id, resolved: t.resolved })),
        ),
      );
    }

    if (item.approvals) {
      const seen = db.seenApprovers(item.key);
      const current = item.approvals.by;
      const fresh = current.filter((u) => !seen.has(u) && u !== me);
      if (!seeding) {
        for (const by of fresh) {
          events.push({
            type: 'approval',
            ...base(item),
            by,
            ...(item.approvals.left !== undefined ? { left: item.approvals.left } : {}),
            ...(item.approvals.required !== undefined ? { required: item.approvals.required } : {}),
          });
        }
      }
      pending.push((d) => d.setApprovers(item.key, current));
    }

    // Merge conflicts. Only on transition into conflict, so it says something
    // once rather than every cycle for the life of the conflict.
    if (!seeding && item.hasConflicts && prev?.has_conflicts === 0) {
      events.push({ type: 'unmergeable', ...base(item) });
    }

    events.push(...ciEvents({ db, item, seeding, now, pending }));

    pending.push((d) =>
      d.upsertMr(
        {
          key: item.key,
          project_path: item.projectPath,
          project_id: item.projectId,
          iid: item.iid,
          branch: item.branch,
          title: item.title,
          head_sha: item.headSha,
          web_url: item.webUrl,
          updated_at: item.updatedAt,
          user_notes_count: item.userNotesCount,
          unresolved: item.threads ? unresolvedCount(item.threads) : (prev?.unresolved ?? 0),
          approvals_left: item.approvals?.left ?? prev?.approvals_left ?? null,
          approvals_required: item.approvals?.required ?? prev?.approvals_required ?? null,
          approvals_by: item.approvals ? item.approvals.by.join(',') : (prev?.approvals_by ?? null),
          has_conflicts: item.hasConflicts ? 1 : 0,
          in_scope: item.inScope ? 1 : 0,
          reason: item.reason,
          // A harvest miss (Jira down, cadence skip) must not wipe the
          // last-known ticket — but a key the MR no longer claims (retitled,
          // rebased) must not be pinned forever either. Preserve prev only
          // while the branch/title still carries that exact key.
          ticket_key: item.ticket?.key ?? (stillClaims(item, prev?.ticket_key) ? prev!.ticket_key : null),
          ticket_status:
            item.ticket?.status ?? (stillClaims(item, prev?.ticket_key) ? (prev?.ticket_status ?? null) : null),
          // The whole ticket, not just its status: the next cadence miss
          // rebuilds from this, and a ticket missing fixVersions/issueType
          // reads as UNKNOWN, which silently flips every `empty` rule.
          ticket_json: item.ticket
            ? JSON.stringify(item.ticket)
            : (stillClaims(item, prev?.ticket_key) ? (prev?.ticket_json ?? null) : null),
          unverified_count: item.unverifiedCache ? String(item.unverifiedCache.count) : null,
          unverified_sha: item.unverifiedCache?.sha ?? null,
        },
        now,
      ),
    );
  }

  events.push(...todoEvents({ db, items, todos, me, now, pending, seedingAll }));

  return {
    events,
    commit: (d) => {
      for (const fn of pending) fn(d);
    },
  };
}

/**
 * CI events.
 *
 * Two different dedup keys, because the two situations differ:
 *  - a **result** (failed/succeeded/aborted) keys on the run/pipeline id, so a
 *    re-push produces a new id and notifies again.
 *  - **suggest-run** keys on `(provider, branch, definition, head sha)`, so it
 *    fires once per push. This matters enormously: on rocket the unverified state
 *    persists for weeks (every `.rwx/ci.yml` run on ENG-118 since 2026-07-09 is
 *    still `waiting`), and keying on anything cyclical would nag every 60s.
 */
const ciEvents = (args: {
  db: Db;
  item: WatchItem;
  seeding: boolean;
  now: string;
  pending: ((db: Db) => void)[];
}): AppEvent[] => {
  const { db, item, seeding, now, pending } = args;
  const events: AppEvent[] = [];
  const gate = item.testGate;

  for (const check of item.checks ?? []) {
    // Only report checks for the commit under review; a result for an abandoned
    // push is greyed in the UI and never notified.
    if (check.sha !== item.headSha) continue;
    if (check.state === 'in_progress' || check.state === 'waiting') continue;

    const kind = check.state === 'succeeded' ? 'ci_succeeded' : 'ci_failed';
    pending.push((d) => d.upsertCiRun(ciRow(item, check)));

    // Notify each run's result exactly once. The `ci_result` key is shared with
    // the watched-run path (runs we started), so whichever sees the run finish
    // first notifies and the other stays quiet.
    const resultKey = `${check.provider}|${check.id}`;
    const already = db.wasNotified('ci_result', resultKey);
    // Mark it seen either way — this is also what keeps a run that was already
    // finished when we first saw the MR from notifying on a later cycle (silent
    // seeding for CI results).
    if (!already) pending.push((d) => d.markNotified('ci_result', resultKey, now));
    if (seeding || already) continue;

    events.push({
      type: kind,
      ...base(item),
      provider: check.provider,
      role: check.role,
      name: check.name,
      checkId: check.id,
      ciUrl: check.url,
    });
  }

  if (!seeding && gate?.kind === 'unverified' && gate.startable) {
    const definition = item.checks?.find((c) => c.role === 'tests')?.name ?? 'tests';
    const key = suggestRunKey(gate.provider, item.branch, definition, item.headSha);
    if (!db.wasNotified('suggest_run', key)) {
      events.push({
        type: 'ci_suggest_run',
        ...base(item),
        provider: gate.provider,
        unverifiedCommits: gate.unverifiedCommits,
        headSha: item.headSha,
        ...(gate.url ? { ciUrl: gate.url } : {}),
        ...(gate.lastResult ? { lastResult: gate.lastResult.result } : {}),
      });
      pending.push((d) => d.markNotified('suggest_run', key, now));
    }
  }

  return events;
}

export const suggestRunKey = (
  provider: string,
  branch: string,
  definition: string,
  headSha: string,
): string => {
  return [provider, branch, definition, headSha].join('|');
}

/**
 * Events GitLab's todo feed reports better than we can derive.
 *
 * `build_failed` and `unmergeable` todos are authored by *you* — GitLab creates
 * them on your behalf — so the usual "ignore my own activity" filter would
 * wrongly drop exactly the ones worth seeing. Only `review_submitted` and
 * mentions are filtered by author.
 */
const todoEvents = (args: {
  db: Db;
  items: WatchItem[];
  todos: ForgeTodo[];
  me: string;
  now: string;
  pending: ((db: Db) => void)[];
  /** True on the very first cycle, when nothing should notify. */
  seedingAll: boolean;
}): AppEvent[] => {
  const { db, items, todos, me, now, pending, seedingAll } = args;
  const byKey = new Map(items.filter((i) => i.inScope).map((i) => [i.key, i]));
  const events: AppEvent[] = [];

  for (const todo of todos) {
    if (todo.target_type !== 'MergeRequest') continue;
    if (todo.action_name !== 'review_submitted') continue;
    if (todo.author.username === me) continue;
    const key = todo.target?.references?.full;
    if (!key) continue;
    const item = byKey.get(key);
    if (!item) continue;

    // Todos have no lifecycle we can diff, so dedup on the todo's own id.
    const dedupKey = String(todo.id);
    if (db.wasNotified('todo_review', dedupKey)) continue;
    pending.push((d) => d.markNotified('todo_review', dedupKey, now));
    if (seedingAll) continue;

    events.push({ type: 'review_submitted', ...base(item), by: todo.author.username });
  }
  return events;
}

const ciRow = (item: WatchItem, check: Check) => {
  return {
    id: check.id,
    provider: check.provider,
    project_path: item.projectPath,
    branch: item.branch,
    name: check.name,
    role: check.role,
    sha: check.sha,
    state: check.state,
    url: check.url,
    created_at: check.createdAt,
  };
}

const base = (item: WatchItem) => {
  return {
    mrKey: item.key,
    mrTitle: item.title,
    branch: item.branch,
    url: item.webUrl,
    ...(item.ticket ? { ticket: item.ticket.key } : {}),
  };
}

/** Strip markdown noise so a notification body reads as a sentence. */
export const previewOf = (body: string, max = 140): string => {
  const flat = body
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One notification per MR per cycle, so 12 new comments is one banner. */
export const coalesce = (events: AppEvent[]): AppEvent[] => {
  const comments = new Map<string, AppEvent & { type: 'comment' }>();
  const rest: AppEvent[] = [];

  for (const e of events) {
    if (e.type !== 'comment') {
      rest.push(e);
      continue;
    }
    const existing = comments.get(e.mrKey);
    if (!existing) {
      comments.set(e.mrKey, { ...e });
      continue;
    }
    existing.count += e.count;
    existing.authors = [...new Set([...existing.authors, ...e.authors])];
    existing.noteIds = [...existing.noteIds, ...e.noteIds];
    existing.preview = e.preview;
  }
  return [...comments.values(), ...rest];
}

/** Human-readable notification title + body. */
export const describe = (e: AppEvent): { title: string; body: string } => {
  switch (e.type) {
    case 'comment': {
      const who = e.authors.join(', ');
      const n = e.count === 1 ? '1 new comment' : `${e.count} new comments`;
      return { title: `${e.mrKey} — ${n}`, body: `${who}: ${e.preview}` };
    }
    case 'approval':
      return {
        title: `${e.mrKey} — approved by ${e.by}`,
        body: e.left !== undefined && e.left > 0 ? `${e.left} more approval(s) needed · ${e.mrTitle}` : e.mrTitle,
      };
    case 'review_submitted':
      return { title: `${e.mrKey} — review from ${e.by}`, body: e.mrTitle };
    case 'thread_resolved':
      return {
        title: `${e.mrKey} — ${e.count} thread(s) resolved`,
        body: e.mrTitle,
      };
    case 'unmergeable':
      return { title: `${e.mrKey} — merge conflict`, body: e.mrTitle };
    case 'ci_failed':
      return {
        title: `${e.mrKey} — ${label(e.provider, e.role)} failed`,
        body: `${e.name} · ${e.branch}`,
      };
    case 'ci_succeeded':
      return {
        title: `${e.mrKey} — ${label(e.provider, e.role)} passed`,
        body: `${e.name} · ${e.branch}`,
      };
    case 'ci_aborted':
      return {
        title: `${e.mrKey} — ${label(e.provider, e.role)} aborted`,
        body: `${e.name} · ${e.branch}`,
      };
    case 'ci_suggest_run': {
      const n = e.unverifiedCommits;
      const count = n === 'many' ? undefined : `${n} commit${n === 1 ? '' : 's'} unverified`;
      // "never run" and "stale" are different asks: the first is "this code has
      // no verdict at all", the second is "the verdict you have is out of date".
      const how = e.lastResult
        ? `stale — last ${e.lastResult === 'succeeded' ? 'passed' : 'failed'}${count ? `, ${count}` : ''}`
        : (count ?? 'never run');
      const title = e.lastResult
        ? `${e.mrKey} — tests ${how}`
        : `${e.mrKey} — tests never run${count ? ` (${count})` : ''}`;
      return {
        title,
        body: `${e.branch} · start a ${e.provider.toUpperCase()} run`,
      };
    }
  }
}

/** Say which system reported it, so lint is never mistaken for specs. */
const label = (provider: string, role: string): string => {
  const p = provider === 'rwx' ? 'RWX' : 'CI';
  return role === 'lint' ? `${p} lint` : `${p} tests`;
}

export interface Notification {
  title: string;
  body: string;
  /** Where a click goes. Absent for digests, which just open the popover. */
  url?: string;
  /** Events this notification stands in for, so history stays per-MR. */
  events: AppEvent[];
}

const SUGGEST_DIGEST_THRESHOLD = 3;

/**
 * Turn events into the banners actually shown.
 *
 * Separate from `diff` on purpose: events are the durable record (one row per MR
 * per thing that happened), while notifications are a presentation choice.
 *
 * The case that forces this: rocket's unverified state applies to *every* open MR
 * at once, so the first real cycle legitimately produces ~10 `ci_suggest_run`
 * events. Ten banners is unusable; one that says "10 branches have unverified
 * tests" is actionable. Results and comments stay individual — those are
 * per-MR news you want to read separately.
 */
export const toNotifications = (events: AppEvent[]): Notification[] => {
  const suggests = events.filter((e): e is AppEvent & { type: 'ci_suggest_run' } => e.type === 'ci_suggest_run');
  const rest = events.filter((e) => e.type !== 'ci_suggest_run');

  const out: Notification[] = rest.map((e) => {
    const { title, body } = describe(e);
    return { title, body, url: e.url, events: [e] };
  });

  if (suggests.length === 0) return out;

  if (suggests.length < SUGGEST_DIGEST_THRESHOLD) {
    for (const e of suggests) {
      const { title, body } = describe(e);
      out.push({ title, body, url: e.ciUrl ?? e.url, events: [e] });
    }
    return out;
  }

  const branches = suggests.map((e) => e.ticket ?? e.branch);
  const shown = branches.slice(0, 4).join(', ');
  const more = branches.length > 4 ? `, +${branches.length - 4} more` : '';
  out.push({
    title: `${suggests.length} branches have unverified tests`,
    body: `${shown}${more}`,
    events: suggests,
  });
  return out;
}
