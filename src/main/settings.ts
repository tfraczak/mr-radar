import {
  FORGES,
  type RuleCondition,
  type RuleField, APPEARANCES, NOTIFICATION_METHODS, NOTIFICATION_SOUNDS, RULE_FIELDS, RULE_OPS, RULE_TARGETS, THEMES, type Config, type StatusRule } from '../core/config';
import type { Db } from '../core/db';
import { isPinnedHttpsOrigin } from '../core/sources/jira';
import type { EditableSettings } from '../renderer/contract';

/**
 * Every status the section picker should offer: statuses ever seen on tracked
 * tickets (persisted in jira_statuses) plus anything already configured — so a
 * hand-configured status survives even if never observed.
 */
export const knownStatuses = (db: Db, config: Config): string[] => {
  const out = new Map<string, string>();
  const add = (s: string) => {
    if (s && !out.has(s.toLowerCase())) out.set(s.toLowerCase(), s);
  };
  for (const s of db.seenStatuses()) add(s);
  for (const s of config.jira.activeStatuses) add(s);
  for (const s of config.statusSections.hidden) add(s);
  for (const s of config.statusSections.verification) add(s);
  for (const s of config.statusSections.done) add(s);
  return [...out.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Map between the in-app Settings form and the on-disk config.
 *
 * The form owns a known subset of fields; everything else in config.json (the
 * backoff ladder, notification coalescing, etc.) is preserved untouched on save
 * by patching into the raw object rather than rewriting it wholesale.
 */

const DEFAULT_HOURS = { days: [1, 2, 3, 4, 5], start: '08:00', end: '19:00' };

/** Membership in the config lists, folded into one per-status assignment. */
const toAssignments = (config: Config): EditableSettings['statusAssignments'] => {
  const out = new Map<string, EditableSettings['statusAssignments'][number]>();
  const put = (status: string, section: EditableSettings['statusAssignments'][number]['section']) => {
    if (!out.has(status.toLowerCase())) out.set(status.toLowerCase(), { status, section });
  };
  for (const s of config.jira.activeStatuses) put(s, 'active');
  for (const s of config.statusSections.verification) put(s, 'verification');
  for (const s of config.statusSections.done) put(s, 'done');
  for (const s of config.statusSections.hidden) put(s, 'ignore');
  return [...out.values()];
}

/** Repos the radar actually tracks: observed projects ∪ configured ones. */
export const knownRepos = (db: Db, config: Config): string[] => {
  const out = new Set<string>([...db.seenRepos(), ...Object.keys(config.repos)]);
  return [...out].sort((a, b) => a.localeCompare(b));
}

export const toEditable = (config: Config, repoChoices: string[] = [], activeForge: 'gitlab' | 'github' = 'gitlab'): EditableSettings => {
  const h = config.poll.activeHours;
  return {
    jiraEmail: config.jira.email,
    jiraBaseUrl: config.jira.baseUrl,
    activeStatuses: config.jira.activeStatuses,
    statusAssignments: toAssignments(config),
    sectionChoices: ['active', 'verification', 'done', 'ignore', 'other'],
    statusRules: config.statusRules.map((r) => ({
      ...r,
      field: r.field ?? '',
      repo: r.repo ?? '',
      value: r.value ?? '',
      else: r.else ?? 'next',
      also: (r.also ?? []).map((c) => ({ connector: c.connector, field: c.field, op: c.op, value: c.value ?? '' })),
    })),
    ruleRepoChoices: repoChoices.length ? repoChoices : Object.keys(config.repos).sort(),
    ruleFieldChoices: [...RULE_FIELDS],
    ruleOpChoices: [...RULE_OPS],
    ruleTargetChoices: [...RULE_TARGETS],
    recentDaysFallback: config.recentDaysFallback,
    notificationsEnabled: config.notifications.enabled,
    notificationSound: config.notifications.sound,
    soundChoices: [...NOTIFICATION_SOUNDS],
    notificationMethod: config.notifications.method,
    methodChoices: [...NOTIFICATION_METHODS],
    updateStyle: config.git.updateStyle,
    rwxEnabled: config.rwx.enabled,
    forge: config.forge,
    forgeChoices: [...FORGES],
    activeForge,
    updateStyleChoices: ['rebase', 'merge'],
    theme: config.ui.theme,
    themeChoices: [...THEMES],
    appearance: config.ui.appearance,
    appearanceChoices: [...APPEARANCES],
    tabCounts: config.ui.tabCounts,
    tabCountsChoices: ['active', 'all'],
    pollBaseSeconds: config.poll.baseSeconds,
    slackReadyStatuses: config.slack.readyStatuses,
    slackTemplate: config.slack.template,
    activeHours: {
      enabled: h !== undefined && h.enabled !== false,
      days: h?.days ?? DEFAULT_HOURS.days,
      start: h?.start ?? DEFAULT_HOURS.start,
      end: h?.end ?? DEFAULT_HOURS.end,
    },
    // One row per repo the user works in — configured ones plus every repo
    // observed from their MRs — so a checkout can be added without editing
    // config.json by hand.
    repos: [...new Set([...Object.keys(config.repos), ...repoChoices])].sort().map((projectPath) => ({
      projectPath,
      checkout: config.repos[projectPath]?.checkout ?? '',
      rwxDefinition: config.repos[projectPath]?.rwxDefinition ?? '',
      testGate: config.repos[projectPath]?.testGate ?? 'auto',
    })),
    repoGateChoices: ['auto', 'rwx', activeForge, 'none'],
  };
}

/** A human-readable error if the input is invalid, else undefined. */
export const validateEditable = (s: EditableSettings): string | undefined => {
  if (s.jiraEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.jiraEmail)) {
    return 'Jira email looks malformed.';
  }
  if (s.jiraBaseUrl && !isPinnedHttpsOrigin(s.jiraBaseUrl)) {
    return 'Atlassian URL must be a bare https origin (no path, query, or userinfo).';
  }
  if (!Number.isFinite(s.recentDaysFallback) || s.recentDaysFallback < 0) {
    return 'Recent-days fallback must be 0 or more.';
  }
  if (!Number.isFinite(s.pollBaseSeconds) || s.pollBaseSeconds < 15) {
    return 'Poll interval must be at least 15 seconds.';
  }
  const activeCount = s.statusAssignments?.length
    ? s.statusAssignments.filter((a) => a.section === 'active').length
    : s.activeStatuses.length;
  if (activeCount === 0) {
    return 'Assign at least one status to the Active section.';
  }
  if (s.activeHours.enabled) {
    for (const t of [s.activeHours.start, s.activeHours.end]) {
      if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(t)) return `Active hours time "${t}" must be HH:MM.`;
    }
    if (s.activeHours.days.length === 0) return 'Pick at least one active day.';
  }
  return undefined;
}

