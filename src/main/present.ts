import { DEFAULT_CONFIG, type Config, type RuleTarget, type StatusRule } from '../core/config';
import { unresolvedCount } from '../core/correlate';
import { describePause } from '../core/schedule';
import type { TestGate, WatchItem } from '../core/types';
import type { Attention, UiGroup, UiItem, UiSnapshot, UiState, UiStatusGroup } from './state';

export type StatusSections = Config['statusSections'];

/** How long after a ticket is resolved we stop showing it. */
const CLOSED_HIDE_MS = 7 * 86_400_000;

/**
 * Jira workflow order for the "by status" sort — most-actionable / closest-to-
 * done first. Unknown statuses sort last. This is a sensible default; the exact
 * set of statuses varies by project.
 */
const STATUS_ORDER = [
  'Code Review',
  'Dev Complete',
  'In QA',
  'In Development',
  'Ready to Work',
  'To Do',
  'Backlog',
];
/** Closed-ish statuses sink below everything, including unknown statuses. */
const STATUS_LAST = ['Closed', 'Done', 'Resolved', "Won't Do", 'Cancelled', 'Canceled'];
const statusRank = (status: string): number => {
  const lower = status.toLowerCase();
  if (STATUS_LAST.some((s) => s.toLowerCase() === lower)) return STATUS_ORDER.length + 1;
  const i = STATUS_ORDER.findIndex((s) => s.toLowerCase() === lower);
  return i === -1 ? STATUS_ORDER.length : i;
}

/**
 * Shape the live state for the popover.
 *
 * All the wording lives here rather than in the renderer, so the CI chip's label
 * — the one place it must be unambiguous whether RWX or GitLab reported, and
 * whether it was tests or lint — is decided in one testable place.
 */
export type UpdateStyle = 'rebase' | 'merge';

export const present = (
  state: UiState,
  activeStatuses: string[] = [],
  now: Date = new Date(),
  updateStyle: UpdateStyle = 'rebase',
  sections: StatusSections = DEFAULT_CONFIG.statusSections,
  rules: StatusRule[] = DEFAULT_CONFIG.statusRules,
): UiSnapshot => {
  const active = new Set(activeStatuses.map((s) => s.toLowerCase()));
  const hidden = new Set(sections.hidden.map((s) => s.toLowerCase()));
  const items = (state.snapshot?.items ?? [])
    .filter((i) => i.inScope)
    .filter((i) => !hiddenStaleClosed(i, now))
    .filter((i) => !(i.ticket && hidden.has(i.ticket.status.toLowerCase())));
  const unreadKeys = new Set(state.unread.map((e) => e.mrKey));

  const { groups, devCompleteGroups, verificationGroups, doneGroups, otherGroups } = groupItems(
    items,
    unreadKeys,
    active,
    now,
    updateStyle,
    sections,
    rules,
  );
  return {
    at: state.snapshot?.at,
    lastPollAt: state.lastPollAt,
    nextPollAt: state.nextPollAt,
    polling: state.polling,
    paused: state.pausedReason ? describePause(state.pausedReason) : undefined,
    enabled: state.schedule.enabled,
    lastError: state.lastError,
    unreadCount: state.unread.length,
    unreadKeys: [...unreadKeys],
    sources: Object.entries(state.snapshot?.sources ?? {}).map(([name, h]) => ({
      name,
      ok: h.ok,
      error: h.error,
      stale: h.stale,
    })),
    highlight: state.highlight,
    groups,
    devCompleteGroups,
    verificationGroups,
    doneGroups,
    otherGroups,
    jiraNeedsToken: !state.jiraConfigured,
    jiraEmail: state.jiraEmail,
  };
}

/** Branches it's normal to merge into; anything else earns a warning. */
const isMainline = (target: string): boolean => {
  return target === '' || target === 'main' || target === 'master';
}

/** Drop tickets that were resolved more than a week ago — they're done with. */
const hiddenStaleClosed = (item: WatchItem, now: Date): boolean => {
  const t = item.ticket;
  if (!t || t.statusCategory !== 'Done' || !t.resolutionDate) return false;
  const resolved = new Date(t.resolutionDate).getTime();
  return Number.isFinite(resolved) && now.getTime() - resolved > CLOSED_HIDE_MS;
}

