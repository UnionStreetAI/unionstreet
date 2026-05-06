import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { TokenUsage } from "@unionstreet/ai-codex";
import { USAGE_PATH } from "./paths.ts";
import { resolveAuthProfiles, type ProviderAccounting } from "./auth-profiles.ts";
import { authKeyToRegistryId, getModelsRegistry } from "./models-dev.ts";

export interface UsageRecord {
  id: string;
  ts: number;
  actor: string;
  provider: string;
  model: string;
  sessionId?: string;
  trace?: string;
  threadId?: string;
  runId?: string;
  step?: number;
  kind: "prompt" | "lash" | "scheduler" | "chat";
  usage: TokenUsage;
  costMicroUsd?: number;
  costSource?: "explicit" | "provider:free" | "provider:rate_card" | "env:rate_card" | "models.dev" | "unknown";
  metadata?: Record<string, unknown>;
}

export interface UsageQuery {
  actor?: string;
  provider?: string;
  model?: string;
  sessionId?: string;
  trace?: string;
  kind?: UsageRecord["kind"];
  since?: number;
  until?: number;
  limit?: number;
}

export interface UsageSummary {
  calls: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  costMicroUsd: number;
}

export async function writeUsageRecord(
  input: Omit<UsageRecord, "id" | "ts" | "costMicroUsd" | "costSource"> &
    Partial<Pick<UsageRecord, "id" | "ts" | "costMicroUsd" | "costSource">>,
): Promise<UsageRecord> {
  const usage = normalizeUsage(input.usage);
  const cost = await costFor({ ...input, usage });
  const record: UsageRecord = {
    id: input.id ?? randomUUID(),
    ts: input.ts ?? Date.now(),
    actor: normalizeActor(input.actor),
    provider: input.provider,
    model: input.model,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.trace ? { trace: input.trace } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.step ? { step: input.step } : {}),
    kind: input.kind,
    usage,
    ...(cost.costMicroUsd !== undefined ? { costMicroUsd: cost.costMicroUsd } : {}),
    costSource: cost.source,
    ...(input.metadata ? { metadata: redactMetadata(input.metadata) } : {}),
  };
  await fs.mkdir(dirname(USAGE_PATH), { recursive: true });
  await fs.appendFile(USAGE_PATH, JSON.stringify(record) + "\n", { mode: 0o600 });
  return record;
}

interface CostRate {
  input?: number;
  output?: number;
  reasoning?: number;
  cache_read?: number;
  cache_write?: number;
}

interface CostDecision {
  costMicroUsd?: number;
  source: UsageRecord["costSource"];
}

async function costFor(
  input: Pick<UsageRecord, "actor" | "provider" | "model" | "usage"> &
    Partial<Pick<UsageRecord, "costMicroUsd" | "costSource">>,
): Promise<CostDecision> {
  if (input.costMicroUsd !== undefined) return { costMicroUsd: input.costMicroUsd, source: input.costSource ?? "explicit" };

  const accounting = await providerAccounting(input.actor, input.provider);
  if (accounting?.mode === "free") return { costMicroUsd: 0, source: "provider:free" };
  if (accounting?.mode === "rate_card") {
    return {
      costMicroUsd: costFromRate(input.usage, accounting.rates_per_million_usd),
      source: "provider:rate_card",
    };
  }
  if (accounting?.mode === "unknown") return { source: "unknown" };

  const rates = readCostRates();
  const envRate = rates[`${input.provider}/${input.model}`] ?? rates[input.model];
  if (envRate) return { costMicroUsd: costFromRate(input.usage, envRate), source: "env:rate_card" };

  const registryRate = await modelsDevRate(input.provider, input.model, input.usage);
  if (registryRate) return { costMicroUsd: costFromRate(input.usage, registryRate), source: "models.dev" };

  return { source: "unknown" };
}

async function providerAccounting(actor: string, provider: string): Promise<ProviderAccounting | undefined> {
  try {
    const auth = await resolveAuthProfiles(actor);
    const cred = auth.merged.providers[provider];
    return cred?.kind === "api_key" ? cred.accounting : undefined;
  } catch {
    return undefined;
  }
}

