import { describe, expect, it } from 'vitest';
import {
  NO_TICKET_STATUS, DEFAULT_CONFIG, type StatusRule } from '../src/core/config';
import { present } from '../src/main/present';
import { initialUiState, type UiState } from '../src/main/state';
import type { JiraTicket, TestGate, WatchItem } from '../src/core/types';

const NOW = new Date('2026-07-30T12:00:00Z');
const ACTIVE = ['In Development', 'Code Review', 'Dev Complete'];

const gate = (over: Partial<Extract<TestGate, { kind: 'unverified' }>> & { kind?: TestGate['kind'] } = {}): TestGate => {
  const k = over.kind ?? 'unverified';
  if (k === 'unverified') {
    return { kind: 'unverified', provider: 'rwx', unverifiedCommits: 'many', startable: true, ...over } as TestGate;
  }
  if (k === 'verified') return { kind: 'verified', provider: 'rwx', result: 'succeeded', url: 'u', name: '.rwx/ci.yml' };
  if (k === 'in_progress') return { kind: 'in_progress', provider: 'rwx', url: 'u' };
  return { kind: 'none' };
};

let n = 0;
const item = (over: Partial<WatchItem> = {}): WatchItem => {
  n += 1;
  return {
    key: `acme/rocket!${7000 + n}`,
    projectPath: 'acme/rocket',
    projectId: 1,
    iid: 7000 + n,
    branch: `ENG-${n}`,
    targetBranch: 'main',
    title: `MR ${n}`,
    headSha: `sha${n}`,
    webUrl: '#',
    updatedAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    userNotesCount: 0,
    draft: false,
    hasConflicts: false,
    reason: 'authored',
    inScope: true,
    threads: [],
    approvals: { required: 1, left: 0, by: ['x'] },
    testGate: { kind: 'none' },
    ...over,
  };
};

const stateWith = (items: WatchItem[]): UiState => ({
  ...initialUiState(),
  snapshot: { at: NOW.toISOString(), items, activeTickets: [], sources: {} as never },
});

const ticket = (status: string, over: Partial<JiraTicket> = {}): JiraTicket => ({
  key: `T-${status}`,
  summary: '',
  status,
  updated: '',
  url: '#',
  ...over,
});

const attentionOf = (item: WatchItem): string => {
  const snap = present(stateWith([item]), ACTIVE, NOW);
  const all = [...snap.groups, ...snap.otherGroups].flatMap((g) => g.items);
  return all[0]?.attention.text ?? '(hidden)';
};

