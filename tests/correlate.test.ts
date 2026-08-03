import { describe, expect, it } from 'vitest';
import { correlate, detailsChanged, inScope, projectPathOf, summarizeThreads } from '../src/core/correlate';
import { ticketKeyFromBranch } from '../src/core/sources/jira';
import type { ForgeDiscussion, ForgeMr, JiraTicket } from '../src/core/types';

const fullMr = (iid: number, over: Partial<ForgeMr> = {}): ForgeMr =>
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
  }) as ForgeMr;

import { ticketKeyCandidates, ticketKeyFromBranch, ticketKeyFromTitle, titleKeyCandidate } from '../src/core/sources/jira';

import { titleBranch } from '../src/core/sources/rwx';

describe('rwx run title attribution', () => {
  it('parses the branch VERBATIM from the trigger convention', () => {
    expect(titleBranch('ENG-132 - mira.dev@acme.com')).toBe('ENG-132');
    expect(titleBranch('tf-eng-126-fix - mira.dev@acme.com')).toBe('tf-eng-126-fix');
    expect(titleBranch('feature/ENG-126 - mira.dev@acme.com')).toBe('feature/ENG-126');
    expect(titleBranch('Nightly regression sweep')).toBeUndefined();
    expect(titleBranch('fix things - not an email')).toBeUndefined();
    // The app's own legacy no-jira-email tail must still attribute.
    expect(titleBranch('ENG-132 - mr-radar')).toBe('ENG-132');
    expect(titleBranch('tf-eng-126-fix - mr-radar@local')).toBe('tf-eng-126-fix');
  });
});

describe('ticket key extraction', () => {
  it('tolerates every real-world branch decoration', () => {
    expect(ticketKeyFromBranch('ENG-126')).toBe('ENG-126');
    expect(ticketKeyFromBranch('feature/ENG-126')).toBe('ENG-126');
    expect(ticketKeyFromBranch('ENG-126-followup')).toBe('ENG-126');
    expect(ticketKeyFromBranch('tf-eng-126-brief-descriptor')).toBe('ENG-126');
    expect(ticketKeyFromBranch('eng_126_fix')).toBe('ENG-126');
    expect(ticketKeyFromBranch('main')).toBeUndefined();
    expect(ticketKeyFromBranch('release-26-32')).toBe('RELEASE-26'); // guess: gated before Jira
  });

  it('returns ALL candidates so decorative tokens cannot swallow the real key', () => {
    expect(ticketKeyCandidates('sprint-2-ENG-126').map((c) => c.key)).toEqual(['SPRINT-2', 'ENG-126']);
    expect(ticketKeyCandidates('issue-123-ENG-126-fix').map((c) => c.key)).toEqual(['ISSUE-123', 'ENG-126']);
    // Confidence marks the uppercase (strong) form for harvest gating.
    expect(ticketKeyCandidates('sprint-2-ENG-126').map((c) => c.confident)).toEqual([false, true]);
    // A later uppercase occurrence upgrades an earlier lowercase duplicate.
    expect(ticketKeyCandidates('eng-126-backport-of-ENG-126')).toEqual([
      { key: 'ENG-126', confident: true },
    ]);
  });

  it('title keys must LEAD the title — mid-sentence mentions never link', () => {
    expect(ticketKeyFromTitle('ENG-129: Extend the flow')).toBe('ENG-129');
    expect(ticketKeyFromTitle('[ENG-129] Extend the flow')).toBe('ENG-129');
    expect(ticketKeyFromTitle('  eng_129 - fix')).toBe('ENG-129');
    expect(ticketKeyFromTitle('Extend the flow extracted from ENG-126')).toBeUndefined();
    expect(ticketKeyFromTitle('Fix the widget')).toBeUndefined();
  });

  it('draft prefixes and bare-key titles still lead', () => {
    expect(ticketKeyFromTitle('Draft: ENG-129: fix login')).toBe('ENG-129');
    expect(ticketKeyFromTitle('WIP: eng_129 fix')).toBe('ENG-129');
    expect(ticketKeyFromTitle('ENG-129')).toBe('ENG-129');
    expect(ticketKeyFromTitle('[ENG-129]')).toBe('ENG-129');
    expect(ticketKeyFromTitle('Draft: fix login for ENG-129')).toBeUndefined();
    expect(titleKeyCandidate('eng-129: x')?.confident).toBe(false);
  });
});

describe('candidate binding', () => {
  const eng126 = { key: 'ENG-126', summary: '', status: 'In Development', updated: '', url: '#' };

  it('a decorative token ahead of the real key still binds the active ticket', () => {
    const mr = fullMr(7, { source_branch: 'sprint-2-ENG-126' });
    const items = correlate({
      authored: [mr],
      reviewer: [],
      activeTickets: [eng126],
      recentDaysFallback: 0,
      now: new Date('2026-08-01T12:00:00Z'),
    });
    expect(items[0]?.ticket?.key).toBe('ENG-126');
  });

  it('title leading key binds when the branch has no bindable key', () => {
    const mr = fullMr(8, { source_branch: 'quick-fix', title: 'ENG-126: patch the widget' });
    const items = correlate({
      authored: [mr],
      reviewer: [],
      activeTickets: [eng126],
      recentDaysFallback: 0,
      now: new Date('2026-08-01T12:00:00Z'),
    });
    expect(items[0]?.ticket?.key).toBe('ENG-126');
  });
});

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
    const mr = { references: { full: 'acme/rocket!7576' }, web_url: '' } as ForgeMr;
    expect(projectPathOf(mr)).toBe('acme/rocket');
  });
  it('falls back to parsing the web_url', () => {
    const mr = {
      references: { full: '' },
      web_url: 'https://gitlab.com/acme/gadget/-/merge_requests/320',
    } as unknown as ForgeMr;
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
    const discussions: ForgeDiscussion[] = [
      { id: 'd1', individual_note: true, notes: [note(1, true)] },
      { id: 'd2', individual_note: false, notes: [note(2, false)] },
    ];
    const threads = summarizeThreads(discussions);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe('d2');
  });

  it('carries resolution state and diff position', () => {
    const discussions: ForgeDiscussion[] = [
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
