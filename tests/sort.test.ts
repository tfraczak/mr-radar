import { describe, expect, it } from 'vitest';
import { groupSortKey, sortedGroups, type SortMode } from '../src/renderer/sort';
import type { UiGroup, UiItem } from '../src/renderer/contract';

const T0 = '2026-08-01T00:00:00Z';
const T1 = '2026-08-09T00:00:00Z';

const item = (over: Partial<UiItem> = {}): UiItem => ({
  key: 'acme/rocket!1',
  iid: 1,
  projectPath: 'acme/rocket',
  branch: 'ENG-1',
  targetBranch: 'main',
  title: 'MR',
  url: '#',
  headSha: 'sha',
  reason: 'authored',
  draft: false,
  hasConflicts: false,
  unresolved: 0,
  commentCount: 0,
  unread: false,
  createdAt: T0,
  updatedAt: T0,
  overdue: false,
  attention: { text: 'No action needed', tone: 'muted', rank: 10 },
  ci: { label: '—', tone: 'none', startable: false },
  checks: [],
  ...over,
});

const mrGroup = (key: string, rank: number, over: Partial<UiItem> = {}): UiGroup => ({
  ticket: { key, status: 'In Development', url: '#', statusRank: 3 },
  items: [item({ key: `acme/rocket!${key}`, attention: { text: 'x', tone: 'muted', rank }, ...over })],
});

const noMrGroup = (key: string, rank: number, updated = T0): UiGroup => ({
  ticket: { key, status: 'Code Review', url: '#', statusRank: 0 },
  items: [],
  noMr: {
    summary: `${key} summary`,
    updated,
    expected: rank < 5,
    attention: { text: 'No MR yet', tone: rank < 5 ? 'warn' : 'muted', rank },
  },
});

const order = (groups: UiGroup[], mode: SortMode): string[] =>
  sortedGroups(groups, mode).map((g) => g.ticket?.key ?? '(none)');

describe('no-MR groups within their own section', () => {
  it('orders by urgency: an expected MR above a merely-absent one', () => {
    // The section is homogeneous, so the default sort is what ranks it —
    // "expected at this status" (warn) has to come before "not started yet".
    const groups = [noMrGroup('ENG-9', 9), noMrGroup('ENG-3', 2), noMrGroup('ENG-8', 9)];
    expect(order(groups, 'attention')).toEqual(['ENG-3', 'ENG-9', 'ENG-8']);
  });

  it('is stable for equal keys', () => {
    const groups = [noMrGroup('ENG-9', 9), noMrGroup('ENG-8', 9), noMrGroup('ENG-7', 9)];
    expect(order(groups, 'attention')).toEqual(['ENG-9', 'ENG-8', 'ENG-7']);
  });
});

describe('no-MR groups in the other sorts', () => {
  it('never pin to an end for want of items', () => {
    // Every mode must give an itemless group a real stand-in key: a bare
    // minBy/maxBy over [] yields ±Infinity, which would nail these rows to the
    // top or bottom of every list regardless of what they say.
    for (const mode of ['attention', 'oldest', 'active', 'status', 'comments'] as SortMode[]) {
      const key = groupSortKey(noMrGroup('ENG-1', 9), mode);
      expect(Number.isFinite(key), `${mode} produced ${key}`).toBe(true);
    }
  });

  it('sorts by the ticket updated time in the time-based modes', () => {
    const groups = [noMrGroup('ENG-old', 9, T0), noMrGroup('ENG-new', 9, T1)];
    expect(order(groups, 'oldest')).toEqual(['ENG-old', 'ENG-new']);
    expect(order(groups, 'active')).toEqual(['ENG-new', 'ENG-old']);
  });

  it('sorts by workflow rank under the status sort, like any group', () => {
    // Code Review (0) outranks In Development (3).
    const groups = [noMrGroup('ENG-1', 9), { ...noMrGroup('ENG-2', 9), ticket: { key: 'ENG-2', status: 'In Development', url: '#', statusRank: 3 } }];
    expect(order(groups, 'status')).toEqual(['ENG-1', 'ENG-2']);
  });
});

describe('MR groups', () => {
  it('order by their most urgent row, and rows by urgency within a group', () => {
    const busy: UiGroup = {
      ticket: { key: 'ENG-1', status: 'In Development', url: '#', statusRank: 3 },
      items: [
        item({ key: 'a', attention: { text: 'calm', tone: 'muted', rank: 9 } }),
        item({ key: 'b', attention: { text: 'urgent', tone: 'bad', rank: 0 } }),
      ],
    };
    const calm = mrGroup('ENG-2', 5);
    const sorted = sortedGroups([calm, busy], 'attention');
    expect(sorted.map((g) => g.ticket?.key)).toEqual(['ENG-1', 'ENG-2']);
    expect(sorted[0]?.items.map((i) => i.key)).toEqual(['b', 'a']); // rows re-ordered too
  });
});
