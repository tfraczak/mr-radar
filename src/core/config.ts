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
  | 'needs-fix-version'
  | 'next';

export const RULE_TARGETS: readonly RuleTarget[] = [
  'active',
  'verification',
  'done',
  'ignore',
  'other',
  'needs-fix-version',
  'next',
];

export type RuleField = 'fixVersions' | 'issueType' | 'dueDate';
export type RuleOp = 'empty' | 'present' | 'matches' | 'past';

export const RULE_FIELDS: readonly RuleField[] = ['fixVersions', 'issueType', 'dueDate'];
export const RULE_OPS: readonly RuleOp[] = ['empty', 'present', 'matches', 'past'];

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
  field: RuleField;
  op: RuleOp;
  value?: string;
  then: RuleTarget;
  else: RuleTarget;
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
  gitlab: {
    /** Numeric user id. Resolved from `glab api user` on first run if absent. */
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
    /** Overrides activeStatuses when set. */
    jql?: string;
    refreshMinutes: number;
  };
  poll: {
    baseSeconds: number;
    /** Backoff ladder applied after consecutive quiet cycles. */
    backoffSeconds: number[];
    quietCyclesBeforeBackoff: number;
    reconcileMinutes: number;
    activeHours?: { days: number[]; start: string; end: string };
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
  /** Include MRs updated within N days even if their ticket isn't active. */
  recentDaysFallback: number;
  /**
   * Visual theme. `theme` picks a palette (each defines a light AND a dark
   * half); `appearance` picks which half applies — 'system' follows macOS.
   */
  ui: {
    theme: string;
    appearance: 'system' | 'light' | 'dark';
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
  };
}

export const CONFIG_DIR = join(homedir(), '.config', 'mr-radar');
/** `MR_RADAR_CONFIG` / `MR_RADAR_DB` let a dry run target throwaway paths. */
export const CONFIG_PATH = process.env.MR_RADAR_CONFIG ?? join(CONFIG_DIR, 'config.json');
export const STATE_DIR = join(homedir(), '.local', 'state', 'mr-radar');
export const DB_PATH = process.env.MR_RADAR_DB ?? join(STATE_DIR, 'mr-radar.db');

export const DEFAULT_CONFIG: Config = {
  gitlab: {},
  jira: {
    baseUrl: '',
    email: '',
    activeStatuses: ['In Development', 'Code Review', 'Dev Complete'],
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
    // needs one (actionable), otherwise it's out of dev's hands. Edit or add
    // rules in Settings → Jira → Advanced.
    { status: 'Dev Complete', field: 'fixVersions', op: 'empty', then: 'needs-fix-version', else: 'verification' },
  ],
  recentDaysFallback: 0,
  ui: { theme: 'system', appearance: 'system' },
  web: { enabled: true, port: 8942 },
  notifications: { enabled: true, coalesce: true, sound: 'default', method: 'auto' },
};

export const NOTIFICATION_METHODS = ['auto', 'native', 'terminal-notifier', 'osascript'] as const;

/** 'system' is the stock palette; the rest are alternate token sets. */
export const THEMES = ['system', 'slate', 'bubblegum', 'pine', 'pizza', 'seafoam', 'quarry', 'lilac', 'sunflower', 'meringue', 'oatmeal', 'coral', 'glacier', 'moss', 'cocoa', 'peach', 'charcoal', 'parchment', 'storm', 'mist', 'lemonade', 'matcha', 'bubbles'] as const;
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
  validate(cfg, path);
  return cfg;
}

const validate = (cfg: Config, path: string): void => {
  const problems: string[] = [];
  if (cfg.jira.baseUrl !== '' && !isPinnedHttpsOrigin(cfg.jira.baseUrl)) {
    problems.push('jira.baseUrl must be a bare https origin (no path, query, or userinfo)');
  }
  if (cfg.poll.baseSeconds < 15) problems.push('poll.baseSeconds must be >= 15');
  if (!Number.isInteger(cfg.web.port) || cfg.web.port < 1024 || cfg.web.port > 65535) {
    problems.push('web.port must be an integer in 1024–65535');
  }
  if (!(APPEARANCES as readonly string[]).includes(cfg.ui.appearance)) {
    problems.push(`ui.appearance must be one of ${APPEARANCES.join(', ')}`);
  }
  for (const [i, rule] of cfg.statusRules.entries()) {
    if (!rule.status?.trim()) problems.push(`statusRules[${i}]: status is required`);
    if (!RULE_FIELDS.includes(rule.field)) problems.push(`statusRules[${i}]: bad field "${rule.field}"`);
    if (!RULE_OPS.includes(rule.op)) problems.push(`statusRules[${i}]: bad op "${rule.op}"`);
    if (!RULE_TARGETS.includes(rule.then) || !RULE_TARGETS.includes(rule.else)) {
      problems.push(`statusRules[${i}]: then/else must be one of ${RULE_TARGETS.join(', ')}`);
    }
  }
  if (!cfg.poll.backoffSeconds.length) problems.push('poll.backoffSeconds must not be empty');
  if (cfg.jira.activeStatuses.length === 0 && !cfg.jira.jql) {
    problems.push('jira.activeStatuses must not be empty unless jira.jql is set');
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
export const buildJql = (cfg: Config): string => {
  if (cfg.jira.jql) return cfg.jira.jql;
  // Backslash first, then quotes — a status ending in `\` must not be able to
  // escape the closing quote and change the query's meaning.
  const statuses = cfg.jira.activeStatuses
    .map((s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(', ');
  // Assigned OR watched: an MR you're reviewing may be on a ticket you watch but
  // don't own, and you still want it treated as active.
  return `(assignee = currentUser() OR watcher = currentUser()) AND status IN (${statuses}) ORDER BY updated DESC`;
}
