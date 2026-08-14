import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { isPinnedHttpsOrigin } from './sources/jira';
import type { CiProvider } from './types';

/** Where a conditional rule can send a ticket. 'next' = defer to later rules. */
export type RuleTarget =
  | 'active'
  | 'verification'
  | 'done'
  | 'ignore'
  | 'other'
  | 'needs-value'
  | 'next';

/**
 * Sentinel for the rule-status dropdown: matches MRs with NO Jira ticket at
 * all (no key in the branch or title). Such rules are inherently
 * unconditional — there are no ticket fields to test.
 */
export const NO_TICKET_STATUS = '(no ticket)';

export const RULE_TARGETS: readonly RuleTarget[] = [
  'active',
  'verification',
  'done',
  'ignore',
  'other',
  'needs-value',
  'next',
];

/**
 * Sentinel for the MR-expectation rule dropdown: matches a ticket in ANY
 * status. Lets one rule exempt a whole issue type ("spikes never need an MR")
 * instead of one rule per status.
 */
export const ANY_STATUS = '(any status)';

export type RuleField = 'fixVersions' | 'issueType' | 'dueDate';
export type RuleOp = 'always' | 'empty' | 'present' | 'matches' | 'past';

export const RULE_FIELDS: readonly RuleField[] = ['fixVersions', 'issueType', 'dueDate'];
export const RULE_OPS: readonly RuleOp[] = ['always', 'empty', 'present', 'matches', 'past'];

export type RuleConnector = 'and' | 'or';

/** One extra condition chained onto a rule's primary check, left to right. */
export interface RuleCondition {
  connector: RuleConnector;
  field: RuleField;
  op: Exclude<RuleOp, 'always'>;
  value?: string;
}

/**
 * One conditional routing rule: "for tickets in `status`, when `field` `op`
 * (`value`), go to `then`, otherwise `else`."
 *
 * Semantics worth knowing: `empty` means KNOWN-empty — a ticket whose field is
 * simply unknown (cached before the field existed) takes the `else` branch, so
 * stale data can never trigger an actionable state. `matches` is a
 * case-insensitive regex against the field (fix version names joined).
 */
export interface StatusRule {
  status: string;
  /** Project path the rule applies to; absent/empty = any repo. */
  repo?: string;
  /** Absent for op 'always' — an unconditional route needs no field. */
  field?: RuleField;
  op: RuleOp;
  value?: string;
  /** Extra chained conditions, folded left to right (a AND b OR c ...). */
  also?: RuleCondition[];
  then: RuleTarget;
  /** Absent = 'next': no else branch, fall through to later rules. */
  else?: RuleTarget;
}

/** What an MR-expectation rule decides about a ticket. 'next' = defer. */
export type MrRuleTarget = 'expect' | 'exempt' | 'next';

export const MR_RULE_TARGETS: readonly MrRuleTarget[] = ['expect', 'exempt', 'next'];

/**
 * One rule about whether a ticket is *supposed* to have a merge request:
 * "for tickets in `status`, when `field` `op` (`value`), `then`, otherwise
 * `else`". `expect` warns when no MR exists, `exempt` says never mention it,
 * 'next' falls through to the following rule and finally to `noMr.expectStatuses`.
 *
 * Same field/op vocabulary as StatusRule — deliberately, so the rule builder and
 * the predicate are shared. There's no repo scope: a ticket without an MR has no
 * repo to scope by.
 */
export interface MrRule {
  /** Ticket status, or ANY_STATUS to match every status. */
  status: string;
  /** Absent for op 'always'. */
  field?: RuleField;
  op: RuleOp;
  value?: string;
  also?: RuleCondition[];
  then: MrRuleTarget;
  /** Absent = 'next'. */
  else?: MrRuleTarget;
}

export interface RepoOverride {
  /** Pin the test gate instead of detecting it. */
  testGate?: CiProvider | 'none';
  /** Local checkout path — required to trigger an RWX run for this repo. */
  checkout?: string;
  /** RWX definition treated as the test gate. */
  rwxDefinition?: string;
}

