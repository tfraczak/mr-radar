import { fetchJsonWithRetries, HttpError } from '../retry';
import type { JiraTicket } from '../types';

/**
 * Jira is the only source reached over raw HTTP, so it's the only one needing a
 * credential. The token is supplied by the caller (from the macOS Keychain via
 * Electron safeStorage) and never persisted by this module.
 *
 * `baseUrl` is pinned in config and never taken from runtime input — same
 * posture as fixing the site server-side in a credential model, removing
 * the arbitrary-host token-leak surface.
 */
export class JiraSource {
  constructor(
    private readonly baseUrl: string,
    private readonly email: string,
    private readonly token: string,
  ) {
    if (!isPinnedHttpsOrigin(baseUrl)) {
      throw new Error(`jira baseUrl must be a bare https origin (no path/userinfo), got: ${baseUrl}`);
    }
  }

  get configured(): boolean {
    return Boolean(this.email && this.token);
  }

  private get headers(): Record<string, string> {
    const basic = Buffer.from(`${this.email}:${this.token}`).toString('base64');
    return {
      Authorization: `Basic ${basic}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  /** Liveness + credential check against `/myself` before anything else. */
  async verify(): Promise<{ ok: boolean; accountId?: string; error?: string }> {
    try {
      const me = await fetchJsonWithRetries<{ accountId: string }>(
        `${this.baseUrl}/rest/api/3/myself`,
        { headers: this.headers },
      );
      return { ok: true, accountId: me.accountId };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Search issues by JQL.
   *
   * Uses `/rest/api/3/search/jql`. The classic `/rest/api/3/search` endpoint was
   * removed by Atlassian (CHANGE-2046) and returns 410 — do not switch back.
   */
  async search(jql: string, maxResults = 100): Promise<JiraTicket[]> {
    const out: JiraTicket[] = [];
    let nextPageToken: string | undefined;

    do {
      const body: Record<string, unknown> = {
        jql,
        maxResults,
        fields: ['summary', 'status', 'updated', 'duedate', 'resolutiondate', 'fixVersions', 'issuetype'],
      };
      if (nextPageToken) body.nextPageToken = nextPageToken;

      const res = await fetchJsonWithRetries<JiraSearchResponse>(
        `${this.baseUrl}/rest/api/3/search/jql`,
        { method: 'POST', headers: this.headers, body: JSON.stringify(body) },
      );

      for (const issue of res.issues ?? []) {
        // Per-item guard so one malformed issue can't kill the cycle —
        // a page cap chosen for exactly this reason.
        try {
          out.push(this.toTicket(issue));
        } catch {
          continue;
        }
      }
      nextPageToken = res.nextPageToken;
    } while (nextPageToken && out.length < 500);

    return out;
  }

  /**
   * Fetch specific issues by key, regardless of status — used to learn the real
   * status of a non-active ticket behind an in-scope MR. `key IN (...)` needs no
   * assignee/watcher clause, so it works for tickets that aren't "yours".
   */
  /** Keys that recently resolved to nothing — don't re-ask Jira for a day. */
  private missingKeys = new Map<string, number>();
  private static readonly MISS_TTL_MS = 24 * 60 * 60 * 1000;

  async searchByKeys(keys: string[], countCall?: () => void): Promise<JiraTicket[]> {
    const now = Date.now();
    const unique = [...new Set(keys)].filter(Boolean).filter((k) => {
      const missedAt = this.missingKeys.get(k);
      return !missedAt || now - missedAt > JiraSource.MISS_TTL_MS;
    });
    if (unique.length === 0) return [];
    try {
      countCall?.();
      const found = await this.search(`key IN (${unique.join(', ')})`, 100);
      // A key the (successful) batch didn't return doesn't exist for us —
      // remember, so it can't poison future batches either.
      const returned = new Set(found.map((t) => t.key));
      for (const k of unique) if (!returned.has(k)) this.missingKeys.set(k, now);
      return found;
    } catch (err) {
      // Jira 400s the WHOLE `key IN (...)` when ANY key doesn't exist, and
      // extracted keys are guesses — one bogus guess must not lose the
      // harvest for every legitimate key. Retry per-key IN SMALL CHUNKS,
      // remembering misses. Anything but a 400 (outage, auth) surfaces to
      // the caller so source health reports it.
      if (!(err instanceof HttpError) || err.status !== 400 || unique.length === 1) throw err;
      const found: JiraTicket[] = [];
      for (let i = 0; i < unique.length; i += 5) {
        const chunk = unique.slice(i, i + 5);
        const results = await Promise.all(
          chunk.map(async (k) => {
            countCall?.();
            try {
              const r = await this.search(`key = ${k}`, 1);
              if (r.length === 0) this.missingKeys.set(k, now);
              return r;
            } catch {
              this.missingKeys.set(k, now); // nonexistent → 400 here too
              return [] as JiraTicket[];
            }
          }),
        );
        found.push(...results.flat());
      }
      return found;
    }
  }

  private toTicket(issue: JiraIssue): JiraTicket {
    const f = issue.fields ?? {};
    return {
      key: issue.key,
      summary: f.summary ?? '',
      status: f.status?.name ?? 'Unknown',
      updated: f.updated ?? '',
      url: `${this.baseUrl}/browse/${issue.key}`,
      ...(f.duedate ? { dueDate: f.duedate } : {}),
      ...(f.status?.statusCategory?.name ? { statusCategory: f.status.statusCategory.name } : {}),
      ...(f.resolutiondate ? { resolutionDate: f.resolutiondate } : {}),
      ...(f.issuetype?.name ? { issueType: f.issuetype.name } : {}),
      fixVersions: (f.fixVersions ?? []).flatMap((v) =>
        v.id && v.name ? [{ id: v.id, name: v.name }] : [],
      ),
    };
  }

  /**
   * The project's unreleased versions — the sensible candidates when assigning
   * a fix version to a Dev Complete ticket. Newest first.
   */
  async projectVersions(projectKey: string): Promise<{ id: string; name: string }[]> {
    if (!/^[A-Z][A-Z0-9]+$/.test(projectKey)) throw new Error(`bad project key: ${projectKey}`);
    const versions = await fetchJsonWithRetries<
      { id: string; name: string; released?: boolean; archived?: boolean }[]
    >(`${this.baseUrl}/rest/api/3/project/${projectKey}/versions`, { headers: this.headers });
    return versions
      .filter((v) => !v.released && !v.archived)
      .reverse()
      .map((v) => ({ id: v.id, name: v.name }));
  }

  /** Set (replace) the issue's fix version. The one write this app performs. */
  async setFixVersion(issueKey: string, versionId: string): Promise<void> {
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(issueKey)) throw new Error(`bad issue key: ${issueKey}`);
    if (!/^\d+$/.test(versionId)) throw new Error(`bad version id: ${versionId}`);
    const res = await fetch(`${this.baseUrl}/rest/api/3/issue/${issueKey}`, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({ update: { fixVersions: [{ set: [{ id: versionId }] }] } }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Jira rejected the fix version (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }
  }
}

interface JiraIssue {
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string; statusCategory?: { name?: string } };
    updated?: string;
    duedate?: string | null;
    resolutiondate?: string | null;
    issuetype?: { name?: string };
    fixVersions?: { id?: string; name?: string }[];
  };
}

interface JiraSearchResponse {
  issues?: JiraIssue[];
  nextPageToken?: string;
  isLast?: boolean;
}

/**
 * A bare `https://host[:port]` origin — no path, query, fragment, or userinfo.
 *
 * A plain regex like `^https://[^/]+$` is not enough: `[^/]+` also matches
 * `your-org.atlassian.net@evil.com`, which `fetch` treats as userinfo and would
 * send the Basic-auth token to `evil.com`. Parse with URL and reject anything
 * that isn't a clean origin, so the pinned-host SSRF posture actually holds.
 */
export const isPinnedHttpsOrigin = (value: string): boolean => {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' &&
    u.username === '' &&
    u.password === '' &&
    u.search === '' &&
    u.hash === '' &&
    (u.pathname === '' || u.pathname === '/') &&
    `https://${u.host}` === value.replace(/\/$/, '')
  );
};

/** A ticket key guessed out of free text, with how trustworthy it looks. */
export interface TicketKeyCandidate {
  key: string;
  /** True when the key appeared UPPERCASE in the source — the strong form. */
  confident: boolean;
}

const KEY_TOKEN = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]+)[-_](\d+)(?![A-Za-z0-9])/g;

