import { fetchJsonWithRetries } from '../retry';
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
  async searchByKeys(keys: string[]): Promise<JiraTicket[]> {
    const unique = [...new Set(keys)].filter(Boolean);
    if (unique.length === 0) return [];
    const jql = `key IN (${unique.join(', ')})`;
    return this.search(jql, 100);
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

/** Branch names are exactly the ticket key, e.g. `ENG-126`, `APP-19615`. */
const TICKET_KEY = /^([A-Z][A-Z0-9]+)-(\d+)$/;

export const ticketKeyFromBranch = (branch: string): string | undefined => {
  const direct = TICKET_KEY.exec(branch.trim());
  if (direct) return direct[0];
  // Tolerate decorated branches (`ENG-126-followup`, `feature/ENG-126`) even
  // though the convention here is a bare key.
  const embedded = /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(branch);
  return embedded?.[1];
}
