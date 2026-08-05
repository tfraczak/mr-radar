import type { Config } from './config';
import { unresolvedCount } from './correlate';
import type { WatchItem } from './types';

/**
 * "Is this MR ready to announce for code review?" — the predicate behind the
 * Copy-for-Slack button.
 *
 * Pure and reason-listing by design: the same function paints the button from
 * (possibly minutes-old) snapshot data and delivers the verdict after the
 * fresh single-MR re-check, and a refusal must always say exactly why.
 *
 * The CI requirement is per-repo without any new setting: a repo whose
 * detected/pinned test gate is 'none' (production-scripts) has nothing to
 * pass; everywhere else the gate must be verified green for the CURRENT head
 * commit AND every current-head check must be green — which is what makes
 * juno require RWX *and* its pipeline, not just the pipeline.
 */
export interface ReviewReadiness {
  eligible: boolean;
  /** Human sentences, each one an unmet requirement. Empty = eligible. */
  reasons: string[];
}

export const reviewReadiness = (item: WatchItem, readyStatuses: string[]): ReviewReadiness => {
  const reasons: string[] = [];
  const ready = new Set(readyStatuses.map((s) => s.toLowerCase()));

  if (readyStatuses.length === 0) {
    // Savable state (every chip removed) = the feature is off; say so rather
    // than emitting a baffling "X is not one of: " for every ticket.
    return {
      eligible: false,
      reasons: ['No ready-for-review statuses are configured (Settings → Slack).'],
    };
  }

  if (!item.ticket) {
    reasons.push('No Jira ticket is bound to this MR.');
  } else if (!ready.has(item.ticket.status.toLowerCase())) {
    reasons.push(
      `${item.ticket.key} is '${item.ticket.status}', not ${readyStatuses.length === 1 ? `'${readyStatuses[0]}'` : `one of: ${readyStatuses.join(', ')}`}.`,
    );
  }

  if (item.draft) reasons.push('The MR is still marked as a draft.');
  if (item.hasConflicts) reasons.push('The MR has merge conflicts.');

  const unresolved = item.threads ? unresolvedCount(item.threads) : (item.unresolvedFallback ?? 0);
  if (unresolved > 0) {
    reasons.push(`${unresolved} review thread${unresolved === 1 ? ' is' : 's are'} still open.`);
  }

  reasons.push(...ciReasons(item));
  return { eligible: reasons.length === 0, reasons };
};

const ciReasons = (item: WatchItem): string[] => {
  const gate = item.testGate;
  const reasons: string[] = [];

  // No gate resolved at all = the repo has never been through a cycle's CI
  // resolution; a fresh check will fill it in. Say so rather than guessing.
  if (gate === undefined) return ['CI state is not resolved yet — try again in a moment.'];

  switch (gate.kind) {
    case 'none':
      break; // repo has no test CI (e.g. production-scripts) — nothing to pass
    case 'verified':
      if (gate.result === 'failed') reasons.push(`Tests failed (${gate.name}).`);
      break;
    case 'in_progress':
      reasons.push('A test run is still in progress.');
      break;
    case 'unverified':
      reasons.push(
        gate.startable
          ? 'Tests have not run for the head commit — start an RWX run first.'
          : 'Tests have not run for the head commit yet.',
      );
      break;
  }

  // Beyond the gate, every SECONDARY suite that ran for the CURRENT head must
  // be green (juno: the pipeline check is sha-filtered, so it is either for
  // the head or absent — and a brand-new head is already caught by the gate
  // going unverified). 'tests'-role suites are the gate's to judge, and a
  // stale secondary run (older commit) is deliberately not blocking: a one-off
  // definition that ran once months ago must not veto announcements forever.
  for (const check of item.checks ?? []) {
    if (check.role === 'tests' || check.sha !== item.headSha) continue;
    if (check.state === 'failed') reasons.push(`${check.name} failed.`);
    else if (check.state === 'in_progress' || check.state === 'waiting') {
      reasons.push(`${check.name} is still ${check.state === 'in_progress' ? 'running' : 'waiting'}.`);
    }
  }

  // Deliberately NO "side suite must exist for the head" rule. Live data
  // killed two attempts at one: side suites can be conditional (juno's
  // flow-client is path-filtered and legitimately absent for backend-only
  // heads) and old pipelines scroll out of the API page — both false-block.
  // Accepted edge: a canceled/[ci skip] pipeline that produced no judgeable
  // result does not block; the gate, thread, and status checks still must
  // pass, all verified fresh.
  return [...new Set(reasons)];
};

/**
 * Markdown-style named links in the template: `[text](https://…)`. The two
 * clipboard flavors render them differently — rich targets (Slack's composer)
 * read the HTML flavor and paste a real hyperlink; plain targets get
 * `text (url)`.
 */
const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

const escapeHtml = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/**
 * Render the announce message in both clipboard flavors.
 * Placeholders: {ticketKey} {ticketUrl} {title} {mrUrl}; links: [text](url).
 */
export const reviewMessageParts = (
  item: WatchItem,
  config: Config,
): { text: string; html: string } => {
  const key = item.ticket?.key ?? '';
  const values: Record<string, string> = {
    ticketKey: key,
    ticketUrl:
      item.ticket?.url ?? (key && config.jira.baseUrl ? `${config.jira.baseUrl}/browse/${key}` : item.webUrl),
    title: stripLeadingKey(item.title, key),
    mrUrl: item.webUrl,
  };
  // Single pass: substituted text (an MR title containing '{mrUrl}') is never
  // itself rescanned for placeholders.
  const substituted = config.slack.template.replace(
    /\{(ticketKey|ticketUrl|title|mrUrl)\}/g,
    (_, name: string) => values[name] ?? '',
  );

  let text = '';
  let html = '';
  let last = 0;
  for (const m of substituted.matchAll(LINK_RE)) {
    const [whole, label, url] = m as unknown as [string, string, string];
    const before = substituted.slice(last, m.index);
    text += before;
    html += escapeHtml(before);
    // Plain flavor: skip the parenthetical when the label IS the url.
    text += label === url ? url : `${label} (${url})`;
    html += `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
    last = (m.index ?? 0) + whole.length;
  }
  const rest = substituted.slice(last);
  text += rest;
  html += escapeHtml(rest);
  return { text, html: html.replaceAll('\n', '<br>') };
};

/** The plain-text flavor alone — what the CLI prints and tests assert. */
export const reviewMessage = (item: WatchItem, config: Config): string =>
  reviewMessageParts(item, config).text;

/**
 * {title} is the SUBJECT, not the raw MR title: a leading mention of the
 * bound ticket's key ('ENG-42: …', '[ENG-42] …', 'eng-42 - …') is stripped,
 * because the key is its own variable and 'ENG-42 … ENG-42: subject' reads
 * twice. Only the bound key is stripped — a title leading with some OTHER
 * ticket's key keeps it, and a title that IS just the key stays whole.
 */
const stripLeadingKey = (title: string, key: string): string => {
  if (!key) return title;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = title.replace(new RegExp(`^\\[?${escaped}\\]?[\\s:\\-–—]*`, 'i'), '').trim();
  return stripped || title;
};
