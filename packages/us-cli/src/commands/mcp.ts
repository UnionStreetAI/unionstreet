import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import kleur from "kleur";
import {
  deleteMcpCredential,
  exchangeMcpOAuthCallback,
  inspectMcpStatus,
  listMcpCredentials,
  normalizeMcpServerName,
  profileExists,
  saveMcpApiKeyCredential,
  saveMcpOAuthCredential,
  startMcpOAuth,
  type McpOAuthMetadata,
  type McpCredentialStatus,
} from "@unionstreet/server";

interface McpCommandOptions {
  profile?: string;
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string | number;
  header?: string;
  provider?: string;
  oauth?: boolean | string;
  authUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  scope?: string;
  audience?: string;
  callbackEnv?: string;
}

export async function mcpCommand(
  action: string | undefined,
  server: string | undefined,
  options: McpCommandOptions = {},
): Promise<void> {
  const profile = sanitizeProfile(options.profile);
  switch (action) {
    case "status":
    case undefined:
      await mcpStatus(profile, server);
      return;
    case "auth":
      await mcpAuth(profile, server, options);
      return;
    case "logout":
    case "remove":
      await mcpLogout(profile, server);
      return;
    default:
      throw new Error(`Unknown MCP action "${action}". Try: status | auth <server> | logout <server>`);
  }
}

export async function agentMcpCommand(
  profile: string,
  action: string | undefined,
  server: string | undefined,
  options: Omit<McpCommandOptions, "profile"> = {},
): Promise<void> {
  await mcpCommand(action, server, { ...options, profile });
}

async function mcpStatus(profile: string | undefined, serverFilter: string | undefined): Promise<void> {
  const status = await inspectMcpStatus(process.cwd(), profile);
  const filter = serverFilter ? normalizeMcpServerName(serverFilter) : undefined;
  const servers = filter ? status.servers.filter((server) => server.name === filter) : status.servers;
  const credentials = await listMcpCredentials(profile);

  console.log("");
  console.log(kleur.bold("mcp") + (profile ? `  ${kleur.magenta(`profile:${profile}`)}` : `  ${kleur.cyan("global view")}`));
  console.log("");

  if (!servers.length) {
    console.log(kleur.dim(filter ? `  no configured MCP server named "${filter}"` : "  no MCP servers found"));
  } else {
    for (const server of servers) {
      const decision = status.grants[server.name];
      const credential = server.credential ?? credentials[server.name] ?? { server: server.name, configured: false };
      const grant = profile
        ? decision?.allowed
          ? kleur.green("granted")
          : kleur.red("blocked")
        : kleur.dim("grant n/a");
      const cred = credentialLabel(credential);
      const transport = server.transport === "remote" ? server.url ?? "remote" : server.command ?? server.transport;
      console.log(`  ${kleur.bold(server.name.padEnd(16))} ${grant.padEnd(18)} ${cred.padEnd(22)} ${kleur.dim(transport)}`);
      if (decision?.allowed) {
        console.log(kleur.dim(`    tools: ${decision.tools.join(", ") || "*"}`));
      }
    }
  }

  const orphaned = Object.keys(credentials).filter((name) => !status.servers.some((server) => server.name === name));
  if (orphaned.length) {
    console.log("");
    console.log(kleur.bold("  credentials without local server config:"));
    for (const name of orphaned) {
      console.log(`    ${kleur.cyan(name.padEnd(16))} ${credentialLabel(credentials[name]!)}`);
    }
  }
  console.log("");
}

async function mcpAuth(profile: string | undefined, server: string | undefined, options: McpCommandOptions): Promise<void> {
  if (!profile) {
    throw new Error("MCP auth is agent-scoped. Use `us <agent> mcp auth <server>` or `us mcp auth <server> --profile <agent>`.");
  }
  await assertProfile(profile);
  const name = normalizeMcpServerName(server ?? "");
  const apiKey = readOption(options.apiKey);
  const accessToken = readOption(options.accessToken);

  if (apiKey && accessToken) {
    throw new Error("Choose either --api-key or --access-token, not both.");
  }

  if (!apiKey && !accessToken && (options.oauth || options.authUrl || options.tokenUrl || options.clientId)) {
    await mcpOAuth(profile, name, options);
    return;
  }

  if (accessToken) {
    await saveMcpOAuthCredential({
      profile,
      server: name,
      accessToken,
      refreshToken: readOption(options.refreshToken),
      expiresAt: parseExpiresAt(options.expiresAt),
      provider: options.provider,
    });
    console.log(kleur.green(`\n  ✓ saved OAuth token for @${profile} → ${name}\n`));
    return;
  }

  const key = apiKey ?? await askSecret(`Paste API key/token for @${profile} → ${name}`);
  await saveMcpApiKeyCredential({
    profile,
    server: name,
    apiKey: key,
    header: options.header,
    provider: options.provider,
  });
  console.log(kleur.green(`\n  ✓ saved API key for @${profile} → ${name}\n`));
}