export interface Config {
  /**
   * Which forge this install watches. 'auto' detects from which CLI
   * (glab/gh) is authenticated, preferring one with a stored identity;
   * pin it in Settings → General when detection guesses wrong.
   */
  forge: 'auto' | 'gitlab' | 'github';
  gitlab: {
    /** Numeric user id. Resolved from `glab api user` on first run if absent. */
    userId?: number;
    username?: string;
  };
  github: {
    /** Numeric user id. Resolved from `gh api user` on first run if absent. */
    userId?: number;
    username?: string;
  };
  jira: {
    /**
     * Your Atlassian site, e.g. https://your-org.atlassian.net. Pinned here
     * (set once in Settings), never taken from runtime input (SSRF posture).
     * Empty = Jira features are off and MR scope falls back to recent activity.
     */
    baseUrl: string;
    email: string;
    /** Statuses that count as "actively in flight". Drives MR scope. */
    activeStatuses: string[];
    /**
     * Which fields make a ticket "mine": each renders as `<clause> =
     * currentUser()`, OR-ed together. Defaults to assignee + watcher; orgs
     * that designate the developer via a custom user-picker (e.g. a "Dev
     * Resource" field) add it here — picked in Settings from the site's real
     * user-valued fields, stored as rename-proof `cf[<id>]` clauses.
     */
    ownerFields: { clause: string; label: string }[];
    /** Overrides activeStatuses AND ownerFields when set. */
    jql?: string;
    refreshMinutes: number;
  };
  poll: {
    baseSeconds: number;
    /** Backoff ladder applied after consecutive quiet cycles. */
    backoffSeconds: number[];
    quietCyclesBeforeBackoff: number;
    reconcileMinutes: number;
    /**
     * The polling window. `enabled: false` keeps the user's chosen window in
     * the config while it's switched off, so re-enabling restores it instead
     * of resetting to defaults. Absent flag = enabled (pre-flag configs).
     */
    activeHours?: { days: number[]; start: string; end: string; enabled?: boolean };
    slowOnBattery: boolean;
  };
  repos: Record<string, RepoOverride>;
  /**
   * The RWX integration. Off (or with the CLI missing, detected at runtime)
   * the app is GitLab-pipelines-only and never invokes `rwx`.
   */
  rwx: {
    enabled: boolean;
  };
  git: {
    /**
     * How you bring main into a branch — adjusts guidance text only (e.g. a
     * conflict says "needs a rebase" vs "merge main into the branch"). Most of
     * the team merges; rebase fans set 'rebase'.
     */
    updateStyle: 'rebase' | 'merge';
  };
  /**
   * Where each Jira status renders in the popover, beyond the active watch
   * list (`jira.activeStatuses`) and the special Dev Complete handling:
   *  - hidden: never shown at all (Backlog noise);
   *  - verification: own section — out of dev's hands, being verified;
   *  - done: collapsed at the bottom (closed >1 week ago disappears entirely).
   * Statuses in none of these land in the collapsed "Other" section.
   */
  statusSections: {
    hidden: string[];
    verification: string[];
    done: string[];
  };
  /**
   * Conditional routing, evaluated top-to-bottom BEFORE statusSections: for a
   * ticket in `status`, test a field and route to `then` or `else`. 'next'
   * falls through to the following rule / plain section mapping. The defaults
   * reproduce the built-in Dev Complete behavior — edit rather than fight them.
   */
  statusRules: StatusRule[];
  /**
   * Active tickets with **no merge request at all**.
   *
   * The radar is MR-shaped: every row starts from a merge request, so the one
   * state it structurally cannot show is "you haven't started". These settings
   * put such a ticket on screen as a row of its own — quietly by default, and
   * as a warning at the statuses where an MR is genuinely expected.
   */
  noMr: {
    enabled: boolean;
    /** Statuses where a missing MR is a problem, not just a fact (warn tone). */
    expectStatuses: string[];
    /** Conditional expectations, evaluated before `expectStatuses`. */
    rules: MrRule[];
  };
  /** Include MRs updated within N days even if their ticket isn't active. */
  recentDaysFallback: number;
  /**
   * Visual theme. `theme` picks a palette (each defines a light AND a dark
   * half); `appearance` picks which half applies — 'system' follows macOS.
   */
  ui: {
    theme: string;
    appearance: 'system' | 'light' | 'dark';
    /** What the popover tab labels count: active-scope work, or every section shown. */
    tabCounts: 'active' | 'all';
  };
  /**
   * The poller's localhost status page — the popover UI served to a browser.
   * This is how the UI is reached on a ThreatLocker-managed Mac, where the
   * Electron app is blocked. Bound to 127.0.0.1 only.
   */
  web: {
    enabled: boolean;
    port: number;
  };
  /**
   * The "announce for code review" helper (the Copy-for-Slack button). No
   * Slack credentials live here — iteration 1 is clipboard-only; a webhook,
   * when added, goes to the Keychain like every other secret.
   */
  slack: {
    /** Ticket statuses that count as ready to announce (case-insensitive). */
    readyStatuses: string[];
    /** Message template: {ticketKey} {ticketUrl} {title} {mrUrl}. */
    template: string;
  };
  notifications: {
    enabled: boolean;
    coalesce: boolean;
    /**
     * `'default'` = the system alert sound, `'silent'` = no sound, or a macOS
     * sound name (Glass, Ping, Sosumi, …).
     */
    sound: string;
    /**
     * How to deliver banners. `'auto'` = `osascript` (always allowed, always
     * delivers). `'terminal-notifier'` is explicit opt-in: it adds the app icon
     * and click-to-open, but app control (ThreatLocker) blocks it on this
     * machine and every blocked execution pops a system banner — so nothing
     * selects it automatically. `'native'` is Electron's path, which an
     * ad-hoc-signed app often fails to register with macOS.
     */
    method: 'auto' | 'native' | 'terminal-notifier' | 'osascript';
    /**
     * Notify about CI results on MRs you did NOT author.
     *
     * Off by default: a green suite on someone else's branch is not something
     * you act on as a reviewer — the row's chip is there when you look. What you
     * do want from those MRs is people (comments, approvals) and the fact that
     * the author pushed since you last spoke, which notify regardless.
     */
    ciForOthers: boolean;
  };
}

