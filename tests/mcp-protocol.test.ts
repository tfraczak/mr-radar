import { describe, expect, it } from 'vitest';
import {
  createSession,
  handleMessage,
  parseError,
  SUPPORTED_VERSIONS,
  type McpServerInfo,
  type McpToolDef,
} from '../src/mcp/protocol';

const SERVER: McpServerInfo = { name: 'mr-radar', version: '0.2.0', instructions: 'hybrid rules' };

const tools: McpToolDef[] = [
  {
    name: 'echo',
    description: 'echoes',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    handler: async (args) => ({ echoed: args }),
  },
  {
    name: 'boom',
    description: 'always fails',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      throw new Error('MR Radar is not running — start it.');
    },
  },
];

const req = (method: string, params?: unknown, id: number | string | null = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});

const call = (message: unknown) => handleMessage(createSession(), message, tools, SERVER);

describe('initialize', () => {
  it('echoes a supported protocol version and carries instructions', async () => {
    const got = (await call(req('initialize', { protocolVersion: '2024-11-05' }))) as {
      result: { protocolVersion: string; instructions: string; capabilities: unknown };
    };
    expect(got.result.protocolVersion).toBe('2024-11-05');
    expect(got.result.instructions).toBe('hybrid rules');
    expect(got.result.capabilities).toEqual({ tools: { listChanged: false } });
  });

  it('answers an unknown requested version with our newest', async () => {
    const got = (await call(req('initialize', { protocolVersion: '2099-01-01' }))) as {
      result: { protocolVersion: string };
    };
    expect(got.result.protocolVersion).toBe(SUPPORTED_VERSIONS[0]);
  });
});

describe('protocol plumbing', () => {
  it('ignores notifications, including unknown ones', async () => {
    expect(await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
    expect(await call({ jsonrpc: '2.0', method: 'notifications/whatever' })).toBeUndefined();
  });

  it('answers ping with an empty result', async () => {
    expect(await call(req('ping'))).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('rejects unknown methods with -32601 and bad shapes with -32600', async () => {
    const unknown = (await call(req('resources/list'))) as { error: { code: number } };
    expect(unknown.error.code).toBe(-32601);
    const bad = (await call({ id: 2, method: 'ping' })) as { error: { code: number } };
    expect(bad.error.code).toBe(-32600);
    const notObject = (await call('hello')) as { error: { code: number } };
    expect(notObject.error.code).toBe(-32600);
  });

  it('parse errors carry -32700 and a null id', () => {
    expect(parseError()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'parse error: not valid JSON' },
    });
  });

  it('answers each element of a batch array independently', async () => {
    const got = (await call([req('ping', undefined, 1), req('ping', undefined, 2), { jsonrpc: '2.0', method: 'notifications/x' }])) as {
      id: number;
    }[];
    expect(got.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe('tools', () => {
  it('lists the registry with schemas and annotations', async () => {
    const got = (await call(req('tools/list'))) as {
      result: { tools: { name: string; annotations?: unknown }[] };
    };
    expect(got.result.tools.map((t) => t.name)).toEqual(['echo', 'boom']);
    expect(got.result.tools[0]?.annotations).toEqual({ readOnlyHint: true });
  });

  it('dispatches tools/call and serializes the payload as text content', async () => {
    const got = (await call(req('tools/call', { name: 'echo', arguments: { a: 1 } }))) as {
      result: { content: { type: string; text: string }[]; isError?: boolean };
    };
    expect(got.result.isError).toBeUndefined();
    expect(JSON.parse(got.result.content[0]!.text)).toEqual({ echoed: { a: 1 } });
  });

  it('turns a throwing handler into an isError RESULT, not a protocol error', async () => {
    const got = (await call(req('tools/call', { name: 'boom', arguments: {} }))) as {
      result: { content: { text: string }[]; isError: boolean };
      error?: unknown;
    };
    expect(got.error).toBeUndefined();
    expect(got.result.isError).toBe(true);
    expect(got.result.content[0]?.text).toContain('not running');
  });

  it('rejects an unknown tool name with -32602', async () => {
    const got = (await call(req('tools/call', { name: 'nope' }))) as { error: { code: number } };
    expect(got.error.code).toBe(-32602);
  });
});
