import { promises as fs } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import yaml from "js-yaml";
import { US_HOME } from "./paths.ts";
import { readGlobalConfig } from "./global-config.ts";
import { readAgentPack } from "./agent-pack.ts";
import { resolveAgentPrincipal, type FederatedAgentIdentity } from "./federation.ts";
import { writeEvent } from "./events.ts";

export type SecretProviderType = "env_file" | "env" | "external";

export interface SecretProviderConfig {
  type: SecretProviderType;
  path?: string;
  url?: string;
  apiKeyEnv?: string;
}

export interface SecretAudience {
  agents: string[];
  groups: string[];
  roles: string[];
  principals: string[];
}

export interface SecretEntryConfig {
  provider: string;
  env: Record<string, string>;
  audience: SecretAudience;
}

export interface SecretRegistry {
  providers: Record<string, SecretProviderConfig>;
  entries: Record<string, SecretEntryConfig>;
}

export interface ResolvedSecretGrant {
  id: string;
  allowed: boolean;
  reason: string;
  provider?: string;
  env: string[];
  missing: string[];
}

export interface SecretMaterialization {
  path?: string;
  grants: ResolvedSecretGrant[];
  env: Record<string, string>;
  warnings: string[];
}

export async function readSecretRegistry(): Promise<SecretRegistry> {
  const cfg = await readGlobalConfig();
  const raw = isRecord(cfg.secrets) ? cfg.secrets : {};
  return normalizeSecretRegistry(raw);
}

export async function resolveSecretGrantsForAgent(profile: string): Promise<ResolvedSecretGrant[]> {
  const registry = await readSecretRegistry();
  const requested = await requestedSecretIds(profile);
  const identity = await resolveAgentPrincipal(profile);
  const out: ResolvedSecretGrant[] = [];

  for (const id of requested) {
    const entry = registry.entries[id];
    if (!entry) {
      if (id === `profile:${profile}`) {
        out.push({ id, allowed: true, reason: "implicit profile secret namespace", env: [], missing: [] });
        continue;
      }
      out.push({ id, allowed: false, reason: "secret grant is not defined", env: [], missing: [] });
      continue;
    }
    const provider = registry.providers[entry.provider];
    if (!provider) {
      out.push({ id, allowed: false, reason: `secret provider "${entry.provider}" is not defined`, env: Object.keys(entry.env).sort(), missing: [] });
      continue;
    }
    if (!secretAudienceAllows(entry.audience, identity)) {
      out.push({
        id,
        allowed: false,
        reason: `@${profile} is not in the grant audience`,
        provider: entry.provider,
        env: Object.keys(entry.env).sort(),
        missing: [],
      });
      continue;
    }
    out.push({
      id,
      allowed: true,
      reason: "allowed by secret audience",
      provider: entry.provider,
      env: Object.keys(entry.env).sort(),
      missing: [],
    });
  }

  const sorted = out.sort((a, b) => a.id.localeCompare(b.id));
  for (const grant of sorted) {
    await writeEvent({
      type: "secret.grant.resolve",
      actor: profile,
      subject: profile,
      resource: `secret:${grant.id}`,
      outcome: grant.allowed ? "allow" : "deny",
      reason: grant.reason,
      payload: {
        id: grant.id,
        provider: grant.provider,
        env: grant.env,
        missing: grant.missing,
      },
    });
  }
  return sorted;
}

export async function materializeAgentSecrets(
  profile: string,
  workspacePath: string,
): Promise<SecretMaterialization> {
  const registry = await readSecretRegistry();
  const grants = await resolveSecretGrantsForAgent(profile);
  const env: Record<string, string> = {};
  const warnings: string[] = [];
  const providerCache = new Map<string, Promise<Record<string, string>>>();

  for (const grant of grants) {
    if (!grant.allowed || !grant.provider) continue;
    const entry = registry.entries[grant.id];
    const provider = registry.providers[grant.provider];
    if (!entry || !provider) continue;
    const providerEnv = providerCache.get(grant.provider) ?? readProviderEnv(provider);
    providerCache.set(grant.provider, providerEnv);
    const source = await providerEnv;

    const missing: string[] = [];
    for (const [targetName, sourceName] of Object.entries(entry.env)) {
      const value = process.env[sourceName] ?? source[sourceName];
      if (value == null) {
        missing.push(targetName);
        continue;
      }
      env[targetName] = value;
    }
    grant.missing = missing.sort();
    if (missing.length) {
      warnings.push(`secret grant "${grant.id}" is missing ${missing.join(", ")}`);
    }
  }

  if (!Object.keys(env).length) {
    await writeEvent({
      type: "secret.materialize",
      actor: profile,
      subject: profile,
      outcome: "info",
      payload: {
        workspacePath,
        envCount: 0,
        granted: grants.filter((grant) => grant.allowed).map((grant) => grant.id),
        warnings,
      },
    });
    return { grants, env, warnings };
  }

  const path = join(workspacePath, ".us-secrets.env");
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, serializeEnv(env), { mode: 0o600 });
  await writeEvent({
    type: "secret.materialize",
    actor: profile,
    subject: profile,
    resource: path,
    outcome: "success",
    severity: warnings.length ? "warn" : "info",
    payload: {
      workspacePath,
      envCount: Object.keys(env).length,
      granted: grants.filter((grant) => grant.allowed).map((grant) => grant.id),
      warnings,
    },
  });
  return { path, grants, env, warnings };
}

