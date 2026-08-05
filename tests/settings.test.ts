import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import {
  applyEditable,
  mergeSharedSettings,
  shareableSettings,
  toEditable,
  validateEditable,
} from '../src/main/settings';
import type { EditableSettings } from '../src/renderer/contract';

describe('settings sharing (export/import)', () => {
  const localRaw = {
    jira: { baseUrl: 'https://x.atlassian.net', email: 'me@co.com', activeStatuses: ['Code Review'] },
    gitlab: { userId: 1000001, username: 'mira.dev' },
    statusSections: { hidden: ['Backlog'], verification: ['QA'], done: ['Closed'] },
    notifications: { enabled: true, sound: 'Glass', method: 'auto' },
  };

  it('export strips identity — email and gitlab never leave the machine', () => {
    const shared = shareableSettings(localRaw);
    expect(shared.gitlab).toBeUndefined();
    expect((shared.jira as Record<string, unknown>).email).toBeUndefined();
    expect((shared.jira as Record<string, unknown>).baseUrl).toBe('https://x.atlassian.net');
    expect(shared.statusSections).toEqual(localRaw.statusSections);
  });

  it('import overlays team settings but keeps the local identity', () => {
    const fromTeammate = {
      jira: { baseUrl: 'https://x.atlassian.net', email: 'teammate@co.com', activeStatuses: ['To Do'] },
      gitlab: { userId: 999 },
      statusSections: { hidden: [], verification: ['In QA'], done: ['Closed'] },
      git: { updateStyle: 'merge' },
    };
    const merged = mergeSharedSettings(localRaw, fromTeammate);
    const jira = merged.jira as Record<string, unknown>;
    expect(jira.email).toBe('me@co.com'); // mine, not the teammate's
    expect(jira.activeStatuses).toEqual(['To Do']); // theirs — the shared part
    expect(merged.gitlab).toEqual(localRaw.gitlab); // identity untouched
    expect((merged.statusSections as Record<string, unknown>).verification).toEqual(['In QA']);
    expect((merged.git as Record<string, unknown>).updateStyle).toBe('merge');
  });
});

const editable = (over: Partial<EditableSettings> = {}): EditableSettings => ({
  ...toEditable(DEFAULT_CONFIG),
  jiraEmail: 'me@company.com',
  ...over,
});

describe('toEditable', () => {
  it('projects config into the editable shape', () => {
    const e = toEditable(DEFAULT_CONFIG);
    expect(e.activeStatuses).toEqual(DEFAULT_CONFIG.jira.activeStatuses);
    expect(e.pollBaseSeconds).toBe(DEFAULT_CONFIG.poll.baseSeconds);
    expect(e.activeHours.enabled).toBe(false); // no window by default
    expect(e.soundChoices).toContain('silent');
  });
});

describe('validateEditable', () => {
  it('accepts a well-formed settings object', () => {
    expect(validateEditable(editable())).toBeUndefined();
  });
  it('rejects a malformed email', () => {
    expect(validateEditable(editable({ jiraEmail: 'not-an-email' }))).toMatch(/email/i);
  });
  it('rejects a non-https or path-bearing Jira base URL', () => {
    expect(validateEditable(editable({ jiraBaseUrl: 'http://x.atlassian.net' }))).toMatch(/https/i);
    expect(validateEditable(editable({ jiraBaseUrl: 'https://x.atlassian.net/wiki' }))).toMatch(/https/i);
  });
  it('rejects a too-fast poll interval', () => {
    expect(validateEditable(editable({ pollBaseSeconds: 5 }))).toMatch(/15 seconds/);
  });
  it('requires at least one active status (or active assignment)', () => {
    // With assignments present they are the source of truth.
    expect(
      validateEditable(
        editable({ activeStatuses: [], statusAssignments: [{ status: 'Closed', section: 'done' }] }),
      ),
    ).toMatch(/active/i);
    // Without assignments, the plain list is validated.
    expect(validateEditable(editable({ activeStatuses: [], statusAssignments: [] }))).toMatch(/active/i);
  });
  it('validates active-hours times and days when enabled', () => {
    expect(
      validateEditable(editable({ activeHours: { enabled: true, days: [1], start: '8am', end: '19:00' } })),
    ).toMatch(/HH:MM/);
    expect(
      validateEditable(editable({ activeHours: { enabled: true, days: [], start: '08:00', end: '19:00' } })),
    ).toMatch(/day/i);
  });
});