describe('attention priority', () => {
  it('merge conflict outranks everything', () => {
    expect(attentionOf(item({ hasConflicts: true, testGate: gate() }))).toMatch(/Merge conflict/);
  });
  it('conflict guidance respects the configured update style', () => {
    const conflicted = item({ hasConflicts: true, testGate: gate() });
    const rebase = present(stateWith([conflicted]), ACTIVE, NOW, 'rebase');
    const merge = present(stateWith([conflicted]), ACTIVE, NOW, 'merge');
    const textOf = (s: ReturnType<typeof present>) =>
      [...s.groups, ...s.otherGroups].flatMap((g) => g.items)[0]?.attention.text;
    expect(textOf(rebase)).toMatch(/needs a rebase/);
    expect(textOf(merge)).toMatch(/merge main into the branch/);
    expect(textOf(merge)).not.toMatch(/rebase/);
  });
  it('failing tests outrank a review request', () => {
    const failed = { kind: 'verified', provider: 'rwx', result: 'failed', url: 'u', name: 'rspec' } as TestGate;
    expect(attentionOf(item({ reason: 'reviewer', testGate: failed }))).toMatch(/Tests failing/);
  });
  it('a review request outranks unresolved threads', () => {
    const withThread = item({
      reason: 'reviewer',
      threads: [{ id: 't', resolved: false, resolvable: true, notes: [] }],
    });
    expect(attentionOf(withThread)).toMatch(/review is requested/i);
  });
  it('unresolved threads outrank never-run tests', () => {
    expect(
      attentionOf(item({ threads: [{ id: 't', resolved: false, resolvable: true, notes: [] }], testGate: gate() })),
    ).toMatch(/unresolved thread/);
  });
  it('never-run tests outrank waiting-on-approval', () => {
    expect(attentionOf(item({ testGate: gate(), approvals: { required: 1, left: 1, by: [] } }))).toMatch(/never run/i);
  });
  it('a stale run reads as stale with its old verdict, not as never run', () => {
    const stale = gate({
      unverifiedCommits: 3,
      lastResult: { result: 'succeeded', sha: 'old', url: 'u' },
    });
    const text = attentionOf(item({ testGate: stale, approvals: { required: 1, left: 1, by: [] } }));
    expect(text).toMatch(/stale — passed 3 commits ago/i);
    expect(text).not.toMatch(/never/i);
  });
  it('a stale FAILED run is yellow (stale ≠ failing) but says failed', () => {
    const stale = gate({ lastResult: { result: 'failed', sha: 'old', url: 'u' } });
    const snap = present(stateWith([item({ testGate: stale, approvals: { required: 1, left: 1, by: [] } })]), ACTIVE, NOW);
    const row = [...snap.groups, ...snap.otherGroups].flatMap((g) => g.items)[0];
    expect(row?.attention.text).toMatch(/stale — failed/i);
    expect(row?.attention.tone).toBe('warn'); // stale is never red; only never-run is
    expect(row?.ci.label).toBe('RWX stale');
    expect(row?.ci.tone).toBe('warn');
    expect(row?.ci.detail).toMatch(/last failed/);
  });
  it('the chip says never run only when there is truly no history', () => {
    const snap = present(stateWith([item({ testGate: gate() })]), ACTIVE, NOW);
    const row = [...snap.groups, ...snap.otherGroups].flatMap((g) => g.items)[0];
    expect(row?.ci.label).toBe('RWX never run');
    expect(row?.ci.detail).toBe('specs never run');
  });

  it('names a fresh green secondary suite so it cannot pass for the specs', () => {
    // rocket's frontend-ci.yml auto-starts and goes green on every push — the
    // exact thing that makes a never-verified branch LOOK verified.
    const it_ = item({
      testGate: gate(),
      checks: [
        { provider: 'rwx', role: 'tests', name: '.rwx/ci.yml', sha: 'shaX', state: 'waiting', url: 'u', id: '1', createdAt: '' },
        { provider: 'rwx', role: 'lint', name: '.rwx/frontend-ci.yml', sha: 'shaX', state: 'succeeded', url: 'u', id: '2', createdAt: '' },
      ],
    });
    it_.headSha = 'shaX'; // the green run is for the current head → not stale
    const snap = present(stateWith([it_]), ACTIVE, NOW);
    const row = [...snap.groups, ...snap.otherGroups].flatMap((g) => g.items)[0];
    expect(row?.ci.detail).toBe('frontend ✓ — but specs never run');
    // And the secondary check is exposed for the row badge.
    expect(row?.checks.find((c) => c.role !== 'tests')?.stale).toBe(false);
  });
  it('ready to merge when verified, approved, and clean', () => {
    expect(attentionOf(item({ testGate: gate({ kind: 'verified' }) }))).toMatch(/Ready to merge/);
  });
  it('a non-main target splits into "Checks passed" + "Target not main"', () => {
    const it_ = item({ testGate: gate({ kind: 'verified' }), targetBranch: 'release/26-33' });
    const snap = present(stateWith([it_]), ACTIVE, NOW);
    const row = [...snap.groups, ...snap.otherGroups].flatMap((g) => g.items)[0];
    expect(row?.attention).toMatchObject({ text: 'Checks passed', tone: 'good' });
    expect(row?.attentionExtra).toMatchObject({ text: 'Target not main', tone: 'warn' });
  });
  it('a mainline target keeps the plain Ready to merge with no extra', () => {
    const it_ = item({ testGate: gate({ kind: 'verified' }), targetBranch: 'main' });
    const snap = present(stateWith([it_]), ACTIVE, NOW);
    const row = [...snap.groups, ...snap.otherGroups].flatMap((g) => g.items)[0];
    expect(row?.attention.text).toBe('Ready to merge');
    expect(row?.attentionExtra).toBeUndefined();
  });
  it('falls back to draft, then no action', () => {
    expect(attentionOf(item({ draft: true, testGate: { kind: 'none' }, approvals: undefined }))).toMatch(/Draft/);
    expect(attentionOf(item({ testGate: { kind: 'none' }, approvals: undefined }))).toMatch(/No action/);
  });
});

