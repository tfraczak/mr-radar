import { beforeEach, describe, expect, it } from 'vitest';
import { Db, commitDates } from '../src/core/db';
import { coalesce, diff, toNotifications } from '../src/core/events';
import { summarizeThreads, unresolvedCount } from '../src/core/correlate';
import { EVENT_TYPES } from '../src/core/types';
import type { AppEvent, Check, ForgeDiscussion, ForgeTodo, TestGate, WatchItem } from '../src/core/types';
import discussionsGadget from './fixtures/discussions-gadget320.json';

const ME = 'mira.dev';
const NOW = '2026-07-29T12:00:00.000Z';
const LATER = '2026-07-29T12:01:00.000Z';
const HEAD = 'aaaa1111';

let db: Db;
beforeEach(() => {
  db = new Db(':memory:');
});

const item = (over: Partial<WatchItem> = {}): WatchItem => ({
  key: 'acme/rocket!7576',
  projectPath: 'acme/rocket',
  projectId: 1,
  iid: 7576,
  branch: 'ENG-118',
  title: 'Vendor payoff-quote-by-date',
  headSha: HEAD,
  webUrl: 'https://gitlab.com/acme/rocket/-/merge_requests/7576',
  updatedAt: NOW,
  createdAt: NOW,
  userNotesCount: 0,
  draft: false,
  hasConflicts: false,
  reason: 'authored',
  inScope: true,
  ...over,
});

const note = (id: number, author: string, body = 'looks good') => ({
  id,
  author,
  body,
  createdAt: NOW,
});

const thread = (id: string, notes: ReturnType<typeof note>[], resolved = false) => ({
  id,
  resolved,
  resolvable: true,
  notes,
});

/** Run a cycle and persist, the way pollOnce does. */
const cycle = (items: WatchItem[], todos: ForgeTodo[] = [], now = NOW): AppEvent[] => {
  const { events, commit } = diff({ db, items, todos, me: ME, now });
  db.transaction(() => {
    commit(db);
    db.recordEvents(events, now, true);
  });
  return events;
};

describe('silent seeding', () => {
  it('emits nothing on the first sighting of an MR, however much is on it', () => {
    const events = cycle([
      item({
        threads: [thread('t1', [note(1, 'jo.keller'), note(2, 'sam.rios')])],
        approvals: { required: 1, left: 0, by: ['jo.keller'] },
      }),
    ]);
    expect(events).toEqual([]);
  });

  it('emits nothing on a second identical cycle either', () => {
    const i = item({ threads: [thread('t1', [note(1, 'jo.keller')])] });
    cycle([i]);
    expect(cycle([item({ threads: [thread('t1', [note(1, 'jo.keller')])] })])).toEqual([]);
  });

  it('stays silent for a brand-new MR appearing mid-life', () => {
    cycle([item()]);
    const fresh = item({
      key: 'acme/rocket!9999',
      iid: 9999,
      branch: 'ENG-200',
      threads: [thread('t9', [note(90, 'someone')])],
    });
    const events = cycle([item(), fresh], [], LATER);
    expect(events.filter((e) => e.mrKey === 'acme/rocket!9999')).toEqual([]);
  });

  it('reseeds silently after the database is wiped', () => {
    cycle([item({ threads: [thread('t1', [note(1, 'jo.keller')])] })]);
    db.close();
    db = new Db(':memory:'); // stands in for a deleted db file
    const events = cycle([item({ threads: [thread('t1', [note(1, 'jo.keller')])] })]);
    expect(events).toEqual([]);
  });
});

describe('persisted ticket claims', () => {
  it('preserves the last-known ticket through a harvest miss while still claimed', () => {
    // The default item branch is ENG-118 — the persisted key it claims.
    const withTicket = item({ ticket: { key: 'ENG-118', status: 'In Development' } });
    cycle([withTicket]);
    // Next cycle: Jira couldn't resolve it (item.ticket unset) but the branch
    // still carries ENG-118, so the association survives the miss.
    cycle([item({})]);
    expect(db.getMr(item({}).key)?.ticket_key).toBe('ENG-118');
  });

  it('drops a persisted ticket the MR no longer claims (retitle self-heals)', () => {
    const withTicket = item({ ticket: { key: 'ENG-126', status: 'In Development' } });
    cycle([withTicket]);
    // The MR moves to a keyless branch and title: the old key must not pin.
    cycle([item({ branch: 'quick-fix', title: 'Patch the widget' })]);
    expect(db.getMr(item({}).key)?.ticket_key).toBeNull();
  });
});