describe('applyEditable', () => {
  it('folds edits in while preserving unknown keys', () => {
    const raw: Record<string, unknown> = { somethingAdvanced: 42, jira: { baseUrl: 'https://x.atlassian.net' } };
    const next = applyEditable(raw, editable({ jiraEmail: 'a@b.co', recentDaysFallback: 7 }));
    expect(next.somethingAdvanced).toBe(42); // untouched
    expect((next.jira as Record<string, unknown>).email).toBe('a@b.co');
    expect(next.recentDaysFallback).toBe(7);
  });

  it('writes status assignments into activeStatuses + statusSections', () => {
    const next = applyEditable(
      {},
      editable({
        statusAssignments: [
          { status: 'In Development', section: 'active' },
          { status: 'In QA', section: 'verification' },
          { status: 'Closed', section: 'done' },
          { status: 'Backlog', section: 'ignore' },
          { status: 'Weird Status', section: 'other' },
        ],
      }),
    );
    expect((next.jira as Record<string, unknown>).activeStatuses).toEqual(['In Development']);
    expect(next.statusSections).toEqual({
      hidden: ['Backlog'],
      verification: ['In QA'],
      done: ['Closed'],
    });
    // 'other' rows land in no list — that's the default bucket by omission.
  });

  it('sanitizes status rules on save — half-edited rows are dropped', () => {
    const next = applyEditable(
      {},
      editable({
        statusRules: [
          { status: 'Dev Complete', field: 'fixVersions', op: 'empty', then: 'active', else: 'verification' },
          { status: '', field: 'fixVersions', op: 'empty', then: 'active', else: 'other' }, // no status
          { status: 'QA', field: 'nonsense', op: 'empty', then: 'active', else: 'other' }, // bad field
        ],
      }),
    );
    expect(next.statusRules).toEqual([
      { status: 'Dev Complete', field: 'fixVersions', op: 'empty', then: 'active', else: 'verification' },
    ]);
    // Repo scope round-trips; empty string means any repo and is omitted.
    const scoped = applyEditable(
      {},
      editable({
        statusRules: [
          { status: 'QA', repo: 'acme/gadget', field: 'dueDate', op: 'past', then: 'active', else: 'next' },
          { status: 'QA', repo: '', field: 'dueDate', op: 'past', then: 'active', else: 'next' },
        ],
      }),
    );
    // 'next' means "no else" and is not persisted — absent else IS next.
    expect(scoped.statusRules).toEqual([
      { status: 'QA', repo: 'acme/gadget', field: 'dueDate', op: 'past', then: 'active' },
      { status: 'QA', field: 'dueDate', op: 'past', then: 'active' },
    ]);
  });

  it('persists chained conditions and drops malformed ones', () => {
    const next = applyEditable({}, editable({
      statusRules: [{
        status: 'QA', repo: '', field: 'fixVersions', op: 'empty', value: '',
        also: [
          { connector: 'and', field: 'issueType', op: 'matches', value: 'story' },
          { connector: 'nope', field: 'issueType', op: 'matches', value: 'x' },
          { connector: 'or', field: 'dueDate', op: 'always', value: '' },
        ],
        then: 'verification', else: 'next',
      }],
    }));
    expect(next.statusRules).toEqual([{
      status: 'QA', field: 'fixVersions', op: 'empty',
      also: [{ connector: 'and', field: 'issueType', op: 'matches', value: 'story' }],
      then: 'verification',
    }]);
  });

  it('round-trips theme + appearance, rejecting junk values', () => {
    const next = applyEditable({}, editable({ theme: 'pine', appearance: 'dark' }));
    expect(next.ui).toEqual({ theme: 'pine', appearance: 'dark', tabCounts: 'active' });
    const junk = applyEditable({}, editable({ theme: 'neon-vomit', appearance: 'dark' }));
    expect(junk.ui).toBeUndefined(); // unknown theme → not written
  });

  it('round-trips the branch update style, rejecting junk values', () => {
    const next = applyEditable({}, editable({ updateStyle: 'merge' }));
    expect((next.git as Record<string, unknown>).updateStyle).toBe('merge');
    const junk = applyEditable({}, editable({ updateStyle: 'yolo-push' }));
    expect(junk.git).toBeUndefined(); // not an enum value → not written
  });

  it('disabling the window keeps the settings, marked disabled', () => {
    const raw: Record<string, unknown> = { poll: { activeHours: { days: [1], start: '10:00', end: '16:00' } } };
    const next = applyEditable(raw, editable({ activeHours: { enabled: false, days: [1], start: '10:00', end: '16:00' } }));
    expect((next.poll as Record<string, unknown>).activeHours).toEqual({
      days: [1], start: '10:00', end: '16:00', enabled: false,
    });
  });

  it('re-enabling offers the previously saved window, not the defaults', () => {
    // Disable, then round-trip through the editable form: the user's own
    // window must come back, not 08:00-19:00.
    const disabled = applyEditable(
      { poll: { activeHours: { days: [2, 4], start: '06:30', end: '14:00' } } },
      editable({ activeHours: { enabled: false, days: [2, 4], start: '06:30', end: '14:00' } }),
    );
    const form = toEditable(disabled as never);
    expect(form.activeHours).toEqual({ enabled: false, days: [2, 4], start: '06:30', end: '14:00' });
  });

  it('a never-configured window stays absent when saved disabled', () => {
    const next = applyEditable({}, editable({ activeHours: { enabled: false, days: [1], start: '08:00', end: '19:00' } }));
    expect((next.poll as Record<string, unknown>).activeHours).toBeUndefined();
  });

  it('writes poll.activeHours when the window is enabled', () => {
    const next = applyEditable({}, editable({ activeHours: { enabled: true, days: [1, 2], start: '09:00', end: '17:00' } }));
    expect((next.poll as Record<string, unknown>).activeHours).toEqual({ days: [1, 2], start: '09:00', end: '17:00' });
  });

  it('stores repo checkouts and drops all-blank rows entirely', () => {
    const next = applyEditable({}, editable({
      repos: [
        { projectPath: 'acme/rocket', checkout: '/Users/x/code/rocket', rwxDefinition: '.rwx/ci.yml', testGate: 'auto' },
        { projectPath: 'acme/gadget', checkout: '', rwxDefinition: '', testGate: 'auto' },
        { projectPath: 'acme/ops-scripts', checkout: '', rwxDefinition: '', testGate: 'none' },
      ],
    }));
    const repos = next.repos as Record<string, { checkout?: string; rwxDefinition?: string }>;
    expect(repos['acme/rocket'].checkout).toBe('/Users/x/code/rocket');
    // A gate pin alone is worth keeping — 'none' silences a repo without a checkout.
    expect(repos['acme/ops-scripts']).toEqual({ testGate: 'none' });
    // A row with nothing set writes no entry at all — seen repos surface as
    // blank rows every session and must not accumulate {} clutter in config.
    expect(repos['acme/gadget']).toBeUndefined();
  });
});

