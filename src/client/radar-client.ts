import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, loadConfig } from '../core/config';
import { openReadOnlyDb, type MrRow, type ReadOnlyDb } from '../core/db';
import type { JiraTicket } from '../core/types';
import type { EventView, HealthInfo, ItemDetail } from '../web-server';
import type { UiGroup, UiItem, UiSnapshot, UiStatusGroup } from '../renderer/contract';
import type { TriggerResult } from '../core/trigger';

/**
 * The one hybrid client for MR Radar's local surfaces, shared by every agent
 * front end (the radar CLI today, the MCP server next).
 *
 *  - Reads go to the live app first (localhost web API, token from the 0600
 *    discovery file) and fall back to a read-only open of the SQLite DB when
 *    the app is down — data as of the last completed poll, flagged stale.
 *  - Actions are live-only: without the app there is nothing to act on.
 *
 * Everything effectful is injectable so tests use literal fakes.
 */

export type Section = 'active' | 'needs' | 'verification' | 'done' | 'other';

export interface Freshness {
  source: 'live' | 'db';
  /** When the data was true: snapshot time (live) or last-seen marker (db). */
  dataAsOf?: string;
  stale?: boolean;
  staleNote?: string;
}

export interface MrRowView {
  key: string;
  title: string;
  url: string;
  section?: Section;
  ticket?: { key?: string; status?: string; url?: string };
  branch: string;
  targetBranch?: string;
  reason: string;
  participation?: string;
  draft?: boolean;
  conflicts: boolean;
  unresolved: number;
  commentCount: number;
  approvals?: { required?: number; left?: number; by: string[] };
  unread?: boolean;
  attention?: { text: string; tone: string; rank: number };
  ci?: UiItem['ci'];
  checks?: UiItem['checks'];
  headSha?: string;
  updatedAt: string;
  dueDate?: string;
  overdue?: boolean;
  lastSeenAt?: string;
  /** Fields the offline (DB) shape genuinely lacks — never faked. */
  unavailableOffline?: string[];
}

export interface StatusView extends Freshness {
  appRunning: boolean;
  mode?: string;
  version?: string;
  polling?: boolean;
  enabled?: boolean;
  paused?: string;
  lastPollAt?: string;
  nextPollAt?: string;
  lastError?: string;
  unreadCount?: number;
  sources?: UiSnapshot['sources'];
  counts: Partial<Record<Section, number>> & { total?: number };
}

export class AppDownError extends Error {
  constructor(port: number) {
    super(
      `MR Radar is not running — nothing answered at http://127.0.0.1:${port} (connection refused). ` +
        `Actions need the live app; read commands still work with data as of the last poll. ` +
        `Start it with 'yarn tray:restart' or 'yarn poller:restart' in the mr-radar checkout.`,
    );
    this.name = 'AppDownError';
  }
}

/** Raised by reads when neither the app nor a DB file exists. */
export class NoDataError extends Error {
  constructor() {
    super('No data yet — MR Radar has never completed a poll on this machine.');
    this.name = 'NoDataError';
  }
}

interface TokenInfo {
  token: string;
  port: number;
}

export interface RadarClientDeps {
  fetchFn?: typeof fetch;
  tokenFilePath?: string;
  /** Fallback port when no token file exists (older builds): config's web.port. */
  defaultPort?: () => number;
  openDb?: () => ReadOnlyDb | undefined;
}

const READ_TIMEOUT_MS = 5_000;
/** start-run awaits the rwx CLI end-to-end; give it real time. */
const START_RUN_TIMEOUT_MS = 60_000;

const DB_LIST_UNAVAILABLE = ['section', 'targetBranch', 'draft', 'attention', 'ci', 'checks', 'unread'];

export class RadarClient {
  private readonly fetchFn: typeof fetch;
  private readonly tokenFilePath: string;
  private readonly defaultPort: () => number;
  private readonly openDb: () => ReadOnlyDb | undefined;
  private cached: TokenInfo | undefined;

  constructor(deps: RadarClientDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.tokenFilePath = deps.tokenFilePath ?? join(STATE_DIR, 'web-token.json');
    this.defaultPort =
      deps.defaultPort ??
      ((): number => {
        try {
          return loadConfig().web.port;
        } catch {
          return 8942;
        }
      });
    this.openDb = deps.openDb ?? openReadOnlyDb;
  }

  // -- discovery -------------------------------------------------------------

