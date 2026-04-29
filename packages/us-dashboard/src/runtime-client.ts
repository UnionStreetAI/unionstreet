export interface RuntimeSnapshot {
  connected: boolean;
  baseUrl: string;
  error?: string;
  health?: RuntimeHealth;
  runtime?: RuntimeInfo;
  agents: RuntimeAgentSnapshot[];
  runtimes: RuntimeContract[];
  events: RuntimeEvent[];
  usage: RuntimeUsageResponse;
  scheduler: {
    jobs: RuntimeSchedulerJob[];
    runs: RuntimeSchedulerRun[];
  };
  memory: RuntimeMemoryEvent[];
  models: RuntimeModelGroup[];
}

export interface RuntimeHealth {
  ok: boolean;
  version: string;
  runtimeId: string;
  uptimeMs: number;
  usHome: string;
  ts: number;
}

export interface RuntimeInfo {
  runtimeId: string;
  version: string;
  startedAt: number;
  uptimeMs: number;
  usHome: string;
  cwd: string;
  profiles: number;
  endpoints: string[];
}

export interface RuntimeAgentSnapshot {
  profile: string;
  model?: { provider?: string; id?: string };
  modelChain?: Array<{ provider?: string; id?: string }>;
  pack?: {
    id?: string;
    identity?: {
      displayName?: string;
      title?: string;
      roles?: string[];
      groups?: string[];
    };
    model?: {
      primary?: { provider?: string; id?: string };
      fallback?: Array<{ provider?: string; id?: string }>;
    };
    lash?: {
      thread?: string;
      structured?: string;
    };
    schedule?: RuntimePackSchedule[];
    pulse?: {
      enabled?: boolean;
      cadence?: string;
      instructions?: string;
    };
  };
  runtime?: RuntimeContract;
  principal?: {
    id?: string;
    subject?: string;
    displayName?: string;
    title?: string;
    roles?: string[];
    groups?: string[];
    manager?: string;
  };
  delegation?: Array<{ profile: string; relation: string; depth?: number; displayName?: string; title?: string }>;
  mcp?: {
    servers?: Array<{ name: string; transport?: string; url?: string; command?: string; enabled?: boolean; credential?: { configured?: boolean; kind?: string; source?: string } }>;
    builtinTools?: Array<{ name: string; description?: string }>;
    grants?: Record<string, { allowed?: boolean; reason?: string; tools?: string[] }>;
  };
  memory?: Record<string, unknown>;
  sessions?: RuntimeSession[];
}

export interface RuntimeModelGroup {
  id: string;
  label: string;
  authMethod: string;
  state: "live" | "fallback" | "error" | string;
  baseUrl?: string;
  models: RuntimeModel[];
}

export interface RuntimeModel {
  id: string;
  description?: string;
  display_name?: string;
  context_window?: number;
}

export interface RuntimeContract {
  profile?: string;
  provider?: string;
  runtime?: string;
  head?: Record<string, unknown>;
  compute?: Record<string, unknown>;
  storage?: Record<string, unknown>;
  ingress?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  tools?: Record<string, unknown>;
  warnings?: string[];
}

export interface RuntimeEvent {
  id?: string;
  ts: number;
  type: string;
  actor?: string;
  subject?: string;
  target?: string;
  resource?: string;
  outcome?: string;
  reason?: string;
  trace?: string;
  threadId?: string;
  payload?: unknown;
}

export interface RuntimeUsageResponse {
  usage: RuntimeUsageRecord[];
  summary: {
    input?: number;
    output?: number;
    reasoning?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
    calls?: number;
    costMicroUsd?: number;
  };
}

export interface RuntimeUsageRecord {
  ts?: number;
  actor?: string;
  provider?: string;
  model?: string;
  sessionId?: string;
  trace?: string;
  kind?: string;
  input?: number;
  output?: number;
  reasoning?: number;
  total?: number;
  costMicroUsd?: number;
}