/**
 * Fold the edited settings into the raw config object, preserving unknown keys.
 * Returns the new raw object to persist.
 */
export const applyEditable = (
  raw: Record<string, unknown>,
  s: EditableSettings,
): Record<string, unknown> => {
  const next: Record<string, unknown> = { ...raw };

  // The per-status assignments are the source of truth when present: 'active'
  // rows become jira.activeStatuses (driving scope), the rest fill the section
  // lists. 'other' rows appear in no list — that's the default bucket.
  const assignments = s.statusAssignments ?? [];
  const bySection = (section: string): string[] =>
    assignments.filter((a) => a.section === section).map((a) => a.status);
  const activeStatuses = assignments.length ? bySection('active') : s.activeStatuses;

  if (Array.isArray(s.slackReadyStatuses)) {
    const readyStatuses = s.slackReadyStatuses.map((v) => String(v).trim()).filter(Boolean);
    const template = typeof s.slackTemplate === 'string' && s.slackTemplate.trim() ? s.slackTemplate.trim() : undefined;
    next.slack = {
      ...(asObject(next.slack) ?? {}),
      readyStatuses,
      ...(template ? { template } : {}),
    };
  }

  const jira = { ...(asObject(next.jira) ?? {}) };
  jira.email = s.jiraEmail;
  jira.baseUrl = s.jiraBaseUrl;
  jira.activeStatuses = activeStatuses;
  next.jira = jira;

  if (assignments.length) {
    next.statusSections = {
      hidden: bySection('ignore'),
      verification: bySection('verification'),
      done: bySection('done'),
    };
  }

  if (Array.isArray(s.statusRules)) {
    // Keep only well-formed rules; a half-edited row must not brick the config.
    next.statusRules = s.statusRules.flatMap((r): StatusRule[] => {
      const status = r.status?.trim();
      if (!status) return [];
      // Unconditional ('always') rules have no field; every other op needs one.
      if (r.op !== 'always' && !(RULE_FIELDS as readonly string[]).includes(r.field)) return [];
      if (!(RULE_OPS as readonly string[]).includes(r.op)) return [];
      if (!(RULE_TARGETS as readonly string[]).includes(r.then)) return [];
      if (r.else && r.else !== 'next' && !(RULE_TARGETS as readonly string[]).includes(r.else)) return [];
      const rule: StatusRule = {
        status,
        ...(r.repo?.trim() ? { repo: r.repo.trim() } : {}),
        op: r.op as StatusRule['op'],
        ...(r.value?.trim() ? { value: r.value.trim() } : {}),
        then: r.then as StatusRule['then'],
      };
      if (r.else && r.else !== 'next') rule.else = r.else as StatusRule['then'];
      if (r.op !== 'always') rule.field = r.field as RuleField;
      const also = (r.also ?? []).flatMap((c): RuleCondition[] => {
        if (c.connector !== 'and' && c.connector !== 'or') return [];
        if (!(RULE_FIELDS as readonly string[]).includes(c.field)) return [];
        if (!(RULE_OPS as readonly string[]).includes(c.op) || c.op === 'always') return [];
        return [{
          connector: c.connector,
          field: c.field as RuleField,
          op: c.op as RuleCondition['op'],
          ...(c.value?.trim() ? { value: c.value.trim() } : {}),
        }];
      });
      if (r.op !== 'always' && also.length) rule.also = also;
      return [rule];
    });
  }

  next.recentDaysFallback = s.recentDaysFallback;

  const notifications = { ...(asObject(next.notifications) ?? {}) };
  notifications.enabled = s.notificationsEnabled;
  if (s.notificationSound) notifications.sound = s.notificationSound;
  if ((NOTIFICATION_METHODS as readonly string[]).includes(s.notificationMethod)) {
    notifications.method = s.notificationMethod;
  }
  next.notifications = notifications;

  if ((THEMES as readonly string[]).includes(s.theme) && (APPEARANCES as readonly string[]).includes(s.appearance)) {
    const ui = { ...(asObject(next.ui) ?? {}) };
    ui.theme = s.theme;
    ui.appearance = s.appearance;
    if (s.tabCounts === 'active' || s.tabCounts === 'all') ui.tabCounts = s.tabCounts;
    next.ui = ui;
  }

  if (s.updateStyle === 'rebase' || s.updateStyle === 'merge') {
    const git = { ...(asObject(next.git) ?? {}) };
    git.updateStyle = s.updateStyle;
    next.git = git;
  }

  const rwx = { ...(asObject(next.rwx) ?? {}) };
  rwx.enabled = s.rwxEnabled !== false;
  next.rwx = rwx;

  if ((FORGES as readonly string[]).includes(s.forge)) next.forge = s.forge;

  const poll = { ...(asObject(next.poll) ?? {}) };
  poll.baseSeconds = s.pollBaseSeconds;
  if (s.activeHours.enabled) {
    poll.activeHours = { days: s.activeHours.days, start: s.activeHours.start, end: s.activeHours.end };
  } else if (asObject(poll.activeHours)) {
    // Keep the user's window while it's off, so re-enabling restores it
    // instead of resetting to the 8-to-7 defaults.
    poll.activeHours = { ...(asObject(poll.activeHours) as object), enabled: false };
  } else {
    // Never configured — nothing worth remembering.
    delete poll.activeHours;
  }
  next.poll = poll;

  const repos: Record<string, unknown> = { ...(asObject(next.repos) ?? {}) };
  for (const r of s.repos) {
    if (!r.projectPath.trim()) continue;
    const entry: Record<string, unknown> = { ...(asObject(repos[r.projectPath]) ?? {}) };
    if (r.checkout.trim()) entry.checkout = r.checkout.trim();
    else delete entry.checkout;
    if (r.rwxDefinition.trim()) entry.rwxDefinition = r.rwxDefinition.trim();
    else delete entry.rwxDefinition;
    if (r.testGate === 'rwx' || r.testGate === 'gitlab' || r.testGate === 'github' || r.testGate === 'none') entry.testGate = r.testGate;
    else delete entry.testGate;
    if (Object.keys(entry).length) repos[r.projectPath] = entry;
    else delete repos[r.projectPath];
  }
  next.repos = repos;

  return next;
}