export const CONFIG_DIR = join(homedir(), '.config', 'mr-radar');
/** `MR_RADAR_CONFIG` / `MR_RADAR_DB` let a dry run target throwaway paths. */
export const CONFIG_PATH = process.env.MR_RADAR_CONFIG ?? join(CONFIG_DIR, 'config.json');
export const STATE_DIR = join(homedir(), '.local', 'state', 'mr-radar');
export const DB_PATH = process.env.MR_RADAR_DB ?? join(STATE_DIR, 'mr-radar.db');

export const FORGES = ['auto', 'gitlab', 'github'] as const;

export const DEFAULT_CONFIG: Config = {
  forge: 'auto',
  gitlab: {},
  github: {},
  jira: {
    baseUrl: '',
    email: '',
    activeStatuses: ['In Development', 'Code Review', 'Dev Complete'],
    ownerFields: [
      { clause: 'assignee', label: 'Assignee' },
      { clause: 'watcher', label: 'Watcher' },
    ],
    refreshMinutes: 10,
  },
  poll: {
    baseSeconds: 60,
    backoffSeconds: [60, 120, 300, 900],
    quietCyclesBeforeBackoff: 3,
    reconcileMinutes: 30,
    slowOnBattery: true,
  },
  // Test gates are detected from live data and shouldn't be pinned here.
  // Repos need no entry at all unless you want to trigger RWX runs from the
  // app: `rwx run` has to resolve `.rwx/` from a local working tree, so set
  // each repo's checkout in Settings → General (rows appear automatically for
  // every repo the app has seen you working in).
  repos: {},
  rwx: { enabled: true },
  git: { updateStyle: 'rebase' },
  statusSections: {
    hidden: ['Backlog'],
    verification: ['In QA', 'QA', 'Ready for QA'],
    done: ['Closed', 'Done', 'Resolved', "Won't Do", 'Cancelled', 'Canceled'],
  },
  statusRules: [
    // The example default: a Dev Complete ticket with no fix version still
    // needs one ("Needs fix version" section), otherwise it's out of dev's
    // hands. Edit or add rules in Settings → Jira → Advanced.
    { status: 'Dev Complete', field: 'fixVersions', op: 'empty', then: 'needs-value', else: 'verification' },
  ],
  // Every active ticket without an MR gets a row; only Code Review makes it a
  // warning. Deliberately not Dev Complete — by then the MR has usually merged
  // and merged MRs leave the radar, which would read as a missing MR.
  noMr: { enabled: true, expectStatuses: ['Code Review'], rules: [] },
  recentDaysFallback: 0,
  ui: { theme: 'system', appearance: 'system', tabCounts: 'active' },
  web: { enabled: true, port: 8942 },
  slack: {
    readyStatuses: ['Code Review'],
    template: 'hey team! {ticketUrl} is ready for review. {title}',
  },
  notifications: { enabled: true, coalesce: true, sound: 'default', method: 'auto', ciForOthers: false },
};

