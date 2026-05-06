/**
 * models.dev integration.
 *
 * https://models.dev/api.json is a public, community-maintained JSON
 * registry of every major LLM provider's models — id, display name,
 * release date, context window, cost, capabilities, modalities. We use
 * it as the baseline source of "what models exist for provider X" so
 * we never have to hardcode lists in client code.
 *
 * Strategy:
 *   1. Cache the response on disk at `~/.us/cache/models-dev.json` with
 *      a fetchedAt timestamp.
 *   2. On read, return cache immediately if present (even if stale) so
 *      the UI never waits.
 *   3. Refresh in the background when the cache is older than TTL.
 *
 * Live `/v1/models` calls (when a provider speaks OpenAI compat) layer
 * on top of this — they're the authoritative current list for an account
 * but cost an extra HTTP round trip.
 */
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { US_HOME } from "./paths.ts";

const REGISTRY_URL = "https://models.dev/api.json";
const CACHE_PATH = join(US_HOME, "cache", "models-dev.json");
const TTL_MS = 60 * 60 * 1000; // 1 hour
const NEGATIVE_TTL_MS = 5 * 60 * 1000; // don't hammer the URL when it 5xx's

// ---------- shapes ----------

/** Subset of the models.dev model entry we care about. */
export interface RegistryModel {
  id: string;
  name?: string;
  family?: string;
  release_date?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    context_over_200k?: {
      input?: number;
      output?: number;
      cache_read?: number;
      cache_write?: number;
    };
  };
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
}

/** A provider entry from models.dev. */
export interface RegistryProvider {
  id: string;
  name: string;
  models: Record<string, RegistryModel>;
}

export type Registry = Record<string, RegistryProvider>;

interface CacheFile {
  fetched_at: number;
  data: Registry;
}

// ---------- fetch + cache ----------

let inFlight: Promise<Registry> | null = null;
let lastFetchFailedAt = 0;

/**
 * Returns the registry. Fast-path: returns cache if available, kicks off
 * a refresh in the background if the cache is stale. Cold-start: fetches
 * synchronously the first time.
 */
export async function getModelsRegistry(): Promise<Registry> {
  const cached = await readCache();
  if (cached) {
    const age = Date.now() - cached.fetched_at;
    if (age > TTL_MS && !inFlight && Date.now() - lastFetchFailedAt > NEGATIVE_TTL_MS) {
      // Refresh in the background — don't await.
      inFlight = refresh().finally(() => {
        inFlight = null;
      });
    }
    return cached.data;
  }

  // No cache at all — wait for the network.
  if (!inFlight) {
    inFlight = refresh().finally(() => {
      inFlight = null;
    });
  }
  try {
    return await inFlight;
  } catch {
    return {};
  }
}

async function refresh(): Promise<Registry> {
  try {
    const r = await fetch(REGISTRY_URL, {
      headers: { accept: "application/json" },
    });
    if (!r.ok) throw new Error(`models.dev: HTTP ${r.status}`);
    const data = (await r.json()) as Registry;
    await writeCache({ fetched_at: Date.now(), data });
    return data;
  } catch (e) {
    lastFetchFailedAt = Date.now();
    throw e;
  }
}

async function readCache(): Promise<CacheFile | null> {
  try {
    const raw = await fs.readFile(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw) as CacheFile;
    if (typeof parsed.fetched_at !== "number" || !parsed.data) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(file: CacheFile): Promise<void> {
  try {
    await fs.mkdir(dirname(CACHE_PATH), { recursive: true });
    await fs.writeFile(CACHE_PATH, JSON.stringify(file));
  } catch {
    // best-effort
  }
}

// ---------- query helpers ----------

/**
 * The auth-profiles cred keys we use don't always match models.dev
 * provider ids. (`codex` → `openai`, `claude` → `anthropic`, etc.)
 *
 * Returns the models.dev provider id for a given auth cred key, or
 * `undefined` if we don't have a registry for it.
 */
export function authKeyToRegistryId(authKey: string): string | undefined {
  if (authKey.startsWith("custom-openai-compat:")) return undefined;
  switch (authKey) {
    // OAuth keys land under different names than registry ids:
    case "codex":
      return "openai";
    case "claude":
      return "anthropic";
    case "github-copilot":
      return "github-copilot";

    // API-key entries already match registry ids in most cases:
    case "openai":
    case "anthropic":
    case "google":
    case "mistral":
    case "groq":
    case "cohere":
    case "perplexity":
    case "xai":
    case "openrouter":
    case "together":
    case "fireworks":
    case "cerebras":
    case "deepinfra":
    case "ai21":
    case "amazon-bedrock":
    case "azure-openai":
    case "vertex":
      return authKey;

    // Aggregators / custom — registry doesn't know about them
    case "vercel-ai-gateway":
    case "cloudflare-ai-gateway":
    case "opencode-zen":
    case "custom-openai-compat":
      return undefined;

    default:
      return authKey; // try as-is
  }
}

/** Fetches models for a specific auth-profiles key (returning [] if not registered). */
export async function getModelsForAuthKey(authKey: string): Promise<RegistryModel[]> {
  const id = authKeyToRegistryId(authKey);
  if (!id) return [];
  const registry = await getModelsRegistry();
  const provider = registry[id];
  if (!provider) return [];
  return Object.values(provider.models);
}

/** Get just the registry display label for a provider. */
export async function getProviderLabel(authKey: string): Promise<string | undefined> {
  const id = authKeyToRegistryId(authKey);
  if (!id) return undefined;
  const registry = await getModelsRegistry();
  return registry[id]?.name;
}
