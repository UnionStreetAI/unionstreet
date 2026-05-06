import type {
  OpenApiOperationRequest,
  OpenApiOperationResponse,
  OpenApiOperations,
  OpenApiSchemas,
} from "./generated/openapi-types.ts";

export type {
  OpenApiOperationId,
  OpenApiOperationRequest,
  OpenApiOperationResponse,
  OpenApiOperations,
  OpenApiSchemas,
} from "./generated/openapi-types.ts";

export interface UnionStreetClientOptions {
  baseUrl?: string;
  token?: string | (() => string | undefined);
  fetch?: FetchLike;
}

export interface UnionStreetSdkRoute {
  method: "GET" | "POST";
  path: string;
}

export const UNION_STREET_SDK_ROUTES: UnionStreetSdkRoute[] = [
  { method: "GET", path: "/health" },
  { method: "GET", path: "/openapi.json" },
  { method: "GET", path: "/api/runtime" },
  { method: "GET", path: "/api/agents" },
  { method: "GET", path: "/api/agents/{profile}" },
  { method: "POST", path: "/api/agents/{profile}/prompt" },
  { method: "POST", path: "/api/peers/{profile}/wake" },
  { method: "GET", path: "/api/models" },
  { method: "GET", path: "/api/runtimes" },
  { method: "GET", path: "/api/runtimes/{profile}" },
  { method: "POST", path: "/api/runtimes/{profile}/ensure" },
  { method: "GET", path: "/api/events" },
  { method: "GET", path: "/api/events/stream" },
  { method: "GET", path: "/api/usage" },
  { method: "GET", path: "/api/memory" },
  { method: "GET", path: "/api/memory/anchors" },
  { method: "GET", path: "/api/sessions" },
  { method: "GET", path: "/api/scheduler/jobs" },
  { method: "POST", path: "/api/scheduler/jobs" },
  { method: "GET", path: "/api/scheduler/due" },
  { method: "POST", path: "/api/scheduler/tick" },
  { method: "GET", path: "/api/scheduler/runs" },
  { method: "POST", path: "/api/fleet/plan" },
  { method: "POST", path: "/api/fleet/validate" },
  { method: "POST", path: "/api/fleet/apply" },
  { method: "POST", path: "/api/webhooks/{source}" },
] as const;

export interface RequestOptions {
  signal?: AbortSignal;
}

export type RuntimeProvider =
  | "local"
  | "docker"
  | "kubernetes"
  | "aws"
  | "gcp"
  | "azure"
  | "vercel"
  | "render"
  | "modal"
  | "daytona";

export type RuntimeHeadProvider = Exclude<RuntimeProvider, "docker">;
export type RuntimeStorageProvider =
  | "local"
  | "volume"
  | "s3"
  | "gcs"
  | "azure-blob"
  | "vercel-blob"
  | "render-disk"
  | "modal-volume"
  | "daytona-volume";
export type RuntimeIngressProvider =
  | "local"
  | "http"
  | "vercel"
  | "render"
  | "aws-alb"
  | "gcp-lb"
  | "azure-app-gateway"
  | "kubernetes-ingress"
  | "modal"
  | "daytona";
export type RuntimeWorkspaceScope = "agent" | "session" | "shared";
export type RuntimeComputeTarget = "host" | "container" | "vm" | "pod" | "function" | "sandbox";
export type RuntimeNetworkMode = "none" | "egress" | "private";
export type RuntimeIngressAuth = "federation-jwt" | "oauth" | "none";
export type RuntimeIngressReceiver = "mcp" | "lash" | "webhook" | "control";
export type RuntimeEventOutcome = "allow" | "deny" | "success" | "failure" | "info";
export type RuntimeEventSeverity = "debug" | "info" | "warn" | "error";
export type RuntimeUsageKind = "prompt" | "lash" | "scheduler" | "chat";
export type RuntimeCostSource = "explicit" | "provider:free" | "provider:rate_card" | "env:rate_card" | "models.dev" | "unknown";
export type RuntimeSchedulerJobKind = "pulse" | "schedule";
export type RuntimeSchedulerRunStatus = "claimed" | "running" | "complete" | "failed";
export type RuntimeWebhookBody = OpenApiOperationRequest<"postApiWebhooksSource">;
type RuntimeOperationResponse<T extends keyof OpenApiOperations> = OpenApiOperationResponse<T>;

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
  model?: RuntimeModelTarget;
  modelChain?: RuntimeModelTarget[];
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
  profile: string;
  head: RuntimeHeadConfig;
  compute: RuntimeComputeConfig;
  storage: RuntimeStorageConfig;
  ingress: RuntimeIngressConfig;
  workspace: RuntimeWorkspaceConfig;
  workspacePath: string;
  pluginId: string;
  terraformModule?: string;
  secrets: Array<Record<string, unknown>>;
  secretsPath?: string;
  warnings?: string[];
}