export const NOTIFICATION_METHODS = ['auto', 'native', 'terminal-notifier', 'osascript'] as const;

/** 'system' is the stock palette; the rest are alternate token sets. */
export const THEMES = ['system', 'slate', 'bubblegum', 'pine', 'pizza', 'seafoam', 'quarry', 'lilac', 'sunflower', 'meringue', 'oatmeal', 'coral', 'glacier', 'moss', 'cocoa', 'peach', 'charcoal', 'parchment', 'storm', 'mist', 'lemonade', 'matcha', 'bubbles', 'juniper', 'harbor', 'rain', 'pumpkin', 'mulberry', 'watermelon', 'mineral', 'olivine', 'sage', 'voltage', 'verdigris', 'denim', 'adobe', 'fig', 'domino'] as const;
export const APPEARANCES = ['system', 'light', 'dark'] as const;

/** macOS system sounds offered in the sound picker, plus default/silent. */
export const NOTIFICATION_SOUNDS = [
  'default',
  'silent',
  'Glass',
  'Ping',
  'Pop',
  'Hero',
  'Submarine',
  'Sosumi',
  'Tink',
  'Funk',
] as const;

/** Deep-merge just the one level we need; arrays and scalars replace wholesale. */
const merge = <T>(base: T, over: unknown): T => {
  if (over === null || over === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over as T;
  if (typeof over !== 'object' || Array.isArray(over)) return over as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = k in out ? merge((base as Record<string, unknown>)[k], v) : v;
  }
  return out as T;
}

