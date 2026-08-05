import { describe, expect, it } from 'vitest';
import { AppDownError, type RadarClient } from '../src/client/radar-client';
import { runCommand, type CliDeps } from '../src/radar-cli';

/** Literal fake client + captured output; no process I/O anywhere. */
const harness = (client: Partial<Record<keyof RadarClient, unknown>>) => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    client: client as unknown as RadarClient,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    isTTY: false,
  };
  return { deps, out, err };
};

const run = (argv: string[], client: Partial<Record<keyof RadarClient, unknown>>) => {
  const h = harness(client);
  return runCommand(argv, h.deps).then((code) => ({ code, out: h.out, err: h.err }));
};

describe('radar-cli', () => {
  it('help exits 0 and documents the exit-code contract', async () => {
    const { code, out } = await run(['help'], {});
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('exit 2');
  });

  it('status --json passes the envelope through verbatim', async () => {
    const status = { source: 'live', dataAsOf: 't', appRunning: true, counts: { active: 2 } };
    const { code, out } = await run(['status', '--json'], { status: async () => status });
    expect(code).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual(status);
  });

  it('surfaces the stale banner on human output', async () => {
    const { out } = await run(['status'], {
      status: async () => ({
        source: 'db',
        stale: true,
        staleNote: 'MR Radar is not running; data is from the last completed poll.',
        appRunning: false,
        counts: { total: 3 },
      }),
    });
    expect(out[0]).toContain('not running');
  });

  it('rejects an invalid --section before calling the client', async () => {
    const { code, err } = await run(['list', '--section', 'bogus'], {});
    expect(code).toBe(1);
    expect(err[0]).toContain('--section must be one of');
  });

  it('actions map AppDownError to exit 2 with a machine shape under --json', async () => {
    const { code, out } = await run(['run', 'acme/rocket!1', '--json'], {
      startRun: async () => {
        throw new AppDownError(8942);
      },
    });
    expect(code).toBe(2);
    expect(JSON.parse(out[0]!)).toMatchObject({ error: 'app_not_running' });
  });

  it('run exits 1 when the trigger is refused (e.g. not startable)', async () => {
    const { code, out } = await run(['run', 'acme/rocket!1'], {
      startRun: async () => ({ started: false, message: 'Tests already passed for this commit.' }),
    });
    expect(code).toBe(1);
    expect(out[0]).toContain('already passed');
  });

  it('pause/resume are idempotent and say so', async () => {
    const { code, out } = await run(['pause'], {
      setPolling: async (enabled: boolean) => ({ enabled, changed: false }),
    });
    expect(code).toBe(0);
    expect(out[0]).toContain('(already was)');
  });

  it('events forwards limit and mr filters', async () => {
    const seen: unknown[] = [];
    const { code } = await run(['events', '--limit', '5', '--mr', 'acme/rocket!1'], {
      events: async (limit: number, mr?: string) => {
        seen.push([limit, mr]);
        return { source: 'db', events: [] };
      },
    });
    expect(code).toBe(0);
    expect(seen).toEqual([[5, 'acme/rocket!1']]);
  });

  it('discussions renders bodies with file anchors', async () => {
    const { out } = await run(['discussions', 'acme/rocket!1'], {
      discussions: async () => ({
        source: 'live',
        dataAsOf: 't',
        threads: [
          {
            id: 'T1',
            resolved: false,
            resolvable: true,
            filePath: 'app/models/widget.rb',
            line: 12,
            notes: [{ id: 1, author: 'mira.dev', body: 'rename this\nplease', createdAt: 't' }],
          },
        ],
      }),
    });
    expect(out.join('\n')).toContain('app/models/widget.rb:12');
    expect(out.join('\n')).toContain('rename this');
  });

  it('unknown commands and options fail fast', async () => {
    expect((await run(['frobnicate'], {})).code).toBe(1);
    expect((await run(['list', '--wat'], {})).code).toBe(1);
    expect((await run(['show'], {})).code).toBe(1);
  });
});
