/**
 * @unionstreet/us-runtime
 *
 * Head-node control plane for local Union Street runtimes. The runtime API is
 * intentionally backed by us-core state only: no dashboard fixtures, no mocked
 * scheduler execution, and no synthetic agent data.
 */
import {
  FileMemoryStore,
  US_HOME,
  claimDueSchedulerJobs,
  dueSchedulerJobs,
  executeSchedulerRun,
  ensureAgentWorkspace,
  inspectMcpStatus,
  listProfiles,
  listSchedulerJobs,
  queryEvents,
  queryUsageRecords,
  queryMemoryEvents,
  readAgentPack,
  readSchedulerRuns,
  listSessions,
  resolveAgentPrincipal,
  resolveAgentRuntime,
  resolveDelegationTargets,
  resolveMemorySyncConfig,
  resolveMcpGrantsForAgent,
  runAgentPrompt,
  summarizeUsage,
  writeEvent,
  type ControlPlaneEventType,
  type EventQuery,
  type MemoryEventKind,
  type UsageQuery,
} from "@unionstreet/us-core";

export const VERSION = "0.1.0";
const runtimeStartedAt = Date.now();
const runtimeId = `runtime-${runtimeStartedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export interface RuntimeServerOptions {
  port?: number;
  hostname?: string;
  cwd?: string;
}

export interface RuntimeServerHandle {
  url: string;
  port: number;
  hostname: string;
  server: Bun.Server<unknown>;
  stop(): void;
}

export function createRuntimeFetchHandler(options: Pick<RuntimeServerOptions, "cwd"> = {}) {
  const cwd = options.cwd ?? process.cwd();
  return async function fetchHandler(request: Request): Promise<Response> {
    try {
      return await routeRequest(request, cwd);
    } catch (error) {
      return json({
        error: "internal_error",
        message: (error as Error).message,
      }, 500);
    }
  };
}

export function startRuntimeServer(options: RuntimeServerOptions = {}): RuntimeServerHandle {
  const hostname = options.hostname ?? "127.0.0.1";
  const server = Bun.serve({
    hostname,
    port: options.port ?? 0,
    fetch: createRuntimeFetchHandler({ cwd: options.cwd }),
  });
  const port = server.port ?? options.port ?? 0;
  return {
    url: `http://${hostname}:${port}`,
    port,
    hostname,
    server,
    stop: () => server.stop(true),
  };
}