describe('Copy-for-Slack settings', () => {
  it('round-trips ready statuses and the template through the editable form', () => {
    const editable = toEditable({
      ...DEFAULT_CONFIG,
      slack: { readyStatuses: ['Code Review', 'In Review'], template: '{ticketKey}: {title}' },
    });
    expect(editable.slackReadyStatuses).toEqual(['Code Review', 'In Review']);
    expect(editable.slackTemplate).toBe('{ticketKey}: {title}');

    const raw = applyEditable({}, {
      ...editable,
      slackReadyStatuses: ['Dev Complete', '  '],
      slackTemplate: '  new template {title} ',
    });
    expect(raw.slack).toEqual({ readyStatuses: ['Dev Complete'], template: 'new template {title}' });
  });

  it('a blank template falls back to the existing/default one', () => {
    const raw = applyEditable(
      { slack: { readyStatuses: [], template: 'keep me' } },
      { ...toEditable(DEFAULT_CONFIG), slackReadyStatuses: ['Code Review'], slackTemplate: '   ' },
    );
    expect(raw.slack).toEqual({ readyStatuses: ['Code Review'], template: 'keep me' });
  });
});

describe('tab counts setting', () => {
  it('round-trips through the editable form', () => {
    const editable = toEditable({ ...DEFAULT_CONFIG, ui: { ...DEFAULT_CONFIG.ui, tabCounts: 'all' } });
    expect(editable.tabCounts).toBe('all');
    expect(editable.tabCountsChoices).toEqual(['active', 'all']);
    const raw = applyEditable({}, { ...editable, tabCounts: 'active' });
    expect((raw.ui as { tabCounts: string }).tabCounts).toBe('active');
    // Junk values are dropped rather than persisted.
    const junk = applyEditable({}, { ...editable, tabCounts: 'everything' });
    expect((junk.ui as { tabCounts?: string }).tabCounts).toBeUndefined();
  });
});

describe('owner fields (the "Dev Resource" abstraction)', () => {
  it('round-trips through the editable form, sanitizing entries', () => {
    const editable = toEditable({
      ...DEFAULT_CONFIG,
      jira: {
        ...DEFAULT_CONFIG.jira,
        ownerFields: [{ clause: 'cf[10123]', label: 'Dev Resource' }],
      },
    });
    expect(editable.ownerFields).toEqual([{ clause: 'cf[10123]', label: 'Dev Resource' }]);

    const raw = applyEditable({}, {
      ...editable,
      ownerFields: [
        { clause: ' assignee ', label: ' Assignee ' },
        { clause: '', label: 'dropped' },
        { clause: 'cf[10123]', label: '' }, // label falls back to the clause
      ],
    });
    expect((raw.jira as { ownerFields: unknown }).ownerFields).toEqual([
      { clause: 'assignee', label: 'Assignee' },
      { clause: 'cf[10123]', label: 'cf[10123]' },
    ]);
  });

  it('an all-blank payload keeps the existing config value (old UI shells)', () => {
    const raw = applyEditable(
      { jira: { ownerFields: [{ clause: 'assignee', label: 'Assignee' }] } },
      { ...toEditable(DEFAULT_CONFIG), ownerFields: [{ clause: ' ', label: '' }] },
    );
    expect((raw.jira as { ownerFields: unknown }).ownerFields).toEqual([
      { clause: 'assignee', label: 'Assignee' },
    ]);
  });

  it('is part of the shareable team conventions', () => {
    const shared = shareableSettings({
      jira: { email: 'me@x.com', ownerFields: [{ clause: 'cf[1]', label: 'Dev Resource' }] },
    });
    expect((shared.jira as { ownerFields: unknown }).ownerFields).toEqual([
      { clause: 'cf[1]', label: 'Dev Resource' },
    ]);
    expect((shared.jira as { email?: unknown }).email).toBeUndefined(); // identity stays out
  });
});