/**
 * Evaluate one rule's predicate against a ticket. `empty` means KNOWN-empty:
 * an unknown field (row cached before the field existed) is neither empty nor
 * present, so it always takes the `else` branch — stale data can never invent
 * an actionable state.
 */
const rulePredicate = (rule: StatusRule, t: NonNullable<WatchItem['ticket']>, now: Date): boolean => {
  if (rule.field === 'fixVersions') {
    const v = t.fixVersions;
    if (rule.op === 'empty') return v !== undefined && v.length === 0;
    if (rule.op === 'present') return (v ?? []).length > 0;
    if (rule.op === 'matches') return safeMatch(rule.value, (v ?? []).map((x) => x.name).join(', '));
    return false;
  }
  const str = rule.field === 'issueType' ? t.issueType : t.dueDate;
  switch (rule.op) {
    case 'empty':
      return str === '';
    case 'present':
      return Boolean(str);
    case 'matches':
      return safeMatch(rule.value, str ?? '');
    case 'past': {
      if (rule.field !== 'dueDate' || !t.dueDate) return false;
      const due = new Date(`${t.dueDate}T23:59:59`);
      return Number.isFinite(due.getTime()) && due.getTime() < now.getTime();
    }
  }
}

/** Case-insensitive regex, treating an invalid pattern as no-match. */
const safeMatch = (pattern: string | undefined, value: string): boolean => {
  if (!pattern) return false;
  try {
    return new RegExp(pattern, 'i').test(value);
  } catch {
    return false;
  }
}

/**
 * The first non-'next' target the rules produce for this ticket, if any.
 * Rules run top-to-bottom; 'next' defers to later rules, then to the plain
 * status→section mapping.
 */
export const ruleTarget = (
  rules: StatusRule[],
  t: WatchItem['ticket'],
  now: Date,
  projectPath: string,
): Exclude<RuleTarget, 'next'> | undefined => {
  if (!t) return undefined;
  for (const rule of rules) {
    if (rule.status.toLowerCase() !== t.status.toLowerCase()) continue;
    // A rule can be pinned to one repo; empty/absent means any.
    if (rule.repo && rule.repo !== projectPath) continue;
    const target = rulePredicate(rule, t, now) ? rule.then : rule.else;
    if (target !== 'next') return target;
  }
  return undefined;
}

/**
 * Still needs a fix version? Drives the picker and the attention line wherever
 * the ticket lands — deliberately independent of the routing rules, so moving
 * Dev Complete into Active (a custom rule) keeps the "assign one" affordance.
 */
export const needsFixVersion = (t: WatchItem['ticket']): boolean => {
  if (!t || t.status.toLowerCase() !== 'dev complete') return false;
  if (t.issueType && /data\s*fix/i.test(t.issueType)) return false;
  return t.fixVersions !== undefined && t.fixVersions.length === 0;
}

/**
 * Split in-scope items into two buckets:
 *  - `groups`: one per active-status ticket, shown expanded at the top.
 *  - `otherGroups`: everything else, grouped by real Jira status (or "No ticket"),
 *    for a collapsed section below. Ordering within both is decided in the
 *    renderer (sort/filter are live UI prefs).
 */
