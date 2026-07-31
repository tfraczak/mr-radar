/**
 * The IPC contract between the main process and the popover.
 *
 * Lives on the renderer side and owns only *types* — no runtime code — so the
 * renderer compiles fully self-contained (rootDir "."), with nothing dragged in
 * from the Electron main modules. The main process imports these types to shape
 * what it sends; the boundary itself is dynamic (structured-clone over IPC), so
 * these are a compile-time convenience, not a runtime guarantee.
 */

export interface UiSnapshot {
  at?: string | undefined;
  lastPollAt?: string | undefined;
  nextPollAt?: string | undefined;
  polling: boolean;
  paused?: string | undefined;
  enabled: boolean;
  lastError?: string | undefined;
  unreadCount: number;
  unreadKeys: string[];
  sources: { name: string; ok: boolean; error?: string | undefined; stale?: boolean | undefined }[];
  /** Active-status ticket groups, shown expanded at the top. */
  groups: UiGroup[];
  /** Dev Complete tickets still needing a fix version — actionable, own section.
   *  (Dev Complete WITH a version, or data fixes, land in otherGroups instead.) */
  devCompleteGroups: UiGroup[];
  /** Statuses mapped to the Verification section (e.g. In QA, In Verification). */
  verificationGroups: UiStatusGroup[];
  /** Statuses mapped to Done — collapsed at the very bottom. */
  doneGroups: UiStatusGroup[];
  /** MRs whose ticket status is unmapped, grouped by real status for a
   *  collapsed "Other" section below the active groups. */
  otherGroups: UiStatusGroup[];
  /** Row to scroll to and flash (notification click-through). `at` dedupes. */
  highlight?: { key: string; at: string } | undefined;
  /** Jira has no stored token yet, so the popover offers a connect field. */
  jiraNeedsToken: boolean;
  /** Atlassian account email, shown next to the connect field for context. */
  jiraEmail?: string | undefined;
}

export interface UiStatusGroup {
  status: string;
  statusRank: number;
  items: UiItem[];
}

export interface UiGroup {
  ticket?:
    | {
        key: string;
        status: string;
        url: string;
        statusRank: number;
        /** Dev Complete, non-data-fix, no fix version — offer the picker. */
        needsFixVersion?: boolean;
      }
    | undefined;
  items: UiItem[];
}

/** The single most important thing to do for a row, and how urgent it is. */
export interface Attention {
  text: string;
  tone: 'good' | 'bad' | 'warn' | 'info' | 'muted';
  /** Lower = more urgent; drives the default "attention" sort. */
  rank: number;
}

export interface UiItem {
  key: string;
  iid: number;
  projectPath: string;
  branch: string;
  targetBranch: string;
  title: string;
  url: string;
  headSha: string;
  reason: 'authored' | 'reviewer' | 'participating';
  /** How I'm participating, when reason is `participating`. */
  participation?: 'commented' | 'mentioned' | undefined;
  draft: boolean;
  hasConflicts: boolean;
  unresolved: number;
  commentCount: number;
  approvals?: { required: number; left: number; by: string[] } | undefined;
  unread: boolean;
  createdAt: string;
  updatedAt: string;
  dueDate?: string | undefined;
  overdue: boolean;
  attention: Attention;
  /** A second, independent signal shown beside the primary one (e.g. a
   *  good "Checks passed" paired with a warn "Target not main"). */
  attentionExtra?: Attention | undefined;
  ci: {
    label: string;
    tone: 'good' | 'bad' | 'busy' | 'warn' | 'none';
    provider?: string | undefined;
    url?: string | undefined;
    startable: boolean;
    detail?: string | undefined;
  };
  checks: { provider: string; role: string; name: string; state: string; url: string; stale: boolean }[];
}

/**
 * The user-editable slice of config, surfaced in the in-app Settings panel.
 * Advanced keys (backoff ladder, per-source detail) stay in config.json and are
 * preserved untouched on save.
 */
/** Where a Jira status renders. 'other' = the default unmapped bucket. */
export type StatusSection = 'active' | 'verification' | 'done' | 'ignore' | 'other';