describe('Dev Complete routing', () => {
  const dc = (over: Partial<JiraTicket> = {}): JiraTicket =>
    ticket('Dev Complete', { key: 'ENG-77', issueType: 'Story', fixVersions: [], ...over });

  const buckets = (t: JiraTicket) => {
    const snap = present(stateWith([item({ ticket: t })]), ACTIVE, NOW);
    return {
      active: snap.groups.length,
      needs: snap.needsGroups.length,
      verification: snap.verificationGroups.length,
      other: snap.otherGroups.length,
      snap,
    };
  };

  it('needs-fix-version → its own section, flagged for the picker', () => {
    const b = buckets(dc());
    expect(b.needs).toBe(1);
    expect(b.active).toBe(0);
    expect(b.other).toBe(0);
    expect(b.snap.needsGroups[0]?.ticket?.needsField).toBe('fixVersions');
    expect(b.snap.needsGroups[0]?.items[0]?.attention.text).toBe(
      'Dev Complete — needs a fix version',
    );
  });

  it('with a fix version assigned → effectively in QA: Verification section', () => {
    const b = buckets(dc({ fixVersions: [{ id: '1', name: '2026.31' }] }));
    expect(b.needs).toBe(0);
    expect(b.verification).toBe(1);
  });

  it('an issue-type rule can exempt a category from needing a fix version', () => {
    // e.g. "data fixes ship without a release": match the type, route straight
    // to Verification, everything else falls through to the default rule.
    const rules: StatusRule[] = [
      { status: 'Dev Complete', field: 'issueType', op: 'matches', value: 'data ?fix', then: 'verification', else: 'next' },
      ...DEFAULT_CONFIG.statusRules,
    ];
    const snap = present(
      stateWith([item({ ticket: dc({ issueType: 'Data Fix' }) })]),
      ACTIVE,
      NOW,
      'rebase',
      DEFAULT_CONFIG.statusSections,
      rules,
    );
    expect(snap.needsGroups).toHaveLength(0);
    expect(snap.verificationGroups).toHaveLength(1);
  });

  it('unknown fixVersions (stale cache) is never flagged on guesswork', () => {
    const t = dc();
    delete t.fixVersions;
    const b = buckets(t);
    expect(b.needs).toBe(0); // waits for fresh Jira data instead
    expect(b.verification).toBe(1);
  });
});