async function routeRequest(request: Request, cwd: string): Promise<Response> {
  const url = new URL(request.url);
  const path = trimPath(url.pathname);
  const parts = path.split("/").filter(Boolean);

  if (request.method === "OPTIONS") return empty(204);
  if (request.method === "GET" && path === "health") {
    return json({ ok: true, version: VERSION, runtimeId, uptimeMs: Date.now() - runtimeStartedAt, usHome: US_HOME, ts: Date.now() });
  }

  if (parts[0] !== "api") return json({ error: "not_found", path: url.pathname }, 404);

  if (request.method === "GET" && parts[1] === "runtime" && parts.length === 2) {
    const profiles = await listProfiles();
    return json({
      runtimeId,
      version: VERSION,
      startedAt: runtimeStartedAt,
      uptimeMs: Date.now() - runtimeStartedAt,
      usHome: US_HOME,
      cwd,
      profiles: profiles.length,
      endpoints: [
        "/health",
        "/api/runtime",
        "/api/agents",
        "/api/runtimes",
        "/api/events",
        "/api/events/stream",
        "/api/usage",
        "/api/scheduler/jobs",
        "/api/scheduler/tick",
        "/api/webhooks/:source",
      ],
    });
  }

  if (request.method === "GET" && parts[1] === "agents" && parts.length === 2) {
    const profiles = await listProfiles();
    return json({
      agents: await Promise.all(profiles.map((profile) => agentSnapshot(profile, cwd))),
    });
  }

  if (request.method === "GET" && parts[1] === "agents" && parts[2] && parts.length === 3) {
    return json(await agentSnapshot(parts[2], cwd));
  }

  if (request.method === "POST" && parts[1] === "agents" && parts[2] && parts[3] === "prompt" && parts.length === 4) {
    const body = await readJsonBody(request);
    const prompt = readPayloadString(body, "prompt");
    if (!prompt) return json({ error: "missing_prompt", message: "agent prompt requires JSON body { prompt: string }" }, 400);
    const result = await runAgentPrompt({
      profile: parts[2],
      prompt,
      cwd,
      ...(readPayloadString(body, "sessionId") ? { sessionId: readPayloadString(body, "sessionId") } : {}),
      ...(readPayloadString(body, "trace") ? { trace: readPayloadString(body, "trace") } : {}),
    });
    return json({ result }, 202);
  }

  if (request.method === "GET" && parts[1] === "runtimes" && parts.length === 2) {
    const profiles = readProfilesParam(url) ?? await listProfiles();
    return json({ runtimes: await Promise.all(profiles.map((profile) => resolveAgentRuntime(profile))) });
  }

  if (request.method === "GET" && parts[1] === "runtimes" && parts[2] && parts.length === 3) {
    return json(await resolveAgentRuntime(parts[2]));
  }

  if (request.method === "POST" && parts[1] === "runtimes" && parts[2] && parts[3] === "ensure" && parts.length === 4) {
    return json(await ensureAgentWorkspace(parts[2]));
  }

  if (request.method === "GET" && parts[1] === "events" && parts.length === 2) {
    return json({ events: await queryEvents(readEventQuery(url)) });
  }

  if (request.method === "GET" && parts[1] === "usage" && parts.length === 2) {
    const records = await queryUsageRecords(readUsageQuery(url));
    return json({ usage: records, summary: summarizeUsage(records) });
  }

  if (request.method === "GET" && parts[1] === "events" && parts[2] === "stream" && parts.length === 3) {
    return eventStream(readEventQuery(url));
  }

  if (request.method === "GET" && parts[1] === "memory" && parts.length === 2) {
    const profile = readStringParam(url, "profile");
    const limit = readNumberParam(url, "limit") ?? 100;
    const memory = await queryMemoryEvents({
      ...(profile ? { peer: profile } : {}),
      ...(readStringParam(url, "kind") ? { kind: readStringParam(url, "kind") as MemoryEventKind } : {}),
      ...(readStringParam(url, "trace") ? { trace: readStringParam(url, "trace") } : {}),
      limit,
    });
    return json({ memory });
  }

  if (request.method === "GET" && parts[1] === "memory" && parts[2] === "anchors" && parts.length === 3) {
    const profile = readStringParam(url, "profile");
    if (!profile) return json({ error: "missing_profile", message: "memory anchors require ?profile=<agent>" }, 400);
    const limit = readNumberParam(url, "limit") ?? 25;
    const store = new FileMemoryStore();
    try {
      return json({ anchors: await store.recentAnchors(profile, limit) });
    } finally {
      await store.close();
    }
  }

  if (request.method === "GET" && parts[1] === "sessions" && parts.length === 2) {
    const profile = readStringParam(url, "profile");
    if (!profile) return json({ error: "missing_profile", message: "sessions require ?profile=<agent>" }, 400);
    return json({ sessions: await listSessions(profile) });
  }

  if (request.method === "GET" && parts[1] === "scheduler" && parts[2] === "jobs" && parts.length === 3) {
    return json({ jobs: await listSchedulerJobs(readProfilesParam(url) ?? undefined) });
  }

  if (request.method === "GET" && parts[1] === "scheduler" && parts[2] === "due" && parts.length === 3) {
    return json({ due: await dueSchedulerJobs(readNow(url), readProfilesParam(url) ?? undefined) });
  }

  if (request.method === "POST" && parts[1] === "scheduler" && parts[2] === "tick" && parts.length === 3) {
    const body = await readJsonBody(request);
    const now = readBodyNumber(body, "now") ?? readNow(url);
    const profiles = readBodyStringArray(body, "profiles") ?? readProfilesParam(url) ?? undefined;
    const claimed = await claimDueSchedulerJobs(now, profiles);
    const execute = readBooleanParam(url, "execute") ?? readBodyBoolean(body, "execute") ?? false;
    if (!execute) return json({ runs: claimed });
    const runs = [];
    for (const run of claimed) {
      runs.push(await executeSchedulerRun(run, async (job, schedulerRun) => {
        const result = await runAgentPrompt({
          profile: job.profile,
          prompt: job.prompt,
          cwd,
          trace: `scheduler:${schedulerRun.id}`,
          sessionId: `scheduler-${job.profile}-${job.kind}-${job.dueAt}`,
        });
        return {
          trace: result.trace,
          sessionId: result.sessionId,
          result: {
            text: result.text,
            model: `${result.provider}/${result.model}`,
            steps: result.steps,
            toolCalls: result.toolCalls,
            usage: result.usage,
          },
        };
      }));
    }
    return json({ runs });
  }

  if (request.method === "GET" && parts[1] === "scheduler" && parts[2] === "runs" && parts.length === 3) {
    return json({ runs: await readSchedulerRuns() });
  }

  if (request.method === "POST" && parts[1] === "webhooks" && parts[2] && parts.length === 3) {
    const body = await readJsonBody(request);
    const source = parts[2];
    const actor = readHeaderPrincipal(request) ?? readPayloadString(body, "actor") ?? source;
    const event = await writeEvent({
      type: "webhook.received",
      actor,
      subject: readPayloadString(body, "subject") ?? actor,
      resource: `webhook:${source}`,
      outcome: "success",
      payload: {
        source,
        body,
        headers: selectedHeaders(request.headers),
      },
    });
    return json({ event }, 202);
  }

  return json({ error: "not_found", path: url.pathname }, 404);
}