const groupItems = (
  items: WatchItem[],
  unreadKeys: Set<string>,
  active: Set<string>,
  now: Date,
  updateStyle: UpdateStyle,
  sections: StatusSections,
  rules: StatusRule[],
): {
  groups: UiGroup[];
  devCompleteGroups: UiGroup[];
  verificationGroups: UiStatusGroup[];
  doneGroups: UiStatusGroup[];
  otherGroups: UiStatusGroup[];
} => {
  const byTicket = new Map<string, UiGroup>();
  const devComplete = new Map<string, UiGroup>();
  const verification = new Map<string, UiStatusGroup>();
  const done = new Map<string, UiStatusGroup>();
  const byStatus = new Map<string, UiStatusGroup>();

  const lower = (xs: string[]) => new Set(xs.map((s) => s.toLowerCase()));
  const verificationSet = lower(sections.verification);
  const doneSet = lower(sections.done);

  const isActive = (t: WatchItem['ticket']): boolean =>
    t !== undefined && active.has(t.status.toLowerCase());

  for (const item of items) {
    const ui = toUiItem(item, unreadKeys.has(item.key), now, updateStyle);
    const status = item.ticket?.status;
    const needsFix = needsFixVersion(item.ticket);

    // Conditional rules first (e.g. the default Dev Complete pair), then the
    // plain status→section mapping. `needsFix` keeps the picker/attention
    // wherever the ticket lands — routing and affordance are independent.
    const target = ruleTarget(rules, item.ticket, now, item.projectPath);
    if (target && item.ticket) {
      switch (target) {
        case 'ignore':
          continue;
        case 'needs-fix-version':
          addToTicketGroup(devComplete, item.ticket, ui, needsFix);
          continue;
        case 'active':
          addToTicketGroup(byTicket, item.ticket, ui, needsFix);
          continue;
        case 'verification':
          addToStatusGroup(verification, item.ticket.status, ui);
          continue;
        case 'done':
          addToStatusGroup(done, item.ticket.status, ui);
          continue;
        case 'other':
          addToStatusGroup(byStatus, item.ticket.status, ui);
          continue;
      }
    }

    if (status && verificationSet.has(status.toLowerCase())) {
      addToStatusGroup(verification, status, ui);
      continue;
    }
    if (status && doneSet.has(status.toLowerCase())) {
      addToStatusGroup(done, status, ui);
      continue;
    }

    if (isActive(item.ticket) && item.ticket) {
      addToTicketGroup(byTicket, item.ticket, ui, needsFix);
      continue;
    }

    // Anything unmapped (or no ticket) → collapsed "Other", grouped by status.
    addToStatusGroup(byStatus, status ?? 'No ticket', ui);
  }

  return {
    groups: [...byTicket.values()],
    devCompleteGroups: [...devComplete.values()],
    verificationGroups: [...verification.values()],
    doneGroups: [...done.values()],
    otherGroups: [...byStatus.values()],
  };
}

const addToTicketGroup = (
  map: Map<string, UiGroup>,
  ticket: NonNullable<WatchItem['ticket']>,
  ui: UiItem,
  needsFix: boolean,
): void => {
  const existing = map.get(ticket.key);
  if (existing) {
    existing.items.push(ui);
    return;
  }
  map.set(ticket.key, {
    ticket: {
      key: ticket.key,
      status: ticket.status,
      url: ticket.url,
      statusRank: statusRank(ticket.status),
      ...(needsFix ? { needsFixVersion: true } : {}),
    },
    items: [ui],
  });
}

const addToStatusGroup = (map: Map<string, UiStatusGroup>, status: string, ui: UiItem): void => {
  const group = map.get(status);
  if (group) group.items.push(ui);
  else map.set(status, { status, statusRank: statusRank(status), items: [ui] });
}