export interface RuntimeHeadConfig {
  mode: "embedded" | "daemon" | "remote";
  provider: RuntimeHeadProvider;
  honcho?: {
    baseUrl?: string;
    workspaceId?: string;
    apiKeyEnv?: string;
  };
  endpoint?: string;
}

export interface RuntimeWorkspaceConfig {
  provider: RuntimeProvider;
  scope: RuntimeWorkspaceScope;
  root?: string;
  workdir: string;
  image?: string;
  region?: string;
  size?: string;
  network?: RuntimeNetworkMode;
  persistent?: boolean;
  ttlMinutes?: number;
  plugin?: string;
  labels?: Record<string, string>;
  env?: Record<string, string>;
}

export interface RuntimeComputeConfig {
  provider: RuntimeProvider;
  target: RuntimeComputeTarget;
  image?: string;
  command?: string[];
  cpu?: string;
  memory?: string;
  gpu?: string;
  region?: string;
  minInstances?: number;
  maxInstances?: number;
}

export interface RuntimeStorageConfig {
  provider: RuntimeStorageProvider;
  bucket?: string;
  volume?: string;
  mountPath: string;
  persistent: boolean;
  encryption?: "provider-managed" | "customer-managed";
}

export interface RuntimeIngressConfig {
  provider: RuntimeIngressProvider;
  url?: string;
  internalUrl?: string;
  public: boolean;
  auth: RuntimeIngressAuth;
  receives: RuntimeIngressReceiver[];
}

export interface RuntimeEvent {
  id: string;
  ts: number;
  type: string;
  actor?: string;
  subject?: string;
  target?: string;
  resource?: string;
  reason?: string;
  trace?: string;
  threadId?: string;
  sessionId?: string;
  severity?: RuntimeEventSeverity;
  outcome: RuntimeEventOutcome;
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
  kind: RuntimeUsageKind;
  usage: RuntimeTokenUsage;
  costMicroUsd?: number;
  costSource?: RuntimeCostSource;
  metadata?: Record<string, unknown>;
}

export interface RuntimeTokenUsage {
  input: number;
  output: number;
  reasoning?: number;
  cache_read?: number;
  cache_write?: number;
  total: number;
}

export interface RuntimeSchedulerJob {
  id: string;
  profile: string;
  kind: RuntimeSchedulerJobKind;
  name: string;
  cron?: string;
  cadence: string;
  timezone?: string;
  prompt: string;
  deliverables: string[];
  route: string[];
  dueAt?: number;
  enabled: boolean;
}

export interface RuntimeSchedulerRun {
  id: string;
  profile: string;
  jobId: string;
  kind: RuntimeSchedulerJobKind;
  status: RuntimeSchedulerRunStatus;
  dueAt: number;
  dueKey?: string;
  ts?: number;
  prompt?: string;
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
  profile?: string;
  text?: string;
  provider?: string;
  model?: string;
  trace?: string;
  runId?: string;
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

export interface RuntimeModelTarget {
  provider: string;
  id: string;
}

export interface RuntimePromptRequest {
  prompt: string;
  sessionId?: string;
  trace?: string;
  model?: RuntimeModelTarget;
}

export interface RuntimePromptResponse {
  result: RuntimePromptResult;
}

export interface RuntimePeerWakeRequest {
  caller: string;
  message: string;
  trace?: string;
  wakeKind?: "delegate" | "report";
  textVerbosity?: "low" | "medium" | "high";
  thread?: { id: string; resume?: string; summary?: string; turn: number };
  chain?: Array<{ from: string; to: string; at: string }>;
}

export interface RuntimePeerWakeResult {
  ok: boolean;
  response?: string;
  trace?: string;
  thread?: unknown;
  chain?: unknown[];
  delegation?: { relation?: string; depth?: number };
  modelId?: string;
  usage?: { input?: number; output?: number; reasoning?: number; total?: number };
  error?: string;
}

export interface RuntimePeerWakeResponse {
  result: RuntimePeerWakeResult;
}

export interface SchedulerJobCreateRequest {
  owner: string;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  deliverables: string[];
  route: string[];
}

export interface SchedulerJobCreateResponse {
  schedule: RuntimePackSchedule;
}

export interface SchedulerTickRequest {
  now?: number;
  profiles?: string[];
  execute?: boolean;
}

export interface SchedulerRunsResponse {
  runs: RuntimeSchedulerRun[];
}

export interface FleetPlanCreateRequest {
  profile: string;
  prompt: string;
}

export interface FleetValidateRequest {
  plan: RuntimeFleetPlan;
  allowExisting?: boolean;
}

export interface FleetApplyRequest {
  plan: RuntimeFleetPlan;
  overwrite?: boolean;
  dryRun?: boolean;
}

export interface FleetApplyResponse {
  applied: boolean;
  profiles: string[];
  validation: RuntimeFleetValidation;
  message?: string;
}

export interface WebhookIngressResponse {
  event: RuntimeEvent;
}

export class UnionStreetApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, fallback = `http ${status}`) {
    super(readErrorMessage(body) ?? fallback);
    this.name = "UnionStreetApiError";
    this.status = status;
    this.body = body;
  }
}