export interface RuntimeSchedulerJob {
  id: string;
  profile: string;
  kind: "pulse" | "schedule" | string;
  name?: string;
  cron?: string;
  cadence?: string;
  timezone?: string;
  prompt?: string;
  deliverables?: string[];
  route?: string[];
  dueAt?: number;
  enabled?: boolean;
}

export interface RuntimeSchedulerRun {
  id: string;
  profile: string;
  jobId?: string;
  kind?: string;
  status?: string;
  dueAt?: number;
  claimedAt?: number;
  completedAt?: number;
  trace?: string;
  sessionId?: string;
  result?: unknown;
}

export interface RuntimePackSchedule {
  id?: string;
  name?: string;
  cron?: string;
  timezone?: string;
  prompt?: string;
  deliverables?: string[];
  route?: string[];
}

export interface RuntimeMemoryEvent {
  id?: string;
  ts?: number;
  peer?: string;
  kind?: string;
  trace?: string;
  source?: string;
  text?: string;
  payload?: unknown;
}

export interface RuntimeSession {
  id?: string;
  path?: string;
  updatedAt?: number;
  turns?: number;
  provider?: string;
  model?: string;
}

export interface RuntimePromptResult {
  text?: string;
  provider?: string;
  model?: string;
  trace?: string;
  sessionId?: string;
  sessionFile?: string;
  toolCalls?: Array<{ name?: string; args?: unknown; result?: unknown }>;
  steps?: unknown[];
  usage?: { input?: number; output?: number; reasoning?: number; total?: number };
}

export interface RuntimeFleetPlan {
  version: 1;
  kind: "union-street.fleet-plan";
  name: string;
  mission: string;
  root: string;
  generatedBy: string;
  agents: RuntimeFleetPlanAgent[];
}

export interface RuntimeFleetPlanAgent {
  id: string;
  displayName: string;
  title: string;
  manager?: string;
  groups: string[];
  roles: string[];
  soul: string;
  model: { provider: string; id: string };
  fallback?: Array<{ provider: string; id: string }>;
  mcp?: string[];
  cli?: string[];
  permissions?: string[];
  secrets?: string[];
}

export interface RuntimeFleetValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  summary: {
    agents: number;
    root: string;
    groups: string[];
    roles: string[];
    mcpServers: string[];
  };
}

export interface RuntimeFleetPlanResponse {
  plan: RuntimeFleetPlan;
  validation: RuntimeFleetValidation;
  result?: RuntimePromptResult;
}

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

export async function loadRuntimeSnapshot(signal?: AbortSignal): Promise<RuntimeSnapshot> {
  const baseUrl = runtimeBaseUrl();
  try {
    const [health, runtime, agents, runtimes, events, usage, jobs, runs, memory] = await Promise.all([
      runtimeJson<RuntimeHealth>("/health", { signal }),
      runtimeJson<RuntimeInfo>("/api/runtime", { signal }),
      runtimeJson<{ agents: RuntimeAgentSnapshot[] }>("/api/agents", { signal }),
      runtimeJson<{ runtimes: RuntimeContract[] }>("/api/runtimes", { signal }),
      runtimeJson<{ events: RuntimeEvent[] }>("/api/events?limit=250", { signal }),
      runtimeJson<RuntimeUsageResponse>("/api/usage?limit=1000", { signal }),
      runtimeJson<{ jobs: RuntimeSchedulerJob[] }>("/api/scheduler/jobs", { signal }),
      runtimeJson<{ runs: RuntimeSchedulerRun[] }>("/api/scheduler/runs", { signal }),
      runtimeJson<{ memory: RuntimeMemoryEvent[] }>("/api/memory?limit=250", { signal }),
    ]);

    return {
      connected: true,
      baseUrl,
      health,
      runtime,
      agents: agents.agents,
      runtimes: runtimes.runtimes,
      events: events.events,
      usage,
      scheduler: { jobs: jobs.jobs, runs: runs.runs },
      memory: memory.memory,
      models: [],
    };
  } catch (error) {
    return emptyRuntimeSnapshot(baseUrl, (error as Error).message);
  }
}

