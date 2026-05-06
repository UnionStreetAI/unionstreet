/**
 * @unionstreet/server
 *
 * Head-node control plane for local Union Street runtimes. The runtime API is
 * intentionally backed by server state only: no dashboard fixtures, no mocked
 * scheduler execution, and no synthetic agent data.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { US_HOME } from "../paths.ts";
import { FileMemoryStore, queryMemoryEvents, resolveMemorySyncConfig, type MemoryEventKind } from "../memory.ts";
import { queryEvents, writeEvent, type ControlPlaneEventType, type EventQuery } from "../events.ts";
import { queryUsageRecords, summarizeUsage, type UsageQuery } from "../usage.ts";
import { listProfiles, profileExists } from "../profile.ts";
import { readAgentPack } from "../agent-pack.ts";
import { listSessions } from "../sessions.ts";
import { runAgentPrompt } from "../prompt-runner.ts";
import { peerCall } from "../peer.ts";
import { discoverModelGroups } from "../model-discovery.ts";
import { readModelChain } from "../fallback.ts";
import {
  applyFleetPlan,
  createFleetPlanningPrompt,
  normalizeFleetPlan,
  parseFleetPlanText,
  validateFleetPlan,
} from "../fleet-plan.ts";
import {
  claimDueSchedulerJobs,
  createScheduledOrchestration,
  dueSchedulerJobs,
  executeSchedulerRun,
  listSchedulerJobs,
  readSchedulerRuns,
} from "../scheduler.ts";
import { ensureAgentWorkspace, resolveAgentRuntime } from "../cloud-runtime.ts";
import { inspectMcpStatus } from "../mcp-status.ts";
import {
  resolveAgentPrincipal,
  resolveDelegationTargets,
  resolveMcpGrantsForAgent,
} from "../federation.ts";
import { RUNTIME_API_ROUTES, UNION_STREET_OPENAPI, runtimeEndpointList } from "./openapi.ts";
export { RUNTIME_API_ROUTES, UNION_STREET_OPENAPI } from "./openapi.ts";

export const VERSION = "0.1.0";
const runtimeStartedAt = Date.now();
const runtimeId = `runtime-${runtimeStartedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const requestOrigin = new AsyncLocalStorage<string | undefined>();

export interface RuntimeServerOptions {
  port?: number;
  hostname?: string;
  cwd?: string;
  authToken?: string;
}

export interface RuntimeServerHandle {
  url: string;
  port: number;
  hostname: string;
  server: Bun.Server<unknown>;
  stop(): void;
}

export function createRuntimeFetchHandler(options: Pick<RuntimeServerOptions, "cwd" | "authToken"> = {}) {
  const cwd = options.cwd ?? process.cwd();
  const authToken = options.authToken ?? process.env.US_RUNTIME_BEARER_TOKEN;
  return async function fetchHandler(request: Request): Promise<Response> {
    return requestOrigin.run(request.headers.get("origin") ?? undefined, async () => {
      try {
        return await routeRequest(request, cwd, typeof authToken === "string" ? authToken : undefined);
      } catch (error) {
        return json({
          error: "internal_error",
          message: (error as Error).message,
        }, 500);
      }
    });
  };
}

export function startRuntimeServer(options: RuntimeServerOptions = {}): RuntimeServerHandle {
  const hostname = options.hostname ?? "127.0.0.1";
  const server = Bun.serve({
    hostname,
    port: options.port ?? 0,
    fetch: createRuntimeFetchHandler({ cwd: options.cwd, authToken: options.authToken }),
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

async function routeRequest(request: Request, cwd: string, authToken?: string): Promise<Response> {
  const url = new URL(request.url);
  const path = trimPath(url.pathname);
  const parts = path.split("/").filter(Boolean);

  if (request.method === "OPTIONS") return empty(204);
  if (request.method === "GET" && path === "health") {
    return json({ ok: true, version: VERSION, runtimeId, uptimeMs: Date.now() - runtimeStartedAt, usHome: US_HOME, ts: Date.now() });
  }
  if (request.method === "GET" && path === "openapi.json") {
    return json(UNION_STREET_OPENAPI);
  }

  if (parts[0] !== "api") return json({ error: "not_found", path: url.pathname }, 404);
  if (!authorizeRuntimeRequest(request, authToken)) {
    return json({ error: "unauthorized", message: "runtime API requires Authorization: Bearer <token>" }, 401);
  }

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
      endpoints: runtimeEndpointList(),
    });
  }

  if (request.method === "GET" && parts[1] === "agents" && parts.length === 2) {
    const profiles = await listProfiles();
    return json({
      agents: await Promise.all(profiles.map((profile) => agentSnapshot(profile, cwd))),
    });
  }

  if (request.method === "GET" && parts[1] === "agents" && parts[2] && parts.length === 3) {
    const profile = await readExistingProfile(parts[2]);
    if (!profile.ok) return json(profile.body, profile.status);
    return json(await agentSnapshot(profile.profile, cwd));
  }

  if (request.method === "GET" && parts[1] === "models" && parts.length === 2) {
    const profileResult = await readOptionalExistingProfileParam(url);
    if (!profileResult.ok) return json(profileResult.body, profileResult.status);
    return json({
      profile: profileResult.profile,
      groups: await discoverModelGroups({ profile: profileResult.profile }),
    });
  }

  if (request.method === "POST" && parts[1] === "fleet" && parts[2] === "plan" && parts.length === 3) {
    if (!authorizeRuntimeWriteRequest(request, authToken)) {
      return json({
        error: "write_auth_required",
        message: "fleet planning executes an agent prompt; start runtime with US_RUNTIME_BEARER_TOKEN and send Authorization: Bearer <token>",
      }, 401);
    }
    const body = await readJsonBody(request);
    if (isBodyTooLarge(body)) return json({ error: "body_too_large", message: body.message }, 413);
    if (isMalformedJson(body)) return json({ error: "malformed_json", message: body.message }, 400);
    const profile = await readExistingProfile(readPayloadString(body, "profile") ?? "");
    if (!profile.ok) return json(profile.body, profile.status);
    const prompt = readPayloadString(body, "prompt");
    if (!prompt) return json({ error: "missing_prompt", message: "fleet planning requires JSON body { profile, prompt }" }, 400);
    const result = await runAgentPrompt({
      profile: profile.profile,
      prompt: createFleetPlanningPrompt(profile.profile, prompt),
      cwd,
    });
    let plan;
    try {
      plan = parseFleetPlanText(result.text);
    } catch (error) {
      await writeEvent({
        type: "fleet.plan.create",
        actor: profile.profile,
        outcome: "failure",
        reason: (error as Error).message,
        trace: result.trace,
        sessionId: result.sessionId,
      });
      return json({ error: "invalid_fleet_plan", message: (error as Error).message, raw: result.text, result }, 422);
    }
    const validation = await validateFleetPlan(plan, { allowExisting: true });
    await writeEvent({
      type: "fleet.plan.create",
      actor: profile.profile,
      subject: plan.root,
      resource: `fleet:${plan.name}`,
      outcome: validation.ok ? "success" : "failure",
      reason: validation.ok ? undefined : validation.errors.join("; "),
      trace: result.trace,
      sessionId: result.sessionId,
      payload: {
        agents: plan.agents.map((agent) => agent.id),
        errors: validation.errors,
        warnings: validation.warnings,
      },
    });
    return json({ plan, validation, result }, validation.ok ? 202 : 422);
  }

  if (request.method === "POST" && parts[1] === "fleet" && parts[2] === "validate" && parts.length === 3) {
    const body = await readJsonBody(request);
    if (isBodyTooLarge(body)) return json({ error: "body_too_large", message: body.message }, 413);
    if (isMalformedJson(body)) return json({ error: "malformed_json", message: body.message }, 400);
    const planResult = readBodyFleetPlan(body);
    if (!planResult.ok) return json(planResult.body, planResult.status);
    return json({
      plan: planResult.plan,
      validation: await validateFleetPlan(planResult.plan, { allowExisting: readBodyBoolean(body, "allowExisting") ?? false }),
    });
  }

  if (request.method === "POST" && parts[1] === "fleet" && parts[2] === "apply" && parts.length === 3) {
    if (!authorizeRuntimeWriteRequest(request, authToken)) {
      return json({
        error: "write_auth_required",
        message: "fleet apply writes profiles and federation policy; start runtime with US_RUNTIME_BEARER_TOKEN and send Authorization: Bearer <token>",
      }, 401);
    }
    const body = await readJsonBody(request);
    if (isBodyTooLarge(body)) return json({ error: "body_too_large", message: body.message }, 413);
    if (isMalformedJson(body)) return json({ error: "malformed_json", message: body.message }, 400);
    const planResult = readBodyFleetPlan(body);
    if (!planResult.ok) return json(planResult.body, planResult.status);
    const result = await applyFleetPlan(planResult.plan, {
      overwrite: readBodyBoolean(body, "overwrite") ?? false,
      dryRun: readBodyBoolean(body, "dryRun") ?? false,
    });
    return json({
      ...result,
      ...(result.validation.ok ? {} : { message: result.validation.errors.join("; ") || "fleet plan did not validate" }),
    }, result.validation.ok ? 202 : 409);
  }

  if (request.method === "POST" && parts[1] === "agents" && parts[2] && parts[3] === "prompt" && parts.length === 4) {
    const profile = await readExistingProfile(parts[2]);
    if (!profile.ok) return json(profile.body, profile.status);
    const body = await readJsonBody(request);
    if (isBodyTooLarge(body)) return json({ error: "body_too_large", message: body.message }, 413);
    if (isMalformedJson(body)) return json({ error: "malformed_json", message: body.message }, 400);
    const prompt = readPayloadString(body, "prompt");
    if (!prompt) return json({ error: "missing_prompt", message: "agent prompt requires JSON body { prompt: string }" }, 400);
    const model = readBodyModelTarget(body);
    if (!model.ok) return json(model.body, model.status);
    const result = await runAgentPrompt({
      profile: profile.profile,
      prompt,
      ...(model.target ? { model: model.target } : {}),
      cwd,
      ...(readPayloadString(body, "sessionId") ? { sessionId: readPayloadString(body, "sessionId") } : {}),
      ...(readPayloadString(body, "trace") ? { trace: readPayloadString(body, "trace") } : {}),
    });
    return json({ result }, 202);
  }

  if (request.method === "POST" && parts[1] === "peers" && parts[2] && parts[3] === "wake" && parts.length === 4) {
    const target = await readExistingProfile(parts[2]);
    if (!target.ok) return json(target.body, target.status);
    const body = await readJsonBody(request);
    if (isBodyTooLarge(body)) return json({ error: "body_too_large", message: body.message }, 413);
    if (isMalformedJson(body)) return json({ error: "malformed_json", message: body.message }, 400);
    const caller = readPayloadString(body, "caller");
    const message = readPayloadString(body, "message");
    if (!caller) return json({ error: "missing_caller", message: "peer wake requires JSON body { caller: string, message: string }" }, 400);
    if (!message) return json({ error: "missing_message", message: "peer wake requires JSON body { caller: string, message: string }" }, 400);
    const result = await peerCall({
      callingPeer: caller,
      targetPeer: target.profile,
      message,
      ...(readPayloadString(body, "trace") ? { trace: readPayloadString(body, "trace") } : {}),
      ...(readWakeKind(body) ? { wakeKind: readWakeKind(body) } : {}),
      ...(readTextVerbosity(body) ? { textVerbosity: readTextVerbosity(body) } : {}),
      ...(readLashThread(body) ? { thread: readLashThread(body) } : {}),
      ...(readLashChain(body) ? { chain: readLashChain(body) } : {}),
    });
    return json({ result }, result.ok ? 202 : 409);
  }

  if (request.method === "GET" && parts[1] === "runtimes" && parts.length === 2) {
    const profilesResult = await readExistingProfilesParam(url);
    if (!profilesResult.ok) return json(profilesResult.body, profilesResult.status);
    const profiles = profilesResult.profiles ?? await listProfiles();
    return json({ runtimes: await Promise.all(profiles.map((profile) => resolveAgentRuntime(profile))) });
  }

  if (request.method === "GET" && parts[1] === "runtimes" && parts[2] && parts.length === 3) {
    const profile = await readExistingProfile(parts[2]);
    if (!profile.ok) return json(profile.body, profile.status);
    return json(await resolveAgentRuntime(profile.profile));
  }

  if (request.method === "POST" && parts[1] === "runtimes" && parts[2] && parts[3] === "ensure" && parts.length === 4) {
    const profile = await readExistingProfile(parts[2]);
    if (!profile.ok) return json(profile.body, profile.status);
    return json(await ensureAgentWorkspace(profile.profile));
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
    const profileResult = await readOptionalExistingProfileParam(url);
    if (!profileResult.ok) return json(profileResult.body, profileResult.status);
    const limit = readLimitParam(url, "limit", 100, 1_000);
    const memory = await queryMemoryEvents({
      ...(profileResult.profile ? { peer: profileResult.profile } : {}),
      ...(readStringParam(url, "kind") ? { kind: readStringParam(url, "kind") as MemoryEventKind } : {}),
      ...(readStringParam(url, "trace") ? { trace: readStringParam(url, "trace") } : {}),
      limit,
    });
    return json({ memory });
  }

  if (request.method === "GET" && parts[1] === "memory" && parts[2] === "anchors" && parts.length === 3) {
    if (!readStringParam(url, "profile")) return json({ error: "missing_profile", message: "memory anchors require ?profile=<agent>" }, 400);
    const profileResult = await readOptionalExistingProfileParam(url);
    if (!profileResult.ok) return json(profileResult.body, profileResult.status);
    const limit = readLimitParam(url, "limit", 25, 1_000);
    const store = new FileMemoryStore();
    try {
      return json({ anchors: await store.recentAnchors(profileResult.profile!, limit) });
    } finally {
      await store.close();
    }
  }

  if (request.method === "GET" && parts[1] === "sessions" && parts.length === 2) {
    if (!readStringParam(url, "profile")) return json({ error: "missing_profile", message: "sessions require ?profile=<agent>" }, 400);
    const profileResult = await readOptionalExistingProfileParam(url);
    if (!profileResult.ok) return json(profileResult.body, profileResult.status);
    return json({ sessions: await listSessions(profileResult.profile!) });
  }

  if (request.method === "GET" && parts[1] === "scheduler" && parts[2] === "jobs" && parts.length === 3) {
    const profilesResult = await readExistingProfilesParam(url);
    if (!profilesResult.ok) return json(profilesResult.body, profilesResult.status);
    return json({ jobs: await listSchedulerJobs(profilesResult.profiles ?? undefined) });
  }

  if (request.method === "POST" && parts[1] === "scheduler" && parts[2] === "jobs" && parts.length === 3) {
    if (!authorizeRuntimeWriteRequest(request, authToken)) {
      return json({
        error: "write_auth_required",
        message: "scheduler job creation writes agent schedule config; start runtime with US_RUNTIME_BEARER_TOKEN and send Authorization: Bearer <token>",
      }, 401);
    }
    const body = await readJsonBody(request);
    if (isBodyTooLarge(body)) return json({ error: "body_too_large", message: body.message }, 413);
    if (isMalformedJson(body)) return json({ error: "malformed_json", message: body.message }, 400);
    try {
      const schedule = await createScheduledOrchestration({
        owner: readPayloadString(body, "owner") ?? "",
        name: readPayloadString(body, "name") ?? "",
        cron: readPayloadString(body, "cron") ?? "",
        timezone: readPayloadString(body, "timezone") ?? "",
        prompt: readPayloadString(body, "prompt") ?? "",
        deliverables: readBodyStringArray(body, "deliverables") ?? [],
        route: readBodyStringArray(body, "route") ?? [],
      });
      return json({ schedule }, 201);
    } catch (error) {
      return json({ error: "invalid_schedule", message: (error as Error).message }, 400);
    }
  }

  if (request.method === "GET" && parts[1] === "scheduler" && parts[2] === "due" && parts.length === 3) {
    const profilesResult = await readExistingProfilesParam(url);
    if (!profilesResult.ok) return json(profilesResult.body, profilesResult.status);
    return json({ due: await dueSchedulerJobs(readNow(url), profilesResult.profiles ?? undefined) });
  }

  if (request.method === "POST" && parts[1] === "scheduler" && parts[2] === "tick" && parts.length === 3) {
    const body = await readJsonBody(request);
    if (isBodyTooLarge(body)) return json({ error: "body_too_large", message: body.message }, 413);
    if (isMalformedJson(body)) return json({ error: "malformed_json", message: body.message }, 400);
    const now = readBodyNumber(body, "now") ?? readNow(url);
    const profilesResult = readBodyStringArray(body, "profiles")
      ? await readExistingProfilesFromValues(readBodyStringArray(body, "profiles")!)
      : await readExistingProfilesParam(url);
    if (!profilesResult.ok) return json(profilesResult.body, profilesResult.status);
    const profiles = profilesResult.profiles ?? undefined;
    const claimed = await claimDueSchedulerJobs(now, profiles);
    const execute = readBooleanParam(url, "execute") ?? readBodyBoolean(body, "execute") ?? false;
    if (!execute) return json({ runs: claimed });
    const runs = [];
    for (const run of claimed) {
      runs.push(await executeSchedulerRun(run, async (job, schedulerRun) => {
        const route = job.route.length ? job.route : [job.profile];
        const steps = [];
        let upstream = "";
        for (const [index, profile] of route.entries()) {
          const result = await runAgentPrompt({
            profile,
            prompt: runtimeScheduledRoutePrompt(job.name, job.prompt, route, profile, index, upstream, job.deliverables),
            cwd,
            trace: `scheduler:${schedulerRun.id}`,
            sessionId: `scheduler-${job.profile}-${job.kind}-${job.dueAt}-${index + 1}-${profile}`,
          });
          upstream = result.text;
          steps.push({
            profile,
            text: result.text,
            model: `${result.provider}/${result.model}`,
            steps: result.steps,
            toolCalls: result.toolCalls,
            usage: result.usage,
            trace: result.trace,
            sessionId: result.sessionId,
          });
        }
        const last = steps.at(-1);
        return {
          trace: `scheduler:${schedulerRun.id}`,
          sessionId: last?.sessionId,
          result: {
            text: last?.text ?? "",
            model: last?.model,
            route,
            routeSteps: steps,
            steps: steps.reduce((count, step) => count + (Array.isArray(step.steps) ? step.steps.length : 1), 0),
            toolCalls: steps.flatMap((step) => step.toolCalls ?? []),
            usage: aggregateRuntimeStepUsage(steps),
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
    const sourceResult = readWebhookSource(parts[2]);
    if (!sourceResult.ok) return json(sourceResult.body, sourceResult.status);
    const source = sourceResult.source;
    let rawBody: string;
    try {
      rawBody = await readRawBody(request);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return json({ error: "body_too_large", message: error.message }, 413);
      throw error;
    }
    const signature = verifyWebhookSignature(source, rawBody, request.headers);
    if (!signature.ok) return json(signature.body, signature.status);
    const body = parseJsonText(rawBody);
    if (isMalformedJson(body)) return json({ error: "malformed_json", message: body.message }, 400);
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
  const [pack, runtime, principal, delegationTargets, mcpStatus, memorySync, sessions, modelChain] = await Promise.all([
    readOptionalRuntimeAgentPack(profile),
    resolveAgentRuntime(profile),
    resolveAgentPrincipal(profile),
    resolveDelegationTargets(profile),
    inspectMcpStatus(cwd, profile),
    resolveMemorySyncConfig(profile),
    listSessions(profile),
    readModelChain(profile),
  ]);
  const grants = await resolveMcpGrantsForAgent(profile, mcpStatus.servers);
  return {
    profile,
    pack,
    model: modelChain[0],
    modelChain,
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

async function readOptionalRuntimeAgentPack(profile: string) {
  try {
    return await readAgentPack(profile);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
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
    limit: readLimitParam(url, "limit", 100, 1_000),
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
    limit: readLimitParam(url, "limit", 100, 1_000),
  };
}

interface MalformedJson {
  malformedJson: true;
  message: string;
}

interface BodyTooLarge {
  bodyTooLarge: true;
  message: string;
}

const MAX_JSON_BODY_BYTES = 1_000_000;

async function readJsonBody(request: Request): Promise<unknown | MalformedJson | BodyTooLarge> {
  try {
    return parseJsonText(await readRawBody(request));
  } catch (error) {
    if (error instanceof BodyTooLargeError) return { bodyTooLarge: true, message: error.message };
    throw error;
  }
}

async function readRawBody(request: Request): Promise<string> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_JSON_BODY_BYTES) {
    throw new BodyTooLargeError(`request body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BODY_BYTES) {
    throw new BodyTooLargeError(`request body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
  }
  return text;
}

function parseJsonText(text: string): unknown | MalformedJson {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    return {
      malformedJson: true,
      message: `request body is not valid JSON: ${(error as Error).message}`,
    };
  }
}

function isMalformedJson(value: unknown): value is MalformedJson {
  return isRecord(value) && value.malformedJson === true && typeof value.message === "string";
}

function isBodyTooLarge(value: unknown): value is BodyTooLarge {
  return isRecord(value) && value.bodyTooLarge === true && typeof value.message === "string";
}

class BodyTooLargeError extends Error {}

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

function readLimitParam(url: URL, name: string, fallback: number, max: number): number {
  const value = readNumberParam(url, name);
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
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

function readWakeKind(body: unknown): "delegate" | "report" | undefined {
  const value = readPayloadString(body, "wakeKind");
  return value === "delegate" || value === "report" ? value : undefined;
}

function readTextVerbosity(body: unknown): "low" | "medium" | "high" | undefined {
  const value = readPayloadString(body, "textVerbosity");
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function readLashThread(body: unknown): any | undefined {
  if (!isRecord(body) || !isRecord(body.thread)) return undefined;
  const id = typeof body.thread.id === "string" ? body.thread.id.trim() : "";
  const turn = Number(body.thread.turn);
  const resume = typeof body.thread.resume === "string" ? body.thread.resume.trim() : "resume_or_create";
  const summary = typeof body.thread.summary === "string" ? body.thread.summary.trim() : undefined;
  return id && Number.isInteger(turn) && turn >= 0 ? { id, resume, ...(summary ? { summary } : {}), turn } : undefined;
}

function readLashChain(body: unknown): Array<{ from: string; to: string; at: string }> | undefined {
  if (!isRecord(body) || !Array.isArray(body.chain)) return undefined;
  const chain = body.chain.flatMap((item) => {
    if (!isRecord(item)) return [];
    const from = typeof item.from === "string" ? item.from.trim() : "";
    const to = typeof item.to === "string" ? item.to.trim() : "";
    const at = typeof item.at === "string" && item.at.trim() ? item.at.trim() : new Date(0).toISOString();
    return from && to ? [{ from, to, at }] : [];
  });
  return chain.length ? chain : undefined;
}

function readBodyModelTarget(
  body: unknown,
): { ok: true; target?: { provider: string; id: string } } | { ok: false; status: number; body: { error: string; message: string } } {
  if (!isRecord(body) || body.model === undefined) return { ok: true };
  if (!isRecord(body.model)) {
    return { ok: false, status: 400, body: { error: "invalid_model", message: "model override must be { provider: string, id: string }" } };
  }
  const provider = typeof body.model.provider === "string" ? body.model.provider.trim() : "";
  const id = typeof body.model.id === "string" ? body.model.id.trim() : "";
  if (!provider || !id) {
    return { ok: false, status: 400, body: { error: "invalid_model", message: "model override requires non-empty provider and id" } };
  }
  if (!isSafeModelRoutePart(provider, 128) || !isSafeModelRoutePart(id, 256)) {
    return { ok: false, status: 400, body: { error: "invalid_model", message: "model provider/id may only contain letters, digits, dots, underscores, colons, slashes, and dashes" } };
  }
  return { ok: true, target: { provider, id } };
}

function runtimeScheduledRoutePrompt(
  name: string,
  prompt: string,
  route: string[],
  profile: string,
  index: number,
  upstream: string,
  deliverables: string[],
): string {
  return [
    `Scheduled orchestration: ${name}`,
    `Route: ${route.map((agent) => `@${agent}`).join(" -> ")}`,
    `Current step: ${index + 1}/${route.length} (@${profile})`,
    "",
    "Instructions:",
    prompt,
    ...(upstream ? ["", "Upstream output from the previous route step:", upstream] : []),
    ...(deliverables.length ? ["", "Deliverables:", ...deliverables.map((deliverable) => `- ${deliverable}`)] : []),
  ].join("\n");
}

function aggregateRuntimeStepUsage(steps: Array<{ usage?: { input?: number; output?: number; reasoning?: number; total?: number } }>) {
  return steps.reduce((total, step) => ({
    input: total.input + (step.usage?.input ?? 0),
    output: total.output + (step.usage?.output ?? 0),
    reasoning: total.reasoning + (step.usage?.reasoning ?? 0),
    total: total.total + (step.usage?.total ?? 0),
  }), { input: 0, output: 0, reasoning: 0, total: 0 });
}

function readBodyFleetPlan(
  body: unknown,
): { ok: true; plan: ReturnType<typeof normalizeFleetPlan> } | { ok: false; status: number; body: { error: string; message: string } } {
  if (!isRecord(body) || body.plan === undefined) {
    return { ok: false, status: 400, body: { error: "missing_fleet_plan", message: "fleet route requires JSON body { plan }" } };
  }
  try {
    return { ok: true, plan: normalizeFleetPlan(body.plan) };
  } catch (error) {
    return { ok: false, status: 400, body: { error: "invalid_fleet_plan", message: (error as Error).message } };
  }
}

function readHeaderPrincipal(request: Request): string | undefined {
  const value = request.headers.get("x-union-street-actor") ?? request.headers.get("x-us-actor");
  return value?.trim() || undefined;
}

function isSafeModelRoutePart(value: string, max: number): boolean {
  return value.length > 0
    && value.length <= max
    && !value.includes("..")
    && !value.startsWith("/")
    && !value.endsWith("/")
    && /^[A-Za-z0-9._:/-]+$/.test(value);
}

function selectedHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["content-type", "user-agent", "x-github-event", "x-linear-event", "x-union-street-actor", "x-us-actor"]) {
    const value = headers.get(name);
    if (value) out[name] = value;
  }
  return out;
}

function readWebhookSource(
  raw: string,
): { ok: true; source: string } | { ok: false; status: number; body: { error: string; message: string } } {
  const source = decodeURIComponent(raw).trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(source)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid_webhook_source",
        message: "webhook source must be lowercase letters, digits, underscores, or dashes, start with a letter, and be at most 64 characters",
      },
    };
  }
  return { ok: true, source };
}

function verifyWebhookSignature(
  source: string,
  rawBody: string,
  headers: Headers,
): { ok: true } | { ok: false; status: number; body: { error: string; message: string } } {
  const secret = webhookSecretForSource(source);
  if (!secret) return { ok: true };
  const provided = headers.get("x-us-signature") ?? headers.get("x-hub-signature-256");
  if (!provided?.trim()) {
    return {
      ok: false,
      status: 401,
      body: { error: "webhook_signature_required", message: `webhook:${source} requires an HMAC SHA-256 signature` },
    };
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const actual = provided.trim().replace(/^sha256=/i, "");
  if (!constantTimeEqualHex(actual, expected)) {
    return {
      ok: false,
      status: 401,
      body: { error: "webhook_signature_invalid", message: `webhook:${source} signature did not match` },
    };
  }
  return { ok: true };
}

function webhookSecretForSource(source: string): string | undefined {
  const key = `US_WEBHOOK_${source.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_SECRET`;
  return process.env[key]?.trim() || process.env.US_WEBHOOK_SECRET?.trim() || undefined;
}

function constantTimeEqualHex(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]+$/i.test(actual) || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

async function readExistingProfile(
  raw: string,
): Promise<
  | { ok: true; profile: string }
  | { ok: false; status: number; body: { error: string; message: string } }
> {
  const profile = decodeURIComponent(raw).trim().replace(/^@+/, "");
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(profile)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid_profile",
        message: "profile must be lowercase letters, digits, underscores, or dashes, start with a letter, and be at most 64 characters",
      },
    };
  }
  if (!(await profileExists(profile))) {
    return {
      ok: false,
      status: 404,
      body: { error: "profile_not_found", message: `profile "${profile}" does not exist` },
    };
  }
  return { ok: true, profile };
}

async function readOptionalExistingProfileParam(
  url: URL,
): Promise<
  | { ok: true; profile?: string }
  | { ok: false; status: number; body: { error: string; message: string } }
> {
  const raw = readStringParam(url, "profile");
  if (!raw) return { ok: true };
  const profile = await readExistingProfile(raw);
  if (!profile.ok) return profile;
  return { ok: true, profile: profile.profile };
}

async function readExistingProfilesParam(
  url: URL,
): Promise<
  | { ok: true; profiles?: string[] }
  | { ok: false; status: number; body: { error: string; message: string } }
> {
  const values = readProfilesParam(url);
  if (!values) return { ok: true };
  return readExistingProfilesFromValues(values);
}

async function readExistingProfilesFromValues(
  values: string[],
): Promise<
  | { ok: true; profiles: string[] }
  | { ok: false; status: number; body: { error: string; message: string } }
> {
  const out: string[] = [];
  for (const value of values) {
    const profile = await readExistingProfile(value);
    if (!profile.ok) return profile;
    if (!out.includes(profile.profile)) out.push(profile.profile);
  }
  return { ok: true, profiles: out };
}

function authorizeRuntimeRequest(request: Request, token: string | undefined): boolean {
  const expected = token?.trim();
  if (!expected) return true;
  const auth = request.headers.get("authorization")?.trim() ?? "";
  return constantTimeUtf8Equal(auth, `Bearer ${expected}`);
}

function authorizeRuntimeWriteRequest(request: Request, token: string | undefined): boolean {
  const expected = token?.trim();
  if (!expected) return false;
  const auth = request.headers.get("authorization")?.trim() ?? "";
  return constantTimeUtf8Equal(auth, `Bearer ${expected}`);
}

function constantTimeUtf8Equal(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
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
  const origin = requestOrigin.getStore();
  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-us-signature,x-hub-signature-256,x-union-street-actor,x-us-actor",
    "vary": "Origin",
  };
  if (origin && isAllowedRuntimeOrigin(origin)) headers["access-control-allow-origin"] = origin;
  return headers;
}

function isAllowedRuntimeOrigin(origin: string): boolean {
  const explicit = (process.env.US_RUNTIME_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (explicit.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:")
      && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
