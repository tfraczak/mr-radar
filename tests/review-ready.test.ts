import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/core/config';
import { reviewMessage, reviewMessageParts, reviewReadiness } from '../src/core/review-ready';
import type { Check, JiraTicket, TestGate, WatchItem } from '../src/core/types';

const READY = ['Code Review'];

const ticket = (status = 'Code Review'): JiraTicket => ({
  key: 'ENG-42',
  summary: 'Add the widget',
  status,
  updated: '',
  url: 'https://acme.atlassian.net/browse/ENG-42',
});

const gate = (over: Partial<Record<string, unknown>> = {}): TestGate =>
  ({ kind: 'verified', provider: 'rwx', result: 'succeeded', url: 'u', name: '.rwx/ci.yml', ...over }) as TestGate;

const check = (over: Partial<Check> = {}): Check => ({
  provider: 'gitlab',
  role: 'lint',
  name: 'pipeline',
  sha: 'head',
  state: 'succeeded',
  url: '',
  id: '1',
  createdAt: '',
  ...over,
});

let n = 0;
const item = (over: Partial<WatchItem> = {}): WatchItem => {
  n += 1;
  return {
    key: `acme/rocket!${n}`,
    projectPath: 'acme/rocket',
    projectId: 1,
    iid: n,
    branch: 'ENG-42',
    targetBranch: 'main',
    title: 'ENG-42: Add the widget',
    headSha: 'head',
    webUrl: 'https://gitlab.example/mr/1',
    updatedAt: '',
    createdAt: '',
    userNotesCount: 0,
    draft: false,
    hasConflicts: false,
    reason: 'authored',
    inScope: true,
    ticket: ticket(),
    threads: [],
    testGate: gate(),
    checks: [check()],
    ...over,
  };
};

describe('reviewReadiness', () => {
  it('a green, discussed-out, correctly-statused MR is eligible', () => {
    expect(reviewReadiness(item(), READY)).toEqual({ eligible: true, reasons: [] });
  });

  it('wrong ticket status / missing ticket both block, with names', () => {
    const wrong = reviewReadiness(item({ ticket: ticket('In Development') }), READY);
    expect(wrong.eligible).toBe(false);
    expect(wrong.reasons[0]).toContain("'In Development'");
    const none = item();
    delete none.ticket;
    expect(reviewReadiness(none, READY).reasons[0]).toContain('No Jira ticket');
  });

  it('draft, conflicts, and open threads each block with their own reason', () => {
    const r = reviewReadiness(
      item({
        draft: true,
        hasConflicts: true,
        threads: [
          { id: 'T1', resolved: false, resolvable: true, notes: [] },
          { id: 'T2', resolved: false, resolvable: true, notes: [] },
        ],
      }),
      READY,
    );
    expect(r.reasons).toHaveLength(3);
    expect(r.reasons.join(' ')).toMatch(/draft/);
    expect(r.reasons.join(' ')).toMatch(/conflict/);
    expect(r.reasons.join(' ')).toMatch(/2 review threads are still open/);
  });

  it('uses the fallback count when the thread list was not fetched', () => {
    const stale = item({ unresolvedFallback: 1 });
    delete stale.threads;
    expect(reviewReadiness(stale, READY).reasons.join(' ')).toMatch(/1 review thread is/);
  });

  it("a 'none' gate (production-scripts) waives the CI requirement entirely", () => {
    const r = reviewReadiness(item({ testGate: { kind: 'none' }, checks: [] }), READY);
    expect(r.eligible).toBe(true);
  });

  it('gate failures, running gates, and never-run gates all block', () => {
    expect(reviewReadiness(item({ testGate: gate({ result: 'failed' }) }), READY).reasons[0]).toContain('Tests failed');
    expect(
      reviewReadiness(item({ testGate: { kind: 'in_progress', provider: 'rwx' } }), READY).reasons[0],
    ).toContain('still in progress');
    const never = reviewReadiness(
      item({ testGate: { kind: 'unverified', provider: 'rwx', unverifiedCommits: 1, startable: true } }),
      READY,
    );
    expect(never.reasons[0]).toContain('start an RWX run');
  });

  it('the juno case: RWX gate green but the pipeline failed → blocked', () => {
    const r = reviewReadiness(item({ checks: [check({ state: 'failed', name: 'rspec pipeline' })] }), READY);
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toBe('rspec pipeline failed.');
  });

  it('a stale secondary suite (older commit) does NOT block — one-off runs must not veto forever', () => {
    expect(reviewReadiness(item({ checks: [check({ sha: 'older-commit', state: 'failed' })] }), READY).eligible).toBe(true);
  });

  it('a secondary suite still running for the head commit blocks', () => {
    const r = reviewReadiness(item({ checks: [check({ state: 'in_progress' })] }), READY);
    expect(r.reasons[0]).toContain('still running');
  });

  it("a failed 'tests'-role check is the gate's story, not a duplicate reason", () => {
    const r = reviewReadiness(
      item({
        testGate: gate({ result: 'failed' }),
        checks: [check({ role: 'tests', name: '.rwx/ci.yml', state: 'failed' })],
      }),
      READY,
    );
    expect(r.reasons).toEqual(['Tests failed (.rwx/ci.yml).']);
  });

  it('an unresolved (undefined) gate asks for a retry instead of guessing', () => {
    const fresh = item();
    delete fresh.testGate;
    expect(reviewReadiness(fresh, READY).reasons[0]).toContain('not resolved yet');
  });
});

