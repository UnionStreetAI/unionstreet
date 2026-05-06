export interface DummyMcpServerOptions {
  name: string;
  token: string;
  toolName: string;
  poem: string;
  port?: number;
  hostname?: string;
}

export interface DummyMcpServerHandle {
  name: string;
  token: string;
  url: string;
  stop(): void;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export async function startDummyMcpServer(options: DummyMcpServerOptions): Promise<DummyMcpServerHandle> {
  const hostname = options.hostname ?? "127.0.0.1";
  const sessionId = `dummy-${options.name}-${Math.random().toString(36).slice(2)}`;
  const server = Bun.serve({
    hostname,
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/mcp") return Response.json({ error: "not_found" }, { status: 404 });
      const auth = request.headers.get("authorization") ?? "";
      if (auth !== `Bearer ${options.token}`) {
        return Response.json({ error: "unauthorized", message: "missing or invalid bearer token" }, { status: 401 });
      }
      if (request.method === "GET") return new Response("", { status: 405 });
      if (request.method === "DELETE") return new Response("", { status: 204 });
      if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
      const payload = await request.json().catch(() => undefined);
      const messages = Array.isArray(payload) ? payload : [payload];
      const replies = messages.map((message) => replyFor(message as JsonRpcRequest, options)).filter(Boolean);
      if (!replies.length) return new Response(null, { status: 202, headers: { "mcp-session-id": sessionId } });
      return Response.json(Array.isArray(payload) ? replies : replies[0], {
        headers: { "mcp-session-id": sessionId },
      });
    },
  });
  return {
    name: options.name,
    token: options.token,
    url: `http://${hostname}:${server.port}/mcp`,
    stop() {
      server.stop(true);
    },
  };
}

function replyFor(message: JsonRpcRequest | undefined, options: DummyMcpServerOptions): Record<string, unknown> | undefined {
  if (!message || !message.id) return undefined;
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: `union-street-dummy-${options.name}`, version: "0.0.0" },
      },
    };
  }
  if (message.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: options.toolName,
            title: `${options.name} poem`,
            description: "Return a short deterministic poem for integration testing.",
            inputSchema: {
              type: "object",
              properties: {
                topic: { type: "string", description: "Topic or prompt to weave into the poem." },
              },
              required: [],
            },
          },
        ],
      },
    };
  }
  if (message.method === "tools/call") {
    const name = typeof message.params?.name === "string" ? message.params.name : "";
    if (name !== options.toolName) {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          isError: true,
          content: [{ type: "text", text: `unknown tool ${name}` }],
        },
      };
    }
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
    const topic = typeof args.topic === "string" && args.topic.trim() ? args.topic.trim() : "Union Street";
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: `${options.poem}\n\ntopic: ${topic}` }],
        structuredContent: {
          server: options.name,
          tool: options.toolName,
          topic,
          poem: options.poem,
        },
      },
    };
  }
  return {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `unknown method ${message.method ?? ""}` },
  };
}