  private discover(): TokenInfo | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.tokenFilePath, 'utf8')) as {
        token?: string;
        port?: number;
      };
      if (typeof raw.token === 'string' && typeof raw.port === 'number') {
        return { token: raw.token, port: raw.port };
      }
    } catch {
      /* no file — try the HTML scrape below */
    }
    return undefined;
  }

  /** Builds predating the token file: the unauthenticated page embeds it. */
  private async scrape(port: number): Promise<TokenInfo | undefined> {
    try {
      const res = await this.fetchFn(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      const html = await res.text();
      const m = /<meta name="radar-token" content="([0-9a-f]{32})"/.exec(html);
      return m?.[1] ? { token: m[1], port } : undefined;
    } catch {
      return undefined;
    }
  }

  private async tokenInfo(rediscover = false): Promise<TokenInfo | undefined> {
    if (!rediscover && this.cached) return this.cached;
    this.cached = this.discover() ?? (await this.scrape(this.defaultPort()));
    return this.cached;
  }

  // -- transport ---------------------------------------------------------------

  private async api<T>(
    path: string,
    opts: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    const info = await this.tokenInfo();
    if (!info) throw new AppDownError(this.defaultPort());
    const attempt = async (i: TokenInfo): Promise<Response> =>
      this.fetchFn(`http://127.0.0.1:${i.port}/api/${path}`, {
        method: opts.method ?? 'GET',
        headers: {
          'x-radar-token': i.token,
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs ?? READ_TIMEOUT_MS),
      });

    let res: Response;
    try {
      res = await attempt(info);
    } catch {
      throw new AppDownError(info.port);
    }
    if (res.status === 403) {
      // The app restarted and minted a new token; re-discover once.
      const fresh = await this.tokenInfo(true);
      if (!fresh) throw new AppDownError(info.port);
      try {
        res = await attempt(fresh);
      } catch {
        throw new AppDownError(fresh.port);
      }
      if (res.status === 403) {
        throw new Error(
          'MR Radar rejected the auth token even after refreshing it — the app may have just restarted; retry.',
        );
      }
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`MR Radar API ${path} failed (${res.status}): ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  private async liveSnapshot(): Promise<UiSnapshot | undefined> {
    try {
      return await this.api<UiSnapshot>('snapshot');
    } catch (err) {
      if (err instanceof AppDownError) return undefined;
      throw err;
    }
  }

  private withDb<T>(fn: (db: ReadOnlyDb) => T): T {
    const db = this.openDb();
    if (!db) throw new NoDataError();
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  private dbEnvelope(dataAsOf: string | undefined): Freshness {
    return {
      source: 'db',
      ...(dataAsOf ? { dataAsOf } : {}),
      stale: true,
      staleNote: `MR Radar is not running; data is from the last completed poll${dataAsOf ? ` at ${dataAsOf}` : ''}.`,
    };
  }

  // -- reads -------------------------------------------------------------------

  async health(): Promise<HealthInfo | undefined> {
    const info = await this.tokenInfo();
    const port = info?.port ?? this.defaultPort();
    try {
      const res = await this.fetchFn(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      if (!res.ok) return undefined;
      return (await res.json()) as HealthInfo;
    } catch {
      return undefined;
    }
  }

  async status(): Promise<StatusView> {
    const snapshot = await this.liveSnapshot();
    if (snapshot) {
      const count = (groups: (UiGroup | UiStatusGroup)[]): number =>
        groups.reduce((acc, g) => acc + g.items.length, 0);
      const health = await this.health();
      return {
        source: 'live',
        ...(snapshot.at ? { dataAsOf: snapshot.at } : {}),
        appRunning: true,
        ...(health?.mode ? { mode: health.mode } : {}),
        ...(health?.version ? { version: health.version } : {}),
        polling: snapshot.polling,
        enabled: snapshot.enabled,
        ...(snapshot.paused ? { paused: snapshot.paused } : {}),
        ...(snapshot.lastPollAt ? { lastPollAt: snapshot.lastPollAt } : {}),
        ...(snapshot.nextPollAt ? { nextPollAt: snapshot.nextPollAt } : {}),
        ...(snapshot.lastError ? { lastError: snapshot.lastError } : {}),
        unreadCount: snapshot.unreadCount,
        sources: snapshot.sources,
        counts: {
          active: count(snapshot.groups),
          needs: count(snapshot.needsGroups),
          verification: count(snapshot.verificationGroups),
          done: count(snapshot.doneGroups),
          other: count(snapshot.otherGroups),
        },
      };
    }
    return this.withDb((db) => {
      const rows = db.allMrs();
      const dataAsOf = rows.map((r) => r.last_seen_at).sort().at(-1);
      return {
        ...this.dbEnvelope(dataAsOf),
        appRunning: false,
        counts: { total: rows.length, active: rows.filter((r) => r.in_scope === 1).length },
      };
    });
  }

  async listMrs(filter: { section?: Section; ticket?: string } = {}): Promise<Freshness & { mrs: MrRowView[] }> {
    const snapshot = await this.liveSnapshot();
    if (snapshot) {
      const rows: MrRowView[] = [
        ...snapshot.groups.flatMap((g) => g.items.map((i) => liveRow(i, 'active', g.ticket))),
        ...snapshot.needsGroups.flatMap((g) => g.items.map((i) => liveRow(i, 'needs', g.ticket))),
        ...snapshot.verificationGroups.flatMap((g) => g.items.map((i) => liveRow(i, 'verification', { status: g.status }))),
        ...snapshot.doneGroups.flatMap((g) => g.items.map((i) => liveRow(i, 'done', { status: g.status }))),
        ...snapshot.otherGroups.flatMap((g) => g.items.map((i) => liveRow(i, 'other', { status: g.status }))),
      ];
      return {
        source: 'live',
        ...(snapshot.at ? { dataAsOf: snapshot.at } : {}),
        mrs: rows.filter((r) => matches(r, filter)),
      };
    }
    return this.withDb((db) => {
      const rows = db.allMrs().filter((r) => r.in_scope === 1);
      const dataAsOf = rows.map((r) => r.last_seen_at).sort().at(-1);
      const mrs = rows.map(dbRow).filter((r) => matches(r, { ...(filter.ticket ? { ticket: filter.ticket } : {}) }));
      const envelope = this.dbEnvelope(dataAsOf);
      if (filter.section) {
        envelope.staleNote = `${envelope.staleNote} The --section filter needs the live app and was ignored.`;
      }
      return { ...envelope, mrs };
    });
  }

  async itemDetail(key: string): Promise<Freshness & { item?: ItemDetail | DbItemView; message?: string }> {
    try {
      const got = await this.api<{ ok: boolean; message?: string; item?: ItemDetail }>(
        `item?key=${encodeURIComponent(key)}`,
      );
      return {
        source: 'live',
        ...(got.item?.dataAsOf ? { dataAsOf: got.item.dataAsOf } : {}),
        ...(got.item ? { item: got.item } : {}),
        ...(got.message ? { message: got.message } : {}),
      };
    } catch (err) {
      if (!(err instanceof AppDownError)) throw err;
    }
    return this.withDb((db) => {
      const row = db.getMr(key);
      if (!row) return { ...this.dbEnvelope(undefined), message: 'That MR is not in the local history.' };
      const events = db.recentEvents(10, key);
      const runs = db.completedWatchedRuns(row.branch);
      return {
        ...this.dbEnvelope(row.last_seen_at),
        item: {
          ...dbRow(row),
          recentEvents: events.map((e) => ({ at: e.at, type: e.type })),
          triggeredRuns: runs.map((r) => ({ startedAt: r.started_at, result: r.result, url: r.url })),
          unavailableOffline: [...DB_LIST_UNAVAILABLE, 'threads', 'testGate'],
        },
      };
    });
  }

  async discussions(
    key: string,
    unresolvedOnly = true,
  ): Promise<Freshness & { threads?: ItemDetail['threads']; message?: string }> {
    // Live-only: thread bodies exist solely in the running app's memory.
    const got = await this.api<{ ok: boolean; message?: string; item?: ItemDetail }>(
      `item?key=${encodeURIComponent(key)}`,
    );
    if (!got.ok || !got.item) {
      return { source: 'live', ...(got.message ? { message: got.message } : {}) };
    }
    // Absent (vs empty) threads = the app's on-demand forge fetch failed.
    if (!got.item.threads) {
      return {
        source: 'live',
        dataAsOf: got.item.dataAsOf,
        message: 'Thread bodies could not be fetched from the forge just now — try again shortly.',
      };
    }
    const threads = got.item.threads.filter((t) => !unresolvedOnly || (t.resolvable && !t.resolved));
    return { source: 'live', dataAsOf: got.item.dataAsOf, threads };
  }

  async events(limit = 30, mrKey?: string): Promise<Freshness & { events: EventView[] }> {
    // DB-first: the events table is the durable source of truth even while the
    // app runs (same file). The live endpoint covers a missing/foreign DB.
    try {
      return this.withDb((db) => {
        const rows = db.recentEvents(Math.min(Math.max(limit, 1), 200), mrKey);
        return {
          source: 'db' as const,
          ...(rows[0] ? { dataAsOf: rows[0].at } : {}),
          events: rows.map((r) => {
            let payload: unknown = r.payload;
            try {
              payload = JSON.parse(r.payload);
            } catch {
              /* raw string for a malformed row */
            }
            return {
              id: r.id,
              at: r.at,
              type: r.type,
              mrKey: r.mr_key,
              ...(r.branch ? { branch: r.branch } : {}),
              ...(r.provider ? { provider: r.provider } : {}),
              notified: r.notified === 1,
              payload,
            };
          }),
        };
      });
    } catch (err) {
      if (!(err instanceof NoDataError)) throw err;
      const events = await this.api<EventView[]>(
        `events?limit=${Math.min(Math.max(limit, 1), 200)}${mrKey ? `&mr=${encodeURIComponent(mrKey)}` : ''}`,
      );
      return { source: 'live', events };
    }
  }

  async tickets(): Promise<Freshness & { tickets: JiraTicket[] }> {
    return this.withDb((db) => {
      const { tickets, fetchedAt } = db.cachedJiraTickets();
      return {
        source: 'db' as const,
        ...(fetchedAt ? { dataAsOf: fetchedAt } : {}),
        tickets,
      };
    });
  }

  // -- actions (live-only) -------------------------------------------------------

  async startRun(key: string): Promise<TriggerResult> {
    return this.api<TriggerResult>('start-run', {
      method: 'POST',
      body: { mrKey: key },
      timeoutMs: START_RUN_TIMEOUT_MS,
    });
  }

  async setPolling(enabled: boolean): Promise<{ enabled: boolean; changed: boolean }> {
    return this.api<{ enabled: boolean; changed: boolean }>('set-polling', {
      method: 'POST',
      body: { enabled },
    });
  }

  async pollNow(): Promise<{ ok: boolean }> {
    return this.api<{ ok: boolean }>('poll-now', { method: 'POST', body: {} });
  }
}

/** The offline item shape: DB scalars + best-effort history, nothing faked. */
export interface DbItemView extends MrRowView {
  recentEvents?: { at: string; type: string }[];
  triggeredRuns?: { startedAt: string; result: string | null; url: string }[];
}

const liveRow = (
  i: UiItem,
  section: Section,
  ticket: UiGroup['ticket'] | { status: string } | undefined,
): MrRowView => ({
  key: i.key,
  title: i.title,
  url: i.url,
  section,
  ...(ticket ? { ticket } : {}),
  branch: i.branch,
  targetBranch: i.targetBranch,
  reason: i.reason,
  ...(i.participation ? { participation: i.participation } : {}),
  draft: i.draft,
  conflicts: i.hasConflicts,
  unresolved: i.unresolved,
  commentCount: i.commentCount,
  ...(i.approvals ? { approvals: i.approvals } : {}),
  unread: i.unread,
  attention: i.attention,
  ci: i.ci,
  checks: i.checks,
  headSha: i.headSha,
  updatedAt: i.updatedAt,
  ...(i.dueDate ? { dueDate: i.dueDate } : {}),
  overdue: i.overdue,
});

const dbRow = (r: MrRow): MrRowView => ({
  key: r.key,
  title: r.title,
  url: r.web_url,
  ...(r.ticket_key
    ? { ticket: { key: r.ticket_key, ...(r.ticket_status ? { status: r.ticket_status } : {}) } }
    : {}),
  branch: r.branch,
  reason: r.reason,
  conflicts: r.has_conflicts === 1,
  unresolved: r.unresolved,
  commentCount: r.user_notes_count,
  ...(r.approvals_required !== null || r.approvals_left !== null
    ? {
        approvals: {
          ...(r.approvals_required !== null ? { required: r.approvals_required } : {}),
          ...(r.approvals_left !== null ? { left: r.approvals_left } : {}),
          by: r.approvals_by ? r.approvals_by.split(',').filter(Boolean) : [],
        },
      }
    : {}),
  headSha: r.head_sha,
  updatedAt: r.updated_at,
  lastSeenAt: r.last_seen_at,
  unavailableOffline: DB_LIST_UNAVAILABLE,
});

const matches = (row: MrRowView, filter: { section?: Section; ticket?: string }): boolean => {
  if (filter.section && row.section !== filter.section) return false;
  if (filter.ticket && row.ticket?.key?.toUpperCase() !== filter.ticket.toUpperCase()) return false;
  return true;
};
