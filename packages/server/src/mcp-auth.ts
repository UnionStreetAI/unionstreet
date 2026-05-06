import { profilePaths } from "./paths.ts";
import { profileExists } from "./profile.ts";
import {
  readAuthProfiles,
  resolveAuthProfiles,
  updateAuthProfiles,
  type McpCred,
} from "./auth-profiles.ts";
import { writeEvent } from "./events.ts";

export interface McpCredentialStatus {
  server: string;
  configured: boolean;
  source?: "global" | "profile";
  kind?: McpCred["kind"];
  expiresInSeconds?: number;
}

export interface SaveMcpApiKeyOptions {
  profile: string;
  server: string;
  apiKey: string;
  header?: string;
  provider?: string;
}

export interface SaveMcpOAuthOptions {
  profile: string;
  server: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
  provider?: string;
}

export async function listMcpCredentials(profile?: string): Promise<Record<string, McpCredentialStatus>> {
  const resolved = await resolveAuthProfiles(profile);
  const out: Record<string, McpCredentialStatus> = {};
  for (const [server, cred] of Object.entries(resolved.merged.mcp)) {
    out[server] = credentialStatus(server, cred, resolved.source.mcp[server]);
  }
  return out;
}

export async function getMcpCredential(profile: string | undefined, server: string): Promise<McpCred | undefined> {
  const resolved = await resolveAuthProfiles(profile);
  return resolved.merged.mcp[normalizeMcpServerName(server)];
}

export async function getMcpCredentialStatus(profile: string | undefined, server: string): Promise<McpCredentialStatus> {
  const name = normalizeMcpServerName(server);
  const resolved = await resolveAuthProfiles(profile);
  const cred = resolved.merged.mcp[name];
  return credentialStatus(name, cred, resolved.source.mcp[name]);
}

export async function saveMcpApiKeyCredential(options: SaveMcpApiKeyOptions): Promise<void> {
  const path = await profileAuthPath(options.profile);
  const server = normalizeMcpServerName(options.server);
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("MCP API key cannot be empty.");

  await updateAuthProfiles(path, (current) => ({
    ...current,
    mcp: {
      ...current.mcp,
      [server]: {
        kind: "api_key",
        api_key: apiKey,
        header: options.header?.trim() || defaultHeaderForServer(server),
        provider: options.provider?.trim() || server,
        created: Date.now(),
      },
    },
  }));
  await writeEvent({
    type: "mcp.auth.save",
    actor: options.profile,
    subject: options.profile,
    resource: `mcp:${server}`,
    outcome: "success",
    payload: { server, kind: "api_key", header: options.header?.trim() || defaultHeaderForServer(server), provider: options.provider?.trim() || server },
  });
}

export async function saveMcpOAuthCredential(options: SaveMcpOAuthOptions): Promise<void> {
  const path = await profileAuthPath(options.profile);
  const server = normalizeMcpServerName(options.server);
  const access = options.accessToken.trim();
  if (!access) throw new Error("MCP OAuth access token cannot be empty.");

  await updateAuthProfiles(path, (current) => ({
    ...current,
    mcp: {
      ...current.mcp,
      [server]: {
        kind: "oauth",
        provider: options.provider?.trim() || server,
        access,
        ...(options.refreshToken ? { refresh: options.refreshToken.trim() } : {}),
        ...(options.expiresAt ? { expires: options.expiresAt } : {}),
        ...(options.scope ? { scope: options.scope } : {}),
        ...(options.tokenType ? { token_type: options.tokenType } : {}),
        created: Date.now(),
      },
    },
  }));
  await writeEvent({
    type: "mcp.auth.save",
    actor: options.profile,
    subject: options.profile,
    resource: `mcp:${server}`,
    outcome: "success",
    payload: { server, kind: "oauth", provider: options.provider?.trim() || server, expiresAt: options.expiresAt },
  });
}

export async function deleteMcpCredential(profile: string, server: string): Promise<boolean> {
  const path = await profileAuthPath(profile);
  const name = normalizeMcpServerName(server);
  const before = await readAuthProfiles(path);
  if (!before.mcp[name]) return false;
  await updateAuthProfiles(path, (current) => {
    const next = { ...current.mcp };
    delete next[name];
    return { ...current, mcp: next };
  });
  await writeEvent({
    type: "mcp.auth.delete",
    actor: profile,
    subject: profile,
    resource: `mcp:${name}`,
    outcome: "success",
    payload: { server: name },
  });
  return true;
}

export function normalizeMcpServerName(server: string): string {
  const name = server.trim().replace(/^@+/, "").toLowerCase();
  if (!name) throw new Error("MCP server name is required.");
  return name;
}

function credentialStatus(
  server: string,
  cred: McpCred | undefined,
  source?: "global" | "profile",
): McpCredentialStatus {
  if (!cred) return { server, configured: false };
  const expires = cred.kind === "oauth" ? cred.expires : undefined;
  return {
    server,
    configured: true,
    source,
    kind: cred.kind,
    ...(expires ? { expiresInSeconds: Math.max(0, Math.floor((expires - Date.now()) / 1000)) } : {}),
  };
}

async function profileAuthPath(profile: string): Promise<string> {
  const name = profile.trim().replace(/^@+/, "");
  if (!name) throw new Error("MCP auth requires an agent profile. Example: `us-dev coo mcp auth linear`.");
  if (!(await profileExists(name))) {
    throw new Error(`Profile "${name}" does not exist. Run \`us-dev init ${name}\` first.`);
  }
  return profilePaths(name).authProfiles;
}

function defaultHeaderForServer(server: string): string {
  if (server === "linear") return "Authorization";
  if (server === "github") return "Authorization";
  if (server === "salesforce") return "Authorization";
  return "Authorization";
}
