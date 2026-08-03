import {
  DEFAULT_RWX_TEST_DEFINITION,
  detectRepoRoles,
  failedJobNames,
  checksCheckFor,
  gitlabCheckFor,
  newestCompletedRun,
  resolveTestGate,
  rwxChecksFor,
  rwxRunsFor,
} from './ci';
import { buildJql, type Config } from './config';
import { correlate, detailsChanged, summarizeThreads, unresolvedCount } from './correlate';
import type { Db } from './db';
import { coalesce, diff } from './events';
import type { ForgeSource } from './sources/forge';
import { JiraSource, ticketKeyFromBranch } from './sources/jira';
import { RwxSource, isTerminal } from './sources/rwx';
import type {
  ForgeCheckRun,
  AppEvent,
  Check,
  ForgeCommentEvent,
  ForgeMr,
  ForgePipeline,
  ForgeTodo,
  JiraTicket,
  RepoCiRoles,
  RwxRun,
  Snapshot,
  SourceHealth,
  SourceName,
  WatchItem,
} from './types';

const ROLE_DETECTION_TTL_MS = 7 * 86_400_000;

/** How far back the comment-events window reaches for "participating" MRs. */
const PARTICIPATING_DAYS = 30;
/** Cap ref hydration per cycle so old comment history can't stall a cycle. */
const PARTICIPATING_HYDRATE_MAX = 20;
/** Refs that resolved to a closed MR are re-checked this often (reopens). */
const CLOSED_REF_TTL_MS = 24 * 3_600_000;