async function modelsDevRate(provider: string, model: string, usage: TokenUsage): Promise<CostRate | undefined> {
  if (process.env.US_USAGE_DISABLE_MODELS_DEV_COSTS === "1") return undefined;
  const registryId = authKeyToRegistryId(provider);
  if (!registryId) return undefined;
  try {
    const registry = await getModelsRegistry();
    const cost = registry[registryId]?.models[model]?.cost;
    if (!cost) return undefined;
    const contextTokens = usage.input + (usage.cache_read ?? 0) + (usage.cache_write ?? 0);
    const selected = contextTokens > 200_000 && cost.context_over_200k ? cost.context_over_200k : cost;
    return {
      input: selected.input,
      output: selected.output,
      cache_read: selected.cache_read,
      cache_write: selected.cache_write,
    };
  } catch {
    return undefined;
  }
}

function costFromRate(usage: TokenUsage, rate: CostRate): number {
  return Math.round(
    usage.input * (rate.input ?? 0)
      + usage.output * (rate.output ?? 0)
      + (usage.reasoning ?? 0) * (rate.reasoning ?? rate.output ?? 0)
      + (usage.cache_read ?? 0) * (rate.cache_read ?? 0)
      + (usage.cache_write ?? 0) * (rate.cache_write ?? 0),
  );
}

function readCostRates(): Record<string, CostRate> {
  const raw = process.env.US_MODEL_COSTS_JSON;
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, CostRate>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function readUsageRecords(): Promise<UsageRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(USAGE_PATH, "utf8");
  } catch {
    return [];
  }
  const out: UsageRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as UsageRecord);
    } catch {
      // Ignore corrupt partial rows; the append-only ledger remains inspectable.
    }
  }
  return out;
}

export async function queryUsageRecords(query: UsageQuery = {}): Promise<UsageRecord[]> {
  const records = await readUsageRecords();
  const newestFirst = records
    .filter((record) => matchesUsageQuery(record, query))
    .sort((a, b) => b.ts - a.ts);
  return newestFirst.slice(0, query.limit ?? newestFirst.length);
}

export function summarizeUsage(records: UsageRecord[]): UsageSummary {
  return records.reduce<UsageSummary>(
    (summary, record) => ({
      calls: summary.calls + 1,
      input: summary.input + record.usage.input,
      output: summary.output + record.usage.output,
      reasoning: summary.reasoning + (record.usage.reasoning ?? 0),
      cacheRead: summary.cacheRead + (record.usage.cache_read ?? 0),
      cacheWrite: summary.cacheWrite + (record.usage.cache_write ?? 0),
      total: summary.total + record.usage.total,
      costMicroUsd: summary.costMicroUsd + (record.costMicroUsd ?? 0),
    }),
    { calls: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, costMicroUsd: 0 },
  );
}

function matchesUsageQuery(record: UsageRecord, query: UsageQuery): boolean {
  if (query.actor && record.actor !== normalizeActor(query.actor)) return false;
  if (query.provider && record.provider !== query.provider) return false;
  if (query.model && record.model !== query.model) return false;
  if (query.sessionId && record.sessionId !== query.sessionId) return false;
  if (query.trace && record.trace !== query.trace) return false;
  if (query.kind && record.kind !== query.kind) return false;
  if (query.since && record.ts < query.since) return false;
  if (query.until && record.ts > query.until) return false;
  return true;
}

function normalizeUsage(usage: TokenUsage): TokenUsage {
  const input = finite(usage.input);
  const output = finite(usage.output);
  const reasoning = finite(usage.reasoning ?? 0);
  const cacheRead = finite(usage.cache_read ?? 0);
  const cacheWrite = finite(usage.cache_write ?? 0);
  const total = finite(usage.total || input + output + reasoning + cacheRead + cacheWrite);
  return { input, output, reasoning, cache_read: cacheRead, cache_write: cacheWrite, total };
}

function finite(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeActor(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("@")) return trimmed.slice(1);
  if (trimmed.startsWith("agent:")) return trimmed.slice("agent:".length);
  return trimmed;
}

function redactMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/(token|secret|api[_-]?key|authorization|password|refresh|access)/i.test(key)) {
      out[key] = "<redacted>";
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      out[key] = redactMetadata(entry as Record<string, unknown>);
    } else {
      out[key] = typeof entry === "string" ? redactSecretString(entry) : entry;
    }
  }
  return out;
}

function redactSecretString(value: string): string {
  return value
    .replace(/\b[A-Z0-9_]*SECRET[A-Z0-9_]*DO_NOT_LEAK[A-Z0-9_]*\b/g, "<redacted>")
    .replace(/\b(?:sk|pk|ghp|gho|github_pat|xox[baprs])[-_A-Za-z0-9]{8,}\b/g, "<redacted>");
}