const toUiItem = (item: WatchItem, unread: boolean, now: Date, updateStyle: UpdateStyle): UiItem => {
  const threads = item.threads ?? [];
  // When the detail fetch was skipped this cycle, `threads` is absent — fall
  // back to the last-known unresolved count so the row and attention stay right.
  const unresolved = item.threads ? unresolvedCount(item.threads) : (item.unresolvedFallback ?? 0);
  const commentCount = threads.reduce((n, t) => n + t.notes.length, 0);
  const checks = (item.checks ?? []).map((c) => ({
    provider: c.provider,
    role: c.role,
    name: c.name,
    state: c.state,
    url: c.url,
    // A result for a commit that is no longer the head. Shown greyed so it's
    // visible without implying the current code was verified.
    stale: c.sha !== item.headSha,
  }));
  const ci = ciChip(item.testGate, checks);
  const overdue = isOverdue(item.ticket?.dueDate, now);

  // Two discrete signals beat one muddled sentence: a clean MR aimed at a
  // release branch shows a good "Checks passed" AND a warn "Target not main"
  // — never a bare "Ready to merge" that invites a reflex merge.
  let attention = attentionOf(item, { unresolved, ci, overdue }, updateStyle);
  let attentionExtra: Attention | undefined;
  if (attention.text === 'Ready to merge' && !isMainline(item.targetBranch)) {
    attention = { text: 'Checks passed', tone: 'good', rank: attention.rank };
    attentionExtra = { text: 'Target not main', tone: 'warn', rank: attention.rank };
  }

  return {
    key: item.key,
    iid: item.iid,
    projectPath: item.projectPath,
    branch: item.branch,
    targetBranch: item.targetBranch,
    title: item.title,
    url: item.webUrl,
    headSha: item.headSha,
    reason: item.reason,
    ...(item.participation ? { participation: item.participation } : {}),
    draft: item.draft,
    hasConflicts: item.hasConflicts,
    unresolved,
    commentCount,
    approvals: item.approvals,
    unread,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.ticket?.dueDate ? { dueDate: item.ticket.dueDate } : {}),
    overdue,
    attention,
    ...(attentionExtra ? { attentionExtra } : {}),
    ci,
    checks,
  };
}

const isOverdue = (dueDate: string | undefined, now: Date): boolean => {
  if (!dueDate) return false;
  const due = new Date(`${dueDate}T23:59:59`);
  return Number.isFinite(due.getTime()) && due.getTime() < now.getTime();
}

/**
 * The one thing this row most needs — a prioritized, human "what to do".
 * Order matters: the first matching condition wins and sets the sort rank, so
 * a merge conflict outranks a pending approval, etc.
 */
const attentionOf = (
  item: WatchItem,
  d: { unresolved: number; ci: UiItem['ci']; overdue: boolean },
  updateStyle: UpdateStyle = 'rebase',
): Attention => {
  const approvalsLeft = item.approvals?.left ?? 0;
  const verifiedPass = item.testGate?.kind === 'verified' && item.testGate.result === 'succeeded';

  if (item.hasConflicts) {
    // Respect the user's workflow: rebase fans get "rebase", mergers get merge.
    const how = updateStyle === 'merge' ? 'merge main into the branch' : 'needs a rebase';
    return { text: `Merge conflict — ${how}`, tone: 'bad', rank: 0 };
  }
  if (d.ci.tone === 'bad' && item.testGate?.kind === 'verified') {
    return { text: `Tests failing: ${d.ci.detail ?? 'CI'}`, tone: 'bad', rank: 1 };
  }
  // Dev Complete without a fix version blocks the release train — more urgent
  // than review traffic, less than broken code.
  if (needsFixVersion(item.ticket)) {
    return { text: 'Dev Complete — needs a fix version', tone: 'warn', rank: 2 };
  }
  if (item.reason === 'reviewer') return { text: 'Your review is requested', tone: 'info', rank: 2 };
  if (item.reason === 'participating') {
    if (d.unresolved > 0) {
      // A thread is open on an MR you engaged with — likely a reply to you.
      const how = item.participation === 'mentioned' ? 'You were mentioned' : 'You commented';
      return { text: `${how} — ${d.unresolved} open thread${d.unresolved === 1 ? '' : 's'}`, tone: 'info', rank: 3 };
    }
    // A pending mention todo means you haven't looked at it yet — say so even
    // with no open threads.
    if (item.participation === 'mentioned') {
      return { text: 'You were mentioned', tone: 'info', rank: 3 };
    }
  }
  if (d.unresolved > 0) {
    return { text: `${d.unresolved} unresolved thread${d.unresolved === 1 ? '' : 's'}`, tone: 'warn', rank: 3 };
  }
  if (d.ci.startable) {
    const last = item.testGate?.kind === 'unverified' ? item.testGate.lastResult : undefined;
    if (!last) return { text: 'Tests never run', tone: 'bad', rank: 4 };
    // Stale is yellow, never red: the suite HAS run, it's just behind the head.
    // The old verdict stays in the text so a stale fail still reads urgent.
    const n = item.testGate?.kind === 'unverified' ? item.testGate.unverifiedCommits : 'many';
    const since = n === 'many' ? 'on an older commit' : `${n} commit${n === 1 ? '' : 's'} ago`;
    const verdict = last.result === 'succeeded' ? 'passed' : 'failed';
    return { text: `Tests stale — ${verdict} ${since}`, tone: 'warn', rank: 4 };
  }
  if (d.overdue) return { text: 'Past its due date', tone: 'warn', rank: 5 };
  if (approvalsLeft > 0) {
    return {
      text: `Waiting on ${approvalsLeft} approval${approvalsLeft === 1 ? '' : 's'}`,
      tone: 'muted',
      rank: 6,
    };
  }
  if (d.ci.tone === 'busy') return { text: 'Tests running', tone: 'info', rank: 7 };
  if (verifiedPass && approvalsLeft === 0 && d.unresolved === 0) {
    return { text: 'Ready to merge', tone: 'good', rank: 8 };
  }
  if (item.draft) return { text: 'Draft', tone: 'muted', rank: 9 };
  return { text: 'No action needed', tone: 'muted', rank: 10 };
}

