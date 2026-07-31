import { describe, expect, it } from 'vitest';
import { isPinnedHttpsOrigin } from '../src/core/sources/jira';
import { Db } from '../src/core/db';

describe('isPinnedHttpsOrigin (S4 — SSRF/token-leak guard)', () => {
  it('accepts a bare https origin', () => {
    expect(isPinnedHttpsOrigin('https://acme.atlassian.net')).toBe(true);
    expect(isPinnedHttpsOrigin('https://host:8443')).toBe(true);
  });
  it('rejects userinfo that would redirect the Basic-auth token', () => {
    // `[^/]+` in the old regex matched this; fetch would send creds to evil.com.
    expect(isPinnedHttpsOrigin('https://acme.atlassian.net@evil.com')).toBe(false);
    expect(isPinnedHttpsOrigin('https://user:pass@host')).toBe(false);
  });
  it('rejects non-https, paths, queries, and fragments', () => {
    expect(isPinnedHttpsOrigin('http://host')).toBe(false);
    expect(isPinnedHttpsOrigin('https://host/wiki')).toBe(false);
    expect(isPinnedHttpsOrigin('https://host?x=1')).toBe(false);
    expect(isPinnedHttpsOrigin('https://host#f')).toBe(false);
    expect(isPinnedHttpsOrigin('not a url')).toBe(false);
  });
});

describe('retentionSweep (P3 — bound unbounded tables)', () => {
  it('drops rows older than the retention window, keeps recent ones', () => {
    const db = new Db(':memory:');
    const old = '2020-01-01T00:00:00.000Z';
    const recent = '2026-07-30T12:00:00.000Z';

    db.recordEvents(
      [{ type: 'unmergeable', mrKey: 'p!1', mrTitle: 't', branch: 'b', url: '#' }],
      old,
      true,
    );
    db.recordEvents(
      [{ type: 'unmergeable', mrKey: 'p!2', mrTitle: 't', branch: 'b', url: '#' }],
      recent,
      true,
    );
    db.markNotified('suggest_run', 'k-old', old);
    db.markNotified('suggest_run', 'k-new', recent);

    const removed = db.retentionSweep('2026-07-30T12:00:00.000Z', 30);
    expect(removed).toBeGreaterThanOrEqual(2); // the two old rows
    const types = db.recentEvents(10);
    expect(types).toHaveLength(1); // only the recent event survives
    expect(db.wasNotified('suggest_run', 'k-old')).toBe(false);
    expect(db.wasNotified('suggest_run', 'k-new')).toBe(true);
    db.close();
  });
});
