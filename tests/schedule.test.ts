import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/core/config';
import {
  INITIAL_STATE,
  afterCycle,
  nextIntervalSeconds,
  pausedBecause,
  withinActiveHours,
  type ScheduleState,
} from '../src/core/schedule';

const cfg = (over: Partial<Config['poll']> = {}): Config => ({
  ...DEFAULT_CONFIG,
  poll: { ...DEFAULT_CONFIG.poll, ...over },
});

const state = (over: Partial<ScheduleState> = {}): ScheduleState => ({ ...INITIAL_STATE, ...over });

describe('nextIntervalSeconds', () => {
  it('polls at the base rate while active', () => {
    expect(nextIntervalSeconds(state({ quietCycles: 0 }), cfg())).toBe(60);
  });

  it('steps up the backoff ladder after enough quiet cycles', () => {
    const c = cfg({ baseSeconds: 60, backoffSeconds: [60, 120, 300, 900], quietCyclesBeforeBackoff: 3 });
    expect(nextIntervalSeconds(state({ quietCycles: 2 }), c)).toBe(60); // still base
    expect(nextIntervalSeconds(state({ quietCycles: 3 }), c)).toBe(120); // first rung
    expect(nextIntervalSeconds(state({ quietCycles: 99 }), c)).toBe(900); // capped at last rung
  });

  it('holds at the slowest tier on battery when configured', () => {
    const c = cfg({ slowOnBattery: true, backoffSeconds: [60, 120, 900] });
    expect(nextIntervalSeconds(state({ onBattery: true, quietCycles: 0 }), c)).toBe(900);
  });
});

describe('afterCycle', () => {
  it('resets the quiet counter when there were events', () => {
    expect(afterCycle(state({ quietCycles: 5 }), 2).quietCycles).toBe(0);
  });
  it('increments the quiet counter when there were none', () => {
    expect(afterCycle(state({ quietCycles: 5 }), 0).quietCycles).toBe(6);
  });
});

describe('pausedBecause', () => {
  const now = new Date('2026-07-29T12:00:00'); // a Wednesday noon, local
  it('is undefined when enabled and awake and unlocked', () => {
    expect(pausedBecause(state(), cfg(), now)).toBeUndefined();
  });
  it('reports user / asleep / locked in priority order', () => {
    expect(pausedBecause(state({ enabled: false }), cfg(), now)).toBe('user');
    expect(pausedBecause(state({ asleep: true }), cfg(), now)).toBe('asleep');
    expect(pausedBecause(state({ locked: true }), cfg(), now)).toBe('locked');
  });
  it('reports off-hours outside the active window', () => {
    const c = cfg({ activeHours: { days: [1, 2, 3, 4, 5], start: '08:00', end: '19:00' } });
    expect(pausedBecause(state(), c, new Date('2026-07-29T21:00:00'))).toBe('off-hours');
    expect(pausedBecause(state(), c, new Date('2026-07-29T10:00:00'))).toBeUndefined();
  });
});

describe('withinActiveHours', () => {
  it('is always active with no window configured', () => {
    expect(withinActiveHours(new Date('2026-07-29T03:00:00'), cfg())).toBe(true);
  });
  it('respects a daytime window and the configured days', () => {
    const c = cfg({ activeHours: { days: [1, 2, 3, 4, 5], start: '08:00', end: '19:00' } });
    expect(withinActiveHours(new Date('2026-07-29T09:00:00'), c)).toBe(true); // Wed 9am
    expect(withinActiveHours(new Date('2026-07-29T19:30:00'), c)).toBe(false); // after end
    expect(withinActiveHours(new Date('2026-08-01T12:00:00'), c)).toBe(false); // Saturday
  });
  it('handles a window that wraps past midnight', () => {
    const c = cfg({ activeHours: { days: [], start: '22:00', end: '06:00' } });
    expect(withinActiveHours(new Date('2026-07-29T23:00:00'), c)).toBe(true);
    expect(withinActiveHours(new Date('2026-07-29T05:00:00'), c)).toBe(true);
    expect(withinActiveHours(new Date('2026-07-29T12:00:00'), c)).toBe(false);
  });
});
