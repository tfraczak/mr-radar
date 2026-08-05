import type { RadarClient, Section } from '../client/radar-client';
import type { McpToolDef } from './protocol';

/**
 * The MCP tool registry — nine thin wrappers over RadarClient, sharing the
 * CLI's exact hybrid semantics and freshness envelopes. Descriptions are
 * written for the consuming model: they say when a tool works app-down, what
 * costs money, and what is safe to retry.
 */

const READ_ONLY = { readOnlyHint: true };

const obj = (
  properties: Record<string, unknown> = {},
  required?: string[],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required && required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

const KEY = {
  type: 'string',
  description: "MR key verbatim, e.g. 'group/repo!123' (GitLab) or 'owner/repo#123' (GitHub)",
};

export const makeTools = (client: RadarClient): McpToolDef[] => [
  {
    name: 'radar_status',
    description:
      'Health of MR Radar: whether the app is running, polling state, per-source health (gitlab/jira/rwx), unread count, and MR counts per section. Works app-down (falls back to the last poll, flagged stale).',
    inputSchema: obj(),
    annotations: READ_ONLY,
    handler: async () => client.status(),
  },
  {
    name: 'radar_mrs',
    description:
      "List watched merge requests with section, ticket, what-needs-attention, and CI state. Use the returned 'key' with radar_mr / radar_discussions / radar_start_run. Works app-down (reduced fields, flagged stale).",
    inputSchema: obj({
      section: {
        type: 'string',
        enum: ['active', 'needs', 'verification', 'done', 'other', 'ignored'],
        description: 'Only this popover section (live app only; ignored app-down)',
      },
      ticket: { type: 'string', description: 'Only MRs bound to this Jira key, e.g. ENG-123' },
    }),
    annotations: READ_ONLY,
    handler: async (args) =>
      client.listMrs({
        ...(typeof args.section === 'string' ? { section: args.section as Section } : {}),
        ...(typeof args.ticket === 'string' ? { ticket: args.ticket } : {}),
      }),
  },
  {
    name: 'radar_mr',
    description:
      'Full detail for one MR by key: attention, raw test gate, checks, approvals, ticket. Works app-down (DB scalars plus recent events, flagged stale).',
    inputSchema: obj({ key: KEY }, ['key']),
    annotations: READ_ONLY,
    handler: async (args) => client.itemDetail(String(args.key ?? '')),
  },
  {
    name: 'radar_discussions',
    description:
      'Review discussion threads for an MR with comment bodies, authors, and file/line anchors. Requires the running app (thread bodies live only in its memory). Default: unresolved threads only.',
    inputSchema: obj({ key: KEY, unresolvedOnly: { type: 'boolean', default: true } }, ['key']),
    annotations: READ_ONLY,
    handler: async (args) =>
      client.discussions(String(args.key ?? ''), args.unresolvedOnly !== false),
  },
  {
    name: 'radar_events',
    description:
      'Recent notification events (comments, approvals, CI results), newest first — the durable history. Works app-down.',
    inputSchema: obj({
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 30 },
      mrKey: KEY,
    }),
    annotations: READ_ONLY,
    handler: async (args) =>
      client.events(
        typeof args.limit === 'number' ? args.limit : 30,
        typeof args.mrKey === 'string' ? args.mrKey : undefined,
      ),
  },
  {
    name: 'radar_tickets',
    description:
      'Active Jira tickets in scope (summary, status, due date, fix versions), as cached at the last successful Jira fetch. Works app-down.',
    inputSchema: obj(),
    annotations: READ_ONLY,
    handler: async () => client.tickets(),
  },
  {
    name: 'radar_review_message',
    description:
      "Fresh ready-for-review check for one MR: re-fetches the MR, its Jira ticket, and CI, then reports whether it's announceable (right status, all checks green, no open threads) with the composed Slack message, or the blocking reasons. Requires the running app; takes a few seconds.",
    inputSchema: obj({ key: KEY }, ['key']),
    // Not readOnly: the check refreshes the app's in-memory item (and spends
    // forge/Jira/RWX API calls) even though it writes nothing anywhere.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: async (args) => client.reviewReady(String(args.key ?? '')),
  },
  {
    name: 'radar_set_ignored',
    description:
      "Mute or restore one MR. Ignored MRs move to the collapsed Ignored section, stop notifying, and stop counting toward totals, until the MR closes. Restoring a rule-ignored MR pins it visible. Requires the running app.",
    inputSchema: obj({ key: KEY, ignored: { type: 'boolean' } }, ['key', 'ignored']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args) => {
      if (typeof args.ignored !== 'boolean') throw new Error('ignored (boolean) is required');
      return client.setIgnored(String(args.key ?? ''), args.ignored);
    },
  },
  {
    name: 'radar_start_run',
    description:
      "Start an RWX CI run for an MR's current head commit. This launches a real CI run (costs CI minutes). Safe to retry: an already-in-flight run for the same commit is detected and returned instead of duplicated. Requires the running app.",
    inputSchema: obj({ key: KEY }, ['key']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (args) => client.startRun(String(args.key ?? '')),
  },
  {
    name: 'radar_set_polling',
    description:
      "Pause or resume MR Radar's background polling. Idempotent: pausing an already-paused radar reports changed=false. Requires the running app.",
    inputSchema: obj({ action: { type: 'string', enum: ['pause', 'resume'] } }, ['action']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args) => {
      if (args.action !== 'pause' && args.action !== 'resume') {
        throw new Error("action must be 'pause' or 'resume'");
      }
      return client.setPolling(args.action === 'resume');
    },
  },
  {
    name: 'radar_poll_now',
    description:
      'Trigger an immediate poll cycle. Returns at once; the poll runs in the background — call radar_status afterwards and compare lastPollAt to see the result. Requires the running app.',
    inputSchema: obj(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: async () => client.pollNow(),
  },
];