async function mcpOAuth(profile: string, server: string, options: McpCommandOptions): Promise<void> {
  const metadata = await resolveOAuthMetadata(server, profile, options);
  const started = startMcpOAuth(metadata);

  console.log("");
  console.log(kleur.bold(`mcp oauth → @${profile} / ${server}`));
  console.log(kleur.dim("Open this URL in any browser, complete login, then paste the final redirect URL here."));
  console.log("");
  console.log(started.url);
  console.log("");

  const callback = readCallbackEnv(options.callbackEnv) ?? await askSecret("Paste callback URL or authorization code");
  const token = await exchangeMcpOAuthCallback(started, callback);
  await saveMcpOAuthCredential({
    profile,
    server,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    scope: token.scope,
    tokenType: token.tokenType,
    provider: options.provider ?? server,
  });
  console.log(kleur.green(`\n  ✓ saved OAuth token for @${profile} → ${server}\n`));
}

async function mcpLogout(profile: string | undefined, server: string | undefined): Promise<void> {
  if (!profile) {
    throw new Error("MCP logout is agent-scoped. Use `us <agent> mcp logout <server>` or `us mcp logout <server> --profile <agent>`.");
  }
  await assertProfile(profile);
  const name = normalizeMcpServerName(server ?? "");
  const removed = await deleteMcpCredential(profile, name);
  console.log(removed ? kleur.green(`\n  ✓ removed MCP credential for @${profile} → ${name}\n`) : kleur.yellow(`\n  no MCP credential for @${profile} → ${name}\n`));
}

async function askSecret(message: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const value = await rl.question(`${message}: `);
    const trimmed = value.trim();
    if (!trimmed) return askSecret(message);
    return trimmed;
  } finally {
    rl.close();
  }
}

async function assertProfile(profile: string): Promise<void> {
  if (!(await profileExists(profile))) {
    throw new Error(`Profile "${profile}" does not exist. Run \`us init ${profile}\` first.`);
  }
}

function sanitizeProfile(profile: string | undefined): string | undefined {
  const value = profile?.trim().replace(/^@+/, "");
  return value || undefined;
}

function credentialLabel(credential: McpCredentialStatus): string {
  if (!credential.configured) return kleur.dim("no credential");
  const source = credential.source === "profile" ? kleur.magenta("profile") : kleur.dim("global");
  const kind = credential.kind ?? "unknown";
  const expiry = typeof credential.expiresInSeconds === "number" ? ` ${expiryLabel(credential.expiresInSeconds)}` : "";
  return `${source}/${kind}${expiry}`;
}

function expiryLabel(seconds: number): string {
  if (seconds <= 0) return kleur.red("expired");
  if (seconds < 3600) return kleur.yellow(`${Math.round(seconds / 60)}m`);
  if (seconds < 86400) return kleur.dim(`${Math.round(seconds / 3600)}h`);
  return kleur.dim(`${Math.round(seconds / 86400)}d`);
}

function readOption(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function readCallbackEnv(name: string | undefined): string | undefined {
  const envName = readOption(name);
  if (!envName) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
    throw new Error("--callback-env must be an environment variable name, not the callback value.");
  }
  const value = readOption(process.env[envName]);
  if (!value) throw new Error(`Environment variable ${envName} is empty or not set.`);
  return value;
}

async function resolveOAuthMetadata(
  server: string,
  profile: string,
  options: McpCommandOptions,
): Promise<McpOAuthMetadata> {
  const status = await inspectMcpStatus(process.cwd(), profile);
  const configured = status.servers.find((item) => item.name === server)?.oauth;
  const authorizationUrl = options.authUrl ?? configured?.authorizationUrl;
  const tokenUrl = options.tokenUrl ?? configured?.tokenUrl;
  const clientId = options.clientId ?? configured?.clientId;
  const redirectUri = options.redirectUri ?? configured?.redirectUri ?? "http://localhost:1456/mcp/callback";
  const scope = options.scope ?? configured?.scope;
  const audience = options.audience ?? configured?.audience;
  const missing = [
    !authorizationUrl ? "--auth-url" : "",
    !tokenUrl ? "--token-url" : "",
    !clientId ? "--client-id" : "",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `MCP OAuth for "${server}" needs ${missing.join(", ")} or matching oauth metadata in .mcp.json.`,
    );
  }
  return {
    authorizationUrl: authorizationUrl!,
    tokenUrl: tokenUrl!,
    clientId: clientId!,
    redirectUri,
    ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
    ...(scope ? { scope } : {}),
    ...(audience ? { audience } : {}),
  };
}

function parseExpiresAt(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  const raw = value.trim();
  if (!raw) return undefined;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw new Error(`Invalid --expires-at value "${value}". Use epoch seconds/ms or an ISO date.`);
  return parsed;
}