async function agentSnapshot(profile: string, cwd: string) {
  const [pack, runtime, principal, delegationTargets, mcpStatus, memorySync, sessions] = await Promise.all([
    readAgentPack(profile),
    resolveAgentRuntime(profile),
    resolveAgentPrincipal(profile),
    resolveDelegationTargets(profile),
    inspectMcpStatus(cwd, profile),
    resolveMemorySyncConfig(profile),
    listSessions(profile),
  ]);
  const grants = await resolveMcpGrantsForAgent(profile, mcpStatus.servers);
  return {
    profile,
    pack,
    runtime,
    principal,
    delegation: delegationTargets,
    mcp: {
      servers: mcpStatus.servers,
      builtinTools: mcpStatus.builtinTools,
      grants: Object.fromEntries(grants),
    },
    memory: memorySync,
    sessions,
  };
}

function eventStream(query: EventQuery): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let lastTs = query.since ?? 0;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = async () => {
        if (closed) return;
        const events = (await queryEvents({ ...query, since: lastTs ? lastTs + 1 : query.since, limit: query.limit ?? 100 }))
          .sort((a, b) => a.ts - b.ts);
        for (const event of events) {
          lastTs = Math.max(lastTs, event.ts);
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        }
      };
      await send();
      interval = setInterval(() => {
        send().catch((error) => {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: (error as Error).message })}\n\n`));
        });
      }, 1_000);
    },
    cancel() {
      closed = true;
      if (interval) clearInterval(interval);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...corsHeaders(),
    },
  });
}

function readEventQuery(url: URL): EventQuery {
  return {
    ...(readStringParam(url, "type") ? { type: readStringParam(url, "type") as ControlPlaneEventType } : {}),
    ...(readStringParam(url, "actor") ? { actor: readStringParam(url, "actor") } : {}),
    ...(readStringParam(url, "agent") ? { actor: readStringParam(url, "agent") } : {}),
    ...(readStringParam(url, "subject") ? { subject: readStringParam(url, "subject") } : {}),
    ...(readStringParam(url, "target") ? { target: readStringParam(url, "target") } : {}),
    ...(readStringParam(url, "trace") ? { trace: readStringParam(url, "trace") } : {}),
    ...(readStringParam(url, "outcome") ? { outcome: readStringParam(url, "outcome") as EventQuery["outcome"] } : {}),
    ...(readNumberParam(url, "since") ? { since: readNumberParam(url, "since") } : {}),
    ...(readNumberParam(url, "until") ? { until: readNumberParam(url, "until") } : {}),
    limit: readNumberParam(url, "limit") ?? 100,
  };
}

function readUsageQuery(url: URL): UsageQuery {
  return {
    ...(readStringParam(url, "actor") ? { actor: readStringParam(url, "actor") } : {}),
    ...(readStringParam(url, "agent") ? { actor: readStringParam(url, "agent") } : {}),
    ...(readStringParam(url, "provider") ? { provider: readStringParam(url, "provider") } : {}),
    ...(readStringParam(url, "model") ? { model: readStringParam(url, "model") } : {}),
    ...(readStringParam(url, "sessionId") ? { sessionId: readStringParam(url, "sessionId") } : {}),
    ...(readStringParam(url, "trace") ? { trace: readStringParam(url, "trace") } : {}),
    ...(readStringParam(url, "kind") ? { kind: readStringParam(url, "kind") as UsageQuery["kind"] } : {}),
    ...(readNumberParam(url, "since") ? { since: readNumberParam(url, "since") } : {}),
    ...(readNumberParam(url, "until") ? { until: readNumberParam(url, "until") } : {}),
    limit: readNumberParam(url, "limit") ?? 100,
  };
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function readProfilesParam(url: URL): string[] | undefined {
  const values = url.searchParams.getAll("profile").flatMap((value) => value.split(","));
  const profiles = values.map((value) => value.trim()).filter(Boolean);
  return profiles.length ? profiles : undefined;
}

function readStringParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  return value || undefined;
}

function readNumberParam(url: URL, name: string): number | undefined {
  const value = readStringParam(url, name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readBooleanParam(url: URL, name: string): boolean | undefined {
  const value = readStringParam(url, name);
  if (!value) return undefined;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return undefined;
}

function readNow(url: URL): number {
  const value = readStringParam(url, "now");
  if (!value) return Date.now();
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function readBodyNumber(body: unknown, key: string): number | undefined {
  if (!isRecord(body)) return undefined;
  const parsed = Number(body[key]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readBodyStringArray(body: unknown, key: string): string[] | undefined {
  if (!isRecord(body) || !Array.isArray(body[key])) return undefined;
  const values = body[key].map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean);
  return values.length ? values : undefined;
}

function readBodyBoolean(body: unknown, key: string): boolean | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[key];
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function readPayloadString(body: unknown, key: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readHeaderPrincipal(request: Request): string | undefined {
  const value = request.headers.get("x-union-street-actor") ?? request.headers.get("x-us-actor");
  return value?.trim() || undefined;
}

function selectedHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["content-type", "user-agent", "x-github-event", "x-linear-event", "x-union-street-actor", "x-us-actor"]) {
    const value = headers.get(name);
    if (value) out[name] = value;
  }
  return out;
}

function trimPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function empty(status = 204): Response {
  return new Response(null, {
    status,
    headers: corsHeaders(),
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
