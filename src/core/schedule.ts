import type { Config } from './config';

/**
 * When to poll next.
 *
 * Pure and side-effect free so the ladder is testable; the Electron main process
 * supplies the real power and session signals.
 *
 * The polling itself is cheap (~7 subprocess calls a cycle). What these rules
 * actually reduce is *wakeups* — and with an active-hours window, most of the
 * day costs nothing at all.
 */

export type PauseReason = 'user' | 'asleep' | 'locked' | 'off-hours';

export interface ScheduleState {
  enabled: boolean;
  /** Consecutive cycles that produced no events. */
  quietCycles: number;
  asleep: boolean;
  locked: boolean;
  onBattery: boolean;
}

export const INITIAL_STATE: ScheduleState = {
  enabled: true,
  quietCycles: 0,
  asleep: false,
  locked: false,
  onBattery: false,
};

/** Why polling is currently stopped, or undefined when it should run. */
export const pausedBecause = (
  state: ScheduleState,
  config: Config,
  now: Date,
): PauseReason | undefined => {
  if (!state.enabled) return 'user';
  if (state.asleep) return 'asleep';
  if (state.locked) return 'locked';
  if (!withinActiveHours(now, config)) return 'off-hours';
  return undefined;
}

/**
 * Seconds until the next cycle.
 *
 * Steps up the ladder after `quietCyclesBeforeBackoff` consecutive empty cycles
 * and resets to the base on any event — so an active review conversation polls
 * at 60s while an idle afternoon drifts out to 15 minutes.
 */
export const nextIntervalSeconds = (state: ScheduleState, config: Config): number => {
  const { baseSeconds, backoffSeconds, quietCyclesBeforeBackoff, slowOnBattery } = config.poll;
  if (!backoffSeconds.length) return baseSeconds;

  if (state.onBattery && slowOnBattery) {
    return backoffSeconds[backoffSeconds.length - 1] ?? baseSeconds;
  }
  if (state.quietCycles < quietCyclesBeforeBackoff) return baseSeconds;

  // One rung per additional quiet cycle beyond the threshold.
  const rung = Math.min(
    Math.floor((state.quietCycles - quietCyclesBeforeBackoff) / quietCyclesBeforeBackoff) + 1,
    backoffSeconds.length - 1,
  );
  return backoffSeconds[rung] ?? baseSeconds;
}

export const withinActiveHours = (now: Date, config: Config): boolean => {
  const window = config.poll.activeHours;
  if (!window) return true;
  if (window.days.length > 0 && !window.days.includes(now.getDay())) return false;

  const start = parseHhMm(window.start);
  const end = parseHhMm(window.end);
  if (start === undefined || end === undefined) return true;

  const minutes = now.getHours() * 60 + now.getMinutes();
  // A window like 22:00–06:00 wraps midnight.
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

const parseHhMm = (value: string): number | undefined => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return h * 60 + min;
}

/** Advance the quiet counter after a cycle. Any event resets the ladder. */
export const afterCycle = (state: ScheduleState, eventCount: number): ScheduleState => {
  return { ...state, quietCycles: eventCount > 0 ? 0 : state.quietCycles + 1 };
}

export const describePause = (reason: PauseReason): string => {
  switch (reason) {
    case 'user':
      return 'Paused';
    case 'asleep':
      return 'Paused — display asleep';
    case 'locked':
      return 'Paused — screen locked';
    case 'off-hours':
      return 'Paused — outside active hours';
  }
}