async function requestedSecretIds(profile: string): Promise<string[]> {
  try {
    const pack = await readAgentPack(profile);
    return [...new Set(pack.runtime.secrets.map((id) => id.trim()).filter(Boolean))].sort();
  } catch {
    return [];
  }
}

function normalizeSecretRegistry(raw: Record<string, unknown>): SecretRegistry {
  const providers: Record<string, SecretProviderConfig> = {};
  const entries: Record<string, SecretEntryConfig> = {};

  const rawProviders = isRecord(raw.providers) ? raw.providers : {};
  for (const [id, value] of Object.entries(rawProviders)) {
    if (!isRecord(value)) continue;
    const type = readProviderType(value.type) ?? "env_file";
    providers[id] = {
      type,
      ...(readString(value.path) ? { path: readString(value.path) } : {}),
      ...(readString(value.url) ? { url: readString(value.url) } : {}),
      ...(readString(value.apiKeyEnv) ? { apiKeyEnv: readString(value.apiKeyEnv) } : {}),
    };
  }

  const rawEntries = isRecord(raw.entries) ? raw.entries : {};
  for (const [id, value] of Object.entries(rawEntries)) {
    if (!isRecord(value)) continue;
    const provider = readString(value.provider);
    if (!provider) continue;
    entries[id] = {
      provider,
      env: readStringMap(value.env),
      audience: normalizeAudience(value.audience),
    };
  }

  return { providers, entries };
}

function normalizeAudience(value: unknown): SecretAudience {
  const raw = isRecord(value) ? value : {};
  return {
    agents: readStringArray(raw.agents),
    groups: readStringArray(raw.groups),
    roles: readStringArray(raw.roles),
    principals: readStringArray(raw.principals),
  };
}

function secretAudienceAllows(audience: SecretAudience, identity: FederatedAgentIdentity): boolean {
  const hasSelector = audience.agents.length || audience.groups.length || audience.roles.length || audience.principals.length;
  if (!hasSelector) return false;
  if (audience.agents.length && !audience.agents.includes(identity.profile) && !audience.agents.includes(identity.subject)) return false;
  if (audience.groups.length && !identity.groups.some((group) => audience.groups.includes(group))) return false;
  if (audience.roles.length && !identity.roles.some((role) => audience.roles.includes(role))) return false;
  if (audience.principals.length && !identity.principals.some((principal) => audience.principals.includes(principal))) return false;
  return true;
}

async function readProviderEnv(provider: SecretProviderConfig): Promise<Record<string, string>> {
  if (provider.type === "env") return {};
  if (provider.type === "external") return {};
  if (!provider.path) return {};
  try {
    const raw = await fs.readFile(resolveLocalPath(provider.path), "utf8");
    return parseEnvFile(raw);
  } catch {
    return {};
  }
}

function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    out[match[1]!] = unquoteEnvValue(match[2] ?? "");
  }
  return out;
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function serializeEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n") + "\n";
}

function resolveLocalPath(path: string): string {
  if (path.startsWith("~/")) return resolvePath(process.env.HOME ?? "~", path.slice(2));
  if (path.startsWith("$US_HOME/")) return resolvePath(US_HOME, path.slice("$US_HOME/".length));
  return resolvePath(path);
}

function readProviderType(value: unknown): SecretProviderType | undefined {
  return value === "env_file" || value === "env" || value === "external" ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
}

function readStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, typeof item === "string" ? item.trim() : ""] as const)
      .filter(([, item]) => item.length > 0),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function dumpSecretRegistry(registry: SecretRegistry): string {
  return yaml.dump(registry, { lineWidth: 100 });
}