describe('comments', () => {
  it('notifies a new comment from someone else', () => {
    cycle([item({ threads: [thread('t1', [note(1, ME)])] })]);
    const events = cycle(
      [item({ threads: [thread('t1', [note(1, ME), note(2, 'jo.keller', 'needs a tweak')])] })],
      [],
      LATER,
    );
    expect(events).toHaveLength(1);
    const e = events[0];
    if (e?.type !== 'comment') throw new Error('expected a comment event');
    expect(e.authors).toEqual(['jo.keller']);
    expect(e.count).toBe(1);
    expect(e.preview).toContain('needs a tweak');
  });

  it('does not notify my own comments', () => {
    cycle([item({ threads: [thread('t1', [note(1, 'jo.keller')])] })]);
    const events = cycle(
      [item({ threads: [thread('t1', [note(1, 'jo.keller'), note(2, ME)])] })],
      [],
      LATER,
    );
    expect(events).toEqual([]);
  });

  it('notifies bot comments the same as humans', () => {
    cycle([item({ threads: [thread('t1', [note(1, ME)])] })]);
    const events = cycle(
      [
        item({
          threads: [thread('t1', [note(1, ME), note(2, 'project_1111111_bot_aaaaaaaa', 'bot review')])],
        }),
      ],
      [],
      LATER,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('comment');
  });

  it('never re-notifies the same note', () => {
    cycle([item({ threads: [thread('t1', [note(1, ME)])] })]);
    const withComment = () =>
      item({ threads: [thread('t1', [note(1, ME), note(2, 'jo.keller')])] });
    expect(cycle([withComment()], [], LATER)).toHaveLength(1);
    expect(cycle([withComment()], [], LATER)).toEqual([]);
  });

  it('coalesces many comments on one MR into a single event', () => {
    cycle([item({ threads: [thread('t1', [note(1, ME)])] })]);
    const events = cycle(
      [
        item({
          threads: [
            thread('t1', [note(1, ME), note(2, 'jo.keller'), note(3, 'sam.rios')]),
            thread('t2', [note(4, 'jo.keller')]),
          ],
        }),
      ],
      [],
      LATER,
    );
    const merged = coalesce(events).filter((e) => e.type === 'comment');
    expect(merged).toHaveLength(1);
    const e = merged[0];
    if (e?.type !== 'comment') throw new Error('expected a comment event');
    expect(e.count).toBe(3);
    expect(e.authors.sort()).toEqual(['jo.keller', 'sam.rios']);
  });
});

describe('approvals and conflicts', () => {
  it('notifies a new approval once', () => {
    cycle([item({ approvals: { required: 2, left: 2, by: [] } })]);
    const approved = () => item({ approvals: { required: 2, left: 1, by: ['jo.keller'] } });
    const events = cycle([approved()], [], LATER);
    expect(events).toHaveLength(1);
    const e = events[0];
    if (e?.type !== 'approval') throw new Error('expected an approval event');
    expect(e.by).toBe('jo.keller');
    expect(e.left).toBe(1);
    expect(cycle([approved()], [], LATER)).toEqual([]);
  });

  it('lets a re-approval notify again after an unapproval', () => {
    cycle([item({ approvals: { required: 1, left: 1, by: [] } })]);
    cycle([item({ approvals: { required: 1, left: 0, by: ['jo.keller'] } })], [], LATER);
    cycle([item({ approvals: { required: 1, left: 1, by: [] } })], [], LATER);
    const again = cycle(
      [item({ approvals: { required: 1, left: 0, by: ['jo.keller'] } })],
      [],
      LATER,
    );
    expect(again).toHaveLength(1);
    expect(again[0]?.type).toBe('approval');
  });

  it('notifies a merge conflict only on transition into it', () => {
    cycle([item()]);
    const conflicted = () => item({ hasConflicts: true });
    expect(cycle([conflicted()], [], LATER).map((e) => e.type)).toEqual(['unmergeable']);
    expect(cycle([conflicted()], [], LATER)).toEqual([]);
  });

  it('notifies newly resolved threads', () => {
    cycle([item({ threads: [thread('t1', [note(1, 'jo.keller')], false)] })]);
    const events = cycle(
      [item({ threads: [thread('t1', [note(1, 'jo.keller')], true)] })],
      [],
      LATER,
    );
    expect(events.map((e) => e.type)).toEqual(['thread_resolved']);
  });
});

describe('ci_suggest_run', () => {
  const unverified: TestGate = {
    kind: 'unverified',
    provider: 'rwx',
    unverifiedCommits: 'many',
    startable: true,
  };
  const testsCheck: Check = {
    provider: 'rwx',
    role: 'tests',
    name: '.rwx/ci.yml',
    sha: HEAD,
    state: 'waiting',
    url: 'https://cloud.rwx.com/mint/acme/runs/abc',
    id: 'abc',
    createdAt: NOW,
  };

  it('fires once per head sha, not once per cycle', () => {
    const withGate = () => item({ testGate: unverified, checks: [testsCheck] });
    cycle([withGate()]); // seed
    const first = cycle([withGate()], [], LATER);
    expect(first.map((e) => e.type)).toEqual(['ci_suggest_run']);
    // The condition persists for weeks on rocket; it must not nag again.
    expect(cycle([withGate()], [], LATER)).toEqual([]);
    expect(cycle([withGate()], [], LATER)).toEqual([]);
  });

  it('re-arms on a new push', () => {
    const withGate = (sha: string) =>
      item({ headSha: sha, testGate: unverified, checks: [{ ...testsCheck, sha }] });
    cycle([withGate(HEAD)]);
    expect(cycle([withGate(HEAD)], [], LATER)).toHaveLength(1);
    expect(cycle([withGate('bbbb2222')], [], LATER).map((e) => e.type)).toEqual(['ci_suggest_run']);
  });

  it('does not fire for a non-startable gate', () => {
    // A missing GitLab pipeline is transient, not actionable.
    const gate: TestGate = {
      kind: 'unverified',
      provider: 'gitlab',
      unverifiedCommits: 'many',
      startable: false,
    };
    cycle([item({ testGate: gate })]);
    expect(cycle([item({ testGate: gate })], [], LATER)).toEqual([]);
  });

  it('does not fire for a verified gate', () => {
    const gate: TestGate = {
      kind: 'verified',
      provider: 'rwx',
      result: 'succeeded',
      url: 'u',
      name: '.rwx/ci.yml',
    };
    cycle([item({ testGate: gate })]);
    expect(cycle([item({ testGate: gate })], [], LATER)).toEqual([]);
  });
});

describe('ci results', () => {
  const check = (over: Partial<Check> = {}): Check => ({
    provider: 'gitlab',
    role: 'tests',
    name: 'ruby::rspec::3.2.8',
    sha: HEAD,
    state: 'failed',
    url: 'https://gitlab.com/p/-/pipelines/1',
    id: '1',
    createdAt: NOW,
    ...over,
  });

  it('notifies a failure once, keyed on the run id', () => {
    cycle([item()]);
    expect(cycle([item({ checks: [check()] })], [], LATER).map((e) => e.type)).toEqual(['ci_failed']);
    expect(cycle([item({ checks: [check()] })], [], LATER)).toEqual([]);
  });

  it('notifies again for a new run id after a re-push', () => {
    cycle([item()]);
    cycle([item({ checks: [check()] })], [], LATER);
    const events = cycle([item({ checks: [check({ id: '2' })] })], [], LATER);
    expect(events.map((e) => e.type)).toEqual(['ci_failed']);
  });

  it('ignores checks for a commit that is not the head', () => {
    cycle([item()]);
    const stale = check({ sha: 'old-sha', id: '9' });
    expect(cycle([item({ checks: [stale] })], [], LATER)).toEqual([]);
  });

  it('does not notify in-progress or waiting checks', () => {
    cycle([item()]);
    const events = cycle(
      [item({ checks: [check({ state: 'in_progress', id: '3' }), check({ state: 'waiting', id: '4' })] })],
      [],
      LATER,
    );
    expect(events).toEqual([]);
  });

  it('distinguishes lint from tests in the notification text', () => {
    cycle([item()]);
    const lint = cycle([item({ checks: [check({ role: 'lint', name: 'ruby::lint', id: '5' })] })], [], LATER);
    const [n] = toNotifications(lint);
    expect(n?.title).toContain('CI lint failed');
    expect(n?.title).not.toContain('tests');
  });

  it('labels RWX distinctly from GitLab CI', () => {
    cycle([item()]);
    const rwx = cycle(
      [item({ checks: [check({ provider: 'rwx', name: '.rwx/ci.yml', id: '6' })] })],
      [],
      LATER,
    );
    expect(toNotifications(rwx)[0]?.title).toContain('RWX tests failed');
  });
});

describe('out-of-scope MRs', () => {
  it('are ignored entirely, even with new comments', () => {
    const events = cycle([
      item({ inScope: false, threads: [thread('t1', [note(1, 'jo.keller')])] }),
    ]);
    expect(events).toEqual([]);
    expect(db.getMr('acme/rocket!7576')).toBeUndefined();
  });
});

describe('todos', () => {
  const todo = (over: Partial<ForgeTodo> = {}): ForgeTodo => ({
    id: 500,
    action_name: 'review_submitted',
    target_type: 'MergeRequest',
    author: { id: 2, username: 'jo.keller', name: 'Jo' },
    created_at: NOW,
    target: { iid: 7576, references: { full: 'acme/rocket!7576' } },
    target_url: 'https://gitlab.com/x',
    ...over,
  });

  it('notifies a submitted review once', () => {
    cycle([item()]); // seed
    expect(cycle([item()], [todo()], LATER).map((e) => e.type)).toEqual(['review_submitted']);
    expect(cycle([item()], [todo()], LATER)).toEqual([]);
  });

  it('ignores my own todos', () => {
    cycle([item()]);
    const mine = todo({ author: { id: 1, username: ME, name: 'Mira' } });
    expect(cycle([item()], [mine], LATER)).toEqual([]);
  });

  it('stays silent on the very first cycle', () => {
    expect(cycle([item()], [todo()])).toEqual([]);
  });
});

describe('toNotifications', () => {
  const suggest = (branch: string): AppEvent => ({
    type: 'ci_suggest_run',
    mrKey: `acme/rocket!${branch}`,
    mrTitle: 't',
    branch,
    url: 'u',
    ticket: branch,
    provider: 'rwx',
    unverifiedCommits: 'many',
    headSha: HEAD,
  });

  it('collapses three or more suggest-run events into one digest', () => {
    // rocket's unverified state applies to every open MR at once, so ~10 events is
    // normal and ten banners would be unusable.
    const events = ['ENG-1', 'ENG-2', 'ENG-3', 'ENG-4', 'ENG-5', 'ENG-6'].map(suggest);
    const notifications = toNotifications(events);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toBe('6 branches have unverified tests');
    expect(notifications[0]?.body).toContain('+2 more');
    expect(notifications[0]?.events).toHaveLength(6);
  });

  it('keeps one or two suggest-run events individual', () => {
    expect(toNotifications([suggest('ENG-1'), suggest('ENG-2')])).toHaveLength(2);
  });

  it('says never run when there is no history, stale when there is', () => {
    const never = toNotifications([suggest('ENG-1')]);
    expect(never[0]?.title).toMatch(/tests never run/);

    const stale = toNotifications([
      { ...suggest('ENG-2'), lastResult: 'succeeded', unverifiedCommits: 4 } as AppEvent,
    ]);
    expect(stale[0]?.title).toMatch(/tests stale — last passed, 4 commits unverified/);
    expect(stale[0]?.title).not.toMatch(/never/);
  });

  it('never collapses comments or results into the digest', () => {
    const events: AppEvent[] = [
      ...['ENG-1', 'ENG-2', 'ENG-3'].map(suggest),
      {
        type: 'comment',
        mrKey: 'acme/rocket!1',
        mrTitle: 't',
        branch: 'ENG-9',
        url: 'u',
        authors: ['jo.keller'],
        count: 1,
        preview: 'hi',
        noteIds: [1],
      },
    ];
    const notifications = toNotifications(events);
    expect(notifications).toHaveLength(2);
    expect(notifications.some((n) => n.title.includes('1 new comment'))).toBe(true);
  });
});

describe('summarizeThreads on real discussion data', () => {
  const discussions = discussionsGadget as unknown as ForgeDiscussion[];

  it('drops system notes, which are the bulk of the volume', () => {
    const threads = summarizeThreads(discussions);
    const systemNotes = discussions.flatMap((d) => d.notes.filter((n) => n.system));
    expect(systemNotes.length).toBeGreaterThan(0);
    const keptIds = new Set(threads.flatMap((t) => t.notes.map((n) => n.id)));
    for (const n of systemNotes) expect(keptIds.has(n.id)).toBe(false);
  });

  it('counts only unresolved resolvable threads', () => {
    const threads = summarizeThreads(discussions);
    const count = unresolvedCount(threads);
    expect(count).toBe(threads.filter((t) => t.resolvable && !t.resolved).length);
    expect(count).toBeLessThanOrEqual(threads.length);
  });

  it('keeps the file and line for diff comments', () => {
    const threads = summarizeThreads(discussions);
    const positioned = threads.find((t) => t.filePath !== undefined);
    expect(positioned?.filePath).toMatch(/\.rb$/);
    expect(typeof positioned?.line).toBe('number');
  });
});

describe('reviewer-side notification rules', () => {
  const check = (over: Partial<Check> = {}): Check => ({
    provider: 'rwx',
    role: 'tests',
    name: '.rwx/ci.yml',
    sha: HEAD,
    state: 'succeeded',
    url: 'https://cloud.rwx.com/acme/runs/1',
    id: 'run-1',
    createdAt: NOW,
    ...over,
  });
  const reviewing = (over: Partial<WatchItem> = {}) => item({ reason: 'reviewer', ...over });
  /** The shipped defaults: everything on mine, no CI family on other people's. */
  const NON_CI = EVENT_TYPES.filter((e) => !e.startsWith('ci_'));
  const matrix = (reviewerGetsCi: boolean) => ({
    authored: [...EVENT_TYPES],
    reviewer: reviewerGetsCi ? [...EVENT_TYPES] : [...NON_CI],
    participating: [...NON_CI],
  });
  const cycleWith = (items: WatchItem[], reviewerGetsCi: boolean, now = NOW): AppEvent[] => {
    const { events, commit } = diff({
      db,
      items,
      todos: [],
      me: ME,
      now,
      notifyEvents: matrix(reviewerGetsCi),
    });
    db.transaction(() => {
      commit(db);
      db.recordEvents(events, now, true);
    });
    return events;
  };

  it('stays quiet about CI on an MR I only review', () => {
    cycleWith([reviewing()], false);
    expect(cycleWith([reviewing({ checks: [check()] })], false, LATER)).toEqual([]);
  });

  it('still reports CI on my own MR', () => {
    cycleWith([item()], false);
    expect(cycleWith([item({ checks: [check()] })], false, LATER).map((e) => e.type)).toEqual([
      'ci_succeeded',
    ]);
  });

  it("reports a reviewer MR's CI when the matrix asks for it", () => {
    cycleWith([reviewing()], true);
    expect(cycleWith([reviewing({ checks: [check()] })], true, LATER).map((e) => e.type)).toEqual([
      'ci_succeeded',
    ]);
  });

  it('does not retro-fire old results when a type is switched back on', () => {
    // The result was recorded (silently) while the setting was off; flipping it
    // must not produce a banner for a run that finished ages ago.
    cycleWith([reviewing()], false);
    cycleWith([reviewing({ checks: [check()] })], false, LATER);
    expect(cycleWith([reviewing({ checks: [check()] })], true, LATER)).toEqual([]);
  });

  it('never suggests starting a run on someone else\'s MR', () => {
    const gate: TestGate = { kind: 'unverified', provider: 'rwx', unverifiedCommits: 2, startable: true };
    cycleWith([reviewing()], false);
    expect(cycleWith([reviewing({ testGate: gate })], false, LATER)).toEqual([]);
    // ...but it does on mine. Distinct branch: the nudge's dedup key is
    // provider|branch|definition|sha, and the suppressed one above still
    // recorded its key — suppression is at the banner, not the bookkeeping.
    const own = { key: 'acme/rocket!1', iid: 1, branch: 'ENG-200', headSha: 'own-head' };
    cycleWith([item(own)], false);
    const mine = cycleWith([item({ ...own, testGate: gate })], false, LATER);
    expect(mine.map((e) => e.type)).toEqual(['ci_suggest_run']);
  });
});

describe('the notification matrix', () => {
  const cycleWith = (items: WatchItem[], notifyEvents: Record<string, string[]> | undefined, now = NOW) => {
    const { events, commit } = diff({
      db,
      items,
      todos: [],
      me: ME,
      now,
      ...(notifyEvents ? { notifyEvents: notifyEvents as never } : {}),
    });
    db.transaction(() => {
      commit(db);
      db.recordEvents(events, now, true);
    });
    return events;
  };
  const withComment = (over: Partial<WatchItem> = {}) =>
    item({ threads: [thread('T1', [note(1, 'alex.harper')])], ...over });

  it('notifies everything when no matrix is configured', () => {
    cycleWith([item()], undefined);
    expect(cycleWith([withComment()], undefined, LATER).map((e) => e.type)).toEqual(['comment']);
  });

  it('drops a type the bucket does not list', () => {
    const noComments = { authored: ['approval'], reviewer: [...EVENT_TYPES], participating: [] };
    cycleWith([item()], noComments);
    expect(cycleWith([withComment()], noComments, LATER)).toEqual([]);
  });

  it('routes the same event type differently per bucket', () => {
    // The user's example: comments on my reviews, nothing on drive-bys.
    const matrix = { authored: [...EVENT_TYPES], reviewer: ['comment'], participating: [] };
    const reviewer = { key: 'acme/rocket!11', iid: 11, reason: 'reviewer' as const };
    const drive = { key: 'acme/rocket!12', iid: 12, reason: 'participating' as const };
    cycleWith([item(reviewer), item(drive)], matrix);
    const events = cycleWith([withComment(reviewer), withComment(drive)], matrix, LATER);
    expect(events.map((e) => e.mrKey)).toEqual(['acme/rocket!11']);
  });

  it('suppresses at the banner, not at the bookkeeping', () => {
    // A comment that arrived while its type was off must not fire later when the
    // type is switched back on — you were not told, but it is not news either.
    const off = { authored: [], reviewer: [], participating: [] };
    cycleWith([item()], off);
    expect(cycleWith([withComment()], off, LATER)).toEqual([]);
    expect(cycleWith([withComment()], { authored: [...EVENT_TYPES], reviewer: [], participating: [] }, LATER)).toEqual([]);
  });
});

describe('review_updated (commits since my last review)', () => {
  const reviewing = (over: Partial<WatchItem> = {}) =>
    item({ reason: 'reviewer', myLastCommentAt: NOW, ...over });

  it('fires once per push, not once per cycle', () => {
    cycle([reviewing()]);
    const first = cycle([reviewing({ newCommits: 1 })], [], LATER);
    expect(first.map((e) => e.type)).toEqual(['review_updated']);
    expect(first[0]).toMatchObject({ mrKey: 'acme/rocket!7576', headSha: HEAD, since: NOW, count: 1 });
    // Same head, still updated: already said.
    expect(cycle([reviewing({ newCommits: 1 })], [], LATER)).toEqual([]);
  });

  it('fires again after the next push', () => {
    cycle([reviewing()]);
    cycle([reviewing({ newCommits: 1 })], [], LATER);
    const next = cycle([reviewing({ newCommits: 2, headSha: 'newhead' })], [], LATER);
    expect(next.map((e) => e.type)).toEqual(['review_updated']);
  });

  it('says nothing on the first sighting of an MR', () => {
    // Silent seeding: an MR that is already "updated" when we first see it
    // would otherwise fire on the cycle it appears, like every other signal.
    expect(cycle([reviewing({ newCommits: 1 })])).toEqual([]);
  });

  it('says nothing without the flag, or without a comment of mine', () => {
    cycle([reviewing()]);
    expect(cycle([reviewing()], [], LATER)).toEqual([]);
    const noComment = item({ reason: 'reviewer', newCommits: 1 });
    delete noComment.myLastCommentAt;
    cycle([item({ key: 'acme/rocket!2', iid: 2, reason: 'reviewer' })]);
    expect(cycle([{ ...noComment, key: 'acme/rocket!2', iid: 2 }], [], LATER)).toEqual([]);
  });

  it('persists my last comment and the head commit dates across a skipped fetch', () => {
    cycle([reviewing({ headCommitDates: [LATER, NOW] })]);
    const row = db.getMr('acme/rocket!7576');
    expect(row?.my_last_comment_at).toBe(NOW);
    expect(commitDates(row?.head_commit_dates ?? null)).toEqual([LATER, NOW]);
  });

  it('drops the cached commit dates when the head moves on', () => {
    cycle([reviewing({ headCommitDates: [LATER] })]);
    cycle([reviewing({ headSha: 'newhead' })], [], LATER);
    expect(db.getMr('acme/rocket!7576')?.head_commit_dates).toBeNull();
  });
});