describe('reviewMessage', () => {
  const config = {
    ...DEFAULT_CONFIG,
    jira: { ...DEFAULT_CONFIG.jira, baseUrl: 'https://acme.atlassian.net' },
  } as Config;

  it('renders the default template with ticket link and title', () => {
    expect(reviewMessage(item(), config)).toBe(
      'hey team! https://acme.atlassian.net/browse/ENG-42 is ready for review. Add the widget',
    );
  });

  it('honors custom templates and every placeholder', () => {
    const custom = {
      ...config,
      slack: { ...config.slack, template: '{ticketKey} | {ticketUrl} | {title} | {mrUrl}' },
    } as Config;
    expect(reviewMessage(item(), custom)).toBe(
      'ENG-42 | https://acme.atlassian.net/browse/ENG-42 | Add the widget | https://gitlab.example/mr/1',
    );
  });
});

describe('reviewMessageParts — the two clipboard flavors', () => {
  const config = {
    ...DEFAULT_CONFIG,
    jira: { ...DEFAULT_CONFIG.jira, baseUrl: 'https://acme.atlassian.net' },
  } as Config;
  const withTemplate = (template: string): Config =>
    ({ ...config, slack: { ...config.slack, template } }) as Config;

  it('renders [text](url) as a hyperlink in HTML and as text (url) in plain', () => {
    const parts = reviewMessageParts(item(), withTemplate('hey! [{ticketKey}]({ticketUrl}) is ready. {title}'));
    expect(parts.text).toBe(
      'hey! ENG-42 (https://acme.atlassian.net/browse/ENG-42) is ready. Add the widget',
    );
    expect(parts.html).toBe(
      'hey! <a href="https://acme.atlassian.net/browse/ENG-42">ENG-42</a> is ready. Add the widget',
    );
  });

  it('a label that IS the url skips the redundant parenthetical in plain', () => {
    const parts = reviewMessageParts(item(), withTemplate('see [{ticketUrl}]({ticketUrl})'));
    expect(parts.text).toBe('see https://acme.atlassian.net/browse/ENG-42');
  });

  it('escapes markup from external text (MR titles) in the HTML flavor', () => {
    const hostile = item({ title: 'Fix <script>alert(1)</script> & stuff' });
    const parts = reviewMessageParts(hostile, withTemplate('{title}'));
    expect(parts.html).toBe('Fix &lt;script&gt;alert(1)&lt;/script&gt; &amp; stuff');
    expect(parts.text).toBe('Fix <script>alert(1)</script> & stuff');
  });

  it('a template with no links yields identical text and (escaped) html', () => {
    const parts = reviewMessageParts(item(), config);
    expect(parts.text).toBe(reviewMessage(item(), config));
    expect(parts.html).toContain('is ready for review');
    expect(parts.html).not.toContain('<a ');
  });

  it('malformed link syntax passes through verbatim', () => {
    const parts = reviewMessageParts(item(), withTemplate('[unclosed({mrUrl}) and [no-url]'));
    expect(parts.text).toBe('[unclosed(https://gitlab.example/mr/1) and [no-url]');
    expect(parts.html).not.toContain('<a ');
  });
});

describe('{title} strips the bound ticket key', () => {
  const config = {
    ...DEFAULT_CONFIG,
    jira: { ...DEFAULT_CONFIG.jira, baseUrl: 'https://acme.atlassian.net' },
    slack: { ...DEFAULT_CONFIG.slack, template: '{title}' },
  } as Config;
  const titled = (title: string) => reviewMessage(item({ title }), config);

  it('strips common lead-ins: colon, brackets, dash, case-insensitive', () => {
    expect(titled('ENG-42: Add the widget')).toBe('Add the widget');
    expect(titled('[ENG-42] Add the widget')).toBe('Add the widget');
    expect(titled('eng-42 - Add the widget')).toBe('Add the widget');
    expect(titled('ENG-42 Add the widget')).toBe('Add the widget');
  });

  it("keeps other tickets' keys, mid-title mentions, and bare-key titles", () => {
    expect(titled('ENG-99: Add the widget')).toBe('ENG-99: Add the widget'); // not the bound key
    expect(titled('Add the ENG-42 widget')).toBe('Add the ENG-42 widget'); // not leading
    expect(titled('ENG-42')).toBe('ENG-42'); // stripping would leave nothing
  });

  it('leaves the title alone when no ticket is bound', () => {
    const unbound = item({ title: 'ENG-42: Add the widget' });
    delete unbound.ticket;
    const cfg = { ...config, slack: { ...config.slack, template: '{title}' } } as Config;
    expect(reviewMessage(unbound, cfg)).toBe('ENG-42: Add the widget');
  });
});

describe('empty ready-status list', () => {
  it('reads as "feature off", not a per-ticket status mismatch', () => {
    const r = reviewReadiness(item(), []);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toEqual([
      'No ready-for-review statuses are configured (Settings → Slack).',
    ]);
  });
});