describe('conditional routing rules', () => {
  const dcTicket = (over: Partial<JiraTicket> = {}): JiraTicket =>
    ticket('Dev Complete', { key: 'ENG-88', issueType: 'Story', fixVersions: [], ...over });

  it('a custom rule routes needs-fix Dev Complete into Active — picker intact', () => {
    // The user's sketch: "Dev Complete → Active if fix version empty, else Verification".
    const rules: StatusRule[] = [
      { status: 'Dev Complete', field: 'fixVersions', op: 'empty', then: 'active', else: 'verification' },
    ];
    const snap = present(
      stateWith([item({ ticket: dcTicket() })]),
      ACTIVE,
      NOW,
      'rebase',
      DEFAULT_CONFIG.statusSections,
      rules,
    );
    expect(snap.groups).toHaveLength(1); // Active, not the dedicated section
    expect(snap.needsGroups).toHaveLength(0);
    expect(snap.groups[0]?.ticket?.needsField).toBe('fixVersions'); // picker follows the ticket
    expect(snap.groups[0]?.items[0]?.attention.text).toBe('Dev Complete — needs a fix version');
  });

  it("the same rule's else-branch sends versioned tickets to Verification", () => {
    const rules: StatusRule[] = [
      { status: 'Dev Complete', field: 'fixVersions', op: 'empty', then: 'active', else: 'verification' },
    ];
    const snap = present(
      stateWith([item({ ticket: dcTicket({ fixVersions: [{ id: '1', name: '2026.31' }] }) })]),
      ACTIVE,
      NOW,
      'rebase',
      DEFAULT_CONFIG.statusSections,
      rules,
    );
    expect(snap.groups).toHaveLength(0);
    expect(snap.verificationGroups).toHaveLength(1);
  });

  it("'next' falls through to later rules", () => {
    const rules: StatusRule[] = [
      { status: 'Dev Complete', field: 'issueType', op: 'matches', value: 'data ?fix', then: 'verification', else: 'next' },
      ...DEFAULT_CONFIG.statusRules,
    ];
    const args = ['rebase', DEFAULT_CONFIG.statusSections, rules] as const;
    const snap = present(stateWith([item({ ticket: dcTicket({ issueType: 'DataFix' }) })]), ACTIVE, NOW, ...args);
    expect(snap.verificationGroups).toHaveLength(1); // matched rule 1's then-branch
    const snap2 = present(stateWith([item({ ticket: dcTicket() })]), ACTIVE, NOW, ...args);
    expect(snap2.needsGroups).toHaveLength(1); // fell through to rule 2
  });

  it('chained conditions fold left to right (and/or)', () => {
    // "fixVersions empty AND issueType matches story → verification"
    const rules: StatusRule[] = [{
      status: 'Dev Complete', field: 'fixVersions', op: 'empty',
      also: [{ connector: 'and', field: 'issueType', op: 'matches', value: 'story' }],
      then: 'verification', else: 'other',
    }];
    const args = ['rebase', DEFAULT_CONFIG.statusSections, rules] as const;
    const hit = present(stateWith([item({ ticket: dcTicket({ issueType: 'Story' }) })]), ACTIVE, NOW, ...args);
    expect(hit.verificationGroups).toHaveLength(1);
    const miss = present(stateWith([item({ ticket: dcTicket({ issueType: 'Bug' }) })]), ACTIVE, NOW, ...args);
    expect(miss.verificationGroups).toHaveLength(0); // AND failed → else
    expect(miss.otherGroups).toHaveLength(1);
    // OR rescues the miss.
    const orRules: StatusRule[] = [{
      status: 'Dev Complete', field: 'fixVersions', op: 'present',
      also: [{ connector: 'or', field: 'issueType', op: 'matches', value: 'bug' }],
      then: 'verification', else: 'other',
    }];
    const rescued = present(
      stateWith([item({ ticket: dcTicket({ issueType: 'Bug' }) })]),
      ACTIVE, NOW, 'rebase', DEFAULT_CONFIG.statusSections, orRules,
    );
    expect(rescued.verificationGroups).toHaveLength(1);
  });

  it('a rule without an else falls through like next', () => {
    const rules: StatusRule[] = [
      { status: 'Dev Complete', field: 'issueType', op: 'matches', value: 'story', then: 'done' },
      { status: 'Dev Complete', op: 'always', then: 'verification' },
    ];
    const snap = present(
      stateWith([item({ ticket: dcTicket({ issueType: 'Bug' }) })]),
      ACTIVE, NOW, 'rebase', DEFAULT_CONFIG.statusSections, rules,
    );
    // Rule 1 missed and has no else → falls to rule 2.
    expect(snap.verificationGroups).toHaveLength(1);
  });

  it("an unconditional 'always' rule routes with no field at all", () => {
    // "Dev Complete in <repo> → Verification" — the simple form.
    const rules: StatusRule[] = [
      { status: 'Dev Complete', repo: 'acme/rocket', op: 'always', then: 'verification', else: 'next' },
    ];
    const snap = present(
      stateWith([item({ ticket: dcTicket() })]),
      ACTIVE,
      NOW,
      'rebase',
      DEFAULT_CONFIG.statusSections,
      rules,
    );
    expect(snap.verificationGroups).toHaveLength(1);
    expect(snap.needsGroups).toHaveLength(0); // no empty-check ran, so no "needs" flag
  });

  it('a repo-scoped rule only fires for that repo', () => {
    const rules: StatusRule[] = [
      { status: 'Dev Complete', repo: 'acme/gadget', field: 'fixVersions', op: 'empty', then: 'active', else: 'verification' },
    ];
    // item() helper builds acme/rocket MRs — the gadget-scoped rule must not
    // apply, so routing falls through to the plain status mapping (active set).
    const snap = present(
      stateWith([item({ ticket: dcTicket() })]),
      ACTIVE,
      NOW,
      'rebase',
      DEFAULT_CONFIG.statusSections,
      rules,
    );
    expect(snap.groups).toHaveLength(1); // Dev Complete is in ACTIVE statuses
    expect(snap.needsGroups).toHaveLength(0);
    const scoped: StatusRule[] = [
      { status: 'Dev Complete', repo: 'acme/rocket', field: 'fixVersions', op: 'empty', then: 'needs-value', else: 'verification' },
    ];
    const snap2 = present(stateWith([item({ ticket: dcTicket() })]), ACTIVE, NOW, 'rebase', DEFAULT_CONFIG.statusSections, scoped);
    expect(snap2.needsGroups).toHaveLength(1); // matching repo → rule fires
  });

  it('a past-due rule can escalate tickets', () => {
    const rules: StatusRule[] = [
      { status: 'To Do', field: 'dueDate', op: 'past', then: 'active', else: 'next' },
    ];
    const overdue = ticket('To Do', { key: 'ENG-99', dueDate: '2026-07-01' });
    const snap = present(stateWith([item({ ticket: overdue })]), ACTIVE, NOW, 'rebase', DEFAULT_CONFIG.statusSections, rules);
    expect(snap.groups).toHaveLength(1); // pulled into Active by the rule
  });
});

