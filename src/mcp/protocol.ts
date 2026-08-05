/**
 * Minimal MCP (Model Context Protocol) server core: a tools-only stdio server
 * expressed as one pure function. Hand-rolled on purpose — the official SDK
 * unconditionally drags in two HTTP frameworks and an OAuth stack, and this
 * repo ships with zero runtime dependencies.
 *
 * Framing is newline-delimited JSON-RPC 2.0 (one message per line, UTF-8, no
 * LSP-style Content-Length headers). The entry point (mcp.ts) owns the wire;
 * this module owns the semantics, which keeps every rule testable without
 * process I/O.
 */

/** Newest first; `initialize` echoes the client's version when we support it. */
export const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 2025-03-26+ behavior hints (readOnlyHint etc.); older clients ignore them. */
  annotations?: Record<string, unknown>;
  /** Returns the payload to serialize; throw to produce an isError result. */
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface McpServerInfo {
  name: string;
  version: string;
  /** Free-text guidance the client gives its model — teach the hybrid rules. */
  instructions: string;
}

export interface McpSession {
  protocolVersion: string;
}

export const createSession = (): McpSession => ({ protocolVersion: SUPPORTED_VERSIONS[0] });

type JsonRpcId = string | number | null;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

const response = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
const failure = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

/** The JSON-RPC error for an unparseable line; the entry point sends it. */
export const parseError = (): JsonRpcResponse => failure(null, -32700, 'parse error: not valid JSON');

/**
 * Handle one decoded message (or a 2025-03-26 batch array — answer each
 * element; that spec revision allowed batches and its neighbors tolerate the
 * reply array). Returns undefined when nothing should be written back
 * (notifications), a response object, or an array of them.
 */
export const handleMessage = async (
  session: McpSession,
  message: unknown,
  tools: McpToolDef[],
  server: McpServerInfo,
): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> => {
  if (Array.isArray(message)) {
    const replies: JsonRpcResponse[] = [];
    for (const entry of message) {
      const reply = await handleMessage(session, entry, tools, server);
      if (reply && !Array.isArray(reply)) replies.push(reply);
    }
    return replies.length > 0 ? replies : undefined;
  }

  if (message === null || typeof message !== 'object') {
    return failure(null, -32600, 'invalid request: expected a JSON-RPC object');
  }
  const msg = message as { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown };
  const hasId = 'id' in msg && msg.id !== undefined;

  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // A malformed notification gets no reply; a malformed request gets -32600.
    return hasId ? failure(msg.id ?? null, -32600, 'invalid request') : undefined;
  }

  // Notifications (no id): the only one we care about is initialized, and the
  // spec says unknown notifications are ignored silently — so ignore them all.
  if (!hasId) return undefined;
  const id = msg.id ?? null;
  const params = (msg.params ?? {}) as Record<string, unknown>;

  switch (msg.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      session.protocolVersion = (SUPPORTED_VERSIONS as readonly string[]).includes(asked)
        ? asked
        : SUPPORTED_VERSIONS[0];
      return response(id, {
        protocolVersion: session.protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, version: server.version },
        instructions: server.instructions,
      });
    }

    case 'ping':
      return response(id, {});

    case 'tools/list':
      // The registry is static and small: no pagination, no cursor.
      return response(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.annotations ? { annotations: t.annotations } : {}),
        })),
      });

    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = tools.find((t) => t.name === name);
      if (!tool) return failure(id, -32602, `unknown tool: ${name || '(missing name)'}`);
      const args =
        params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const payload = await tool.handler(args);
        return response(id, {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
        });
      } catch (err) {
        // Tool failures are RESULTS the model can read and recover from —
        // JSON-RPC errors are reserved for protocol-level problems.
        return response(id, {
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      }
    }

    default:
      return failure(id, -32601, `method not found: ${msg.method}`);
  }
};