/** `.rwx/frontend-ci.yml` → `frontend`, short enough for a chip. */
export const shortCheckName = (name: string): string => {
  return name.replace(/^\.rwx\//, '').replace(/(-ci)?\.ya?ml$/, '');
}

export const ciChip = (
  gate: TestGate | undefined,
  checks: UiItem['checks'] = [],
): UiItem['ci'] => {
  if (!gate) return { label: '—', tone: 'none', startable: false };

  const provider = gate.kind === 'none' ? undefined : gate.provider;
  const who = provider === 'rwx' ? 'RWX' : 'CI';
  // A fresh green secondary suite (rocket's auto-started frontend) is exactly
  // what makes an unverified branch LOOK verified — name it so the chip reads
  // "that green run you remember was not the specs".
  const greenOther = checks.find((c) => c.role !== 'tests' && c.state === 'succeeded' && !c.stale);

  switch (gate.kind) {
    case 'verified':
      return gate.result === 'succeeded'
        ? { label: `${who} passed`, tone: 'good', provider, url: gate.url, startable: false }
        : {
            label: `${who} failed`,
            tone: 'bad',
            provider,
            url: gate.url,
            startable: false,
            detail: gate.name,
          };
    case 'in_progress':
      return {
        label: `${who} running`,
        tone: 'busy',
        provider,
        ...(gate.url ? { url: gate.url } : {}),
        startable: false,
      };
    case 'unverified': {
      const n = gate.unverifiedCommits;
      const count = n === 'many' ? undefined : `${n} commit${n === 1 ? '' : 's'} unverified`;
      // Never run vs. ran-on-an-older-commit are different urgencies; say which.
      if (gate.lastResult) {
        const verdict = gate.lastResult.result === 'succeeded' ? 'passed' : 'failed';
        return {
          label: `${who} stale`,
          // Stale is always yellow — the suite HAS run, it's just behind the
          // head. Red is reserved for never-run (and real failures on the head).
          tone: 'warn',
          provider,
          url: gate.url ?? gate.lastResult.url,
          startable: gate.startable,
          detail: count ? `last ${verdict} · ${count}` : `last ${verdict} on an older commit`,
        };
      }
      const never = provider === 'rwx' ? 'specs never run' : (count ?? 'never verified');
      return {
        // Startable + no history = the suite has truly never run — say so. The
        // non-startable case (GitLab, pipeline about to appear) stays gentle.
        label: gate.startable ? `${who} never run` : `${who} not run`,
        // Startable means a human has to press the button — actionable, so red.
        tone: gate.startable ? 'bad' : 'warn',
        provider,
        url: gate.url,
        startable: gate.startable,
        detail: greenOther ? `${shortCheckName(greenOther.name)} ✓ — but ${never}` : never,
      };
    }
    case 'none':
      return { label: 'no CI', tone: 'none', startable: false };
  }
}