export class UnionStreetClient {
  readonly baseUrl: string;
  private readonly token?: string | (() => string | undefined);
  private readonly fetchImpl: FetchLike;

  constructor(options: UnionStreetClientOptions = {}) {
    this.baseUrl = cleanBaseUrl(options.baseUrl ?? "http://127.0.0.1:8787");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) throw new Error("UnionStreetClient requires a fetch implementation.");
  }

  async health(options: RequestOptions = {}): Promise<RuntimeHealth> {
    return this.json<RuntimeOperationResponse<"getHealth">>("/health", { signal: options.signal });
  }

  async openapi(options: RequestOptions = {}): Promise<unknown> {
    return this.json<RuntimeOperationResponse<"getOpenapiJson">>("/openapi.json", { signal: options.signal });
  }

  async runtime(options: RequestOptions = {}): Promise<RuntimeInfo> {
    return this.json<RuntimeOperationResponse<"getApiRuntime">>("/api/runtime", { signal: options.signal });
  }

  async agents(options: RequestOptions = {}): Promise<RuntimeAgentSnapshot[]> {
    const response = await this.json<RuntimeOperationResponse<"getApiAgents">>("/api/agents", { signal: options.signal });
    return response.agents;
  }

  async agent(profile: string, options: RequestOptions = {}): Promise<RuntimeAgentSnapshot> {
    return this.json<RuntimeOperationResponse<"getApiAgentsProfile">>(`/api/agents/${encodeURIComponent(profile)}`, { signal: options.signal });
  }

  async models(profile?: string, options: RequestOptions = {}): Promise<RuntimeModelGroup[]> {
    const query = profile ? `?profile=${encodeURIComponent(profile)}` : "";
    const response = await this.json<RuntimeOperationResponse<"getApiModels">>(`/api/models${query}`, { signal: options.signal });
    return response.groups;
  }

  async sendAgentPrompt(
    profile: string,
    body: OpenApiOperationRequest<"postApiAgentsProfilePrompt">,
    options: RequestOptions = {},
  ): Promise<RuntimePromptResult> {
    const response = await this.json<RuntimeOperationResponse<"postApiAgentsProfilePrompt">>(`/api/agents/${encodeURIComponent(profile)}/prompt`, {
      method: "POST",
      body,
      signal: options.signal,
    });
    return response.result;
  }

  async wakePeer(profile: string, body: OpenApiOperationRequest<"postApiPeersProfileWake">, options: RequestOptions = {}): Promise<RuntimePeerWakeResult> {
    const response = await this.json<RuntimeOperationResponse<"postApiPeersProfileWake">>(`/api/peers/${encodeURIComponent(profile)}/wake`, {
      method: "POST",
      body,
      signal: options.signal,
    });
    return response.result;
  }

  async runtimes(profiles?: string[], options: RequestOptions = {}): Promise<RuntimeContract[]> {
    const query = profiles?.length ? `?profile=${profiles.map(encodeURIComponent).join(",")}` : "";
    const response = await this.json<RuntimeOperationResponse<"getApiRuntimes">>(`/api/runtimes${query}`, { signal: options.signal });
    return response.runtimes;
  }

  async runtimeForAgent(profile: string, options: RequestOptions = {}): Promise<RuntimeContract> {
    return this.json<RuntimeOperationResponse<"getApiRuntimesProfile">>(`/api/runtimes/${encodeURIComponent(profile)}`, { signal: options.signal });
  }

  async ensureAgentRuntime(profile: string, options: RequestOptions = {}): Promise<RuntimeContract> {
    return this.json<RuntimeOperationResponse<"postApiRuntimesProfileEnsure">>(`/api/runtimes/${encodeURIComponent(profile)}/ensure`, {
      method: "POST",
      signal: options.signal,
    });
  }

  async events(query: EventQuery = {}, options: RequestOptions = {}): Promise<RuntimeEvent[]> {
    const response = await this.json<RuntimeOperationResponse<"getApiEvents">>(`/api/events${queryString(query as QueryShape)}`, { signal: options.signal });
    return response.events;
  }

  async usage(query: UsageQuery = {}, options: RequestOptions = {}): Promise<RuntimeUsageResponse> {
    return this.json<RuntimeOperationResponse<"getApiUsage">>(`/api/usage${queryString(query as QueryShape)}`, { signal: options.signal });
  }

  async memory(query: MemoryQuery = {}, options: RequestOptions = {}): Promise<RuntimeMemoryEvent[]> {
    const response = await this.json<RuntimeOperationResponse<"getApiMemory">>(`/api/memory${queryString(query as QueryShape)}`, { signal: options.signal });
    return response.memory;
  }

  async memoryAnchors(profile: string, options: RequestOptions & { limit?: number } = {}): Promise<unknown[]> {
    const response = await this.json<RuntimeOperationResponse<"getApiMemoryAnchors">>(`/api/memory/anchors${queryString({ profile, limit: options.limit })}`, { signal: options.signal });
    return response.anchors;
  }

  async sessions(profile: string, options: RequestOptions = {}): Promise<RuntimeSession[]> {
    const response = await this.json<RuntimeOperationResponse<"getApiSessions">>(`/api/sessions?profile=${encodeURIComponent(profile)}`, { signal: options.signal });
    return response.sessions;
  }

  async schedulerJobs(profiles?: string[], options: RequestOptions = {}): Promise<RuntimeSchedulerJob[]> {
    const query = profiles?.length ? `?profile=${profiles.map(encodeURIComponent).join(",")}` : "";
    const response = await this.json<RuntimeOperationResponse<"getApiSchedulerJobs">>(`/api/scheduler/jobs${query}`, { signal: options.signal });
    return response.jobs;
  }

  async createSchedulerJob(body: OpenApiOperationRequest<"postApiSchedulerJobs">, options: RequestOptions = {}): Promise<RuntimePackSchedule> {
    const response = await this.json<RuntimeOperationResponse<"postApiSchedulerJobs">>("/api/scheduler/jobs", {
      method: "POST",
      body,
      signal: options.signal,
    });
    return response.schedule;
  }

  async schedulerDue(query: SchedulerDueQuery = {}, options: RequestOptions = {}): Promise<RuntimeSchedulerJob[]> {
    const response = await this.json<RuntimeOperationResponse<"getApiSchedulerDue">>(`/api/scheduler/due${queryString(query as QueryShape)}`, { signal: options.signal });
    return response.due;
  }

  async runSchedulerTick(
    body: OpenApiOperationRequest<"postApiSchedulerTick">,
    options: RequestOptions = {},
  ): Promise<RuntimeSchedulerRun[]> {
    const response = await this.json<RuntimeOperationResponse<"postApiSchedulerTick">>("/api/scheduler/tick", {
      method: "POST",
      body,
      signal: options.signal,
    });
    return response.runs;
  }

  async schedulerRuns(options: RequestOptions = {}): Promise<RuntimeSchedulerRun[]> {
    const response = await this.json<RuntimeOperationResponse<"getApiSchedulerRuns">>("/api/scheduler/runs", { signal: options.signal });
    return response.runs;
  }

  async planFleet(body: OpenApiOperationRequest<"postApiFleetPlan">, options: RequestOptions = {}): Promise<RuntimeFleetPlanResponse> {
    return this.json<RuntimeOperationResponse<"postApiFleetPlan">>("/api/fleet/plan", {
      method: "POST",
      body,
      signal: options.signal,
    });
  }

  async validateFleet(plan: RuntimeFleetPlan, options: RequestOptions & { allowExisting?: boolean } = {}): Promise<RuntimeFleetPlanResponse> {
    return this.json<RuntimeOperationResponse<"postApiFleetValidate">>("/api/fleet/validate", {
      method: "POST",
      body: { plan, ...(options.allowExisting === undefined ? {} : { allowExisting: options.allowExisting }) } satisfies OpenApiOperationRequest<"postApiFleetValidate">,
      signal: options.signal,
    });
  }

  async applyFleet(
    plan: RuntimeFleetPlan,
    body: { overwrite?: boolean; dryRun?: boolean } = {},
    options: RequestOptions = {},
  ): Promise<FleetApplyResponse> {
    return this.json<RuntimeOperationResponse<"postApiFleetApply">>("/api/fleet/apply", {
      method: "POST",
      body: { plan, overwrite: body.overwrite === true, dryRun: body.dryRun === true } satisfies OpenApiOperationRequest<"postApiFleetApply">,
      signal: options.signal,
    });
  }

  async sendWebhook(
    source: string,
    body: RuntimeWebhookBody,
    options: RequestOptions & { signature?: string; actor?: string } = {},
  ): Promise<RuntimeEvent> {
    const headers = new Headers();
    if (options.signature) headers.set("x-us-signature", options.signature);
    if (options.actor) headers.set("x-union-street-actor", options.actor);
    const response = await this.json<RuntimeOperationResponse<"postApiWebhooksSource">>(`/api/webhooks/${encodeURIComponent(source)}`, {
      method: "POST",
      headers,
      body,
      signal: options.signal,
    });
    return response.event;
  }

  async snapshot(options: RequestOptions = {}): Promise<RuntimeSnapshot> {
    try {
      const [health, runtime, agents, runtimes, events, usage, jobs, runs, memory] = await Promise.all([
        this.health(options),
        this.runtime(options),
        this.agents(options),
        this.runtimes(undefined, options),
        this.events({ limit: 250 }, options),
        this.usage({ limit: 1_000 }, options),
        this.schedulerJobs(undefined, options),
        this.schedulerRuns(options),
        this.memory({ limit: 250 }, options),
      ]);
      return {
        connected: true,
        baseUrl: this.baseUrl,
        health,
        runtime,
        agents,
        runtimes,
        events,
        usage,
        scheduler: { jobs, runs },
        memory,
        models: [],
      };
    } catch (error) {
      return emptyRuntimeSnapshot(this.baseUrl, (error as Error).message);
    }
  }

  async streamEvents(options: {
    signal: AbortSignal;
    query?: EventQuery;
    onEvent(event: RuntimeEvent): void;
    onError(error: Error): void;
  }): Promise<void> {
    const response = await this.request(`/api/events/stream${queryString({ limit: 100, ...(options.query ?? {}) })}`, { signal: options.signal });
    if (!response.ok || !response.body) {
      throw new UnionStreetApiError(response.status, await readResponseBody(response), `runtime SSE failed: http ${response.status}`);
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

  async json<T>(path: string, init: SdkRequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    const body = await readResponseBody(response);
    if (!response.ok) throw new UnionStreetApiError(response.status, body);
    return body as T;
  }

  async request(path: string, init: SdkRequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const token = this.readToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
    let body: BodyInit | undefined;
    if (init.body !== undefined) {
      if (typeof init.body === "string" || init.body instanceof FormData || init.body instanceof Blob || init.body instanceof URLSearchParams) {
        body = init.body;
      } else {
        body = JSON.stringify(init.body);
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
      }
    }
    const { body: _body, ...requestInit } = init;
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      ...requestInit,
      headers,
      ...(body === undefined ? {} : { body }),
    });
  }

  private readToken(): string | undefined {
    const token = typeof this.token === "function" ? this.token() : this.token;
    return trim(token);
  }
}