export interface EditableSettings {
  jiraEmail: string;
  jiraBaseUrl: string;
  activeStatuses: string[];
  /**
   * Per-status section assignment, driving the dropdown UI. `active` rows are
   * the source of truth for `activeStatuses` on save (they also drive scope).
   */
  statusAssignments: { status: string; section: StatusSection }[];
  sectionChoices: StatusSection[];
  /** Advanced conditional routing rules, evaluated before the section map. */
  statusRules: {
    status: string;
    /** Project path scope; '' = any repo. */
    repo?: string | undefined;
    field: string;
    op: string;
    value?: string | undefined;
    then: string;
    else: string;
  }[];
  ruleFieldChoices: string[];
  ruleOpChoices: string[];
  ruleTargetChoices: string[];
  /** Repos the radar tracks (observed ∪ configured), for rule scoping. */
  ruleRepoChoices: string[];
  recentDaysFallback: number;
  notificationsEnabled: boolean;
  notificationSound: string;
  /** The choices to offer for notificationSound. */
  soundChoices: string[];
  notificationMethod: string;
  /** The choices to offer for notificationMethod. */
  methodChoices: string[];
  /** How you bring main into a branch — adjusts guidance text (rebase/merge). */
  updateStyle: string;
  /** Master switch for the RWX integration (also needs the rwx CLI). */
  rwxEnabled: boolean;
  updateStyleChoices: string[];
  /** Palette name; each theme carries a light and a dark half. */
  theme: string;
  themeChoices: string[];
  /** Which half applies: follow the OS, or pin light/dark. */
  appearance: string;
  appearanceChoices: string[];
  pollBaseSeconds: number;
  activeHours: { enabled: boolean; days: number[]; start: string; end: string };
  repos: { projectPath: string; checkout: string; rwxDefinition: string; testGate: string }[];
  /** 'auto' (detect from live data) plus the pinnable gates. */
  repoGateChoices: string[];
}

/** The surface exposed to the renderer as `window.radar` by the preload. */
export interface RadarApi {
  getSnapshot(): Promise<UiSnapshot>;
  onSnapshot(fn: (snapshot: UiSnapshot) => void): () => void;
  pollNow(): Promise<void>;
  togglePause(): Promise<void>;
  markAllRead(): Promise<void>;
  markRead(mrKey: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  /** `url` (when present) is the run page, offered as a link rather than auto-opened. */
  startRun(mrKey: string): Promise<{ started: boolean; message: string; url?: string }>;
  /** Verify a pasted Jira token and, if valid, store it in the Keychain. */
  setJiraToken(token: string): Promise<{ ok: boolean; message: string }>;
  /** Unreleased fix versions for the ticket's project, for the picker. */
  listFixVersions(
    ticketKey: string,
  ): Promise<{ ok: boolean; versions?: { id: string; name: string }[]; message?: string }>;
  /** Assign a fix version to a ticket — the one Jira write this app performs. */
  setFixVersion(ticketKey: string, versionId: string): Promise<{ ok: boolean; message: string }>;
  /** Add me as a formal reviewer on a participating MR (keeps existing reviewers). */
  becomeReviewer(mrKey: string): Promise<{ ok: boolean; message: string }>;
  /** All Jira status names, for the status-section assignment UI. */
  listStatuses(): Promise<{ ok: boolean; statuses?: string[]; message?: string }>;
  /** The shareable config subset (identity stripped; token never in config). */
  exportSettings(): Promise<{ ok: boolean; settings?: Record<string, unknown>; message?: string }>;
  /** Merge a teammate's shared settings over local config, keeping identity. */
  importSettings(shared: Record<string, unknown>): Promise<{ ok: boolean; message: string }>;
  getSettings(): Promise<EditableSettings>;
  saveSettings(settings: EditableSettings): Promise<{ ok: boolean; message: string }>;
  getLaunchAtLogin(): Promise<boolean>;
  setLaunchAtLogin(enabled: boolean): Promise<boolean>;
  revealConfig(): Promise<void>;
  /** Fires when the tray's "Settings…" item asks the popover to open the panel. */
  onShowSettings(fn: () => void): () => void;
  close(): Promise<void>;
}
