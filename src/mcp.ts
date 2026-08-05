#!/usr/bin/env node
/**
 * MCP stdio server — the protocol twin of radar-cli, for agent clients that
 * speak MCP instead of shelling out:
 *
 *   claude mcp add mr-radar -- node --no-warnings /path/to/mr-radar/dist/mcp.js
 *
 * stdout carries newline-delimited JSON-RPC frames and NOTHING else; all
 * logging goes to stderr (MCP clients surface it in their server logs). The
 * client owns our lifetime: when it closes our stdin, we exit. No pidfile —
 * several clients may each run their own instance; the server is stateless
 * (read-only DB handles are opened per call inside RadarClient and closed).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { RadarClient } from './client/radar-client';
import { createSession, handleMessage, parseError, type McpServerInfo } from './mcp/protocol';
import { makeTools } from './mcp/tools';

const log = (msg: string): void => {
  process.stderr.write(`[mr-radar mcp] ${new Date().toISOString()} ${msg}\n`);
};

const version = (): string => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
};

const SERVER: McpServerInfo = {
  name: 'mr-radar',
  version: version(),
  instructions:
    'MR Radar watches merge requests correlated with Jira tickets and CI. Read tools ' +
    '(radar_status, radar_mrs, radar_mr, radar_events, radar_tickets) work even when the ' +
    'app is not running — results carry {source: "db", stale: true} and reflect the last ' +
    'completed poll. radar_discussions and the action tools (radar_start_run, ' +
    'radar_set_polling, radar_poll_now) need the live app and fail with guidance otherwise. ' +
    "MR keys are verbatim references like 'group/repo!123' or 'owner/repo#123'.",
};

const main = (): void => {
  const session = createSession();
  const tools = makeTools(new RadarClient());
  const write = (reply: unknown): void => {
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  };

  // The client closing our stdin is the shutdown signal — but a request may
  // still be executing (start-run awaits the rwx CLI); drain before exiting.
  let pending = 0;
  let stdinClosed = false;
  const maybeExit = (): void => {
    if (stdinClosed && pending === 0) process.exit(0);
  };

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      write(parseError());
      return;
    }
    // Async per line; responses may interleave, which JSON-RPC ids permit.
    pending += 1;
    void handleMessage(session, message, tools, SERVER)
      .then((reply) => {
        if (reply === undefined) return;
        if (Array.isArray(reply)) for (const r of reply) write(r);
        else write(reply);
      })
      .catch((err) => {
        log(`unhandled: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      })
      .finally(() => {
        pending -= 1;
        maybeExit();
      });
  });

  rl.on('close', () => {
    stdinClosed = true;
    maybeExit();
  });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  log(`ready (pid ${process.pid}, v${SERVER.version})`);
};

main();