describe('(no ticket) sentinel rule', () => {
  const noTicketItem = () => item({ branch: 'quick-fix', title: 'Patch the widget' });

  it('routes ticketless MRs to the collapsed Ignored bucket, not a drop', () => {
    const rules: StatusRule[] = [{ status: NO_TICKET_STATUS, op: 'always', then: 'ignore' }];
    const snap = present(stateWith([noTicketItem()]), ACTIVE, NOW, 'rebase', DEFAULT_CONFIG.statusSections, rules);
    expect(
      snap.groups.length + snap.otherGroups.length + snap.doneGroups.length + snap.verificationGroups.length,
    ).toBe(0);
    expect(snap.ignoredGroups).toHaveLength(1);
    expect(snap.ignoredGroups[0]?.status).toBe('No ticket');
    expect(snap.ignoredGroups[0]?.items[0]?.ignored).toBe('rule'); // → 'Show anyway'
  });

  it("a 'shown' override rescues an MR from the ignore rule", () => {
    const rules: StatusRule[] = [{ status: NO_TICKET_STATUS, op: 'always', then: 'ignore' }];
    const shown = { ...noTicketItem(), ignoreOverride: 'shown' as const };
    const snap = present(stateWith([shown]), ACTIVE, NOW, 'rebase', DEFAULT_CONFIG.statusSections, rules);
    expect(snap.ignoredGroups).toHaveLength(0);
    expect(snap.otherGroups).toHaveLength(1); // plain mapping applies again
  });

  it("a manual 'ignored' override wins regardless of rules", () => {
    const muted = { ...item({ ticket: ticket('In Development') }), ignoreOverride: 'ignored' as const };
    const snap = present(stateWith([muted]), ACTIVE, NOW, 'rebase', DEFAULT_CONFIG.statusSections, []);
    expect(snap.groups).toHaveLength(0); // not in Active despite active status
    expect(snap.ignoredGroups[0]?.items[0]?.ignored).toBe('manual'); // → 'Un-ignore'
  });

  it('never matches MRs that DO have a ticket', () => {
    const rules: StatusRule[] = [{ status: NO_TICKET_STATUS, op: 'always', then: 'ignore' }];
    const snap = present(
      stateWith([item({ ticket: ticket('In Development') })]),
      ACTIVE, NOW, 'rebase', DEFAULT_CONFIG.statusSections, rules,
    );
    expect(snap.groups).toHaveLength(1);
  });

  it('can route ticketless MRs into a section instead', () => {
    const rules: StatusRule[] = [{ status: NO_TICKET_STATUS, op: 'always', then: 'done' }];
    const snap = present(stateWith([noTicketItem()]), ACTIVE, NOW, 'rebase', DEFAULT_CONFIG.statusSections, rules);
    expect(snap.doneGroups).toHaveLength(1);
    expect(snap.doneGroups[0]?.status).toBe('No ticket');
  });

  it('without the rule, ticketless MRs land in Other as before', () => {
    const snap = present(stateWith([noTicketItem()]), ACTIVE, NOW, 'rebase', DEFAULT_CONFIG.statusSections, []);
    expect(snap.otherGroups).toHaveLength(1);
    expect(snap.otherGroups[0]?.status).toBe('No ticket');
  });
});

