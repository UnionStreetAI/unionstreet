import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { McpCred } from "./auth-profiles.ts";
import { getMcpCredential } from "./mcp-auth.ts";
import { inspectMcpStatus, type McpServerInfo } from "./mcp-status.ts";
import { writeEvent } from "./events.ts";
import type { UsTool } from "./tools/index.ts";

export async function resolveMcpToolsForAgent(profile: string, cwd = process.cwd()): Promise<UsTool[]> {
  const status = await inspectMcpStatus(cwd, profile);
  const out: UsTool[] = [];
  for (const server of status.servers) {
    const decision = status.grants[server.name];
    if (!server.enabled || server.transport !== "remote" || !server.url || !decision?.allowed) continue;
    const credential = await getMcpCredential(profile, server.name);
    if (!credential) continue;
    const listed = await listRemoteMcpTools(profile, server, credential);
    if (!listed.ok) continue;
    for (const remoteTool of listed.tools) {
      if (!mcpToolAllowed(remoteTool.name, decision.tools)) continue;
      out.push(remoteToolAdapter(profile, server, credential, remoteTool));
    }
  }
  return out.sort((a, b) => a.definition.name.localeCompare(b.definition.name));
}

async function listRemoteMcpTools(
  profile: string,
  server: McpServerInfo,
  credential: McpCred,
): Promise<{ ok: true; tools: Tool[] } | { ok: false; error: string }> {
  try {
    const result = await mcpRequest(server, credential, "tools/list", {});
    const tools = Array.isArray(result.tools) ? result.tools as Tool[] : [];
    await writeEvent({
      type: "mcp.tool.list",
      actor: profile,
      subject: profile,
      resource: `mcp:${server.name}`,
      outcome: "success",
      payload: { server: server.name, tools: tools.map((tool) => tool.name) },
    });
    return { ok: true, tools };
  } catch (error) {
    await writeEvent({
      type: "mcp.tool.list",
      actor: profile,
      subject: profile,
      resource: `mcp:${server.name}`,
      outcome: "failure",
      reason: (error as Error).message,
      payload: { server: server.name },
    });
    return { ok: false, error: (error as Error).message };
  }
}

function remoteToolAdapter(profile: string, server: McpServerInfo, credential: McpCred, remoteTool: Tool): UsTool {
  const exposedName = exposedMcpToolName(server.name, remoteTool.name);
  return {
    definition: {
      type: "function",
      name: exposedName,
      description: [
        `MCP tool ${remoteTool.name} on ${server.name}.`,
        remoteTool.description ?? "",
      ].filter(Boolean).join(" "),
      parameters: remoteTool.inputSchema as Record<string, unknown>,
    },
    async execute(args, ctx) {
      const actor = ctx.callingPeer ?? profile;
      try {
        const result = await mcpRequest(server, credential, "tools/call", { name: remoteTool.name, arguments: args });
        await writeEvent({
          type: "mcp.tool.call",
          actor,
          subject: actor,
          trace: ctx.trace,
          resource: `mcp:${server.name}/${remoteTool.name}`,
          outcome: "success",
          payload: { exposedName, server: server.name, tool: remoteTool.name },
        });
        return mcpResultText(server.name, remoteTool.name, result as CallToolResult);
      } catch (error) {
        await writeEvent({
          type: "mcp.tool.call",
          actor,
          subject: actor,
          trace: ctx.trace,
          resource: `mcp:${server.name}/${remoteTool.name}`,
          outcome: "failure",
          reason: (error as Error).message,
          payload: { exposedName, server: server.name, tool: remoteTool.name },
        });
        return `error: MCP ${server.name}/${remoteTool.name}: ${(error as Error).message}`;
      }
    },
  };
}

async function mcpRequest(
  server: McpServerInfo,
  credential: McpCred,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!server.url) throw new Error(`MCP server "${server.name}" has no URL`);
  const init = await mcpPost(server.url, credential, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "union-street-mcp-client", version: "0.0.0" },
    },
  });
  await mcpPost(server.url, credential, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  }, init.sessionId);
  const response = await mcpPost(server.url, credential, {
    jsonrpc: "2.0",
    id: 2,
    method,
    params,
  }, init.sessionId);
  if (!response.body || typeof response.body !== "object" || Array.isArray(response.body)) {
    throw new Error(`MCP ${method} returned an invalid response`);
  }
  const json = response.body as Record<string, unknown>;
  if (json.error) throw new Error(safeStringify(json.error));
  const result = json.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`MCP ${method} returned no result`);
  }
  return result as Record<string, unknown>;
}

