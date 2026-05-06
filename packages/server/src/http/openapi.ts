type HttpMethod = "GET" | "POST";
type AuthMode = "none" | "runtime";
type SdkCoverage = "covered" | "excluded";
type ResponseContent = "json" | "sse";

export interface RuntimeApiRoute {
  method: HttpMethod;
  path: string;
  auth: AuthMode;
  sdk: SdkCoverage;
  description: string;
  response: string;
  successStatus?: 200 | 201 | 202;
  responseContent?: ResponseContent;
  request?: string;
  query?: string[];
}

export const RUNTIME_API_ROUTES: RuntimeApiRoute[] = [
  { method: "GET", path: "/health", auth: "none", sdk: "covered", description: "Runtime liveness and process metadata.", response: "RuntimeHealth" },
  { method: "GET", path: "/openapi.json", auth: "none", sdk: "covered", description: "OpenAPI contract for the runtime HTTP API.", response: "OpenApiDocument" },
  { method: "GET", path: "/api/runtime", auth: "runtime", sdk: "covered", description: "Runtime process state and advertised endpoints.", response: "RuntimeInfo" },
  { method: "GET", path: "/api/agents", auth: "runtime", sdk: "covered", description: "List agent snapshots.", response: "AgentsResponse" },
  { method: "GET", path: "/api/agents/{profile}", auth: "runtime", sdk: "covered", description: "Read one agent snapshot.", response: "AgentSnapshot" },
  { method: "POST", path: "/api/agents/{profile}/prompt", auth: "runtime", sdk: "covered", description: "Run a prompt as an agent.", request: "PromptRequest", response: "PromptResponse", successStatus: 202 },
  { method: "POST", path: "/api/peers/{profile}/wake", auth: "runtime", sdk: "covered", description: "Wake a peer through the runtime peer API.", request: "PeerWakeRequest", response: "PeerWakeResponse", successStatus: 202 },
  { method: "GET", path: "/api/models", auth: "runtime", sdk: "covered", description: "Discover model groups for an optional profile.", response: "ModelsResponse", query: ["profile"] },
  { method: "GET", path: "/api/runtimes", auth: "runtime", sdk: "covered", description: "List resolved runtime contracts.", response: "RuntimesResponse", query: ["profile"] },
  { method: "GET", path: "/api/runtimes/{profile}", auth: "runtime", sdk: "covered", description: "Read one resolved runtime contract.", response: "RuntimeContract" },
  { method: "POST", path: "/api/runtimes/{profile}/ensure", auth: "runtime", sdk: "covered", description: "Materialize an agent workspace/runtime.", request: "EmptyRequest", response: "RuntimeContract" },
  { method: "GET", path: "/api/events", auth: "runtime", sdk: "covered", description: "Query append-only control-plane events.", response: "EventsResponse", query: ["type", "actor", "agent", "subject", "target", "trace", "outcome", "since", "until", "limit"] },
  { method: "GET", path: "/api/events/stream", auth: "runtime", sdk: "covered", description: "Stream control-plane events over SSE.", response: "RuntimeEvent", responseContent: "sse", query: ["type", "actor", "agent", "subject", "target", "trace", "outcome", "since", "until", "limit"] },
  { method: "GET", path: "/api/usage", auth: "runtime", sdk: "covered", description: "Query usage records and summary totals.", response: "UsageResponse", query: ["actor", "agent", "provider", "model", "sessionId", "trace", "kind", "since", "until", "limit"] },
  { method: "GET", path: "/api/memory", auth: "runtime", sdk: "covered", description: "Query memory events.", response: "MemoryResponse", query: ["profile", "kind", "trace", "limit"] },
  { method: "GET", path: "/api/memory/anchors", auth: "runtime", sdk: "covered", description: "Query recent memory anchors for a profile.", response: "MemoryAnchorsResponse", query: ["profile", "limit"] },
  { method: "GET", path: "/api/sessions", auth: "runtime", sdk: "covered", description: "List persisted sessions for a profile.", response: "SessionsResponse", query: ["profile"] },
  { method: "GET", path: "/api/scheduler/jobs", auth: "runtime", sdk: "covered", description: "List scheduler jobs.", response: "SchedulerJobsResponse", query: ["profile"] },
  { method: "POST", path: "/api/scheduler/jobs", auth: "runtime", sdk: "covered", description: "Create a scheduled orchestration.", request: "SchedulerJobCreateRequest", response: "SchedulerJobCreateResponse", successStatus: 201 },
  { method: "GET", path: "/api/scheduler/due", auth: "runtime", sdk: "covered", description: "List due scheduler jobs.", response: "SchedulerDueResponse", query: ["profile", "now"] },
  { method: "POST", path: "/api/scheduler/tick", auth: "runtime", sdk: "covered", description: "Claim and optionally execute due scheduler jobs.", request: "SchedulerTickRequest", response: "SchedulerRunsResponse", query: ["profile", "now", "execute"] },
  { method: "GET", path: "/api/scheduler/runs", auth: "runtime", sdk: "covered", description: "List scheduler run history.", response: "SchedulerRunsResponse" },
  { method: "POST", path: "/api/fleet/plan", auth: "runtime", sdk: "covered", description: "Generate a fleet plan by prompting an agent.", request: "FleetPlanCreateRequest", response: "FleetPlanResponse", successStatus: 202 },
  { method: "POST", path: "/api/fleet/validate", auth: "runtime", sdk: "covered", description: "Validate a fleet plan.", request: "FleetValidateRequest", response: "FleetPlanResponse" },
  { method: "POST", path: "/api/fleet/apply", auth: "runtime", sdk: "covered", description: "Apply a valid fleet plan.", request: "FleetApplyRequest", response: "FleetApplyResponse", successStatus: 202 },
  { method: "POST", path: "/api/webhooks/{source}", auth: "runtime", sdk: "covered", description: "Receive a signed external webhook.", request: "WebhookIngressRequest", response: "WebhookIngressResponse", successStatus: 202 },
] as const;

