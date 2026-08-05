import { NO_TICKET_STATUS, type RuleField, type RuleTarget, type StatusRule } from './config';
import type { WatchItem } from './types';

/**
 * Advanced status-rule evaluation, shared by the presentation layer (section
 * routing) and the event pipeline (an 'ignore'-routed MR must not notify or
 * count — silencing is not merely visual). Lives in core so poll/events can
 * use it without reaching into main/.
 */

/** Case-insensitive regex, treating an invalid pattern as no-match. */
const safeMatch = (pattern: string | undefined, value: string): boolean => {
  if (!pattern) return false;
  try {
    return new RegExp(pattern, 'i').test(value);
  } catch {
    return false;
  }
};

const testCondition = (
  t: NonNullable<WatchItem['ticket']>,
  now: Date,
  field: StatusRule['field'],
  op: StatusRule['op'],
  value: string | undefined,
): boolean => {
  if (field === 'fixVersions') {
    const v = t.fixVersions;
    if (op === 'empty') return v !== undefined && v.length === 0;
    if (op === 'present') return (v ?? []).length > 0;
    if (op === 'matches') return safeMatch(value, (v ?? []).map((x) => x.name).join(', '));
    return false;
  }
  const str = field === 'issueType' ? t.issueType : t.dueDate;
  switch (op) {
    case 'empty':
      return str === '';
    case 'present':
      return Boolean(str);
    case 'matches':
      return safeMatch(value, str ?? '');
    case 'past': {
      if (field !== 'dueDate' || !t.dueDate) return false;
      const due = new Date(`${t.dueDate}T23:59:59`);
      return Number.isFinite(due.getTime()) && due.getTime() < now.getTime();
    }
    default:
      return false;
  }
};

const rulePredicate = (rule: StatusRule, t: NonNullable<WatchItem['ticket']>, now: Date): boolean => {
  if (rule.op === 'always') return true;
  // The chain folds left to right, data_set_filter style: each extra
  // condition combines with the running result via its own connector.
  let acc = testCondition(t, now, rule.field, rule.op, rule.value);
  for (const c of rule.also ?? []) {
    const hit = testCondition(t, now, c.field, c.op, c.value);
    acc = c.connector === 'or' ? acc || hit : acc && hit;
  }
  return acc;
};

export interface RuleOutcome {
  target?: Exclude<RuleTarget, 'next'>;
  /**
   * Set when the terminating rule was a true `empty` check: the ticket is
   * missing that field's value, wherever it was routed. Drives the
   * "Needs <field>" affordances (attention line, fix-version picker) —
   * deliberately independent of the target, so a custom rule routing Dev
   * Complete into Active keeps the "assign one" ask visible.
   */
  needs?: RuleField;
}

/**
 * Walk the rules top-to-bottom for this ticket; 'next' defers to later rules,
 * then to the plain status→section mapping ({} = no rule terminated).
 */
export const resolveRules = (
  rules: StatusRule[],
  t: WatchItem['ticket'],
  now: Date,
  projectPath: string,
): RuleOutcome => {
  for (const rule of rules) {
    // '(no ticket)' is a sentinel: it matches exactly the MRs no other rule
    // can — those without a Jira ticket. Everything else needs a status match.
    const matches =
      rule.status === NO_TICKET_STATUS
        ? !t
        : t !== undefined && rule.status.toLowerCase() === t.status.toLowerCase();
    if (!matches) continue;
    // A rule can be pinned to one repo; empty/absent means any.
    if (rule.repo && rule.repo !== projectPath) continue;
    // Ticketless MRs have no fields to test: only an unconditional rule can
    // hit; a conditional one takes its else branch.
    const hit = rule.op === 'always' ? true : t !== undefined && rulePredicate(rule, t, now);
    const target = hit ? rule.then : (rule.else ?? 'next');
    if (target === 'next') continue;
    return { target, ...(hit && rule.op === 'empty' && rule.field ? { needs: rule.field } : {}) };
  }
  return {};
};

export const ruleTarget = (
  rules: StatusRule[],
  t: WatchItem['ticket'],
  now: Date,
  projectPath: string,
): Exclude<RuleTarget, 'next'> | undefined => resolveRules(rules, t, now, projectPath).target;

export type IgnoredBy = 'manual' | 'rule';

/**
 * The one ignore decision, shared by presentation and events: a manual
 * per-MR override wins in both directions ('ignored' pins it ignored,
 * 'shown' rescues it from an ignore rule); otherwise the rules decide.
 */
export const effectiveIgnore = (
  rules: StatusRule[],
  item: Pick<WatchItem, 'ticket' | 'projectPath' | 'ignoreOverride'>,
  now: Date,
): IgnoredBy | undefined => {
  if (item.ignoreOverride === 'ignored') return 'manual';
  if (item.ignoreOverride === 'shown') return undefined;
  return ruleTarget(rules, item.ticket, now, item.projectPath) === 'ignore' ? 'rule' : undefined;
};
