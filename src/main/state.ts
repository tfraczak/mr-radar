import type { AppEvent, Snapshot } from '../core/types';
import type { PauseReason, ScheduleState } from '../core/schedule';
import { INITIAL_STATE } from '../core/schedule';

// The popover view-model lives on the renderer side (its IPC contract). Re-export
// so main-process modules can keep importing these from './state'.
export type { UiSnapshot, UiGroup, UiItem, UiStatusGroup, Attention } from '../renderer/contract';

/**
 * The main process's live view, shared with the popover over IPC.
 *
 * Kept separate from the SQLite layer: the DB is the durable record, this is
 * what's on screen right now (including things not worth persisting, like which
 * items are unread and why polling is currently paused).
 */
export interface UiState {
  snapshot?: Snapshot | undefined;
  /** Events not yet acknowledged, newest first. Drives the tray badge. */
  unread: AppEvent[];
  schedule: ScheduleState;
  pausedReason?: PauseReason | undefined;
  lastPollAt?: string | undefined;
  lastError?: string | undefined;
  polling: boolean;
  nextPollAt?: string | undefined;
  /** Row to flash in the popover (notification click-through). `at` dedupes. */
  highlight?: { key: string; at: string } | undefined;
  /** Whether a Jira token is stored; drives the in-app connect field. */
  jiraConfigured: boolean;
  jiraEmail?: string | undefined;
}

export const initialUiState = (): UiState => {
  return { unread: [], schedule: { ...INITIAL_STATE }, polling: false, jiraConfigured: false };
}

/** Keep only the newest event per (MR, type) so the badge tracks items, not noise. */
export const dedupeUnread = (events: AppEvent[]): AppEvent[] => {
  const seen = new Set<string>();
  const out: AppEvent[] = [];
  for (const e of events) {
    const key = `${e.mrKey}|${e.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.slice(0, 200);
}