export interface PollDeps {
  db: Db;
  config: Config;
  forge: ForgeSource;
  rwx: RwxSource;
  jira?: JiraSource;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface PollResult {
  snapshot: Snapshot;
  events: AppEvent[];
  /** Detail fetches performed, for the "is this actually cheap" check. */
  stats: { detailFetches: number; commitFetches: number; apiCalls: number };
}

/**
 * One poll cycle.
 *
 * Ordering is deliberate: **Jira first**, because its active-ticket set decides
 * which MRs are worth spending detail fetches on. Each source is isolated so one
 * failure degrades that source rather than killing the cycle — and a Jira
 * failure specifically falls back to the cached ticket set, because collapsing
 * scope to empty would silently stop all notifications, the worst outcome here.
 */
export const pollOnce = async (deps: PollDeps, opts: { dryRun?: boolean } = {}): Promise<PollResult> => {
  const { db, config, forge, rwx } = deps;
  // Optional-called so test fakes without the probe default to available.
  const rwxAvailable = (await rwx.available?.()) ?? true;
  const rwxOn = config.rwx.enabled && rwxAvailable;
  const now = deps.now?.() ?? new Date();
  const nowIso = now.toISOString();
  const log = deps.log ?? (() => {});
  const stats = { detailFetches: 0, commitFetches: 0, apiCalls: 0 };
  // Keyed by the ACTIVE forge — the footer shows gitlab OR github, never both.
  const sources: Partial<Record<SourceName, SourceHealth>> = {
    jira: { ok: false, at: nowIso },
    [forge.name]: { ok: false, at: nowIso },
    rwx: { ok: false, at: nowIso },
  };

  // 1. Jira — drives scope.
  const { tickets: activeTickets, health: jiraHealth, refreshed: jiraRefreshed } = await fetchJira(
    deps,
    nowIso,
    log,
  );
  sources.jira = jiraHealth;

  // 2-4. GitLab lists.
  let authored: ForgeMr[] = [];
  let reviewer: ForgeMr[] = [];
  let commented: ForgeMr[] = [];
  let mentioned: ForgeMr[] = [];
  let todos: ForgeTodo[] = [];
  try {
    const userId = await resolveUserId(deps);
    const after = new Date(now.getTime() - PARTICIPATING_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const [authoredRes, reviewerRes, approvedRes, todosRes, commentEvents] = await Promise.all([
      forge.authoredMrs(userId),
      forge.reviewerMrs(userId),
      forge.approvedMrs(userId),
      forge.todos(),
      forge.commentEvents(after),
    ]);
    stats.apiCalls += 5;
    authored = authoredRes;
    todos = todosRes;
    // Definitive reviewer signal: requested reviewer ∪ approved by me.
    reviewer = dedupeMrs([...reviewerRes, ...approvedRes]);
    // Participating signals, weakest bucket: comments I wrote (Events API) and
    // pending mention todos. Mentions come free with the todos we already
    // fetch; GitLab completes a mention todo when it's viewed, so this means
    // "mentions awaiting my attention" — exactly what a radar should show.
    const known = [...authored, ...reviewer];
    commented = await hydrateRefs(deps, commentRefs(commentEvents), known, stats, log);
    mentioned = await hydrateRefs(
      deps,
      mentionRefs(todos),
      [...known, ...commented],
      stats,
      log,
    );
    sources[forge.name] = { ok: true, at: nowIso };
  } catch (err) {
    sources[forge.name] = { ok: false, at: nowIso, error: msg(err) };
    log(`gitlab list failed: ${msg(err)}`);
  }

  const items = correlate({
    authored,
    reviewer,
    commented,
    mentioned,
    activeTickets,
    recentDaysFallback: config.recentDaysFallback,
    now,
  });
  const inScope = items.filter((i) => i.inScope);
  log(`${items.length} open MRs, ${inScope.length} in scope (${activeTickets.length} active tickets)`);

  // Learn the real status of in-scope MRs whose ticket isn't in the active set,
  // so they can be grouped by status instead of dumped under "No active ticket".
  // Tied to the Jira refresh cadence (only on a live refresh, like the active
  // set) rather than every cycle; between refreshes we reconstruct the ticket
  // from the persisted MR row so grouping is preserved without a Jira call.
  const needStatus = inScope.filter((i) => !i.ticket && ticketKeyFromBranch(i.branch));
  if (deps.jira?.configured && jiraRefreshed) {
    const keys = [...new Set(needStatus.map((i) => ticketKeyFromBranch(i.branch)).filter(Boolean))] as string[];
    if (keys.length) {
      try {
        const extra = await deps.jira.searchByKeys(keys);
        stats.apiCalls += 1;
        const byKey = new Map(extra.map((t) => [t.key, t]));
        for (const item of needStatus) {
          const key = ticketKeyFromBranch(item.branch);
          const ticket = key ? byKey.get(key) : undefined;
          if (ticket) item.ticket = ticket;
        }
      } catch (err) {
        log(`non-active ticket status lookup failed: ${msg(err)}`);
      }
    }
  } else {
    // Cadence miss — reuse the last-known status persisted on the MR row.
    for (const item of needStatus) {
      const prev = db.getMr(item.key);
      if (prev?.ticket_key && prev.ticket_status) {
        item.ticket = {
          key: prev.ticket_key,
          summary: '',
          status: prev.ticket_status,
          updated: '',
          url: `${config.jira.baseUrl}/browse/${prev.ticket_key}`,
        };
      }
    }
  }

  // 5. RWX runs — one call covers every branch. Disabled or CLI-less installs
  // skip the integration entirely and report the source healthy-but-idle.
  let rwxRuns: RwxRun[] = [];
  if (rwxOn) {
    try {
      rwxRuns = await rwx.recentRuns(100);
      stats.apiCalls += 1;
      sources.rwx = { ok: true, at: nowIso };
    } catch (err) {
      sources.rwx = { ok: false, at: nowIso, error: msg(err) };
      log(`rwx failed: ${msg(err)}`);
    }
  } else if (!config.rwx.enabled) {
    sources.rwx = { ok: true, at: nowIso }; // user-disabled: healthy, idle
  } else {
    sources.rwx = { ok: false, at: nowIso, error: 'rwx CLI not found' };
    log('rwx CLI not found on PATH — RWX coverage skipped this cycle');
  }

  // 6. Forge CI — on the pipelines model, one call per distinct in-scope
  // project. The checks model (GitHub) fetches per head sha (cached for the
  // cycle in checksBySha, shared by role detection and enrich).
  const projects = [...new Set(inScope.map((i) => i.projectPath))];
  const pipelinesByProject = new Map<string, ForgePipeline[]>();
  const checksBySha = new Map<string, Promise<ForgeCheckRun[]>>();
  const checksFor = (projectPath: string, sha: string): Promise<ForgeCheckRun[]> => {
    if (forge.ci.model !== 'checks') return Promise.resolve([]);
    const ci = forge.ci;
    let hit = checksBySha.get(sha);
    if (!hit) {
      stats.apiCalls += 1;
      hit = ci.checksForSha(projectPath, sha).catch((err) => {
        log(`check runs for ${projectPath}@${sha.slice(0, 8)} unavailable: ${msg(err)}`);
        return [];
      });
      checksBySha.set(sha, hit);
    }
    return hit;
  };
  if (forge.ci.model === 'pipelines') {
    for (const project of projects) {
      try {
        pipelinesByProject.set(project, await forge.ci.pipelines(project));
        stats.apiCalls += 1;
      } catch (err) {
        // A project with CI disabled 403s here; that's a `none` test gate, not
        // an error worth failing the cycle over.
        pipelinesByProject.set(project, []);
        log(`pipelines for ${project} unavailable: ${msg(err)}`);
      }
    }
  }

  const roles = await resolveRoles({ deps, projects, inScope, checksFor, rwxRuns, pipelinesByProject, nowIso, stats, log });

  // 7-9. Per-MR detail work, each item isolated.
  const forceReconcile = shouldReconcile(db, now, config);
  if (forceReconcile) log('full reconcile sweep');

  // Runs we started, checked by id BEFORE enrichment, so in-flight runs join
  // coverage (re-attributed ahead of the API list) and the chip flips to
  // "RWX running" the moment Start run fires.
  const watched = rwxOn
    ? await checkWatchedRuns(deps, nowIso, log)
    : { events: [], commit: () => {}, live: [] as RwxRun[] };
  if (watched.live.length) rwxRuns = dedupeRuns([...watched.live, ...rwxRuns]);

  for (const item of inScope) {
    try {
      await enrich({ deps, item, rwxRuns, pipelinesByProject, checksFor, roles, forceReconcile, stats });
    } catch (err) {
      // One bad MR must not abort the cycle — per-item rescue, cycle continues.
      log(`enrich ${item.key} failed: ${msg(err)}`);
    }
  }

  // 10. Diff, notify, persist. Results of runs we started (watched.events) join
  // the normal diff events; the shared `ci_result` dedup keeps any run from
  // notifying twice across the two paths. Watched-run resolution commits in the
  // same transaction as the events, so the two can't diverge on a crash.
  const me = config[forge.name].username ?? '';
  const { events, commit } = diff({ db, items, todos, me, now: nowIso });
  const allEvents = [...watched.events, ...events];
  const finalEvents = config.notifications.coalesce ? coalesce(allEvents) : allEvents;

  if (!opts.dryRun) {
    db.transaction(() => {
      commit(db);
      watched.commit(db);
      db.recordEvents(finalEvents, nowIso, true);
      if (sources[forge.name]?.ok) db.pruneMrsNotIn(items.map((i) => i.key));
      // Statuses accumulate forever (they rarely change) — this is what feeds
      // the status→section picker even for statuses nothing currently holds.
      db.rememberStatuses(
        [...new Set(items.flatMap((i) => (i.ticket ? [i.ticket.status] : [])))],
        nowIso,
      );
      db.setMeta('last_poll_at', nowIso);
      if (forceReconcile) {
        db.setMeta('last_reconcile_at', nowIso);
        db.retentionSweep(nowIso); // trim events / notified_keys / ci_runs
      }
    });
  }

  return {
    snapshot: { at: nowIso, items, activeTickets, sources },
    events: finalEvents,
    stats,
  };
}

// ---------------------------------------------------------------------------

const fetchJira = async (
  deps: PollDeps,
  nowIso: string,
  log: (m: string) => void,
): Promise<{ tickets: JiraTicket[]; health: SourceHealth; refreshed: boolean }> => {
  const { db, config, jira } = deps;
  const cached = db.cachedJiraTickets();
  const ttlMs = config.jira.refreshMinutes * 60_000;
  const age = cached.fetchedAt ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;

  if (age < ttlMs) {
    return { tickets: cached.tickets, health: { ok: true, at: cached.fetchedAt ?? nowIso }, refreshed: false };
  }
  if (!jira?.configured) {
    return {
      tickets: cached.tickets,
      health: {
        ok: false,
        at: nowIso,
        error: 'jira not configured (set jira.email in config and store an API token)',
        stale: cached.tickets.length > 0,
      },
      refreshed: false,
    };
  }

  try {
    const tickets = await jira.search(buildJql(config));
    db.transaction(() => db.replaceJiraTickets(tickets, nowIso));

    // Harvest status names beyond the active scope: MR-attached tickets only
    // ever show the statuses work passes through, so e.g. "Ready to Work"
    // (no MR yet, not an active status) would never reach the section picker.
    // One extra query per refresh, results used solely for jira_statuses.
    try {
      const recentMine = await jira.search(
        '(assignee = currentUser() OR watcher = currentUser()) AND updated >= -90d',
      );
      const names = [...new Set([...tickets, ...recentMine].map((t) => t.status))];
      db.transaction(() => db.rememberStatuses(names, nowIso));
    } catch {
      // Harvest is a nicety; the MR-attached path still learns statuses.
    }

    return { tickets, health: { ok: true, at: nowIso }, refreshed: true };
  } catch (err) {
    // Fall back to the cached set. Treating scope as empty here would silently
    // stop every GitLab notification during a transient Jira outage.
    log(`jira failed, reusing ${cached.tickets.length} cached tickets: ${msg(err)}`);
    return {
      tickets: cached.tickets,
      health: { ok: false, at: nowIso, error: msg(err), stale: cached.tickets.length > 0 },
      refreshed: false,
    };
  }
}

/**
 * Our own numeric id and username, which every MR query needs.
 *
 * Resolved from `glab api user` once and cached in `meta` — the username matters
 * beyond convenience, since it's how we avoid notifying about our own comments.
 */
/** First occurrence wins, so callers list live data ahead of remembered data. */
const dedupeRuns = (runs: RwxRun[]): RwxRun[] => {
  const seen = new Set<string>();
  const out: RwxRun[] = [];
  for (const r of runs) {
    if (seen.has(r.ID)) continue;
    seen.add(r.ID);
    out.push(r);
  }
  return out;
}

/**
 * Completed test-gate results this DB has ever seen, as synthetic runs:
 * results observed in past cycles (ci_runs) plus runs the user started from
 * the app (watched_runs — recorded with branch/sha/url at trigger time, which
 * RWX itself never attributes for CLI-triggered runs).
 */
const rememberedRuns = (db: Db, projectPath: string, branch: string): RwxRun[] => {
  const finished = (result: string) => ({
    Execution: 'finished' as const,
    Result: result === 'succeeded' ? ('succeeded' as const) : ('failed' as const),
  });
  const base = {
    Branch: branch,
    RepositoryName: '',
    Title: '',
    Trigger: '',
    StartedAt: null,
    CompletedAt: null,
  };
  return [
    ...db.completedTestRuns(projectPath, branch).map((r) => ({
      ...base,
      ID: r.id,
      CommitSha: r.sha,
      DefinitionPath: r.name,
      RunUrl: r.url,
      CreatedAt: r.created_at,
      Status: finished(r.state),
    })),
    ...db.completedWatchedRuns(branch).map((w) => ({
      ...base,
      ID: w.run_id,
      CommitSha: w.sha,
      DefinitionPath: w.definition,
      RunUrl: w.url,
      CreatedAt: w.started_at,
      Status: finished(w.result ?? 'failed'),
    })),
  ];
}

const dedupeMrs = (mrs: ForgeMr[]): ForgeMr[] => {
  const seen = new Set<number>();
  const out: ForgeMr[] = [];
  for (const mr of mrs) {
    if (seen.has(mr.id)) continue;
    seen.add(mr.id);
    out.push(mr);
  }
  return out;
}

/**
 * Closed-ref memory per GitlabSource instance (WeakMap keeps tests isolated;
 * the resident poller reuses one source, so the cache lives across cycles).
 * Comment events point at MRs of any state, and most old ones are closed —
 * without this we'd refetch every closed ref on every cycle forever.
 */
const closedRefCaches = new WeakMap<object, Map<string, number>>();

interface MrRef {
  projectId: number;
  iid: number;
}

/** MR refs from my own comment events (the "commented" participating signal). */
const commentRefs = (events: ForgeCommentEvent[]): MrRef[] => {
  const out: MrRef[] = [];
  for (const e of events) {
    if (e.note?.noteable_type !== 'MergeRequest') continue;
    out.push({ projectId: e.project_id, iid: e.note.noteable_iid });
  }
  return out;
}

/** MR refs from pending mention todos (the "mentioned" participating signal). */
const mentionRefs = (todos: ForgeTodo[]): MrRef[] => {
  const out: MrRef[] = [];
  for (const t of todos) {
    if (t.target_type !== 'MergeRequest') continue;
    if (t.action_name !== 'mentioned' && t.action_name !== 'directly_addressed') continue;
    // The todo carries the MR's state; skip merged/closed without a fetch.
    if (t.target?.state && t.target.state !== 'opened') continue;
    const projectId = t.target?.project_id;
    const iid = t.target?.iid;
    if (typeof projectId === 'number' && typeof iid === 'number') out.push({ projectId, iid });
  }
  return out;
}

/**
 * Turn participating MR refs into open MRs.
 *
 * Skips refs already tracked under a stronger reason (those outrank), and refs
 * recently confirmed closed. Each surviving ref costs one MR fetch per cycle —
 * bounded by the events/todos windows and the hydrate cap.
 */
const hydrateRefs = async (
  deps: PollDeps,
  candidates: MrRef[],
  known: ForgeMr[],
  stats: PollResult['stats'],
  log: (m: string) => void,
): Promise<ForgeMr[]> => {
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  const knownRefs = new Set(known.map((m) => `${m.project_id}!${m.iid}`));
  const cache = closedRefCaches.get(deps.forge) ?? new Map<string, number>();
  closedRefCaches.set(deps.forge, cache);

  const refs = new Map<string, MrRef>();
  for (const r of candidates) {
    const ref = `${r.projectId}!${r.iid}`;
    if (knownRefs.has(ref) || refs.has(ref)) continue;
    const closedAt = cache.get(ref);
    if (closedAt !== undefined && nowMs - closedAt < CLOSED_REF_TTL_MS) continue;
    refs.set(ref, r);
  }

  const out: ForgeMr[] = [];
  for (const [ref, r] of [...refs].slice(0, PARTICIPATING_HYDRATE_MAX)) {
    try {
      const mr = await deps.forge.mrByProjectId(r.projectId, r.iid);
      stats.apiCalls += 1;
      if (mr.state === 'opened') {
        cache.delete(ref);
        out.push(mr);
      } else {
        cache.set(ref, nowMs);
      }
    } catch (err) {
      log(`participating hydrate failed for ${ref}: ${msg(err)}`);
    }
  }
  return out;
}

const resolveUserId = async (deps: PollDeps): Promise<number> => {
  const { db, config, forge } = deps;
  // Identity is cached per forge — meta keys gitlab_user_id / github_user_id.
  const identity = config[forge.name];
  const id = identity.userId ?? numberOrUndefined(db.getMeta(`${forge.name}_user_id`));
  const username = identity.username ?? db.getMeta(`${forge.name}_username`);

  if (id !== undefined && username !== undefined) {
    identity.userId = id;
    identity.username = username;
    return id;
  }

  const me = await forge.currentUser();
  db.transaction(() => {
    db.setMeta(`${forge.name}_user_id`, String(me.id));
    db.setMeta(`${forge.name}_username`, me.username);
  });
  identity.userId = me.id;
  identity.username = me.username;
  return me.id;
}

const numberOrUndefined = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const resolveRoles = async (args: {
  deps: PollDeps;
  projects: string[];
  inScope: WatchItem[];
  checksFor: (projectPath: string, sha: string) => Promise<ForgeCheckRun[]>;
  rwxRuns: RwxRun[];
  pipelinesByProject: Map<string, ForgePipeline[]>;
  nowIso: string;
  stats: { apiCalls: number };
  log: (m: string) => void;
}): Promise<Map<string, RepoCiRoles>> => {
  const { deps, projects, inScope, checksFor, rwxRuns, pipelinesByProject, nowIso, stats, log } = args;
  const { db, config, forge } = deps;
  const out = new Map<string, RepoCiRoles>();

  for (const project of projects) {
    const override = config.repos[project]?.testGate;
    const cached = db.getRepoRoles(project);
    const fresh =
      cached && Date.now() - new Date(cached.detectedAt).getTime() < ROLE_DETECTION_TTL_MS;
    if (cached && (fresh || override)) {
      out.set(project, override ? { ...cached, testGate: override } : cached);
      continue;
    }

    const pipelines = pipelinesByProject.get(project) ?? [];
    const repoName = project.split('/').pop() ?? project;
    const hasRwxRuns = rwxRuns.some((r) => r.RepositoryName === repoName);

    // Classify by the newest pipeline's job names. This is what separates rocket
    // (ruby::lint only) from gadget (ruby::rspec::*) — both have pipelines.
    let latestPipelineJobs;
    let hasCi = pipelines.length > 0;
    if (forge.ci.model === 'pipelines') {
      const newest = [...pipelines].sort((a, b) => b.id - a.id)[0];
      if (newest && !override) {
        try {
          latestPipelineJobs = await forge.ci.pipelineJobs(project, newest.id);
          stats.apiCalls += 1;
        } catch (err) {
          log(`job detection for ${project} failed: ${msg(err)}`);
        }
      }
    } else if (!override) {
      // Checks model: the head sha of any in-scope MR is the newest signal.
      const rep = inScope.find((i) => i.projectPath === project);
      if (rep) {
        const runs = await checksFor(project, rep.headSha);
        hasCi = runs.length > 0;
        if (runs.length > 0) {
          latestPipelineJobs = runs.map((r) => ({
            id: 0,
            name: r.name,
            status: r.state,
            stage: '',
            web_url: r.url,
          }));
        }
      }
    }

    const roles = detectRepoRoles({
      projectPath: project,
      hasRwxRuns,
      hasPipelines: hasCi,
      forgeName: forge.name,
      now: nowIso,
      ...(latestPipelineJobs ? { latestPipelineJobs } : {}),
      ...(override ? { override } : {}),
    });
    db.transaction(() => db.setRepoRoles(project, roles));
    out.set(project, roles);
    log(`${project}: test gate = ${roles.testGate}${roles.gitlabIsLintOnly ? ' (pipeline is lint-only)' : ''}`);
  }
  return out;
}

const enrich = async (args: {
  deps: PollDeps;
  item: WatchItem;
  rwxRuns: RwxRun[];
  pipelinesByProject: Map<string, ForgePipeline[]>;
  checksFor: (projectPath: string, sha: string) => Promise<ForgeCheckRun[]>;
  roles: Map<string, RepoCiRoles>;
  forceReconcile: boolean;
  stats: { detailFetches: number; commitFetches: number; apiCalls: number };
}): Promise<void> => {
  const { deps, item, rwxRuns, pipelinesByProject, checksFor, roles, forceReconcile, stats } = args;
  const { db, config, forge } = deps;

  const prev = db.getMr(item.key);
  const changed = detailsChanged(prev, item);

  if (changed || forceReconcile) {
    const [discussions, approvals] = await Promise.all([
      forge.discussions(item.projectPath, item.iid),
      forge.approvals(item.projectPath, item.iid).catch(() => undefined),
    ]);
    stats.detailFetches += 1;
    stats.apiCalls += 2;
    item.threads = summarizeThreads(discussions);
    if (approvals) {
      item.approvals = {
        ...(approvals.approvals_required !== undefined ? { required: approvals.approvals_required } : {}),
        ...(approvals.approvals_left !== undefined ? { left: approvals.approvals_left } : {}),
        by: (approvals.approved_by ?? []).map((a) => a.user.username),
      };
    }
  } else if (prev) {
    // Detail fetch skipped this cycle — carry the last-known review state
    // forward so the popover keeps showing the right unresolved-thread count and
    // approval progress (and `attentionOf` doesn't wrongly read them as 0 and
    // say "Ready to merge"). `unresolvedFallback` stands in for the thread list
    // we didn't refetch.
    item.unresolvedFallback = prev.unresolved;
    if (prev.approvals_required !== null) {
      item.approvals = {
        required: prev.approvals_required,
        left: prev.approvals_left ?? 0,
        by: prev.approvals_by ? prev.approvals_by.split(',').filter(Boolean) : [],
      };
    }
  }

  const repoRoles = roles.get(item.projectPath) ?? {
    testGate: 'none' as const,
    gitlabIsLintOnly: false,
    detectedAt: new Date().toISOString(),
  };
  const pipelines = pipelinesByProject.get(item.projectPath) ?? [];
  const rwxDefinition =
    config.repos[item.projectPath]?.rwxDefinition ?? DEFAULT_RWX_TEST_DEFINITION;

  // RWX coverage discovery has three blind spots, each patched here:
  //  1. The global list is only the newest 100 runs org-wide (hours, when busy)
  //     — per-branch history fills in older push-created runs.
  //  2. CLI-triggered runs (script/rwx AND our own Start-run button) carry an
  //     EMPTY Branch/CommitSha, so `--branch` filters never return them. They
  //     are attributed via the "<branch> - <email>" title convention, and the
  //     user's own are swept in via `--mine`.
  //  3. Everything scrolls out eventually — completed results any cycle has
  //     seen are remembered in ci_runs and merged back, so a verified branch
  //     can't regress to "never run" because the API window moved on.
  const rwxOn = deps.config.rwx.enabled && ((await deps.rwx.available?.()) ?? true);
  let effectiveRwxRuns = rwxRuns;
  if (rwxOn && repoRoles.testGate === 'rwx') {
    if (newestCompletedRun(rwxRunsFor(rwxRuns, item.branch, rwxDefinition)) === undefined) {
      try {
        const { runs: branchRuns, fetched } = await deps.rwx.branchHistory(item.branch);
        if (fetched) stats.apiCalls += 1;
        if (branchRuns.length) effectiveRwxRuns = [...effectiveRwxRuns, ...branchRuns];
      } catch {
        /* fall back to the global list */
      }
      try {
        const { runs: mine, fetched } = await deps.rwx.myRuns();
        if (fetched) stats.apiCalls += 1;
        if (mine.length) effectiveRwxRuns = [...effectiveRwxRuns, ...mine];
      } catch {
        /* the sweep is best-effort */
      }
    }

    effectiveRwxRuns = dedupeRuns([
      ...effectiveRwxRuns,
      ...rememberedRuns(db, item.projectPath, item.branch),
    ]);

    // A completed CLI run matched to this branch knows its commit only via
    // `runs show` (Init["Commit-sha"]) — hydrate it so verified/stale can bind
    // to the MR head. Cached forever in the source (terminal runs are immutable).
    for (const run of rwxRunsFor(effectiveRwxRuns, item.branch, rwxDefinition)) {
      if (!isTerminal(run) || run.CommitSha) continue;
      try {
        const full = await deps.rwx.showRun(run.ID);
        if (full.fetched) stats.apiCalls += 1;
        run.CommitSha = full.CommitSha;
        if (!run.RunUrl) run.RunUrl = full.RunUrl;
      } catch {
        /* stays unbound; the row still shows as a run, just not as coverage */
      }
    }
  }

  // Build the check list from both providers. A repo can legitimately have both.
  const checks: Check[] = [];
  const forgeRole = repoRoles.testGate === forge.name ? 'tests' : 'lint';
  let failing: string[] | undefined;
  let headChecks: ForgeCheckRun[] | undefined;
  if (forge.ci.model === 'pipelines') {
    const gitlabCheck = gitlabCheckFor(pipelines, item.headSha, forgeRole);
    if (gitlabCheck) {
      if (gitlabCheck.state === 'failed') {
        try {
          const jobs = await forge.ci.pipelineJobs(item.projectPath, Number(gitlabCheck.id));
          stats.apiCalls += 1;
          failing = failedJobNames(jobs);
          if (failing.length) gitlabCheck.name = failing.join(', ');
        } catch {
          /* the name is a nicety; a failed pipeline still reports without it */
        }
      }
      checks.push(gitlabCheck);
    }
  } else {
    headChecks = await checksFor(item.projectPath, item.headSha);
    const check = checksCheckFor(headChecks, item.headSha, forgeRole);
    if (check) {
      failing = headChecks.filter((r) => r.state === 'failed').map((r) => r.name);
      checks.push(check);
    }
  }
  checks.push(...rwxChecksFor(effectiveRwxRuns, item.branch, item.headSha));
  item.checks = checks;

  let gate = resolveTestGate({
    roles: repoRoles,
    headSha: item.headSha,
    branch: item.branch,
    rwxRuns: effectiveRwxRuns,
    rwxTestDefinition: rwxDefinition,
    pipelines,
    ...(headChecks ? { headChecks } : {}),
    ...(failing ? { failingJobNames: failing } : {}),
  });

  // Bridge the gap right after triggering a run: `rwx runs list` is eventually
  // consistent, so a just-started run may not appear for a cycle or two. If we
  // have a watched run we started for THIS head sha, show the gate as running
  // so the button reads "Current run" immediately. Keyed to the head sha, so a
  // new push (head advances) no longer matches → the gate falls back to
  // startable and the button correctly reverts to "Start run".
  if (gate.kind === 'unverified' && gate.startable) {
    const watched = db
      .openWatchedRuns()
      .find((w) => w.branch === item.branch && w.sha === item.headSha);
    if (watched) {
      // In flight → suppress "Start run" so we can't double-trigger, even if we
      // never captured the run URL (url is optional on the in_progress gate).
      gate = { kind: 'in_progress', provider: 'rwx', ...(watched.url ? { url: watched.url } : {}) };
    }
  }

  // Only for a gate someone has to start by hand is it worth paying for the
  // commit list. And only once per head sha: on rocket this unverified state
  // persists for weeks, so re-counting every 60s would be 10 wasted calls a
  // minute forever.
  if (gate.kind === 'unverified' && gate.startable) {
    const cached =
      prev?.unverified_sha === item.headSha && prev.unverified_count !== null
        ? parseCount(prev.unverified_count)
        : undefined;

    if (cached !== undefined) {
      gate = { ...gate, unverifiedCommits: cached };
    } else {
      try {
        const commits = await forge.commits(item.projectPath, item.iid);
        stats.commitFetches += 1;
        stats.apiCalls += 1;
        gate = resolveTestGate({
          roles: repoRoles,
          headSha: item.headSha,
          branch: item.branch,
          rwxRuns: effectiveRwxRuns,
          rwxTestDefinition: rwxDefinition,
          pipelines,
          ...(headChecks ? { headChecks } : {}),
          commits,
          ...(failing ? { failingJobNames: failing } : {}),
        });
      } catch {
        /* keep the 'many' fallback */
      }
    }
    item.unverifiedCache = {
      sha: item.headSha,
      count: gate.kind === 'unverified' ? gate.unverifiedCommits : 'many',
    };
  }
  item.testGate = gate;
}

const parseCount = (raw: string): number | 'many' => {
  if (raw === 'many') return 'many';
  const n = Number(raw);
  return Number.isFinite(n) ? n : 'many';
}

/**
/** Give up on a watched run we can no longer find after this long. */
const WATCHED_RUN_EXPIRE_MS = 6 * 3_600_000;

/**
 * Poll runs started from the app until they finish. Returns the result events
 * plus a `commit` to fold into the cycle's transaction — so resolution and its
 * event record persist atomically (a mid-cycle crash can't leave a run marked
 * done-and-notified while its event was never written).
 *
 * Looks the run up **by id** (`rwx runs show`), which is the only lookup that
 * can work: runs the app starts are CLI-triggered, and those carry an empty
 * Branch in RWX metadata — a branch-scoped list never returns them (verified
 * live on ENG-132), and the global newest-100 scrolls in hours. A run that
 * still errors after WATCHED_RUN_EXPIRE_MS is written off so it stops being
 * re-polled forever. Dedup is shared with the normal CI path via `ci_result`.
 */
const checkWatchedRuns = async (
  deps: PollDeps,
  nowIso: string,
  log: (m: string) => void,
): Promise<{ events: AppEvent[]; commit: (db: Db) => void; live: RwxRun[] }> => {
  const { db, rwx } = deps;
  const open = db.openWatchedRuns();
  if (open.length === 0) return { events: [], commit: () => {}, live: [] };

  const events: AppEvent[] = [];
  const mutations: ((db: Db) => void)[] = [];
  // In-flight runs the app started, hydrated and re-attributed (CLI runs carry
  // no Branch/CommitSha). Fed back into coverage so the CI chip flips to
  // "RWX running" the moment Start run fires — not only after completion.
  const live: RwxRun[] = [];

  for (const watched of open) {
    try {
      let run: RwxRun | undefined;
      try {
        run = await rwx.showRun(watched.run_id);
      } catch {
        run = undefined; // transient failure or a deleted run — see expiry below
      }

      if (run && !isTerminal(run)) {
        live.push({
          ...run,
          Branch: run.Branch || watched.branch,
          CommitSha: run.CommitSha || watched.sha,
          RunUrl: run.RunUrl || watched.url,
        });
      }
      if (!run || !isTerminal(run)) {
        // Not resolved yet. If it's been unfindable for too long, write it off.
        const ageMs = new Date(nowIso).getTime() - new Date(watched.started_at).getTime();
        if (!run && Number.isFinite(ageMs) && ageMs > WATCHED_RUN_EXPIRE_MS) {
          mutations.push((d) => d.resolveWatchedRun(watched.run_id, 'unknown'));
          log(`watched run ${watched.run_id} not found after ${Math.round(ageMs / 3_600_000)}h — giving up`);
        }
        continue;
      }

      const succeeded = run.Status.Result === 'succeeded';
      const resultKey = `rwx|${watched.run_id}`;
      const alreadyNotified = db.wasNotified('ci_result', resultKey);

      mutations.push((d) => {
        d.resolveWatchedRun(watched.run_id, run.Status.Result);
        if (!alreadyNotified) d.markNotified('ci_result', resultKey, nowIso);
      });

      if (!alreadyNotified) {
        const mr = db.getMr(watched.mr_key);
        events.push({
          type: succeeded ? 'ci_succeeded' : 'ci_failed',
          mrKey: watched.mr_key,
          mrTitle: mr?.title ?? watched.mr_key,
          branch: watched.branch,
          url: mr?.web_url ?? run.RunUrl,
          ...(mr?.ticket_key ? { ticket: mr.ticket_key } : {}),
          provider: 'rwx',
          role: 'tests',
          name: watched.definition,
          checkId: watched.run_id,
          ciUrl: run.RunUrl || watched.url,
        });
      }
      log(`watched run ${watched.run_id} finished: ${run.Status.Result}`);
    } catch (err) {
      log(`watched run ${watched.run_id} check failed: ${msg(err)}`);
    }
  }
  return { events, commit: (d) => mutations.forEach((m) => m(d)), live };
}

const shouldReconcile = (db: Db, now: Date, config: Config): boolean => {
  const last = db.getMeta('last_reconcile_at');
  if (!last) return true;
  return now.getTime() - new Date(last).getTime() >= config.poll.reconcileMinutes * 60_000;
}

const msg = (err: unknown): string => {
  return err instanceof Error ? err.message : String(err);
}

export { unresolvedCount };
