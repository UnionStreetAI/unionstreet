/**
 * Fallback chain — per-profile ordered list of model targets the agent
 * tries when the primary fails (auth/rate-limit/upstream-5xx/network).
 *
 * Lives under `model.fallback` in `<profile>/config.yaml`:
 *
 *   model:
 *     provider: codex
 *     id: gpt-5.4
 *     fallback:
 *       - { provider: anthropic, id: claude-sonnet-4 }
 *       - { provider: groq,      id: llama-3.1-70b }
 *
 * The actual retry-on-error LOOP lives in the chat dispatch path. This
 * module owns the schema, the read/write helpers, and a classifier for
 * which errors should trigger fallback (vs surface to the user).
 */
import { updateProfileConfig } from "./profile.ts";
import { profilePaths } from "./paths.ts";
import { readAgentPack } from "./agent-pack.ts";
import { promises as fs } from "node:fs";
import yaml from "js-yaml";

export interface ModelTarget {
  /** Provider id matching an entry in PROVIDERS (e.g., "openai-codex"). */
  provider: string;
  /** Model id within that provider (e.g., "gpt-5.4"). */
  id: string;
}

/**
 * Read the full ordered list — primary first, then any fallbacks. The
 * primary is `[provider, id]` from config.yaml; fallbacks come from
 * `model.fallback`. Always at least 1 entry.
 */
export async function readModelChain(profile: string): Promise<ModelTarget[]> {
  try {
    const pack = await readAgentPack(profile);
    return [pack.model.primary, ...pack.model.fallback];
  } catch {
    // Legacy profiles may not have an agent pack yet.
  }

  const path = profilePaths(profile).config;
  let cfg: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = yaml.load(raw);
    if (parsed && typeof parsed === "object") cfg = parsed as Record<string, unknown>;
  } catch {
    /* missing config — empty chain */
  }
  const model = (cfg.model as { id?: string; provider?: string; fallback?: unknown }) ?? {};
  const primary: ModelTarget = {
    provider: model.provider ?? "openai-codex",
    id: model.id ?? "gpt-5.4",
  };
  const rawChain = Array.isArray(model.fallback) ? (model.fallback as unknown[]) : [];
  const chain: ModelTarget[] = [];
  for (const entry of rawChain) {
    if (entry && typeof entry === "object") {
      const e = entry as { provider?: unknown; id?: unknown };
      if (typeof e.provider === "string" && typeof e.id === "string") {
        chain.push({ provider: e.provider, id: e.id });
      }
    }
  }
  return [primary, ...chain];
}

/**
 * Replace the fallback list (primary stays where it is — set via
 * `setProfileModel`).
 */
export async function setFallbackChain(profile: string, fallback: ModelTarget[]): Promise<void> {
  await updateProfileConfig(profile, (cfg) => {
    const model =
      typeof cfg.model === "object" && cfg.model !== null
        ? { ...(cfg.model as Record<string, unknown>) }
        : ({} as Record<string, unknown>);
    if (fallback.length === 0) {
      delete model.fallback;
    } else {
      model.fallback = fallback.map((t) => ({ provider: t.provider, id: t.id }));
    }
    return { ...cfg, model };
  });
}

// ----- error classification -----

/** Errors worth falling back on. */
export function isRetryableError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  if (msg.includes("rate limit") || msg.includes("rate-limit")) return true;
  if (msg.includes("429")) return true;
  if (msg.includes("401") || msg.includes("403")) return true;
  if (/\b5\d{2}\b/.test(msg)) return true; // 5xx
  if (msg.includes("etimedout") || msg.includes("econnreset") || msg.includes("network")) return true;
  if (msg.includes("overloaded") || msg.includes("upstream")) return true;
  return false;
}

function errorMessage(err: unknown): string {
  if (!err) return "";
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