export function runtimeEndpointList(): string[] {
  return RUNTIME_API_ROUTES
    .filter((route) => route.path.startsWith("/api/"))
    .map((route) => route.method === "GET" ? route.path.replace(/\{([^}]+)\}/g, ":$1") : `${route.method} ${route.path.replace(/\{([^}]+)\}/g, ":$1")}`);
}

export const UNION_STREET_OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "Union Street Runtime API",
    version: "0.1.0",
    description: "HTTP control-plane contract for Union Street agents, runtimes, memory, events, usage, scheduler, fleet, and webhook ingress.",
  },
  security: [{ runtimeBearer: [] }],
  components: {
    securitySchemes: {
      runtimeBearer: {
        type: "http",
        scheme: "bearer",
        description: "Runtime bearer token configured with US_RUNTIME_BEARER_TOKEN or explicit server authToken.",
      },
    },
    schemas: runtimeSchemas(),
  },
  paths: openApiPaths(),
} as const;

type Schema = Record<string, unknown>;

function runtimeSchemas(): Record<string, Schema> {
  const runtimeProvider = enumSchema(["local", "docker", "kubernetes", "aws", "gcp", "azure", "vercel", "render", "modal", "daytona"]);
  const runtimeHeadProvider = enumSchema(["local", "kubernetes", "aws", "gcp", "azure", "vercel", "render", "modal", "daytona"]);
  const runtimeStorageProvider = enumSchema(["local", "volume", "s3", "gcs", "azure-blob", "vercel-blob", "render-disk", "modal-volume", "daytona-volume"]);
  const runtimeIngressProvider = enumSchema(["local", "http", "vercel", "render", "aws-alb", "gcp-lb", "azure-app-gateway", "kubernetes-ingress", "modal", "daytona"]);
  const modelTarget = objectSchema({
    provider: stringSchema(),
    id: stringSchema(),
  }, ["provider", "id"]);
  const tokenUsage = objectSchema({
    input: numberSchema(),
    output: numberSchema(),
    reasoning: numberSchema(),
    cache_read: numberSchema(),
    cache_write: numberSchema(),
    total: numberSchema(),
  }, ["input", "output", "total"], false);
  const usageTotals = objectSchema({
    input: numberSchema(),
    output: numberSchema(),
    reasoning: numberSchema(),
    cacheRead: numberSchema(),
    cacheWrite: numberSchema(),
    total: numberSchema(),
    calls: numberSchema(),
    costMicroUsd: numberSchema(),
  }, [], false);
  const runtimePackSchedule = objectSchema({
    id: stringSchema(),
    name: stringSchema(),
    cron: stringSchema(),
    cadence: stringSchema(),
    timezone: stringSchema(),
    prompt: stringSchema(),
    deliverables: arrayOf(stringSchema()),
    route: arrayOf(stringSchema()),
  }, [], false);
  const runtimeSession = objectSchema({
    id: stringSchema(),
    path: stringSchema(),
    file: stringSchema(),
    updatedAt: numberSchema(),
    turns: numberSchema(),
    provider: stringSchema(),
    model: stringSchema(),
  }, [], false);
  const runtimeEvent = objectSchema({
    id: stringSchema(),
    ts: numberSchema(),
    type: stringSchema(),
    actor: stringSchema(),
    subject: stringSchema(),
    target: stringSchema(),
    resource: stringSchema(),
    outcome: enumSchema(["allow", "deny", "success", "failure", "info"]),
    severity: enumSchema(["debug", "info", "warn", "error"]),
    reason: stringSchema(),
    trace: stringSchema(),
    threadId: stringSchema(),
    sessionId: stringSchema(),
    payload: unknownSchema(),
  }, ["id", "ts", "type", "outcome"], false);
  const runtimeHead = objectSchema({
    mode: enumSchema(["embedded", "daemon", "remote"]),
    provider: runtimeHeadProvider,
    honcho: objectSchema({
      baseUrl: stringSchema(),
      workspaceId: stringSchema(),
      apiKeyEnv: stringSchema(),
    }, [], false),
    endpoint: stringSchema(),
  }, ["mode", "provider"], false);
  const runtimeCompute = objectSchema({
    provider: runtimeProvider,
    target: enumSchema(["host", "container", "vm", "pod", "function", "sandbox"]),
    image: stringSchema(),
    command: arrayOf(stringSchema()),
    cpu: stringSchema(),
    memory: stringSchema(),
    gpu: stringSchema(),
    region: stringSchema(),
    minInstances: numberSchema(),
    maxInstances: numberSchema(),
  }, ["provider", "target"], false);
  const runtimeStorage = objectSchema({
    provider: runtimeStorageProvider,
    bucket: stringSchema(),
    volume: stringSchema(),
    mountPath: stringSchema(),
    persistent: booleanSchema(),
    encryption: enumSchema(["provider-managed", "customer-managed"]),
  }, ["provider", "mountPath", "persistent"], false);
  const runtimeIngress = objectSchema({
    provider: runtimeIngressProvider,
    url: stringSchema(),
    internalUrl: stringSchema(),
    public: booleanSchema(),
    auth: enumSchema(["federation-jwt", "oauth", "none"]),
    receives: arrayOf(enumSchema(["mcp", "lash", "webhook", "control"])),
  }, ["provider", "public", "auth", "receives"], false);
  const runtimeWorkspace = objectSchema({
    provider: runtimeProvider,
    scope: enumSchema(["agent", "session", "shared"]),
    root: stringSchema(),
    workdir: stringSchema(),
    image: stringSchema(),
    region: stringSchema(),
    size: stringSchema(),
    network: enumSchema(["none", "egress", "private"]),
    persistent: booleanSchema(),
    ttlMinutes: numberSchema(),
    plugin: stringSchema(),
    labels: { type: "object", additionalProperties: stringSchema() },
    env: { type: "object", additionalProperties: stringSchema() },
  }, ["provider", "scope", "workdir"], false);
  const runtimeContract = objectSchema({
    profile: stringSchema(),
    pluginId: stringSchema(),
    workspacePath: stringSchema(),
    terraformModule: stringSchema(),
    head: runtimeHead,
    compute: runtimeCompute,
    storage: runtimeStorage,
    ingress: runtimeIngress,
    workspace: runtimeWorkspace,
    secrets: arrayOf(recordSchema("Resolved secret grant.")),
    secretsPath: stringSchema(),
    warnings: arrayOf(stringSchema()),
  }, ["profile", "head", "compute", "storage", "ingress", "workspace", "workspacePath", "pluginId", "secrets"], false);
  const mcpServerStatus = objectSchema({
    name: stringSchema(),
    transport: stringSchema(),
    url: stringSchema(),
    command: stringSchema(),
    enabled: booleanSchema(),
    credential: objectSchema({
      configured: booleanSchema(),
      kind: stringSchema(),
      source: stringSchema(),
    }, [], false),
  }, ["name"], false);
  const promptResult = objectSchema({
    profile: stringSchema(),
    text: stringSchema(),
    provider: stringSchema(),
    model: stringSchema(),
    trace: stringSchema(),
    runId: stringSchema(),
    sessionId: stringSchema(),
    sessionFile: stringSchema(),
    toolCalls: arrayOf(objectSchema({
      name: stringSchema(),
      args: unknownSchema(),
      result: unknownSchema(),
    }, [], false)),
    steps: arrayOf(unknownSchema()),
    usage: usageTotals,
  }, [], false);
  const schedulerRun = objectSchema({
    id: stringSchema(),
    profile: stringSchema(),
    jobId: stringSchema(),
    kind: enumSchema(["pulse", "schedule"]),
    status: enumSchema(["claimed", "running", "complete", "failed"]),
    dueAt: numberSchema(),
    dueKey: stringSchema(),
    ts: numberSchema(),
    prompt: stringSchema(),
    completedAt: numberSchema(),
    trace: stringSchema(),
    sessionId: stringSchema(),
    result: unknownSchema(),
  }, ["id", "profile", "jobId", "kind", "status", "dueAt"], false);
  const schedulerJob = objectSchema({
    id: stringSchema(),
    profile: stringSchema(),
    kind: enumSchema(["pulse", "schedule"]),
    name: stringSchema(),
    cron: stringSchema(),
    cadence: stringSchema(),
    timezone: stringSchema(),
    prompt: stringSchema(),
    deliverables: arrayOf(stringSchema()),
    route: arrayOf(stringSchema()),
    dueAt: numberSchema(),
    enabled: booleanSchema(),
  }, ["id", "profile", "kind", "name", "prompt", "deliverables", "cadence", "enabled", "route"], false);
  const fleetPlanAgent = objectSchema({
    id: stringSchema(),
    displayName: stringSchema(),
    title: stringSchema(),
    manager: stringSchema(),
    groups: arrayOf(stringSchema()),
    roles: arrayOf(stringSchema()),
    soul: stringSchema(),
    model: modelTarget,
    fallback: arrayOf(modelTarget),
    mcp: arrayOf(stringSchema()),
    cli: arrayOf(stringSchema()),
    permissions: arrayOf(stringSchema()),
    secrets: arrayOf(stringSchema()),
  }, ["id", "displayName", "title", "groups", "roles", "soul", "model"], false);
  const fleetPlan = objectSchema({
    version: { type: "integer", const: 1 },
    kind: { type: "string", const: "union-street.fleet-plan" },
    name: stringSchema(),
    mission: stringSchema(),
    root: stringSchema(),
    generatedBy: stringSchema(),
    agents: arrayOf(fleetPlanAgent),
  }, ["version", "kind", "name", "mission", "root", "generatedBy", "agents"], false);
  const fleetValidation = objectSchema({
    ok: booleanSchema(),
    errors: arrayOf(stringSchema()),
    warnings: arrayOf(stringSchema()),
    summary: objectSchema({
      agents: numberSchema(),
      root: stringSchema(),
      groups: arrayOf(stringSchema()),
      roles: arrayOf(stringSchema()),
      mcpServers: arrayOf(stringSchema()),
    }, ["agents", "root", "groups", "roles", "mcpServers"], false),
  }, ["ok", "errors", "warnings", "summary"], false);

  return {
    EmptyRequest: objectSchema({}, [], false),
    Error: objectSchema({ error: stringSchema(), message: stringSchema(), path: stringSchema(), raw: unknownSchema() }, ["error"], false),
    OpenApiDocument: recordSchema("OpenAPI 3.1 document."),
    RuntimeHealth: objectSchema({
      ok: booleanSchema(),
      version: stringSchema(),
      runtimeId: stringSchema(),
      uptimeMs: numberSchema(),
      usHome: stringSchema(),
      ts: numberSchema(),
    }, ["ok", "version", "runtimeId", "uptimeMs", "usHome", "ts"], false),
    RuntimeInfo: objectSchema({
      runtimeId: stringSchema(),
      version: stringSchema(),
      startedAt: numberSchema(),
      uptimeMs: numberSchema(),
      usHome: stringSchema(),
      cwd: stringSchema(),
      profiles: numberSchema(),
      endpoints: arrayOf(stringSchema()),
    }, ["runtimeId", "version", "startedAt", "uptimeMs", "usHome", "cwd", "profiles", "endpoints"], false),
    ModelTarget: modelTarget,
    AgentSnapshot: objectSchema({
      profile: stringSchema(),
      model: modelTarget,
      modelChain: arrayOf(modelTarget),
      pack: recordSchema("Atomic agent pack."),
      runtime: runtimeContract,
      principal: recordSchema("Resolved principal."),
      delegation: arrayOf(objectSchema({
        profile: stringSchema(),
        relation: stringSchema(),
        depth: numberSchema(),
        displayName: stringSchema(),
        title: stringSchema(),
      }, ["profile", "relation"], false)),
      mcp: objectSchema({
        servers: arrayOf(mcpServerStatus),
        builtinTools: arrayOf(objectSchema({ name: stringSchema(), description: stringSchema() }, ["name"], false)),
        grants: { type: "object", additionalProperties: objectSchema({ allowed: booleanSchema(), reason: stringSchema(), tools: arrayOf(stringSchema()) }, [], false) },
      }, [], false),
      memory: recordSchema("Resolved memory sync config."),
      sessions: arrayOf(runtimeSession),
    }, ["profile"], false),
    AgentsResponse: objectSchema({ agents: arrayOf(ref("AgentSnapshot")) }, ["agents"], false),
    RuntimeModel: objectSchema({
      id: stringSchema(),
      description: stringSchema(),
      display_name: stringSchema(),
      context_window: numberSchema(),
    }, ["id"], false),
    RuntimeModelGroup: objectSchema({
      id: stringSchema(),
      label: stringSchema(),
      authMethod: stringSchema(),
      state: stringSchema(),
      baseUrl: stringSchema(),
      models: arrayOf(ref("RuntimeModel")),
    }, ["id", "label", "authMethod", "state", "models"], false),
    ModelsResponse: objectSchema({ profile: stringSchema(), groups: arrayOf(ref("RuntimeModelGroup")) }, ["groups"], false),
    RuntimeContract: runtimeContract,
    RuntimesResponse: objectSchema({ runtimes: arrayOf(ref("RuntimeContract")) }, ["runtimes"], false),
    RuntimeEvent: runtimeEvent,
    EventsResponse: objectSchema({ events: arrayOf(ref("RuntimeEvent")) }, ["events"], false),
    UsageRecord: objectSchema({
      id: stringSchema(),
      ts: numberSchema(),
      actor: stringSchema(),
      provider: stringSchema(),
      model: stringSchema(),
      sessionId: stringSchema(),
      trace: stringSchema(),
      threadId: stringSchema(),
      runId: stringSchema(),
      step: numberSchema(),
      kind: enumSchema(["prompt", "lash", "scheduler", "chat"]),
      usage: tokenUsage,
      costMicroUsd: numberSchema(),
      costSource: enumSchema(["explicit", "provider:free", "provider:rate_card", "env:rate_card", "models.dev", "unknown"]),
      metadata: recordSchema(),
    }, ["id", "ts", "actor", "provider", "model", "kind", "usage"], false),
    UsageSummary: usageTotals,
    UsageResponse: objectSchema({ usage: arrayOf(ref("UsageRecord")), summary: ref("UsageSummary") }, ["usage", "summary"], false),
    MemoryEvent: objectSchema({
      id: stringSchema(),
      ts: numberSchema(),
      peer: stringSchema(),
      kind: stringSchema(),
      trace: stringSchema(),
      source: stringSchema(),
      text: stringSchema(),
      payload: unknownSchema(),
    }, [], false),
    MemoryResponse: objectSchema({ memory: arrayOf(ref("MemoryEvent")) }, ["memory"], false),
    MemoryAnchor: objectSchema({
      id: stringSchema(),
      peer: stringSchema(),
      sessionId: stringSchema(),
      model: stringSchema(),
      summary: stringSchema(),
      isUpdate: booleanSchema(),
      tokensBefore: numberSchema(),
      tokensAfter: numberSchema(),
      droppedCount: numberSchema(),
      ts: numberSchema(),
    }, ["id", "peer", "summary", "ts"], false),
    MemoryAnchorsResponse: objectSchema({ anchors: arrayOf(ref("MemoryAnchor")) }, ["anchors"], false),
    RuntimeSession: runtimeSession,
    SessionsResponse: objectSchema({ sessions: arrayOf(ref("RuntimeSession")) }, ["sessions"], false),
    SchedulerJob: schedulerJob,
    SchedulerJobsResponse: objectSchema({ jobs: arrayOf(ref("SchedulerJob")) }, ["jobs"], false),
    SchedulerDueResponse: objectSchema({ due: arrayOf(ref("SchedulerJob")) }, ["due"], false),
    SchedulerRun: schedulerRun,
    SchedulerRunsResponse: objectSchema({ runs: arrayOf(ref("SchedulerRun")) }, ["runs"], false),
    RuntimePackSchedule: runtimePackSchedule,
    SchedulerJobCreateRequest: objectSchema({
      owner: stringSchema(),
      name: stringSchema(),
      cron: stringSchema(),
      timezone: stringSchema(),
      prompt: stringSchema(),
      deliverables: arrayOf(stringSchema()),
      route: arrayOf(stringSchema()),
    }, ["owner", "name", "cron", "timezone", "prompt", "deliverables", "route"], false),
    SchedulerJobCreateResponse: objectSchema({ schedule: ref("RuntimePackSchedule") }, ["schedule"], false),
    SchedulerTickRequest: objectSchema({
      now: numberSchema(),
      profiles: arrayOf(stringSchema()),
      execute: booleanSchema(),
    }, [], false),
    PromptRequest: objectSchema({
      prompt: stringSchema(),
      sessionId: stringSchema(),
      trace: stringSchema(),
      model: ref("ModelTarget"),
    }, ["prompt"], false),
    PromptResult: promptResult,
    PromptResponse: objectSchema({ result: ref("PromptResult") }, ["result"], false),
    PeerWakeRequest: objectSchema({
      caller: stringSchema(),
      message: stringSchema(),
      trace: stringSchema(),
      wakeKind: { type: "string", enum: ["delegate", "report"] },
      textVerbosity: { type: "string", enum: ["low", "medium", "high"] },
      thread: objectSchema({ id: stringSchema(), resume: stringSchema(), summary: stringSchema(), turn: numberSchema() }, ["id", "turn"], false),
      chain: arrayOf(objectSchema({ from: stringSchema(), to: stringSchema(), at: stringSchema() }, ["from", "to", "at"], false)),
    }, ["caller", "message"], false),
    PeerWakeResult: objectSchema({
      ok: booleanSchema(),
      response: stringSchema(),
      trace: stringSchema(),
      thread: unknownSchema(),
      chain: arrayOf(unknownSchema()),
      delegation: objectSchema({ relation: stringSchema(), depth: numberSchema() }, [], false),
      modelId: stringSchema(),
      usage: usageTotals,
      error: stringSchema(),
    }, ["ok"], false),
    PeerWakeResponse: objectSchema({ result: ref("PeerWakeResult") }, ["result"], false),
    FleetPlan: fleetPlan,
    FleetValidation: fleetValidation,
    FleetPlanCreateRequest: objectSchema({ profile: stringSchema(), prompt: stringSchema() }, ["profile", "prompt"], false),
    FleetValidateRequest: objectSchema({ plan: ref("FleetPlan"), allowExisting: booleanSchema() }, ["plan"], false),
    FleetApplyRequest: objectSchema({ plan: ref("FleetPlan"), overwrite: booleanSchema(), dryRun: booleanSchema() }, ["plan"], false),
    FleetPlanResponse: objectSchema({ plan: ref("FleetPlan"), validation: ref("FleetValidation"), result: ref("PromptResult") }, ["plan", "validation"], false),
    FleetApplyResponse: objectSchema({
      applied: booleanSchema(),
      profiles: arrayOf(stringSchema()),
      validation: ref("FleetValidation"),
      message: stringSchema(),
    }, ["applied", "profiles", "validation"], false),
    WebhookIngressRequest: recordSchema("Provider webhook payload."),
    WebhookIngressResponse: objectSchema({ event: ref("RuntimeEvent") }, ["event"], false),
  };
}