describe('status → section routing', () => {
  const snapFor = (status: string) =>
    present(stateWith([item({ ticket: ticket(status) })]), ACTIVE, NOW);

  it('verification statuses get their own section', () => {
    const snap = snapFor('In QA');
    expect(snap.verificationGroups).toHaveLength(1);
    expect(snap.otherGroups).toHaveLength(0);
  });
  it('done statuses collapse at the bottom', () => {
    const snap = snapFor('Closed');
    expect(snap.doneGroups).toHaveLength(1);
    expect(snap.otherGroups).toHaveLength(0);
  });
  it('hidden statuses are not shown at all', () => {
    const snap = snapFor('Backlog');
    expect(
      snap.groups.length + snap.otherGroups.length + snap.doneGroups.length + snap.verificationGroups.length,
    ).toBe(0);
  });
  it('unmapped statuses default to Other', () => {
    const snap = snapFor('Some Unheard Of Status');
    expect(snap.otherGroups).toHaveLength(1);
  });
});

describe('grouping', () => {
  it('puts active-status tickets in groups, unmapped in Other, Backlog hidden', () => {
    const snap = present(
      stateWith([
        item({ ticket: ticket('Code Review') }),
        item({ ticket: ticket('Backlog') }), // default-hidden section
        item({ ticket: ticket('To Do') }),
      ]),
      ACTIVE,
      NOW,
    );
    expect(snap.groups).toHaveLength(1); // Code Review is active
    expect(snap.otherGroups.map((g) => g.status)).toEqual(['To Do']); // Backlog ignored
  });

  it('buckets MRs with no ticket under "No ticket"', () => {
    const snap = present(stateWith([item({ ticket: undefined })]), ACTIVE, NOW);
    expect(snap.otherGroups[0]?.status).toBe('No ticket');
  });
});

describe('stale-closed hiding', () => {
  const done = (resolvedDaysAgo: number): JiraTicket =>
    ticket('Closed', {
      statusCategory: 'Done',
      resolutionDate: new Date(NOW.getTime() - resolvedDaysAgo * 86_400_000).toISOString(),
    });

  it('hides tickets resolved more than a week ago', () => {
    const snap = present(stateWith([item({ ticket: done(10) })]), ACTIVE, NOW);
    expect(snap.groups.length + snap.otherGroups.length + snap.doneGroups.length).toBe(0);
  });
  it('keeps tickets resolved within the last week, in the Done section', () => {
    const snap = present(stateWith([item({ ticket: done(2) })]), ACTIVE, NOW);
    expect(snap.doneGroups).toHaveLength(1); // Closed routes to Done now
  });
});

describe('overdue', () => {
  it('flags an item whose ticket due date has passed', () => {
    const overdue = ticket('Code Review', { dueDate: '2026-07-01' });
    const snap = present(stateWith([item({ ticket: overdue })]), ACTIVE, NOW);
    expect(snap.groups[0]?.items[0]?.overdue).toBe(true);
  });
});
