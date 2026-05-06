/**
 * auth-profiles.json — per-profile token sink.
 *
 * Two-tier shape:
 *   - providers: model auth (oauth tokens, api keys)
 *   - channels: messaging bot tokens (slack, telegram, discord, email)
 *   - storage: BYO storage creds (cloudflare, vercel, rest)
 *   - mcp: agent-scoped MCP server credentials (linear, github, salesforce, ...)
 *
 * Reads + writes are file-locked via `proper-lockfile`. The file is created
 * with mode 0600 on first write. Writes are atomic (temp file + rename).
 */
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { GLOBAL_AUTH_PROFILES_PATH, profilePaths } from "./paths.ts";

export type OAuthCred = {
  kind: "oauth";
  /** Provider id within @unionstreet/us-auth (e.g., "openai-codex", "anthropic", "github-copilot"). */
  provider: string;
  access: string;
  refresh: string;
  /** Epoch ms. */
  expires: number;
  /** Provider-specific extras (account_id, scope, id_token, ...). */
  [key: string]: unknown;
};

export type ApiKeyCred = {
  kind: "api_key";
  api_key: string;
  /**
   * Optional base URL for OpenAI-compatible providers that aren't at the
   * canonical endpoint — Cloudflare AI Gateway, Vercel AI Gateway, custom
   * vLLM/LM Studio/Ollama deployments, etc. Senders that don't need it
   * just leave it undefined.
   */
  base_url?: string;
  /**
   * Accounting policy is separate from transport. Custom/internal OpenAI-compatible
   * providers may be free, provider-metered elsewhere, or use an explicit rate card.
   */
  accounting?: ProviderAccounting;
};

export type ProviderCred = OAuthCred | ApiKeyCred;

export type ProviderAccounting =
  | { mode: "free"; note?: string }
  | {
      mode: "rate_card";
      /** USD per 1M tokens. */
      rates_per_million_usd: {
        input?: number;
        output?: number;
        reasoning?: number;
        cache_read?: number;
        cache_write?: number;
      };
    }
  | { mode: "unknown"; note?: string };

export type McpApiKeyCred = {
  kind: "api_key";
  api_key: string;
  /** Header name used when materializing this credential for HTTP MCP transports. */
  header?: string;
  /** Optional display/provider hint, e.g. "linear" or "salesforce". */
  provider?: string;
  created: number;
};

export type McpOAuthCred = {
  kind: "oauth";
  provider?: string;
  access: string;
  refresh?: string;
  /** Epoch ms. */
  expires?: number;
  scope?: string;
  token_type?: string;
  created: number;
  [key: string]: unknown;
};

export type McpCred = McpApiKeyCred | McpOAuthCred;

export interface AuthProfilesFile {
  version: 1;
  providers: Record<string, ProviderCred>;
  channels: Record<string, Record<string, unknown>>;
  storage: Record<string, Record<string, unknown>>;
  mcp: Record<string, McpCred>;
}

export const EMPTY_AUTH_PROFILES: AuthProfilesFile = {
  version: 1,
  providers: {},
  channels: {},
  storage: {},
  mcp: {},
};

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/** Read auth-profiles.json. Returns the empty shape if the file is absent. */
export async function readAuthProfiles(path: string): Promise<AuthProfilesFile> {
  if (!(await exists(path))) return structuredClone(EMPTY_AUTH_PROFILES);
  const raw = await fs.readFile(path, "utf8");
  if (!raw.trim()) return structuredClone(EMPTY_AUTH_PROFILES);
  const parsed = JSON.parse(raw) as Partial<AuthProfilesFile>;
  return {
    version: 1,
    providers: parsed.providers ?? {},
    channels: parsed.channels ?? {},
    storage: parsed.storage ?? {},
    mcp: parsed.mcp ?? {},
  };
}

/**
 * Atomic, file-locked update. The mutator receives the current file and
 * returns the next file (or void to no-op). The lock is released on success
 * AND on failure.
 */
