import { describe, expect, it } from 'vitest';
import { correlate, detailsChanged, inScope, projectPathOf, summarizeThreads } from '../src/core/correlate';
import { ticketKeyFromBranch } from '../src/core/sources/jira';
import type { GitlabDiscussion, GitlabMr, JiraTicket } from '../src/core/types';

const fullMr = (iid: number, over: Partial<GitlabMr> = {}): GitlabMr =>
  ({
    id: iid,
    iid,
    project_id: 1,
    title: `MR ${iid}`,
    state: 'opened',
    sha: `sha${iid}`,
    source_branch: `ENG-${iid}`,
    target_branch: 'main',
    web_url: '#',
    updated_at: '2026-07-29T00:00:00Z',
    created_at: '2026-07-29T00:00:00Z',
    user_notes_count: 0,
    draft: false,
    has_conflicts: false,
    author: { id: 9, username: 'other', name: 'Other' },
    references: { full: `acme/rocket!${iid}` },
    ...over,
  }) as GitlabMr;

describe('correlate reason precedence', () => {
  const args = { activeTickets: [], recentDaysFallback: 0, now: new Date('2026-07-29T12:00:00Z') };

  it('labels commented-on MRs as participating/commented and keeps them in scope', () => {
    const items = correlate({ authored: [], reviewer: [], commented: [fullMr(7591)], ...args });
    expect(items).toHaveLength(1);
    expect(items[0]?.reason).toBe('participating');
    expect(items[0]?.participation).toBe('commented');
    expect(items[0]?.inScope).toBe(true);
  });

  it('labels mentioned MRs as participating/mentioned', () => {
    const items = correlate({ authored: [], reviewer: [], mentioned: [fullMr(7700)], ...args });
    expect(items[0]?.reason).toBe('participating');
    expect(items[0]?.participation).toBe('mentioned');
  });

  it('authored > reviewer > commented > mentioned', () => {
    const mr = fullMr(1);
    const cm = correlate({ authored: [], reviewer: [], commented: [mr], mentioned: [mr], ...args });
    expect(cm[0]?.participation).toBe('commented'); // engagement beats a ping
    const rc = correlate({ authored: [], reviewer: [mr], commented: [mr], mentioned: [mr], ...args });
    expect(rc[0]?.reason).toBe('reviewer');
    const all = correlate({ authored: [mr], reviewer: [mr], commented: [mr], mentioned: [mr], ...args });
    expect(all[0]?.reason).toBe('authored');
    expect(all).toHaveLength(1);
  });
});

describe('ticketKeyFromBranch', () => {
  it('reads a bare ticket key', () => {
    expect(ticketKeyFromBranch('ENG-126')).toBe('ENG-126');
    expect(ticketKeyFromBranch('APP-19615')).toBe('APP-19615');
  });
  it('extracts a key embedded in a decorated branch', () => {
    expect(ticketKeyFromBranch('feature/ENG-126-followup')).toBe('ENG-126');
  });
  it('returns undefined when there is no key', () => {
    expect(ticketKeyFromBranch('main')).toBeUndefined();
    expect(ticketKeyFromBranch('hotfix-login')).toBeUndefined();
  });
});

describe('inScope', () => {
  const now = new Date('2026-07-29T12:00:00Z');
  const ticket: JiraTicket = { key: 'ENG-1', summary: '', status: 'Code Review', updated: '', url: '' };

  it('always includes review requests', () => {
    expect(inScope({ reason: 'reviewer', updatedAt: '2020-01-01', recentDaysFallback: 0, now })).toBe(true);
  });
  it('always includes participating MRs — the events window already bounds them', () => {
    expect(inScope({ reason: 'participating', updatedAt: '2020-01-01', recentDaysFallback: 0, now })).toBe(true);
  });
  it('includes authored MRs with an active ticket', () => {
    expect(inScope({ reason: 'authored', ticket, updatedAt: '2020-01-01', recentDaysFallback: 0, now })).toBe(true);
  });
  it('excludes authored MRs without a ticket when no recency fallback', () => {
    expect(inScope({ reason: 'authored', updatedAt: '2020-01-01', recentDaysFallback: 0, now })).toBe(false);
  });
  it('includes recently-updated authored MRs within the fallback window', () => {
    const recent = new Date(now.getTime() - 3 * 86_400_000).toISOString();
    expect(inScope({ reason: 'authored', updatedAt: recent, recentDaysFallback: 14, now })).toBe(true);
    const old = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    expect(inScope({ reason: 'authored', updatedAt: old, recentDaysFallback: 14, now })).toBe(false);
  });
});

describe('projectPathOf', () => {
  it('takes the path from references.full', () => {
    const mr = { references: { full: 'acme/rocket!7576' }, web_url: '' } as GitlabMr;
    expect(projectPathOf(mr)).toBe('acme/rocket');
  });
  it('falls back to parsing the web_url', () => {
    const mr = {
      references: { full: '' },
      web_url: 'https://gitlab.com/acme/gadget/-/merge_requests/320',
    } as unknown as GitlabMr;
    expect(projectPathOf(mr)).toBe('acme/gadget');
  });
});

describe('summarizeThreads', () => {
  const note = (id: number, system: boolean, over: Record<string, unknown> = {}) => ({
    id,
    body: system ? 'changed the description' : 'please fix',
    author: { id: 1, username: 'someone', name: 'Someone' },
    created_at: '2026-07-01',
    updated_at: '2026-07-01',
    system,
    resolvable: !system,
    ...over,
  });

  it('drops threads that are only system notes', () => {
    const discussions: GitlabDiscussion[] = [
      { id: 'd1', individual_note: true, notes: [note(1, true)] },
      { id: 'd2', individual_note: false, notes: [note(2, false)] },
    ];
    const threads = summarizeThreads(discussions);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe('d2');
  });

  it('carries resolution state and diff position', () => {
    const discussions: GitlabDiscussion[] = [
      {
        id: 'd1',
        individual_note: false,
        notes: [note(1, false, { resolvable: true, resolved: true, position: { new_path: 'a.rb', new_line: 5 } })],
      },
    ];
    const [t] = summarizeThreads(discussions);
    expect(t?.resolved).toBe(true);
    expect(t?.filePath).toBe('a.rb');
    expect(t?.line).toBe(5);
  });
});

describe('detailsChanged', () => {
  it('is true for a never-seen MR', () => {
    expect(detailsChanged(undefined, { updatedAt: 'x', userNotesCount: 0 })).toBe(true);
  });
  it('is true when updated_at or note count moved', () => {
    const prev = { updated_at: 'a', user_notes_count: 1 };
    expect(detailsChanged(prev, { updatedAt: 'b', userNotesCount: 1 })).toBe(true);
    expect(detailsChanged(prev, { updatedAt: 'a', userNotesCount: 2 })).toBe(true);
  });
  it('is false when nothing moved', () => {
    const prev = { updated_at: 'a', user_notes_count: 1 };
    expect(detailsChanged(prev, { updatedAt: 'a', userNotesCount: 1 })).toBe(false);
  });
});
