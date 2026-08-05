import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DB_PATH } from './config';
import type { AppEvent, JiraTicket, RepoCiRoles } from './types';

const SCHEMA_VERSION = 1;

/**
 * All persistence. Deliberately the only module that knows SQL.
 *
 * Two invariants the rest of the app relies on:
 *  - `seenMr` is how silent seeding works: an MR absent from `mrs` is recorded
 *    without notifying, which covers first launch, a new MR, and a wiped DB
 *    with one rule instead of three.
 *  - a cycle's writes happen in one transaction, so a crash mid-cycle leaves
 *    the previous complete state rather than a half-snapshot that would
 *    misfire notifications on restart.
 */
export class Db {
  private readonly db: DatabaseSync;

  constructor(path: string = DB_PATH, opts: { readOnly?: boolean } = {}) {
    const readOnly = opts.readOnly ?? false;
    if (!readOnly && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly });
    if (!readOnly) {
      // Both pragmas write (journal-mode change, schema pin); a read-only
      // handle inherits WAL from the writer and must not attempt either.
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA foreign_keys = ON');
    }
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (!readOnly) this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mrs (
        key              TEXT PRIMARY KEY,
        project_path     TEXT NOT NULL,
        project_id       INTEGER NOT NULL,
        iid              INTEGER NOT NULL,
        branch           TEXT NOT NULL,
        title            TEXT NOT NULL,
        head_sha         TEXT NOT NULL,
        web_url          TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        user_notes_count INTEGER NOT NULL DEFAULT 0,
        unresolved       INTEGER NOT NULL DEFAULT 0,
        approvals_left   INTEGER,
        has_conflicts    INTEGER NOT NULL DEFAULT 0,
        in_scope         INTEGER NOT NULL DEFAULT 0,
        reason           TEXT NOT NULL DEFAULT 'authored',
        ticket_key       TEXT,
        ticket_status    TEXT,
        -- Cached unverified-commit count, valid only while head_sha is
        -- unchanged. Avoids re-fetching the commit list every 60s for a state
        -- that persists for weeks on rocket.
        unverified_count TEXT,
        unverified_sha   TEXT,
        -- Last-known approval detail, so a cycle that skips the detail fetch can
        -- still show the right "N/M approved" instead of blanking it.
        approvals_required INTEGER,
        approvals_by       TEXT,
        first_seen_at    TEXT NOT NULL,
        last_seen_at     TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notes_seen (
        mr_key  TEXT NOT NULL,
        note_id INTEGER NOT NULL,
        PRIMARY KEY (mr_key, note_id)
      );

      CREATE TABLE IF NOT EXISTS approvals_seen (
        mr_key   TEXT NOT NULL,
        username TEXT NOT NULL,
        PRIMARY KEY (mr_key, username)
      );

      CREATE TABLE IF NOT EXISTS threads_seen (
        mr_key    TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        resolved  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (mr_key, thread_id)
      );

      CREATE TABLE IF NOT EXISTS ci_runs (
        id           TEXT NOT NULL,
        provider     TEXT NOT NULL,
        project_path TEXT NOT NULL,
        branch       TEXT NOT NULL,
        name         TEXT NOT NULL,
        role         TEXT NOT NULL,
        sha          TEXT NOT NULL,
        state        TEXT NOT NULL,
        url          TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (provider, id)
      );

      -- Generic "we already told them about this" ledger, keyed by scope.
      --
      -- The important use is scope='suggest_run' with key
      -- provider|branch|definition|head_sha, which is what makes the
      -- suggest-a-run nudge fire once per push instead of every 60s. On rocket
      -- that state persists for weeks, so a cyclical key would nag forever.
      CREATE TABLE IF NOT EXISTS notified_keys (
        scope TEXT NOT NULL,
        key   TEXT NOT NULL,
        at    TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      );

      CREATE TABLE IF NOT EXISTS watched_runs (
        run_id       TEXT PRIMARY KEY,
        provider     TEXT NOT NULL,
        mr_key       TEXT NOT NULL,
        branch       TEXT NOT NULL,
        sha          TEXT NOT NULL,
        definition   TEXT NOT NULL,
        url          TEXT NOT NULL,
        started_at   TEXT NOT NULL,
        terminal     INTEGER NOT NULL DEFAULT 0,
        result       TEXT
      );

      CREATE TABLE IF NOT EXISTS jira_tickets (
        key             TEXT PRIMARY KEY,
        summary         TEXT NOT NULL,
        status          TEXT NOT NULL,
        updated         TEXT NOT NULL,
        url             TEXT NOT NULL,
        due_date        TEXT,
        status_category TEXT,
        resolution_date TEXT,
        fetched_at      TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jira_statuses (
        name       TEXT PRIMARY KEY,
        first_seen TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repo_roles (
        project_path        TEXT PRIMARY KEY,
        test_gate           TEXT NOT NULL,
        gitlab_is_lint_only INTEGER NOT NULL DEFAULT 0,
        detected_at         TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        at       TEXT NOT NULL,
        type     TEXT NOT NULL,
        mr_key   TEXT NOT NULL,
        branch   TEXT,
        provider TEXT,
        payload  TEXT NOT NULL,
        notified INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);
      CREATE INDEX IF NOT EXISTS idx_events_mr ON events(mr_key);
      CREATE INDEX IF NOT EXISTS idx_ci_runs_branch ON ci_runs(project_path, branch);
    `);
    // Additive migrations for DBs created before a column existed. ALTER throws
    // if the column is already there, which is the expected no-op on new DBs.
    for (const stmt of [
      'ALTER TABLE jira_tickets ADD COLUMN due_date TEXT',
      'ALTER TABLE jira_tickets ADD COLUMN status_category TEXT',
      'ALTER TABLE jira_tickets ADD COLUMN resolution_date TEXT',
      'ALTER TABLE jira_tickets ADD COLUMN issue_type TEXT',
      // JSON array of {id,name}; NULL = unknown (older row), [] = known-empty.
      'ALTER TABLE jira_tickets ADD COLUMN fix_versions TEXT',
      'ALTER TABLE mrs ADD COLUMN approvals_required INTEGER',
      'ALTER TABLE mrs ADD COLUMN approvals_by TEXT',
      // Manual per-MR ignore override: 'ignored' | 'shown' | NULL (rules
      // decide). Deliberately outside upsertMr's column list so it survives
      // every cycle, and dies with the row when the closed MR is pruned.
      'ALTER TABLE mrs ADD COLUMN ignore_override TEXT',
    ]) {
      try {
        this.db.exec(stmt);
      } catch {
        /* column already present */
      }
    }
    this.setMeta('schema_version', String(SCHEMA_VERSION));
  }

  close(): void {
    this.db.close();
  }

  /** Run fn inside a transaction; rolls back on throw. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* rollback of an already-aborted txn is not interesting */
      }
      throw err;
    }
  }

  // -- meta ------------------------------------------------------------------

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  // -- MRs -------------------------------------------------------------------

  /** The previous cycle's view of an MR, or undefined if never seen. */
  getMr(key: string): MrRow | undefined {
    return this.db.prepare('SELECT * FROM mrs WHERE key = ?').get(key) as MrRow | undefined;
  }

  allMrs(): MrRow[] {
    return this.db.prepare('SELECT * FROM mrs ORDER BY updated_at DESC').all() as unknown as MrRow[];
  }

  upsertMr(row: Omit<MrRow, 'first_seen_at' | 'last_seen_at' | 'ignore_override'>, at: string): void {
    this.db
      .prepare(
        `INSERT INTO mrs (
           key, project_path, project_id, iid, branch, title, head_sha, web_url,
           updated_at, user_notes_count, unresolved, approvals_left, approvals_required,
           approvals_by, has_conflicts, in_scope, reason, ticket_key, ticket_status,
           unverified_count, unverified_sha, first_seen_at, last_seen_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET
           project_path = excluded.project_path,
           project_id = excluded.project_id,
           iid = excluded.iid,
           branch = excluded.branch,
           title = excluded.title,
           head_sha = excluded.head_sha,
           web_url = excluded.web_url,
           updated_at = excluded.updated_at,
           user_notes_count = excluded.user_notes_count,
           unresolved = excluded.unresolved,
           approvals_left = excluded.approvals_left,
           approvals_required = excluded.approvals_required,
           approvals_by = excluded.approvals_by,
           has_conflicts = excluded.has_conflicts,
           in_scope = excluded.in_scope,
           reason = excluded.reason,
           ticket_key = excluded.ticket_key,
           ticket_status = excluded.ticket_status,
           unverified_count = excluded.unverified_count,
           unverified_sha = excluded.unverified_sha,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        row.key,
        row.project_path,
        row.project_id,
        row.iid,
        row.branch,
        row.title,
        row.head_sha,
        row.web_url,
        row.updated_at,
        row.user_notes_count,
        row.unresolved,
        row.approvals_left ?? null,
        row.approvals_required ?? null,
        row.approvals_by ?? null,
        row.has_conflicts,
        row.in_scope,
        row.reason,
        row.ticket_key ?? null,
        row.ticket_status ?? null,
        row.unverified_count ?? null,
        row.unverified_sha ?? null,
        at,
        at,
      );
  }

  /** Set/clear the manual ignore override. False = no such MR row (yet). */
  setIgnoreOverride(key: string, value: 'ignored' | 'shown' | null): boolean {
    const r = this.db.prepare('UPDATE mrs SET ignore_override = ? WHERE key = ?').run(value, key);
    return Number(r.changes ?? 0) > 0;
  }

  /** Drop MRs we no longer see at all (merged/closed), and their child rows. */
  pruneMrsNotIn(keys: string[]): number {
    const keep = new Set(keys);
    const existing = this.db.prepare('SELECT key FROM mrs').all() as { key: string }[];
    const gone = existing.map((r) => r.key).filter((k) => !keep.has(k));
    for (const key of gone) {
      this.db.prepare('DELETE FROM notes_seen WHERE mr_key = ?').run(key);
      this.db.prepare('DELETE FROM approvals_seen WHERE mr_key = ?').run(key);
      this.db.prepare('DELETE FROM threads_seen WHERE mr_key = ?').run(key);
      this.db.prepare('DELETE FROM mrs WHERE key = ?').run(key);
    }
    return gone.length;
  }

  // -- notes / approvals / threads -------------------------------------------

  seenNoteIds(mrKey: string): Set<number> {
    const rows = this.db
      .prepare('SELECT note_id FROM notes_seen WHERE mr_key = ?')
      .all(mrKey) as { note_id: number }[];
    return new Set(rows.map((r) => r.note_id));
  }

  markNotesSeen(mrKey: string, ids: number[]): void {
    const stmt = this.db.prepare(
      'INSERT INTO notes_seen(mr_key, note_id) VALUES(?, ?) ON CONFLICT DO NOTHING',
    );
    for (const id of ids) stmt.run(mrKey, id);
  }

  seenApprovers(mrKey: string): Set<string> {
    const rows = this.db
      .prepare('SELECT username FROM approvals_seen WHERE mr_key = ?')
      .all(mrKey) as { username: string }[];
    return new Set(rows.map((r) => r.username));
  }

  setApprovers(mrKey: string, usernames: string[]): void {
    // Replace rather than insert: an unapproval should let a later re-approval
    // notify again.
    this.db.prepare('DELETE FROM approvals_seen WHERE mr_key = ?').run(mrKey);
    const stmt = this.db.prepare('INSERT INTO approvals_seen(mr_key, username) VALUES(?, ?)');
    for (const u of usernames) stmt.run(mrKey, u);
  }

  seenThreads(mrKey: string): Map<string, boolean> {
    const rows = this.db
      .prepare('SELECT thread_id, resolved FROM threads_seen WHERE mr_key = ?')
      .all(mrKey) as { thread_id: string; resolved: number }[];
    return new Map(rows.map((r) => [r.thread_id, r.resolved === 1]));
  }

  setThreads(mrKey: string, threads: { id: string; resolved: boolean }[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO threads_seen(mr_key, thread_id, resolved) VALUES(?,?,?)
       ON CONFLICT(mr_key, thread_id) DO UPDATE SET resolved = excluded.resolved`,
    );
    for (const t of threads) stmt.run(mrKey, t.id, t.resolved ? 1 : 0);
  }

  /**
   * Statuses seen on tracked tickets accumulate here forever — a status seen
   * once (e.g. Closed, In QA) stays available to the status→section picker
   * even when no current ticket holds it. Statuses rarely change, so there is
   * deliberately no expiry.
   */
  rememberStatuses(names: string[], at: string): void {
    if (names.length === 0) return;
    const stmt = this.db.prepare(
      'INSERT INTO jira_statuses(name, first_seen) VALUES(?, ?) ON CONFLICT DO NOTHING',
    );
    for (const name of names) stmt.run(name, at);
  }

  seenStatuses(): string[] {
    return (
      this.db.prepare('SELECT name FROM jira_statuses ORDER BY name').all() as unknown as {
        name: string;
      }[]
    ).map((r) => r.name);
  }

  // -- CI --------------------------------------------------------------------

  upsertCiRun(r: CiRunRow): void {
    this.db
      .prepare(
        `INSERT INTO ci_runs (id, provider, project_path, branch, name, role, sha, state, url, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(provider, id) DO UPDATE SET
           state = excluded.state, url = excluded.url, role = excluded.role`,
      )
      .run(r.id, r.provider, r.project_path, r.branch, r.name, r.role, r.sha, r.state, r.url, r.created_at);
  }

  getCiRun(provider: string, id: string): CiRunRow | undefined {
    return this.db
      .prepare('SELECT * FROM ci_runs WHERE provider = ? AND id = ?')
      .get(provider, id) as CiRunRow | undefined;
  }

  /**
   * Remembered completed test-gate runs for a branch. This is what makes
   * coverage durable: RWX's list windows scroll fast (100 runs org-wide can be
   * hours) and CLI-triggered runs are only discoverable while visible — but
   * once any cycle has seen a result, it's recorded here and the branch can't
   * regress to "never run" just because the API window moved on.
   */
  completedTestRuns(projectPath: string, branch: string): CiRunRow[] {
    return this.db
      .prepare(
        `SELECT * FROM ci_runs
         WHERE provider = 'rwx' AND project_path = ? AND branch = ? AND role = 'tests'
           AND state IN ('succeeded', 'failed')`,
      )
      .all(projectPath, branch) as unknown as CiRunRow[];
  }

  /**
   * Finished runs the user started FROM THE APP for this branch. The app
   * recorded id/branch/sha/url at trigger time, so these are attributable even
   * though RWX gives CLI-triggered runs no branch metadata at all — the direct
   * answer to "I ran it from the app, why does it say never run?".
   */
  completedWatchedRuns(branch: string): WatchedRunRow[] {
    return this.db
      .prepare(
        `SELECT * FROM watched_runs
         WHERE branch = ? AND terminal = 1 AND result IN ('succeeded', 'failed')`,
      )
      .all(branch) as unknown as WatchedRunRow[];
  }

  wasNotified(scope: string, key: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS ok FROM notified_keys WHERE scope = ? AND key = ?')
      .get(scope, key) as { ok: number } | undefined;
    return row !== undefined;
  }

  markNotified(scope: string, key: string, at: string): void {
    this.db
      .prepare('INSERT INTO notified_keys(scope, key, at) VALUES(?,?,?) ON CONFLICT DO NOTHING')
      .run(scope, key, at);
  }

  // -- repo roles ------------------------------------------------------------

  getRepoRoles(projectPath: string): RepoCiRoles | undefined {
    const row = this.db
      .prepare('SELECT * FROM repo_roles WHERE project_path = ?')
      .get(projectPath) as
      | { test_gate: string; gitlab_is_lint_only: number; detected_at: string }
      | undefined;
    if (!row) return undefined;
    return {
      testGate: row.test_gate as RepoCiRoles['testGate'],
      gitlabIsLintOnly: row.gitlab_is_lint_only === 1,
      detectedAt: row.detected_at,
    };
  }

  /** Every project path the radar has tracked — feeds the rule repo picker. */
  seenRepos(): string[] {
    return (
      this.db
        .prepare('SELECT project_path FROM repo_roles ORDER BY project_path')
        .all() as unknown as { project_path: string }[]
    ).map((r) => r.project_path);
  }

  /** Project prefixes of every ticket ever persisted on an MR row. */
  knownTicketPrefixes(): Set<string> {
    const rows = this.db
      .prepare(`SELECT DISTINCT ticket_key FROM mrs WHERE ticket_key IS NOT NULL`)
      .all() as { ticket_key: string }[];
    return new Set(rows.map((r) => r.ticket_key.split('-')[0]!).filter(Boolean));
  }


  setRepoRoles(projectPath: string, roles: RepoCiRoles): void {
    this.db
      .prepare(
        `INSERT INTO repo_roles(project_path, test_gate, gitlab_is_lint_only, detected_at)
         VALUES(?,?,?,?)
         ON CONFLICT(project_path) DO UPDATE SET
           test_gate = excluded.test_gate,
           gitlab_is_lint_only = excluded.gitlab_is_lint_only,
           detected_at = excluded.detected_at`,
      )
      .run(projectPath, roles.testGate, roles.gitlabIsLintOnly ? 1 : 0, roles.detectedAt);
  }

  // -- watched runs ----------------------------------------------------------

  addWatchedRun(r: WatchedRunRow): void {
    this.db
      .prepare(
        `INSERT INTO watched_runs(run_id, provider, mr_key, branch, sha, definition, url, started_at, terminal, result)
         VALUES(?,?,?,?,?,?,?,?,0,NULL) ON CONFLICT DO NOTHING`,
      )
      .run(r.run_id, r.provider, r.mr_key, r.branch, r.sha, r.definition, r.url, r.started_at);
  }

  openWatchedRuns(): WatchedRunRow[] {
    return this.db
      .prepare('SELECT * FROM watched_runs WHERE terminal = 0')
      .all() as unknown as WatchedRunRow[];
  }

  /** All runs we've started, newest first — the history of triggered runs. */
  allWatchedRuns(limit = 50): WatchedRunRow[] {
    return this.db
      .prepare('SELECT * FROM watched_runs ORDER BY started_at DESC LIMIT ?')
      .all(limit) as unknown as WatchedRunRow[];
  }

  resolveWatchedRun(runId: string, result: string): void {
    this.db
      .prepare('UPDATE watched_runs SET terminal = 1, result = ? WHERE run_id = ?')
      .run(result, runId);
  }

  // -- jira ------------------------------------------------------------------

  /** Replace the cached active set wholesale; only called on a successful fetch. */
  replaceJiraTickets(tickets: JiraTicket[], at: string): void {
    this.db.exec('DELETE FROM jira_tickets');
    const stmt = this.db.prepare(
      `INSERT INTO jira_tickets(key, summary, status, updated, url, due_date, status_category, resolution_date, issue_type, fix_versions, fetched_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const t of tickets) {
      stmt.run(
        t.key,
        t.summary,
        t.status,
        t.updated,
        t.url,
        t.dueDate ?? null,
        t.statusCategory ?? null,
        t.resolutionDate ?? null,
        t.issueType ?? null,
        t.fixVersions ? JSON.stringify(t.fixVersions) : null,
        at,
      );
    }
  }

  cachedJiraTickets(): { tickets: JiraTicket[]; fetchedAt?: string } {
    const rows = this.db.prepare('SELECT * FROM jira_tickets').all() as unknown as {
      key: string;
      summary: string;
      status: string;
      updated: string;
      url: string;
      due_date: string | null;
      status_category: string | null;
      resolution_date: string | null;
      issue_type: string | null;
      fix_versions: string | null;
      fetched_at: string;
    }[];
    return {
      tickets: rows.map((r) => ({
        key: r.key,
        summary: r.summary,
        status: r.status,
        updated: r.updated,
        url: r.url,
        ...(r.due_date ? { dueDate: r.due_date } : {}),
        ...(r.status_category ? { statusCategory: r.status_category } : {}),
        ...(r.resolution_date ? { resolutionDate: r.resolution_date } : {}),
        ...(r.issue_type ? { issueType: r.issue_type } : {}),
        ...(r.fix_versions ? { fixVersions: parseFixVersions(r.fix_versions) } : {}),
      })),
      ...(rows[0] ? { fetchedAt: rows[0].fetched_at } : {}),
    };
  }

  // -- events ----------------------------------------------------------------

  recordEvents(events: AppEvent[], at: string, notified: boolean): void {
    const stmt = this.db.prepare(
      'INSERT INTO events(at, type, mr_key, branch, provider, payload, notified) VALUES(?,?,?,?,?,?,?)',
    );
    for (const e of events) {
      const provider = 'provider' in e ? e.provider : null;
      stmt.run(at, e.type, e.mrKey, e.branch, provider, JSON.stringify(e), notified ? 1 : 0);
    }
  }

  recentEvents(limit = 50, mrKey?: string): EventRow[] {
    if (mrKey !== undefined) {
      return this.db
        .prepare('SELECT * FROM events WHERE mr_key = ? ORDER BY id DESC LIMIT ?')
        .all(mrKey, limit) as unknown as EventRow[];
    }
    return this.db
      .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as EventRow[];
  }

  eventStats(): { type: string; n: number }[] {
    return this.db
      .prepare('SELECT type, COUNT(*) AS n FROM events GROUP BY type ORDER BY n DESC')
      .all() as { type: string; n: number }[];
  }

  /**
   * Trim the append-only / ever-growing tables so the DB doesn't grow without
   * bound over the app's lifetime. Time-based: anything older than `keepDays` is
   * dropped. `events` is kept as history but capped; `notified_keys` re-arming
   * after the cutoff just means a stale nudge could re-fire, which is harmless.
   * Returns rows deleted, for logging.
   */
  retentionSweep(nowIso: string, keepDays = 30): number {
    const cutoff = new Date(new Date(nowIso).getTime() - keepDays * 86_400_000).toISOString();
    let removed = 0;
    for (const [table, col] of [
      ['events', 'at'],
      ['notified_keys', 'at'],
      ['ci_runs', 'created_at'],
    ] as const) {
      const r = this.db.prepare(`DELETE FROM ${table} WHERE ${col} < ?`).run(cutoff);
      removed += Number(r.changes ?? 0);
    }
    return removed;
  }
}

/** The read surface of `Db` — all a second, non-writing process may touch. */
export type ReadOnlyDb = Pick<
  Db,
  | 'getMr'
  | 'allMrs'
  | 'recentEvents'
  | 'eventStats'
  | 'cachedJiraTickets'
  | 'allWatchedRuns'
  | 'openWatchedRuns'
  | 'completedTestRuns'
  | 'completedWatchedRuns'
  | 'seenStatuses'
  | 'seenRepos'
  | 'getMeta'
  | 'knownTicketPrefixes'
  | 'close'
>;

/**
 * Open the DB without write access — no migrate, no WAL pragma — safe from a
 * second process while the tray/poller holds its read-write handle (WAL).
 * `undefined` means "no data yet": the file doesn't exist (a read-only open
 * cannot create one), exists but was never migrated (empty/foreign file), or
 * cannot be read right now (corrupt, or a WAL left by a crashed writer that a
 * read-only handle cannot recover).
 */
export const openReadOnlyDb = (
  path: string = process.env.MR_RADAR_DB ?? DB_PATH,
): ReadOnlyDb | undefined => {
  if (!existsSync(path)) return undefined;
  let db: Db | undefined;
  try {
    db = new Db(path, { readOnly: true });
    // Probe: a handle that can't read the schema would throw 'no such table'
    // on the first real query anyway — degrade to "no data" here instead.
    if (db.getMeta('schema_version') === undefined) {
      db.close();
      return undefined;
    }
    return db;
  } catch {
    try {
      db?.close();
    } catch {
      /* already closed or never opened */
    }
    return undefined;
  }
};

export interface MrRow {
  key: string;
  project_path: string;
  project_id: number;
  iid: number;
  branch: string;
  title: string;
  head_sha: string;
  web_url: string;
  updated_at: string;
  user_notes_count: number;
  unresolved: number;
  approvals_left: number | null;
  approvals_required: number | null;
  approvals_by: string | null;
  has_conflicts: number;
  in_scope: number;
  reason: string;
  ticket_key: string | null;
  ticket_status: string | null;
  unverified_count: string | null;
  unverified_sha: string | null;
  ignore_override: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

/** Defensive JSON parse for the fix_versions column; bad rows read as absent. */
const parseFixVersions = (raw: string): { id: string; name: string }[] => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((v) =>
      v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' &&
      typeof (v as { name?: unknown }).name === 'string'
        ? [{ id: (v as { id: string }).id, name: (v as { name: string }).name }]
        : [],
    );
  } catch {
    return [];
  }
};

export interface CiRunRow {
  id: string;
  provider: string;
  project_path: string;
  branch: string;
  name: string;
  role: string;
  sha: string;
  state: string;
  url: string;
  created_at: string;
}

export interface WatchedRunRow {
  run_id: string;
  provider: string;
  mr_key: string;
  branch: string;
  sha: string;
  definition: string;
  url: string;
  started_at: string;
  terminal: number;
  result: string | null;
}

export interface EventRow {
  id: number;
  at: string;
  type: string;
  mr_key: string;
  branch: string | null;
  provider: string | null;
  payload: string;
  notified: number;
}
