import { describe, expect, it } from 'vitest';
import { NO_TICKET_STATUS, type StatusRule } from '../src/core/config';
import { effectiveIgnore } from '../src/core/rules';

const NOW = new Date('2026-08-05T12:00:00Z');
const IGNORE_NO_TICKET: StatusRule[] = [{ status: NO_TICKET_STATUS, op: 'always', then: 'ignore' }];

const mr = (over: Partial<Parameters<typeof effectiveIgnore>[1]> = {}) => ({
  projectPath: 'acme/rocket',
  ...over,
});

describe('effectiveIgnore — the one shared ignore decision', () => {
  it('rules ignore when no override exists', () => {
    expect(effectiveIgnore(IGNORE_NO_TICKET, mr(), NOW)).toBe('rule');
  });

  it('a manual override wins in both directions', () => {
    expect(effectiveIgnore([], mr({ ignoreOverride: 'ignored' }), NOW)).toBe('manual');
    expect(effectiveIgnore(IGNORE_NO_TICKET, mr({ ignoreOverride: 'shown' }), NOW)).toBeUndefined();
  });

  it('nothing matches: visible', () => {
    expect(effectiveIgnore([], mr(), NOW)).toBeUndefined();
    const withTicket = mr({
      ticket: { key: 'ENG-1', summary: '', status: 'Code Review', updated: '', url: '#' },
    });
    expect(effectiveIgnore(IGNORE_NO_TICKET, withTicket, NOW)).toBeUndefined();
  });
});