async function mcpPost(
  url: string,
  credential: McpCred,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<{ body?: unknown; sessionId?: string }> {
  await assertSafeMcpUrl(url);
  const headers: Record<string, string> = {
    ...authHeaders(credential),
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2025-06-18",
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
  };
  const timeoutMs = mcpHttpTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`MCP request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const nextSessionId = response.headers.get("mcp-session-id") ?? sessionId;
  if (response.status === 202 || response.status === 204) return { sessionId: nextSessionId };
  const text = await response.text();
  if (!response.ok) throw new Error(`http ${response.status}: ${text.slice(0, 500)}`);
  const parsed = text.trim() ? JSON.parse(text) : undefined;
  return { body: parsed, sessionId: nextSessionId };
}

async function assertSafeMcpUrl(value: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MCP URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`MCP URL protocol "${url.protocol}" is not allowed`);
  }
  if (url.username || url.password) {
    throw new Error("MCP URL must not contain embedded credentials");
  }
  const host = url.hostname.toLowerCase();
  if (process.env.US_MCP_ALLOW_PRIVATE_URLS !== "1" && isBlockedMcpHost(host)) {
    throw new Error("MCP URL targets a private, local, loopback, or metadata host");
  }
  if (process.env.US_MCP_ALLOW_PRIVATE_URLS !== "1" && isIP(host) === 0) {
    const records = await lookup(host, { all: true, verbatim: true });
    if (!records.length) throw new Error("MCP URL host did not resolve");
    if (records.some((record) => isBlockedMcpHost(record.address))) {
      throw new Error("MCP URL resolves to a private, local, loopback, or metadata address");
    }
  }
}

function isBlockedMcpHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (normalized === "localhost" || normalized === "metadata.google.internal") return true;
  if (normalized.endsWith(".localhost") || normalized.endsWith(".local")) return true;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return isPrivateIpv4(normalized);
  if (ipVersion === 6) return isPrivateIpv6(normalized);
  return false;
}

function isPrivateIpv4(value: string): boolean {
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fe80:")) return true;
  const first = Number.parseInt(normalized.split(":")[0] || "", 16);
  if (!Number.isFinite(first)) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xff00) === 0xff00) return true;
  return false;
}

function authHeaders(credential: McpCred): Record<string, string> {
  if (credential.kind === "oauth") {
    const tokenType = typeof credential.token_type === "string" && credential.token_type.trim()
      ? credential.token_type.trim()
      : "Bearer";
    return { Authorization: `${tokenType} ${credential.access}` };
  }
  const header = credential.header?.trim() || "Authorization";
  const value = header.toLowerCase() === "authorization" && !/^bearer\s+/i.test(credential.api_key)
    ? `Bearer ${credential.api_key}`
    : credential.api_key;
  return { [header]: value };
}

function mcpResultText(server: string, tool: string, result: CallToolResult): string {
  const content = result.content ?? [];
  const parts = content.map((item) => {
    if (item.type === "text") return item.text;
    if (item.type === "image") return `[image ${item.mimeType}]`;
    if (item.type === "audio") return `[audio ${item.mimeType}]`;
    if (item.type === "resource_link") return `[resource ${item.uri}]`;
    if (item.type === "resource") return `[resource ${item.resource.uri}]`;
    return JSON.stringify(item);
  });
  const structured = result.structuredContent === undefined ? "" : `\nstructured: ${safeStringify(result.structuredContent)}`;
  return [`mcp ${server}/${tool}`, ...parts, structured].filter(Boolean).join("\n");
}

function exposedMcpToolName(server: string, tool: string): string {
  return `mcp_${sanitizeName(server)}_${sanitizeName(tool)}`;
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
}

function mcpToolAllowed(tool: string, patterns: string[]): boolean {
  if (!patterns.length) return false;
  return patterns.some((pattern) => wildcard(pattern, tool));
}

function wildcard(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function mcpHttpTimeoutMs(): number {
  const raw = Number(process.env.US_MCP_HTTP_TIMEOUT_MS);
  if (Number.isInteger(raw) && raw >= 50 && raw <= 300_000) return raw;
  return 15_000;
}
