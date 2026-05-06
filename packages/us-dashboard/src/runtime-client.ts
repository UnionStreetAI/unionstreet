import {
  UnionStreetClient,
  cleanBaseUrl,
  emptyRuntimeSnapshot,
  type RuntimeContract,
  type RuntimeEvent,
  type RuntimeFleetPlan,
  type RuntimeFleetPlanResponse,
  type RuntimeFleetValidation,
  type RuntimeHealth,
  type RuntimeInfo,
  type RuntimeMemoryEvent,
  type RuntimeModelGroup,
  type RuntimePackSchedule,
  type RuntimePromptResult,
  type RuntimeSchedulerRun,
  type RuntimeSnapshot,
} from "@unionstreet/sdk";

export type {
  RuntimeAgentSnapshot,
  RuntimeContract,
  RuntimeEvent,
  RuntimeFleetPlan,
  RuntimeFleetPlanAgent,
  RuntimeFleetPlanResponse,
  RuntimeFleetValidation,
  RuntimeHealth,
  RuntimeInfo,
  RuntimeMemoryEvent,
  RuntimeModel,
  RuntimeModelGroup,
  RuntimePackSchedule,
  RuntimePromptResult,
  RuntimeSchedulerJob,
  RuntimeSchedulerRun,
  RuntimeSession,
  RuntimeSnapshot,
  RuntimeUsageRecord,
  RuntimeUsageResponse,
} from "@unionstreet/sdk";

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";

export function runtimeBaseUrl(): string {
  return cleanBaseUrl(
    import.meta.env.VITE_US_RUNTIME_URL
      || DEFAULT_BASE_URL,
  );
}

export function runtimeToken(): string | undefined {
  return trim(import.meta.env.VITE_US_RUNTIME_TOKEN || globalThis.localStorage?.getItem("us.runtime.token"));
}

export function runtimeClient(): UnionStreetClient {
  return new UnionStreetClient({
    baseUrl: runtimeBaseUrl(),
    token: runtimeToken,
  });
}

export async function loadRuntimeSnapshot(signal?: AbortSignal): Promise<RuntimeSnapshot> {
  return runtimeClient().snapshot({ signal });
}

export async function loadRuntimeModels(profile?: string, signal?: AbortSignal): Promise<RuntimeModelGroup[]> {
  return runtimeClient().models(profile, { signal });
}

export async function sendAgentPrompt(
  profile: string,
  body: { prompt: string; sessionId?: string; trace?: string; model?: { provider: string; id: string } },
  signal?: AbortSignal,
): Promise<RuntimePromptResult> {
  return runtimeClient().sendAgentPrompt(profile, body, { signal });
}

export async function planFleet(
  body: { profile: string; prompt: string },
  signal?: AbortSignal,
): Promise<RuntimeFleetPlanResponse> {
  return runtimeClient().planFleet(body, { signal });
}

export async function validateFleet(
  plan: RuntimeFleetPlan,
  signal?: AbortSignal,
): Promise<RuntimeFleetPlanResponse> {
  return runtimeClient().validateFleet(plan, { signal });
}

export async function applyFleet(
  plan: RuntimeFleetPlan,
  body: { overwrite?: boolean; dryRun?: boolean } = {},
  signal?: AbortSignal,
): Promise<{ applied: boolean; profiles: string[]; validation: RuntimeFleetValidation }> {
  return runtimeClient().applyFleet(plan, body, { signal });
}

export async function runSchedulerTick(
  body: { now?: number; profiles?: string[]; execute?: boolean },
  signal?: AbortSignal,
): Promise<{ runs: RuntimeSchedulerRun[] }> {
  return { runs: await runtimeClient().runSchedulerTick(body, { signal }) };
}

export async function createSchedulerJob(
  body: {
    owner: string;
    name: string;
    cron: string;
    timezone: string;
    prompt: string;
    deliverables: string[];
    route: string[];
  },
  signal?: AbortSignal,
): Promise<{ schedule: RuntimePackSchedule }> {
  return { schedule: await runtimeClient().createSchedulerJob(body, { signal }) };
}

export async function ensureAgentRuntime(profile: string, signal?: AbortSignal): Promise<RuntimeContract> {
  return runtimeClient().ensureAgentRuntime(profile, { signal });
}

export async function streamRuntimeEvents(options: {
  signal: AbortSignal;
  onEvent(event: RuntimeEvent): void;
  onError(error: Error): void;
}): Promise<void> {
  return runtimeClient().streamEvents(options);
}

export { emptyRuntimeSnapshot };

function trim(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
