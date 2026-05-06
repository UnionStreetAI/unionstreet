import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveAgentPrincipal, resolveMcpGrantsForAgent, type FederatedAgentIdentity, type McpGrantDecision } from "./federation.ts";
import { getMcpCredentialStatus, type McpCredentialStatus } from "./mcp-auth.ts";
import type { McpOAuthMetadata } from "./mcp-oauth.ts";
import { pluginMcpConfigPathsForAgent, relativePluginPath } from "./plugins.ts";
import { STARTER_TOOLS } from "./tools/index.ts";

export interface McpServerInfo {
  name: string;
  source: string;
  enabled: boolean;
  transport: "local" | "remote" | "unknown";
  command?: string;
  url?: string;
  auth: "oauth" | "headers" | "env" | "none" | "unknown";
  credential?: McpCredentialStatus;
  oauth?: Partial<McpOAuthMetadata>;
  toolCount?: number;
}

export interface McpStatus {
  servers: McpServerInfo[];
  builtinTools: Array<{ name: string; description: string }>;
  sourcesChecked: string[];
  identity?: FederatedAgentIdentity;
  grants: Record<string, McpGrantDecision>;
}

export async function inspectMcpStatus(cwd = process.cwd(), profile?: string): Promise<McpStatus> {
  const sources = candidateConfigPaths(cwd);
  const servers: McpServerInfo[] = [];
  const seen = new Set<string>();

  for (const path of sources) {
    const config = await readConfig(path);
    if (!config) continue;
    for (const server of extractServers(config, path)) {
      const key = server.name;
      if (seen.has(key)) continue;
      seen.add(key);
      servers.push(server);
    }
  }

  if (profile) {
    for (const entry of await readPluginMcpConfigPaths(profile, cwd)) {
      const config = await readConfig(entry.path);
      if (!config) continue;
      const source = `plugin:${entry.plugin.manifest.name}:${relativePluginPath(entry.path, cwd)}`;
      for (const server of extractServers(config, source)) {
        const key = server.name;
        if (seen.has(key)) continue;
        seen.add(key);
        servers.push(server);
      }
    }
  }

  const identity = profile ? await resolveAgentPrincipal(profile) : undefined;
  if (profile) {
    for (const server of servers) {
      server.credential = await getMcpCredentialStatus(profile, server.name);
    }
  }
  const grants = profile ? await resolveMcpGrantsForAgent(profile, servers) : new Map<string, McpGrantDecision>();
  return {
    servers,
    builtinTools: STARTER_TOOLS.map((tool) => ({
      name: tool.definition.name,
      description: tool.definition.description,
    })),
    sourcesChecked: sources,
    ...(identity ? { identity } : {}),
    grants: Object.fromEntries(grants),
  };
}

async function readPluginMcpConfigPaths(profile: string, cwd: string): ReturnType<typeof pluginMcpConfigPathsForAgent> {
  try {
    return await pluginMcpConfigPathsForAgent(profile, cwd);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function candidateConfigPaths(cwd: string): string[] {
  const home = homedir();
  const local = [
    ".mcp.json",
    "mcp.json",
    "opencode.json",
    "opencode.jsonc",
    ".opencode.json",
    ".opencode.jsonc",
  ].map((name) => resolve(cwd, name));
  return [
    ...local,
    join(home, ".config", "opencode", "opencode.json"),
    join(home, ".config", "opencode", "opencode.jsonc"),
  ];
}

async function readConfig(path: string): Promise<unknown | undefined> {
  try {
    const raw = await fs.readFile(path, "utf8");
    return JSON.parse(stripJsonComments(raw));
  } catch {
    return undefined;
  }
}

function extractServers(config: unknown, source: string): McpServerInfo[] {
  if (!isRecord(config)) return [];
  const roots = [
    config.mcp,
    config.mcpServers,
    config.servers,
    isRecord(config.mcp) ? config.mcp.servers : undefined,
  ];
  const out: McpServerInfo[] = [];
  for (const root of roots) {
    if (!isRecord(root)) continue;
    for (const [name, value] of Object.entries(root)) {
      if (!isRecord(value)) continue;
      out.push(serverFromConfig(name, value, source));
    }
  }
  return out;
}

function serverFromConfig(name: string, raw: Record<string, unknown>, source: string): McpServerInfo {
  const url = readString(raw.url);
  const command = readCommand(raw);
  const enabled = raw.enabled !== false && raw.disabled !== true;
  const transport =
    readString(raw.type) === "remote" || url
      ? "remote"
      : readString(raw.type) === "local" || command
        ? "local"
        : "unknown";
  return {
    name,
    source,
    enabled,
    transport,
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
    auth: inferAuth(raw),
    ...(readOAuthMetadata(raw) ? { oauth: readOAuthMetadata(raw) } : {}),
  };
}

function readCommand(raw: Record<string, unknown>): string | undefined {
  const command = raw.command;
  if (Array.isArray(command)) return command.map(String).join(" ");
  if (typeof command === "string") return command;
  return undefined;
}

function inferAuth(raw: Record<string, unknown>): McpServerInfo["auth"] {
  if (raw.oauth && raw.oauth !== false) return "oauth";
  if (isRecord(raw.headers) && Object.keys(raw.headers).length > 0) return "headers";
  if (isRecord(raw.environment) && Object.keys(raw.environment).length > 0) return "env";
  if (isRecord(raw.env) && Object.keys(raw.env).length > 0) return "env";
  if (raw.oauth === false) return "none";
  return "unknown";
}

function readOAuthMetadata(raw: Record<string, unknown>): Partial<McpOAuthMetadata> | undefined {
  if (!isRecord(raw.oauth)) return undefined;
  const authorizationUrl = readString(raw.oauth.authorizationUrl) ?? readString(raw.oauth.authorization_url) ?? readString(raw.oauth.authUrl) ?? readString(raw.oauth.auth_url);
  const tokenUrl = readString(raw.oauth.tokenUrl) ?? readString(raw.oauth.token_url);
  const clientId = readString(raw.oauth.clientId) ?? readString(raw.oauth.client_id);
  const redirectUri = readString(raw.oauth.redirectUri) ?? readString(raw.oauth.redirect_uri);
  const scopeValue = raw.oauth.scope ?? raw.oauth.scopes;
  const scope = Array.isArray(scopeValue) ? scopeValue.map(String).join(" ") : readString(scopeValue);
  const audience = readString(raw.oauth.audience);
  if (!authorizationUrl && !tokenUrl && !clientId && !redirectUri && !scope && !audience) return undefined;
  return {
    ...(authorizationUrl ? { authorizationUrl } : {}),
    ...(tokenUrl ? { tokenUrl } : {}),
    ...(clientId ? { clientId } : {}),
    ...(redirectUri ? { redirectUri } : {}),
    ...(scope ? { scope } : {}),
    ...(audience ? { audience } : {}),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\" && next) {
        out += next;
        i++;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}