export async function updateAuthProfiles(
  path: string,
  mutator: (current: AuthProfilesFile) => AuthProfilesFile | Promise<AuthProfilesFile>,
): Promise<AuthProfilesFile> {
  await fs.mkdir(dirname(path), { recursive: true });
  // Ensure the file exists before locking; proper-lockfile requires it.
  if (!(await exists(path))) {
    await fs.writeFile(path, JSON.stringify(EMPTY_AUTH_PROFILES, null, 2), { mode: 0o600 });
  }

  const release = await lockfile.lock(path, {
    retries: { retries: 5, factor: 1.5, minTimeout: 50, maxTimeout: 1000 },
    stale: 10_000,
  });
  try {
    const current = await readAuthProfiles(path);
    const next = await mutator(current);
    const tmp = `${path}.tmp.${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fs.rename(tmp, path);
    return next;
  } finally {
    await release();
  }
}

/**
 * Merge two auth-profiles files, profile-priority. Per-profile entries
 * override global entries by key within each section.
 */
export function mergeAuthProfiles(
  global: AuthProfilesFile,
  profile: AuthProfilesFile,
): AuthProfilesFile {
  return {
    version: 1,
    providers: { ...global.providers, ...profile.providers },
    channels: { ...global.channels, ...profile.channels },
    storage: { ...global.storage, ...profile.storage },
    mcp: { ...global.mcp, ...profile.mcp },
  };
}

export interface ResolvedAuth {
  /** The merged file as the agent should see it. */
  merged: AuthProfilesFile;
  /** The raw global file (or empty). */
  global: AuthProfilesFile;
  /** The raw per-profile file (undefined if no profile or absent). */
  profile?: AuthProfilesFile;
  /** Per-key provenance: which file did this entry come from? */
  source: {
    providers: Record<string, "global" | "profile">;
    channels: Record<string, "global" | "profile">;
    storage: Record<string, "global" | "profile">;
    mcp: Record<string, "global" | "profile">;
  };
}

/**
 * Read the global auth-profiles.json plus (optionally) a profile's override,
 * return the merged view + provenance map.
 */
export async function resolveAuthProfiles(
  profileName?: string,
): Promise<ResolvedAuth> {
  const global = await readAuthProfiles(GLOBAL_AUTH_PROFILES_PATH);
  const profile = profileName
    ? await readAuthProfiles(profilePaths(profileName).authProfiles)
    : undefined;
  const merged = profile ? mergeAuthProfiles(global, profile) : global;
  return {
    merged,
    global,
    profile,
    source: provenance(global, profile),
  };
}

function provenance(
  global: AuthProfilesFile,
  profile: AuthProfilesFile | undefined,
): ResolvedAuth["source"] {
  const out = {
    providers: {} as Record<string, "global" | "profile">,
    channels: {} as Record<string, "global" | "profile">,
    storage: {} as Record<string, "global" | "profile">,
    mcp: {} as Record<string, "global" | "profile">,
  };
  for (const section of ["providers", "channels", "storage", "mcp"] as const) {
    for (const k of Object.keys(global[section])) out[section][k] = "global";
    if (profile) for (const k of Object.keys(profile[section])) out[section][k] = "profile";
  }
  return out;
}

/** Redact a credential for human display. */
export function redactCred(cred: ProviderCred): Record<string, unknown> {
  if (cred.kind === "api_key") {
    return {
      kind: "api_key",
      api_key: maskTail(cred.api_key),
      ...(cred.base_url ? { base_url: cred.base_url } : {}),
      ...(cred.accounting ? { accounting: cred.accounting } : {}),
    };
  }
  const { kind: _k, access, refresh, expires, provider, ...rest } = cred;
  return {
    ...rest,
    kind: "oauth",
    provider,
    access: maskTail(access),
    refresh: maskTail(refresh),
    expires_in_s: Math.max(0, Math.floor((expires - Date.now()) / 1000)),
  };
}

/** Redact an MCP credential for human display. */
export function redactMcpCred(cred: McpCred): Record<string, unknown> {
  if (cred.kind === "api_key") {
    return {
      kind: "api_key",
      api_key: maskTail(cred.api_key),
      ...(cred.header ? { header: cred.header } : {}),
      ...(cred.provider ? { provider: cred.provider } : {}),
      created: cred.created,
    };
  }
  const { kind: _k, access, refresh, expires, ...rest } = cred;
  return {
    ...rest,
    kind: "oauth",
    access: maskTail(access),
    ...(refresh ? { refresh: maskTail(refresh) } : {}),
    ...(expires ? { expires_in_s: Math.max(0, Math.floor((expires - Date.now()) / 1000)) } : {}),
  };
}

function maskTail(s: string | undefined, keep = 4): string {
  if (!s) return "<empty>";
  if (s.length <= keep) return "***";
  return `***${s.slice(-keep)}`;
}