/**
 * Every ticket-key-shaped token in a branch name, leftmost first. The simple
 * convention is the bare key (`ENG-126`), but real branches decorate it every
 * way imaginable — `feature/ENG-126`, `ENG-126-followup`,
 * `tf-eng-126-brief-descriptor`, `eng_126_fix`, `sprint-2-ENG-126` — so
 * matching is case-insensitive, treats `_` as `-`, and returns ALL candidates
 * (a decorative `sprint-2` ahead of the real key must not swallow it).
 * Explicit lookarounds instead of \b: underscore is a word character, so \b
 * can never fire next to it and `eng_126_fix` would silently miss.
 *
 * Callers bind candidates in order against a known ticket set; a wrong guess
 * binds nothing. Only the status-harvest path sends guesses to Jira itself —
 * see poll.ts, which filters on `confident` and known project prefixes there.
 */
export const ticketKeyCandidates = (branch: string): TicketKeyCandidate[] => {
  const byKey = new Map<string, TicketKeyCandidate>();
  for (const m of branch.matchAll(KEY_TOKEN)) {
    const key = `${m[1]!.toUpperCase()}-${m[2]}`;
    const confident = m[1] === m[1]!.toUpperCase();
    const existing = byKey.get(key);
    // A later uppercase occurrence upgrades an earlier lowercase one.
    if (existing) existing.confident ||= confident;
    else byKey.set(key, { key, confident }); // Map preserves leftmost order
  }
  return [...byKey.values()];
}

/** The leftmost branch candidate — display/simple-convention convenience. */
export const ticketKeyFromBranch = (branch: string): string | undefined =>
  ticketKeyCandidates(branch)[0]?.key;

/**
 * Fallback when the branch carries no bindable key: a key LEADING the MR
 * title ("ENG-129: Extend the flow", "[ENG-129] fix", "Draft: ENG-129: …",
 * or a bare "ENG-129"). Leading-position only, on purpose — a mid-sentence
 * mention ("extracted from ENG-126") must never cross-link the way Jira's
 * development panel does. GitLab literally prefixes draft titles with
 * "Draft: ", so that (and WIP:) is allowed before the key.
 */
export const titleKeyCandidate = (title: string): TicketKeyCandidate | undefined => {
  const m =
    /^\s*(?:(?:draft|wip)[:\s]\s*)?\[?([A-Za-z][A-Za-z0-9]+)[-_](\d+)\]?(?:\s*[:\-–—\s]|\s*$)/i.exec(title);
  if (!m) return undefined;
  return { key: `${m[1]!.toUpperCase()}-${m[2]}`, confident: m[1] === m[1]!.toUpperCase() };
}

export const ticketKeyFromTitle = (title: string): string | undefined =>
  titleKeyCandidate(title)?.key;
