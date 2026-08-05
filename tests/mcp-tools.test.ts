import { describe, expect, it } from 'vitest';
import { AppDownError, type RadarClient } from '../src/client/radar-client';
import { makeTools } from '../src/mcp/tools';

const toolsWith = (client: Partial<Record<keyof RadarClient, unknown>>) =>
  makeTools(client as unknown as RadarClient);

const find = (tools: ReturnType<typeof makeTools>, name: string) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
};

describe('mcp tool registry', () => {
  it('exposes exactly the nine planned tools, reads annotated read-only', () => {
    const tools = toolsWith({});
    expect(tools.map((t) => t.name)).toEqual([
      'radar_status',
      'radar_mrs',
      'radar_mr',
      'radar_discussions',
      'radar_events',
      'radar_tickets',
      'radar_start_run',
      'radar_set_polling',
      'radar_poll_now',
    ]);
    for (const name of ['radar_status', 'radar_mrs', 'radar_mr', 'radar_discussions', 'radar_events', 'radar_tickets']) {
      expect(find(tools, name).annotations).toMatchObject({ readOnlyHint: true });
    }
    expect(find(tools, 'radar_start_run').annotations).toMatchObject({ idempotentHint: false });
  });

  it('passes filters through and envelopes come back verbatim', async () => {
    const seen: unknown[] = [];
    const tools = toolsWith({
      listMrs: async (filter: unknown) => {
        seen.push(filter);
        return { source: 'db', stale: true, staleNote: 'n', mrs: [] };
      },
    });
    const got = await find(tools, 'radar_mrs').handler({ section: 'active', ticket: 'ENG-1' });
    expect(seen).toEqual([{ section: 'active', ticket: 'ENG-1' }]);
    expect(got).toMatchObject({ source: 'db', stale: true });
  });

  it('radar_set_polling maps pause/resume onto the idempotent endpoint', async () => {
    const seen: boolean[] = [];
    const tools = toolsWith({
      setPolling: async (enabled: boolean) => {
        seen.push(enabled);
        return { enabled, changed: true };
      },
    });
    await find(tools, 'radar_set_polling').handler({ action: 'pause' });
    await find(tools, 'radar_set_polling').handler({ action: 'resume' });
    expect(seen).toEqual([false, true]);
    await expect(find(tools, 'radar_set_polling').handler({ action: 'flip' })).rejects.toThrow(
      /pause.*resume/,
    );
  });

  it('lets AppDownError propagate so the protocol layer emits isError with guidance', async () => {
    const tools = toolsWith({
      startRun: async () => {
        throw new AppDownError(8942);
      },
    });
    await expect(find(tools, 'radar_start_run').handler({ key: 'acme/rocket!1' })).rejects.toThrow(
      /not running.*tray:restart/s,
    );
  });

  it('discussions default to unresolved-only, overridable', async () => {
    const seen: unknown[] = [];
    const tools = toolsWith({
      discussions: async (key: string, unresolvedOnly: boolean) => {
        seen.push([key, unresolvedOnly]);
        return { source: 'live', threads: [] };
      },
    });
    await find(tools, 'radar_discussions').handler({ key: 'k' });
    await find(tools, 'radar_discussions').handler({ key: 'k', unresolvedOnly: false });
    expect(seen).toEqual([
      ['k', true],
      ['k', false],
    ]);
  });
});
