import type { Config } from './config';
import { resolveMrRules } from './rules';
import type { JiraTicket, WatchItem } from './types';

/**
 * Active tickets with no merge request.
 *
 * Every other row in this app starts from an MR, which makes one state
 * structurally invisible: a ticket that is assigned to you, in flight, and has
 * no branch pushed yet. Nothing is wrong with the correlation — there is simply
 * nothing to correlate — so the ticket has to be surfaced from the Jira side.
 *
 * Pure and Electron-free: the poller, the tray, and the tests all share it.
 */

/**
 * How loudly a missing MR should read:
 *  - `expected` — an MR is supposed to exist by now (warn);
 *  - `optional` — normal for this status, just don't let it vanish (muted);
 *  - `exempt`   — a rule says this ticket never needs one; show nothing.
 */
export type MrExpectation = 'expected' | 'optional' | 'exempt';

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export const mrExpectation = (
  ticket: JiraTicket,
  noMr: Config['noMr'],
  now: Date,
): MrExpectation => {
  // Rules first, so an exemption ("spikes and data fixes never need an MR")
  // beats the blunt status list.
  const ruled = resolveMrRules(noMr.rules ?? [], ticket, now);
  if (ruled === 'exempt') return 'exempt';
  if (ruled === 'expect') return 'expected';
  return (noMr.expectStatuses ?? []).some((s) => eq(s, ticket.status)) ? 'expected' : 'optional';
};

export interface MissingMr {
  ticket: JiraTicket;
  /** True when an MR was expected at this point — the row warns rather than informs. */
  expected: boolean;
}

/**
 * Active tickets that no known MR is attached to.
 *
 * Two deliberate choices:
 *  - it consults **every** MR the radar knows, not just the in-scope or visible
 *    ones. An MR that exists but is filtered out of view still means the ticket
 *    is not MR-less, and claiming otherwise would be the worse error.
 *  - statuses routed to Verification / Done / hidden are skipped. Those are the
 *    statuses a ticket reaches *after* its MR merged, and merged MRs leave the
 *    radar — so "no MR" there is almost always a merge, not a gap.
 */
export const ticketsMissingMrs = (args: {
  tickets: JiraTicket[];
  items: Pick<WatchItem, 'ticket'>[];
  noMr: Config['noMr'];
  sections: Config['statusSections'];
  now: Date;
}): MissingMr[] => {
  const { tickets, items, noMr, sections, now } = args;
  if (!noMr.enabled) return [];

  const withMr = new Set(items.map((i) => i.ticket?.key.toLowerCase()).filter(Boolean));
  const postDev = new Set(
    [...sections.hidden, ...sections.verification, ...sections.done].map((s) => s.toLowerCase()),
  );

  const out: MissingMr[] = [];
  const seen = new Set<string>();
  for (const ticket of tickets) {
    const key = ticket.key.toLowerCase();
    if (seen.has(key) || withMr.has(key)) continue;
    seen.add(key);
    // A resolved ticket is finished work, whatever its status name says.
    if (ticket.statusCategory === 'Done') continue;
    if (postDev.has(ticket.status.toLowerCase())) continue;
    const expectation = mrExpectation(ticket, noMr, now);
    if (expectation === 'exempt') continue;
    out.push({ ticket, expected: expectation === 'expected' });
  }
  return out;
};