function openApiPaths(): Record<string, Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of RUNTIME_API_ROUTES) {
    paths[route.path] = {
      ...(paths[route.path] ?? {}),
      ...pathOperation(route),
    };
  }
  return paths;
}

function pathOperation(route: RuntimeApiRoute): Record<string, unknown> {
  const method = route.method.toLowerCase();
  return {
    [method]: {
      summary: route.description,
      operationId: operationId(route),
      ...(route.auth === "none" ? { security: [] } : {}),
      parameters: operationParameters(route),
      ...(route.method === "POST" ? { requestBody: jsonRequestBody(route.request) } : {}),
      responses: operationResponses(route),
    },
  };
}

function operationResponses(route: RuntimeApiRoute): Record<string, unknown> {
  const status = String(route.successStatus ?? 200);
  return {
    [status]: route.responseContent === "sse"
      ? sseResponse("Server-sent event stream", route.response)
      : jsonResponse("Success", route.response),
    "400": jsonResponse("Bad request", "Error"),
    "401": jsonResponse("Unauthorized", "Error"),
    "404": jsonResponse("Not found", "Error"),
    "409": jsonResponse("Conflict", "Error"),
    "413": jsonResponse("Body too large", "Error"),
    "422": jsonResponse("Unprocessable entity", "Error"),
    "500": jsonResponse("Internal error", "Error"),
  };
}