const asObject = (v: unknown): Record<string, unknown> | undefined => {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

// ---------------------------------------------------------------------------
// Sharing settings between teammates
// ---------------------------------------------------------------------------

/** Config keys that make sense on someone else's machine. */
const SHAREABLE_KEYS = [
  'statusSections',
  'statusRules',
  'ui',
  'poll',
  'notifications',
  'repos',
  'rwx',
  'git',
  'recentDaysFallback',
  'web',
  'slack',
] as const;

/**
 * The shareable subset of a raw config: team conventions in, identity out.
 * `jira.email` and `gitlab.*` are personal; the Jira token lives only in the
 * Keychain and can never appear here at all.
 */
export const shareableSettings = (raw: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of SHAREABLE_KEYS) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  const jira = asObject(raw.jira);
  if (jira) {
    const shared: Record<string, unknown> = {};
    if (jira.baseUrl !== undefined) shared.baseUrl = jira.baseUrl;
    if (jira.activeStatuses !== undefined) shared.activeStatuses = jira.activeStatuses;
    if (jira.refreshMinutes !== undefined) shared.refreshMinutes = jira.refreshMinutes;
    out.jira = shared;
  }
  return out;
}

/**
 * Overlay a teammate's shared settings onto the local raw config, keeping the
 * local identity (jira.email, gitlab.*) untouched. The result still goes
 * through writeRawConfig's validation before anything is persisted.
 */
export const mergeSharedSettings = (
  local: Record<string, unknown>,
  shared: Record<string, unknown>,
): Record<string, unknown> => {
  const incoming = shareableSettings(shared); // re-sanitize whatever was pasted
  const next: Record<string, unknown> = { ...local, ...incoming };
  const localJira = asObject(local.jira) ?? {};
  const sharedJira = asObject(incoming.jira) ?? {};
  next.jira = { ...localJira, ...sharedJira, ...(localJira.email !== undefined ? { email: localJira.email } : {}) };
  if (local.gitlab !== undefined) next.gitlab = local.gitlab;
  if (local.github !== undefined) next.github = local.github;
  if (local.forge !== undefined) next.forge = local.forge; // machine-specific
  return next;
}