export const loadConfig = (path: string = CONFIG_PATH): Config => {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`config at ${path} is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  const cfg = merge(DEFAULT_CONFIG, raw);
  normalizeRuleTargets(cfg);
  validate(cfg, path);
  return cfg;
}

/**
 * Older configs used the field-specific 'needs-fix-version' target. Also keep
 * rules coherent: 'needs-value' only means something for an `empty` check, so
 * other ops fall back to 'next'.
 */
const normalizeRuleTargets = (cfg: Config): void => {
  for (const r of cfg.statusRules) {
    if ((r.then as string) === 'needs-fix-version') r.then = 'needs-value';
    if ((r.else as string) === 'needs-fix-version') r.else = 'needs-value';
    if (r.op !== 'empty') {
      if (r.then === 'needs-value') r.then = 'next';
      if (r.else === 'needs-value') r.else = 'next';
    }
  }
}

const validate = (cfg: Config, path: string): void => {
  const problems: string[] = [];
  if (cfg.jira.baseUrl !== '' && !isPinnedHttpsOrigin(cfg.jira.baseUrl)) {
    problems.push('jira.baseUrl must be a bare https origin (no path, query, or userinfo)');
  }
  if (cfg.poll.baseSeconds < 15) problems.push('poll.baseSeconds must be >= 15');
  if (!(FORGES as readonly string[]).includes(cfg.forge)) {
    problems.push(`forge must be one of ${FORGES.join(', ')}`);
  }
  if (!Number.isInteger(cfg.web.port) || cfg.web.port < 1024 || cfg.web.port > 65535) {
    problems.push('web.port must be an integer in 1024–65535');
  }
  if (!(APPEARANCES as readonly string[]).includes(cfg.ui.appearance)) {
    problems.push(`ui.appearance must be one of ${APPEARANCES.join(', ')}`);
  }
  if (cfg.ui.tabCounts !== 'active' && cfg.ui.tabCounts !== 'all') {
    problems.push("ui.tabCounts must be 'active' or 'all'");
  }
  // present() runs the readiness predicate on every snapshot — a malformed
  // slack section must fail loudly at load, not crash every render.
  if (!Array.isArray(cfg.slack.readyStatuses) || cfg.slack.readyStatuses.some((s) => typeof s !== 'string')) {
    problems.push('slack.readyStatuses must be an array of status names');
  }
  if (typeof cfg.slack.template !== 'string' || !cfg.slack.template.trim()) {
    problems.push('slack.template must be a non-empty string');
  }
  for (const [i, rule] of cfg.statusRules.entries()) {
    if (!rule.status?.trim()) problems.push(`statusRules[${i}]: status is required`);
    if (rule.op !== 'always' && !RULE_FIELDS.includes(rule.field as RuleField)) {
      problems.push(`statusRules[${i}]: bad field "${rule.field}"`);
    }
    if (!RULE_OPS.includes(rule.op)) problems.push(`statusRules[${i}]: bad op "${rule.op}"`);
    if (!RULE_TARGETS.includes(rule.then) || (rule.else !== undefined && !RULE_TARGETS.includes(rule.else))) {
      problems.push(`statusRules[${i}]: then/else must be one of ${RULE_TARGETS.join(', ')}`);
    }
    for (const [j, c] of (rule.also ?? []).entries()) {
      if (c.connector !== 'and' && c.connector !== 'or') problems.push(`statusRules[${i}].also[${j}]: bad connector`);
      if (!RULE_FIELDS.includes(c.field)) problems.push(`statusRules[${i}].also[${j}]: bad field "${c.field}"`);
      if (!RULE_OPS.includes(c.op) || (c.op as RuleOp) === 'always') problems.push(`statusRules[${i}].also[${j}]: bad op "${c.op}"`);
    }
  }
  if (typeof cfg.noMr.enabled !== 'boolean') problems.push('noMr.enabled must be a boolean');
  if (!Array.isArray(cfg.noMr.expectStatuses) || cfg.noMr.expectStatuses.some((s) => typeof s !== 'string')) {
    problems.push('noMr.expectStatuses must be an array of status names');
  }
  if (!Array.isArray(cfg.noMr.rules)) problems.push('noMr.rules must be an array');
  else {
    for (const [i, rule] of cfg.noMr.rules.entries()) {
      if (!rule.status?.trim()) problems.push(`noMr.rules[${i}]: status is required`);
      if (rule.op !== 'always' && !RULE_FIELDS.includes(rule.field as RuleField)) {
        problems.push(`noMr.rules[${i}]: bad field "${rule.field}"`);
      }
      if (!RULE_OPS.includes(rule.op)) problems.push(`noMr.rules[${i}]: bad op "${rule.op}"`);
      if (!MR_RULE_TARGETS.includes(rule.then) || (rule.else !== undefined && !MR_RULE_TARGETS.includes(rule.else))) {
        problems.push(`noMr.rules[${i}]: then/else must be one of ${MR_RULE_TARGETS.join(', ')}`);
      }
      for (const [j, c] of (rule.also ?? []).entries()) {
        if (c.connector !== 'and' && c.connector !== 'or') problems.push(`noMr.rules[${i}].also[${j}]: bad connector`);
        if (!RULE_FIELDS.includes(c.field)) problems.push(`noMr.rules[${i}].also[${j}]: bad field "${c.field}"`);
        if (!RULE_OPS.includes(c.op) || (c.op as RuleOp) === 'always') problems.push(`noMr.rules[${i}].also[${j}]: bad op "${c.op}"`);
      }
    }
  }
  if (!cfg.poll.backoffSeconds.length) problems.push('poll.backoffSeconds must not be empty');
  if (cfg.jira.activeStatuses.length === 0 && !cfg.jira.jql) {
    problems.push('jira.activeStatuses must not be empty unless jira.jql is set');
  }
  // Empty ownership would silently collapse scope to nothing — same guard as
  // activeStatuses, same jql-override exemption.
  if (
    !cfg.jira.jql &&
    (!Array.isArray(cfg.jira.ownerFields) ||
      cfg.jira.ownerFields.length === 0 ||
      cfg.jira.ownerFields.some((f) => typeof f?.clause !== 'string' || !f.clause.trim()))
  ) {
    problems.push('jira.ownerFields must be a non-empty array of { clause, label } unless jira.jql is set');
  }
  if (problems.length) {
    throw new Error(`invalid config at ${path}:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Write the default config on first run so there's something to edit. */
export const ensureConfig = (path: string = CONFIG_PATH): Config => {
  if (existsSync(path)) return loadConfig(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { mode: 0o600 });
  return DEFAULT_CONFIG;
}

/**
 * The raw on-disk config object (no defaults merged in), so the settings panel
 * can edit known fields while preserving any advanced keys it doesn't surface.
 */
export const readRawConfig = (path: string = CONFIG_PATH): Record<string, unknown> => {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Persist a raw config object, validating the defaults-merged result first so a
 * bad edit is rejected before it's written. Returns the effective config.
 */
export const writeRawConfig = (raw: Record<string, unknown>, path: string = CONFIG_PATH): Config => {
  const full = merge(DEFAULT_CONFIG, raw);
  normalizeRuleTargets(full);
  validate(full, path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  return full;
}

/**
 * Build the JQL that defines scope. Filters on **status**, never `resolution` —
 * this Jira workflow leaves `resolution` empty on Closed issues, so
 * `resolution = Unresolved` would happily return closed tickets.
 */
// Backslash first, then quotes — a value ending in `\` must not be able to
// escape the closing quote and change the query's meaning.
const jqlQuote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The "this ticket is mine" half of the scope query: each configured owner
 * field renders as `<clause> = currentUser()`, OR-ed. Simple JQL names
 * (assignee, watcher) and `cf[123]` ids pass verbatim; anything else — e.g. a
 * field addressed by display name — is quote-escaped like the statuses.
 */
export const ownerClause = (cfg: Config): string => {
  const terms = cfg.jira.ownerFields
    .map((f) => f.clause.trim())
    .filter(Boolean)
    .map((clause) => (/^[a-z][a-zA-Z0-9]*$/.test(clause) || /^cf\[\d+\]$/.test(clause) ? clause : jqlQuote(clause)))
    .map((clause) => `${clause} = currentUser()`);
  return `(${terms.join(' OR ')})`;
};

export const buildJql = (cfg: Config): string => {
  if (cfg.jira.jql) return cfg.jira.jql;
  const statuses = cfg.jira.activeStatuses.map(jqlQuote).join(', ');
  // Mine OR watched (by default): an MR you're reviewing may be on a ticket
  // you watch but don't own, and you still want it treated as active.
  return `${ownerClause(cfg)} AND status IN (${statuses}) ORDER BY updated DESC`;
}