function operationParameters(route: RuntimeApiRoute): Record<string, unknown>[] {
  return [
    ...(route.path.includes("{profile}") ? [pathParam("profile")] : []),
    ...(route.path.includes("{source}") ? [pathParam("source")] : []),
    ...(route.query ?? []).map(queryParam),
  ];
}

function operationId(route: RuntimeApiRoute): string {
  return `${route.method.toLowerCase()}${route.path.replace(/[^A-Za-z0-9]+(.)?/g, (_, char: string | undefined) => char ? char.toUpperCase() : "")}`;
}

function pathParam(name: string): Record<string, unknown> {
  return {
    name,
    in: "path",
    required: true,
    schema: stringSchema(),
  };
}

function queryParam(name: string): Record<string, unknown> {
  return {
    name,
    in: "query",
    required: false,
    schema: ["since", "until", "limit", "now"].includes(name)
      ? { anyOf: [numberSchema(), stringSchema()] }
      : name === "execute"
        ? { anyOf: [booleanSchema(), stringSchema()] }
        : stringSchema(),
  };
}

function jsonRequestBody(schema?: string): Record<string, unknown> {
  return {
    required: Boolean(schema),
    content: {
      "application/json": {
        schema: schema ? ref(schema) : recordSchema("Route-specific JSON payload."),
      },
    },
  };
}

function jsonResponse(description: string, schema: string): Record<string, unknown> {
  return {
    description,
    content: {
      "application/json": {
        schema: ref(schema),
      },
    },
  };
}

function sseResponse(description: string, eventSchema: string): Record<string, unknown> {
  return {
    description,
    content: {
      "text/event-stream": {
        schema: {
          type: "string",
          description: `Server-sent events with JSON data frames matching #/components/schemas/${eventSchema}.`,
        },
      },
    },
  };
}

function ref(schema: string): Schema {
  return { $ref: `#/components/schemas/${schema}` };
}

function stringSchema(): Schema {
  return { type: "string" };
}

function numberSchema(): Schema {
  return { type: "number" };
}

function booleanSchema(): Schema {
  return { type: "boolean" };
}

function enumSchema(values: string[]): Schema {
  return { type: "string", enum: values };
}

function arrayOf(items: Schema): Schema {
  return { type: "array", items };
}

function unknownSchema(): Schema {
  return {};
}

function recordSchema(description?: string): Schema {
  return {
    type: "object",
    ...(description ? { description } : {}),
    additionalProperties: true,
  };
}

function objectSchema(properties: Record<string, unknown>, required: string[], additionalProperties = false): Schema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties,
  };
}