export async function loadRuntimeModels(profile?: string, signal?: AbortSignal): Promise<RuntimeModelGroup[]> {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : "";
  const response = await runtimeJson<{ groups: RuntimeModelGroup[] }>(`/api/models${query}`, { signal });
  return response.groups;
}

export async function sendAgentPrompt(
  profile: string,
  body: { prompt: string; sessionId?: string; trace?: string; model?: { provider: string; id: string } },
  signal?: AbortSignal,
): Promise<RuntimePromptResult> {
  const response = await runtimeJson<{ result: RuntimePromptResult }>(`/api/agents/${encodeURIComponent(profile)}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return response.result;
}

export async function planFleet(
  body: { profile: string; prompt: string },
  signal?: AbortSignal,
): Promise<RuntimeFleetPlanResponse> {
  return runtimeJson<RuntimeFleetPlanResponse>("/api/fleet/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export async function validateFleet(
  plan: RuntimeFleetPlan,
  signal?: AbortSignal,
): Promise<RuntimeFleetPlanResponse> {
  return runtimeJson<RuntimeFleetPlanResponse>("/api/fleet/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plan }),
    signal,
  });
}

export async function applyFleet(
  plan: RuntimeFleetPlan,
  body: { overwrite?: boolean; dryRun?: boolean } = {},
  signal?: AbortSignal,
): Promise<{ applied: boolean; profiles: string[]; validation: RuntimeFleetValidation }> {
  return runtimeJson<{ applied: boolean; profiles: string[]; validation: RuntimeFleetValidation }>("/api/fleet/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plan, overwrite: body.overwrite === true, dryRun: body.dryRun === true }),
    signal,
  });
}

export async function runSchedulerTick(
  body: { now?: number; profiles?: string[]; execute?: boolean },
  signal?: AbortSignal,
): Promise<{ runs: RuntimeSchedulerRun[] }> {
  return runtimeJson<{ runs: RuntimeSchedulerRun[] }>("/api/scheduler/tick", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
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
  return runtimeJson<{ schedule: RuntimePackSchedule }>("/api/scheduler/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export async function ensureAgentRuntime(profile: string, signal?: AbortSignal): Promise<unknown> {
  return runtimeJson(`/api/runtimes/${encodeURIComponent(profile)}/ensure`, {
    method: "POST",
    signal,
  });
}

export async function streamRuntimeEvents(options: {
  signal: AbortSignal;
  onEvent(event: RuntimeEvent): void;
  onError(error: Error): void;
}): Promise<void> {
  const response = await runtimeFetch("/api/events/stream?limit=100", { signal: options.signal });
  if (!response.ok || !response.body) {
    throw new Error(`runtime SSE failed: http ${response.status}`);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (!options.signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const frames = buffer.split(/\n\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      if (!data) continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed?.message && frame.includes("event: error")) options.onError(new Error(parsed.message));
        else options.onEvent(parsed as RuntimeEvent);
      } catch (error) {
        options.onError(error as Error);
      }
    }
  }
}

async function runtimeJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await runtimeFetch(path, init);
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = typeof body?.message === "string" ? body.message : `http ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

async function runtimeFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = runtimeToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(`${runtimeBaseUrl()}${path}`, { ...init, headers });
}

function emptyRuntimeSnapshot(baseUrl: string, error: string): RuntimeSnapshot {
  return {
    connected: false,
    baseUrl,
    error,
    agents: [],
    runtimes: [],
    events: [],
    usage: { usage: [], summary: {} },
    scheduler: { jobs: [], runs: [] },
    memory: [],
    models: [],
  };
}

function cleanBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function trim(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
