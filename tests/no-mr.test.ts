import { describe, expect, it } from 'vitest';
import { ANY_STATUS, DEFAULT_CONFIG, type Config } from '../src/core/config';
import { mrExpectation, ticketsMissingMrs } from '../src/core/no-mr';
import type { JiraTicket, WatchItem } from '../src/core/types';

const NOW = new Date('2026-08-10T12:00:00Z');

const ticket = (key: string, status: string, over: Partial<JiraTicket> = {}): JiraTicket => ({
  key,
  summary: `${key} summary`,
  status,
  updated: NOW.toISOString(),
  url: `https://jira.example.com/browse/${key}`,
  ...over,
});

/** Only the field ticketsMissingMrs reads, so tests stay honest about the input. */
const withTicket = (t: JiraTicket): Pick<WatchItem, 'ticket'> => ({ ticket: t });

const SECTIONS: Config['statusSections'] = {
  hidden: ['Backlog'],
  verification: ['In QA'],
  done: ['Closed'],
};

const noMrConfig = (over: Partial<Config['noMr']> = {}): Config['noMr'] => ({
  ...DEFAULT_CONFIG.noMr,
  ...over,
});

const missing = (args: {
  tickets: JiraTicket[];
  items?: Pick<WatchItem, 'ticket'>[];
  noMr?: Partial<Config['noMr']>;
}) =>
  ticketsMissingMrs({
    tickets: args.tickets,
    items: args.items ?? [],
    noMr: noMrConfig(args.noMr),
    sections: SECTIONS,
    now: NOW,
  });

describe('ticketsMissingMrs', () => {
  it('reports an active ticket with no MR', () => {
    const rows = missing({ tickets: [ticket('ENG-1', 'In Development')] });
    expect(rows.map((r) => r.ticket.key)).toEqual(['ENG-1']);
    expect(rows[0]?.expected).toBe(false); // In Development is not an expect status
  });

  it('warns at the statuses where an MR is expected, case-insensitively', () => {
    const rows = missing({
      tickets: [ticket('ENG-1', 'code review')],
      noMr: { expectStatuses: ['Code Review'] },
    });
    expect(rows[0]?.expected).toBe(true);
  });

  it('says nothing about a ticket that already has an MR', () => {
    const t = ticket('ENG-1', 'In Development');
    expect(missing({ tickets: [t], items: [withTicket(t)] })).toEqual([]);
  });

  it('matches an existing MR regardless of key casing', () => {
    const t = ticket('ENG-1', 'In Development');
    const lower = withTicket({ ...t, key: 'eng-1' });
    expect(missing({ tickets: [t], items: [lower] })).toEqual([]);
  });

  it('counts an MR that is filtered out of view — it still exists', () => {
    // The caller passes every known item, including ones the UI hides. A
    // hidden MR must never read as a missing MR.
    const t = ticket('ENG-1', 'In Development');
    expect(missing({ tickets: [t], items: [{ ticket: t }] })).toEqual([]);
  });

  it('skips post-development statuses, where a missing MR means it merged', () => {
    const rows = missing({
      tickets: [ticket('ENG-1', 'In QA'), ticket('ENG-2', 'Closed'), ticket('ENG-3', 'Backlog')],
    });
    expect(rows).toEqual([]);
  });

  it('skips resolved tickets whatever their status is called', () => {
    const rows = missing({
      tickets: [ticket('ENG-1', 'In Development', { statusCategory: 'Done' })],
    });
    expect(rows).toEqual([]);
  });

  it('is off entirely when disabled', () => {
    const rows = missing({ tickets: [ticket('ENG-1', 'Code Review')], noMr: { enabled: false } });
    expect(rows).toEqual([]);
  });

  it('dedupes repeated ticket keys', () => {
    const rows = missing({ tickets: [ticket('ENG-1', 'Code Review'), ticket('ENG-1', 'Code Review')] });
    expect(rows).toHaveLength(1);
  });

  it('honours an exempting rule', () => {
    const rows = missing({
      tickets: [ticket('ENG-1', 'In Development', { issueType: 'Spike' })],
      noMr: {
        rules: [{ status: ANY_STATUS, field: 'issueType', op: 'matches', value: 'spike', then: 'exempt' }],
      },
    });
    expect(rows).toEqual([]);
  });

  it('lets a rule expect an MR at a status the list does not cover', () => {
    const rows = missing({
      tickets: [ticket('ENG-1', 'In Development', { issueType: 'Story' })],
      noMr: {
        expectStatuses: [],
        rules: [{ status: 'In Development', field: 'issueType', op: 'matches', value: 'story', then: 'expect' }],
      },
    });
    expect(rows[0]?.expected).toBe(true);
  });
});

describe('mrExpectation', () => {
  const t = ticket('ENG-1', 'Code Review', { issueType: 'Data Fix' });

  it('lets a rule exemption beat the expect-status list', () => {
    const cfg = noMrConfig({
      expectStatuses: ['Code Review'],
      rules: [{ status: ANY_STATUS, field: 'issueType', op: 'matches', value: 'data ?fix', then: 'exempt' }],
    });
    expect(mrExpectation(t, cfg, NOW)).toBe('exempt');
  });

  it('falls through a non-matching rule to the status list', () => {
    const cfg = noMrConfig({
      expectStatuses: ['Code Review'],
      rules: [{ status: ANY_STATUS, field: 'issueType', op: 'matches', value: 'spike', then: 'exempt' }],
    });
    expect(mrExpectation(t, cfg, NOW)).toBe('expected');
  });

  it("treats a rule's else branch as a decision", () => {
    const cfg = noMrConfig({
      expectStatuses: ['Code Review'],
      rules: [{ status: 'Code Review', field: 'issueType', op: 'matches', value: 'spike', then: 'expect', else: 'exempt' }],
    });
    expect(mrExpectation(t, cfg, NOW)).toBe('exempt');
  });

  it('is optional when no rule and no status applies', () => {
    const cfg = noMrConfig({ expectStatuses: ['Dev Complete'], rules: [] });
    expect(mrExpectation(t, cfg, NOW)).toBe('optional');
  });

  it('reads the default config as: rows for everything, warnings at Code Review', () => {
    expect(mrExpectation(ticket('ENG-1', 'Code Review'), DEFAULT_CONFIG.noMr, NOW)).toBe('expected');
    expect(mrExpectation(ticket('ENG-2', 'In Development'), DEFAULT_CONFIG.noMr, NOW)).toBe('optional');
  });
});
