import type { UiGroup } from './contract';

/**
 * How the list is ordered — the Sort dropdown's vocabulary.
 *
 * Pure, DOM-free and separate from renderer.ts so the ordering can be tested
 * directly: a no-MR group has no items to measure, so every mode needs a
 * deliberate stand-in and getting one wrong (a -Infinity that pins tickets to
 * the top) is invisible until it's on screen.
 */
export type SortMode = 'attention' | 'oldest' | 'active' | 'status' | 'comments' | 'hasMr';

/**
 * The 'hasMr' partition: everything with a merge request sorts above every
 * ticket without one. Attention ranks are 0–10, so this offset can't collide
 * with a real key — and adding the rank on top keeps each half ordered by
 * urgency rather than arbitrarily.
 */
const NO_MR_SORT_OFFSET = 1000;

const minBy = <T>(xs: T[], f: (x: T) => number): number =>
  xs.reduce((m, x) => Math.min(m, f(x)), Infinity);
const maxBy = <T>(xs: T[], f: (x: T) => number): number =>
  xs.reduce((m, x) => Math.max(m, f(x)), -Infinity);
const time = (iso: string): number => new Date(iso).getTime();

/** A comparable key per group for the chosen sort (ascending compare). */
export const groupSortKey = (g: UiGroup, mode: SortMode): number => {
  // A no-MR group has no items to measure. It stands in with the ticket's own
  // updated time and its attention rank, so it sorts *among* the real groups
  // rather than pinning to one end of every mode — except in 'hasMr', where
  // sinking below every MR is the whole point.
  if (g.noMr) {
    switch (mode) {
      case 'oldest':
        return time(g.noMr.updated);
      case 'active':
        return -time(g.noMr.updated);
      case 'status':
        return g.ticket ? g.ticket.statusRank : Number.MAX_SAFE_INTEGER;
      case 'comments':
        return 0; // no comments; MR groups sort negative by count, so this lands last
      case 'hasMr':
        return NO_MR_SORT_OFFSET + g.noMr.attention.rank;
      case 'attention':
      default:
        return g.noMr.attention.rank;
    }
  }
  switch (mode) {
    case 'oldest':
      return minBy(g.items, (i) => time(i.createdAt)); // oldest MR first
    case 'active':
      return -maxBy(g.items, (i) => time(i.updatedAt)); // most-recent first
    case 'status':
      return g.ticket ? g.ticket.statusRank : Number.MAX_SAFE_INTEGER; // ungrouped last
    case 'comments':
      return -maxBy(g.items, (i) => i.commentCount); // most comments first
    case 'hasMr': // has an MR: below the offset block, still urgent-first
    case 'attention':
    default:
      return minBy(g.items, (i) => i.attention.rank); // most urgent first
  }
};

/** Groups in display order, each group's own rows by urgency. Stable. */
export const sortedGroups = (groups: UiGroup[], mode: SortMode): UiGroup[] => {
  const withItems = groups.map((g) => ({
    ...g,
    items: [...g.items].sort((a, b) => a.attention.rank - b.attention.rank),
  }));
  return withItems
    .map((g, index) => ({ g, index, key: groupSortKey(g, mode) }))
    .sort((a, b) => a.key - b.key || a.index - b.index) // stable
    .map((x) => x.g);
};