export interface EventQuery {
  type?: string;
  actor?: string;
  agent?: string;
  subject?: string;
  target?: string;
  trace?: string;
  outcome?: string;
  since?: number;
  until?: number;
  limit?: number;
}

export interface UsageQuery {
  actor?: string;
  agent?: string;
  provider?: string;
  model?: string;
  sessionId?: string;
  trace?: string;
  kind?: string;
  since?: number;
  until?: number;
  limit?: number;
}

export interface MemoryQuery {
  profile?: string;
  kind?: string;
  trace?: string;
  limit?: number;
}

export interface SchedulerDueQuery {
  profile?: string | string[];
  now?: number | string;
}

type SdkRequestInit = Omit<RequestInit, "body"> & { body?: unknown };
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type QueryShape = Record<string, string | number | boolean | string[] | undefined>;

export function emptyRuntimeSnapshot(baseUrl: string, error: string): RuntimeSnapshot {
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

export function cleanBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function queryString(query: QueryShape): string {
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query)) {
    if (raw === undefined || raw === null || raw === "") continue;
    if (Array.isArray(raw)) {
      if (raw.length) params.set(key, raw.join(","));
    } else {
      params.set(key, String(raw));
    }
  }
  const value = params.toString();
  return value ? `?${value}` : "";
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function readErrorMessage(body: unknown): string | undefined {
  return typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
    ? body.message
    : undefined;
}

function trim(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
