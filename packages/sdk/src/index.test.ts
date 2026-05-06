import { describe, expect, test } from "bun:test";
import {
  UnionStreetApiError,
  UnionStreetClient,
  cleanBaseUrl,
  emptyRuntimeSnapshot,
  type RuntimeContract,
  type RuntimeEvent,
  type RuntimeSchedulerJob,
  type RuntimeSchedulerRun,
} from "./index.ts";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: unknown;
}

describe("UnionStreetClient", () => {
  test("constructor_WhenBaseUrlHasWhitespaceAndTrailingSlashes_NormalizesStableOrigin", () => {
    expect(cleanBaseUrl("  http://runtime.test/// ")).toBe("http://runtime.test");
    expect(new UnionStreetClient({ baseUrl: "http://runtime.test/" }).baseUrl).toBe("http://runtime.test");
  });

  test("constructor_WhenFetchIsMissing_ThrowsActionableError", () => {
    const originalFetch = globalThis.fetch;
    try {
      Reflect.set(globalThis, "fetch", undefined);
      expect(() => new UnionStreetClient({ baseUrl: "http://runtime.test" })).toThrow("requires a fetch implementation");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("request_WhenTokenProviderReturnsWhitespace_DoesNotSendEmptyAuthorizationHeader", async () => {
    const { client, requests } = mockClient({ token: () => "   ", json: { ok: true } });

    await client.health();

    expect(requests[0]!.headers.has("authorization")).toBe(false);
  });

  test("request_WhenTokenAndExistingHeadersAreProvided_PreservesHeadersAndInjectsBearer", async () => {
    const { client, requests } = mockClient({ token: "runtime-token", json: { ok: true } });

    await client.request("/api/runtime", {
      headers: { "x-request-id": "req-1" },
    });

    expect(requests[0]!.headers.get("authorization")).toBe("Bearer runtime-token");
    expect(requests[0]!.headers.get("x-request-id")).toBe("req-1");
  });

  test("request_WhenBodyIsPlainObject_SerializesJsonAndSetsContentType", async () => {
    const { client, requests } = mockClient({ json: { ok: true } });

    await client.request("/api/runtime", { method: "POST", body: { hello: "world" } });

    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.headers.get("content-type")).toBe("application/json");
    expect(requests[0]!.body).toEqual({ hello: "world" });
  });

  test("request_WhenBodyIsString_PreservesRawBodyAndCallerContentType", async () => {
    const { client, requests } = mockClient({ json: { ok: true } });

    await client.request("/api/webhooks/github", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "raw-body",
    });

    expect(requests[0]!.headers.get("content-type")).toBe("text/plain");
    expect(requests[0]!.body).toBe("raw-body");
  });

  test("healthAndOpenApi_WhenCalled_UsePublicDiscoveryRoutes", async () => {
    const { client, requests } = mockClient({
      responseFor: (request) => request.url.endsWith("/health")
        ? Response.json({ ok: true, version: "0.1.0", runtimeId: "rt", uptimeMs: 1, usHome: "/tmp/us", ts: 1 })
        : Response.json({ openapi: "3.1.0" }),
    });

    await expect(client.health()).resolves.toMatchObject({ ok: true, runtimeId: "rt" });
    await expect(client.openapi()).resolves.toMatchObject({ openapi: "3.1.0" });

    expect(requests.map((request) => request.url)).toEqual([
      "http://runtime.test/health",
      "http://runtime.test/openapi.json",
    ]);
  });

  test("agentScopedRoutes_WhenProfilesContainReservedCharacters_PercentEncodePathSegments", async () => {
    const { client, requests } = mockClient({
      responseFor: (request) => {
        if (request.url.includes("/prompt")) return Response.json({ result: { text: "ok" } }, { status: 202 });
        if (request.url.includes("/wake")) return Response.json({ result: { ok: true } }, { status: 202 });
        return Response.json({ profile: "vp eng/.." });
      },
    });

    await client.agent("vp eng/..");
    await client.sendAgentPrompt("vp eng/..", { prompt: "ship" });
    await client.wakePeer("vp eng/..", { caller: "coo", message: "wake" });
    await client.runtimeForAgent("vp eng/..");
    await client.ensureAgentRuntime("vp eng/..");

    expect(requests.map((request) => request.url)).toEqual([
      "http://runtime.test/api/agents/vp%20eng%2F..",
      "http://runtime.test/api/agents/vp%20eng%2F../prompt",
      "http://runtime.test/api/peers/vp%20eng%2F../wake",
      "http://runtime.test/api/runtimes/vp%20eng%2F..",
      "http://runtime.test/api/runtimes/vp%20eng%2F../ensure",
    ]);
  });

  test("sendAgentPrompt_WhenTokenAndBodyAreProvided_SendsTypedRuntimeRequest", async () => {
    const { client, requests } = mockClient({
      token: () => "runtime-token",
      json: {
        result: {
          text: "ok",
          trace: "trace-sdk",
          sessionId: "session-sdk",
          usage: { total: 2 },
        },
      },
      status: 202,
    });

    const result = await client.sendAgentPrompt("coo", {
      prompt: "ship it",
      trace: "trace-sdk",
      model: { provider: "codex", id: "gpt-5.4" },
    });

    expect(result.text).toBe("ok");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("http://runtime.test/api/agents/coo/prompt");
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer runtime-token");
    expect(requests[0]!.headers.get("content-type")).toBe("application/json");
    expect(requests[0]!.body).toEqual({
      prompt: "ship it",
      trace: "trace-sdk",
      model: { provider: "codex", id: "gpt-5.4" },
    });
  });

  test("listRoutes_WhenFiltersAreProvided_EncodeStableQueryStrings", async () => {
    const { client, requests } = mockClient({
      responseFor: (request) => {
        if (request.url.includes("/api/events")) return Response.json({ events: [] });
        if (request.url.includes("/api/usage")) return Response.json({ usage: [], summary: { total: 0 } });
        if (request.url.includes("/api/memory/anchors")) return Response.json({ anchors: [] });
        if (request.url.includes("/api/memory")) return Response.json({ memory: [] });
        if (request.url.includes("/api/scheduler/due")) return Response.json({ due: [] });
        if (request.url.includes("/api/runtimes")) return Response.json({ runtimes: [] });
        if (request.url.includes("/api/scheduler/jobs")) return Response.json({ jobs: [] });
        return Response.json({});
      },
    });

    await client.events({ actor: "coo", trace: "trace/sdk", limit: 25 });
    await client.usage({ actor: "vp eng", model: "gpt/5", limit: 10 });
    await client.memory({ profile: "coo", kind: "session.message", trace: "trace/sdk" });
    await client.memoryAnchors("vp eng", { limit: 3 });
    await client.runtimes(["coo", "vp-eng"]);
    await client.schedulerJobs(["coo", "vp-eng"]);
    await client.schedulerDue({ profile: ["coo", "vp-eng"], now: 123 });

    expect(requests.map((request) => request.url)).toEqual([
      "http://runtime.test/api/events?actor=coo&trace=trace%2Fsdk&limit=25",
      "http://runtime.test/api/usage?actor=vp+eng&model=gpt%2F5&limit=10",
      "http://runtime.test/api/memory?profile=coo&kind=session.message&trace=trace%2Fsdk",
      "http://runtime.test/api/memory/anchors?profile=vp+eng&limit=3",
      "http://runtime.test/api/runtimes?profile=coo,vp-eng",
      "http://runtime.test/api/scheduler/jobs?profile=coo,vp-eng",
      "http://runtime.test/api/scheduler/due?profile=coo%2Cvp-eng&now=123",
    ]);
  });

  test("modelsAndSessions_WhenProfileIsProvided_EncodeProfileFilter", async () => {
    const { client, requests } = mockClient({
      responseFor: (request) => request.url.includes("/api/models")
        ? Response.json({ groups: [{ id: "codex", label: "Codex", authMethod: "oauth", state: "live", models: [] }] })
        : Response.json({ sessions: [{ id: "session-1" }] }),
    });

    await expect(client.models("vp eng")).resolves.toHaveLength(1);
    await expect(client.sessions("vp eng")).resolves.toEqual([{ id: "session-1" }]);

    expect(requests.map((request) => request.url)).toEqual([
      "http://runtime.test/api/models?profile=vp%20eng",
      "http://runtime.test/api/sessions?profile=vp%20eng",
    ]);
  });

  test("schedulerMutations_WhenCalled_ReturnTypedBodies", async () => {
    const { client, requests } = mockClient({
      responseFor: (request) => {
        if (request.url.endsWith("/api/scheduler/jobs")) return Response.json({ schedule: { id: "weekly" } }, { status: 201 });
        if (request.url.endsWith("/api/scheduler/tick")) return Response.json({ runs: [schedulerRun("run-1", "claimed")] });
        if (request.url.endsWith("/api/scheduler/runs")) return Response.json({ runs: [schedulerRun("run-2", "complete")] });
        return Response.json({});
      },
    });

    await expect(client.createSchedulerJob({
      owner: "coo",
      name: "Weekly",
      cron: "0 9 * * MON",
      timezone: "UTC",
      prompt: "Report",
      deliverables: ["summary"],
      route: ["coo"],
    })).resolves.toEqual({ id: "weekly" });
    await expect(client.runSchedulerTick({ now: 123, profiles: ["coo"], execute: true })).resolves.toEqual([schedulerRun("run-1", "claimed")]);
    await expect(client.schedulerRuns()).resolves.toEqual([schedulerRun("run-2", "complete")]);

    expect(requests[0]!.body).toEqual({
      owner: "coo",
      name: "Weekly",
      cron: "0 9 * * MON",
      timezone: "UTC",
      prompt: "Report",
      deliverables: ["summary"],
      route: ["coo"],
    });
    expect(requests[1]!.body).toEqual({ now: 123, profiles: ["coo"], execute: true });
  });

  test("fleetRoutes_WhenCalled_PreservePlanAndApplyFlags", async () => {
    const plan = {
      version: 1 as const,
      kind: "union-street.fleet-plan" as const,
      name: "test",
      mission: "test mission",
      root: "coo",
      generatedBy: "coo",
      agents: [],
    };
    const { client, requests } = mockClient({
      responseFor: (request) => {
        if (request.url.endsWith("/plan")) return Response.json({ plan, validation: { ok: true, errors: [], warnings: [], summary: {} } });
        if (request.url.endsWith("/validate")) return Response.json({ plan, validation: { ok: true, errors: [], warnings: [], summary: {} } });
        return Response.json({ applied: false, profiles: [], validation: { ok: true, errors: [], warnings: [], summary: {} } }, { status: 202 });
      },
    });

    await client.planFleet({ profile: "coo", prompt: "design" });
    await client.validateFleet(plan);
    await client.applyFleet(plan, { overwrite: true });

    expect(requests.map((request) => [request.method, request.url, request.body])).toEqual([
      ["POST", "http://runtime.test/api/fleet/plan", { profile: "coo", prompt: "design" }],
      ["POST", "http://runtime.test/api/fleet/validate", { plan }],
      ["POST", "http://runtime.test/api/fleet/apply", { plan, overwrite: true, dryRun: false }],
    ]);
  });

  test("sendWebhook_WhenSignatureAndActorAreProvided_SendsSignedIngressRequest", async () => {
    const { client, requests } = mockClient({
      json: { event: runtimeEvent("event-webhook", "webhook.received", { actor: "vp-eng" }) },
      status: 202,
    });

    await expect(client.sendWebhook("git hub/..", { action: "opened" }, {
      signature: "sha256=abc",
      actor: "vp-eng",
    })).resolves.toMatchObject({ type: "webhook.received" });

    expect(requests[0]!.url).toBe("http://runtime.test/api/webhooks/git%20hub%2F..");
    expect(requests[0]!.headers.get("x-us-signature")).toBe("sha256=abc");
    expect(requests[0]!.headers.get("x-union-street-actor")).toBe("vp-eng");
    expect(requests[0]!.body).toEqual({ action: "opened" });
  });

  test("json_WhenRuntimeReturnsJsonError_ThrowsStructuredApiError", async () => {
    const { client } = mockClient({
      json: { error: "unauthorized", message: "runtime API requires Authorization" },
      status: 401,
    });

    try {
      await client.runtime();
      throw new Error("expected runtime call to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(UnionStreetApiError);
      expect((error as UnionStreetApiError).status).toBe(401);
      expect((error as UnionStreetApiError).message).toBe("runtime API requires Authorization");
      expect((error as UnionStreetApiError).body).toEqual({ error: "unauthorized", message: "runtime API requires Authorization" });
    }
  });

  test("json_WhenRuntimeReturnsPlainTextError_ThrowsStructuredTextApiError", async () => {
    const { client } = mockClient({
      responseFor: () => new Response("upstream exploded", { status: 502 }),
    });

    await expect(client.runtime()).rejects.toMatchObject({
      name: "UnionStreetApiError",
      status: 502,
      body: { message: "upstream exploded" },
      message: "upstream exploded",
    });
  });

  test("snapshot_WhenRuntimeIsUnavailable_ReturnsDisconnectedSnapshot", async () => {
    const client = new UnionStreetClient({
      baseUrl: "http://runtime.test",
      fetch: async () => {
        throw new Error("connection refused");
      },
    });

    const snapshot = await client.snapshot();

    expect(snapshot.connected).toBe(false);
    expect(snapshot.baseUrl).toBe("http://runtime.test");
    expect(snapshot.error).toBe("connection refused");
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.scheduler).toEqual({ jobs: [], runs: [] });
  });

  test("snapshot_WhenRuntimeIsHealthy_LoadsAllDashboardCollectionsInParallel", async () => {
    const { client, requests } = mockClient({
      responseFor: (request) => {
        if (request.url.endsWith("/health")) return Response.json({ ok: true, version: "0.1.0", runtimeId: "rt", uptimeMs: 1, usHome: "/tmp/us", ts: 1 });
        if (request.url.endsWith("/api/runtime")) return Response.json({ runtimeId: "rt", version: "0.1.0", startedAt: 1, uptimeMs: 1, usHome: "/tmp/us", cwd: "/tmp", profiles: 1, endpoints: [] });
        if (request.url.endsWith("/api/agents")) return Response.json({ agents: [{ profile: "coo" }] });
        if (request.url.endsWith("/api/runtimes")) return Response.json({ runtimes: [runtimeContract("coo")] });
        if (request.url.includes("/api/events")) return Response.json({ events: [runtimeEvent("event-1", "event")] });
        if (request.url.includes("/api/usage")) return Response.json({ usage: [{ total: 2 }], summary: { total: 2 } });
        if (request.url.endsWith("/api/scheduler/jobs")) return Response.json({ jobs: [schedulerJob("job")] });
        if (request.url.endsWith("/api/scheduler/runs")) return Response.json({ runs: [schedulerRun("run", "claimed")] });
        if (request.url.includes("/api/memory")) return Response.json({ memory: [{ peer: "coo" }] });
        return Response.json({});
      },
    });

    const snapshot = await client.snapshot();

    expect(snapshot.connected).toBe(true);
    expect(snapshot.agents).toEqual([{ profile: "coo" }]);
    expect(snapshot.runtimes).toEqual([runtimeContract("coo")]);
    expect(snapshot.events).toEqual([runtimeEvent("event-1", "event")]);
    expect(snapshot.usage.summary.total).toBe(2);
    expect(snapshot.scheduler).toEqual({ jobs: [schedulerJob("job")], runs: [schedulerRun("run", "claimed")] });
    expect(snapshot.memory).toEqual([{ peer: "coo" }]);
    expect(new Set(requests.map((request) => request.url))).toEqual(new Set([
      "http://runtime.test/health",
      "http://runtime.test/api/runtime",
      "http://runtime.test/api/agents",
      "http://runtime.test/api/runtimes",
      "http://runtime.test/api/events?limit=250",
      "http://runtime.test/api/usage?limit=1000",
      "http://runtime.test/api/scheduler/jobs",
      "http://runtime.test/api/scheduler/runs",
      "http://runtime.test/api/memory?limit=250",
    ]));
  });

  test("emptyRuntimeSnapshot_WhenCalled_ReturnsStrictDisconnectedShape", () => {
    expect(emptyRuntimeSnapshot("http://runtime.test", "boom")).toEqual({
      connected: false,
      baseUrl: "http://runtime.test",
      error: "boom",
      agents: [],
      runtimes: [],
      events: [],
      usage: { usage: [], summary: {} },
      scheduler: { jobs: [], runs: [] },
      memory: [],
      models: [],
    });
  });

  test("streamEvents_WhenSseFramesAreFragmented_ParsesEventsAndErrorFrames", async () => {
    const events: unknown[] = [];
    const errors: string[] = [];
    const controller = new AbortController();
    const { client, requests } = mockClient({
      responseFor: () => new Response(fragmentedTextStream([
        "event: prompt.run.complete\n",
        "data: {\"ts\":1,\"type\":\"prompt.run.complete\",\"actor\":\"coo\"}\n\n",
        "event: error\n",
        "data: {\"message\":\"stream warning\"}\n\n",
      ]), {
        headers: { "content-type": "text/event-stream" },
      }),
    });

    await client.streamEvents({
      signal: controller.signal,
      query: { actor: "coo", trace: "trace/sdk" },
      onEvent: (event) => events.push(event),
      onError: (error) => errors.push(error.message),
    });

    expect(requests[0]!.url).toBe("http://runtime.test/api/events/stream?limit=100&actor=coo&trace=trace%2Fsdk");
    expect(events).toEqual([{ ts: 1, type: "prompt.run.complete", actor: "coo" }]);
    expect(errors).toEqual(["stream warning"]);
  });

  test("streamEvents_WhenSseContainsMalformedJson_ReportsParseErrorAndContinues", async () => {
    const events: unknown[] = [];
    const errors: string[] = [];
    const { client } = mockClient({
      responseFor: () => new Response(fragmentedTextStream([
        "event: broken\n",
        "data: {not-json}\n\n",
        "event: audit.test\n",
        "data: {\"ts\":2,\"type\":\"audit.test\"}\n\n",
      ]), {
        headers: { "content-type": "text/event-stream" },
      }),
    });

    await client.streamEvents({
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
      onError: (error) => errors.push(error.name),
    });

    expect(errors).toEqual(["SyntaxError"]);
    expect(events).toEqual([{ ts: 2, type: "audit.test" }]);
  });

  test("streamEvents_WhenEndpointRejectsRequest_ThrowsApiErrorWithStatusAndBody", async () => {
    const { client } = mockClient({
      json: { error: "unauthorized", message: "nope" },
      status: 401,
    });

    await expect(client.streamEvents({
      signal: new AbortController().signal,
      onEvent: () => {},
      onError: () => {},
    })).rejects.toMatchObject({
      name: "UnionStreetApiError",
      status: 401,
      body: { error: "unauthorized", message: "nope" },
    });
  });
});

function mockClient(options: {
  token?: string | (() => string | undefined);
  json?: unknown;
  status?: number;
  responseFor?: (request: CapturedRequest) => Response;
} = {}): { client: UnionStreetClient; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const client = new UnionStreetClient({
    baseUrl: "http://runtime.test/",
    token: options.token,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const captured: CapturedRequest = {
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: await readRequestBody(request),
      };
      requests.push(captured);
      return options.responseFor?.(captured) ?? Response.json(options.json ?? {}, { status: options.status ?? 200 });
    },
  });
  return { client, requests };
}

async function readRequestBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function fragmentedTextStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function runtimeContract(profile: string): RuntimeContract {
  return {
    profile,
    head: { mode: "embedded", provider: "local" },
    compute: { provider: "local", target: "host" },
    storage: { provider: "local", mountPath: "/tmp/us/workspaces", persistent: true },
    ingress: { provider: "local", public: false, auth: "none", receives: ["control"] },
    workspace: { provider: "local", scope: "agent", workdir: profile },
    workspacePath: `/tmp/us/workspaces/${profile}`,
    pluginId: "runtime-local",
    secrets: [],
    warnings: [],
  };
}

function runtimeEvent(id: string, type: string, extra: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id,
    ts: 1,
    type,
    outcome: "info",
    severity: "info",
    ...extra,
  };
}

function schedulerJob(id: string): RuntimeSchedulerJob {
  return {
    id,
    profile: "coo",
    kind: "pulse",
    name: "Pulse",
    prompt: "Report",
    deliverables: ["summary"],
    cadence: "30m",
    timezone: "UTC",
    enabled: true,
    route: ["coo"],
  };
}

function schedulerRun(id: string, status: "claimed" | "complete"): RuntimeSchedulerRun {
  return {
    id,
    jobId: "pulse:coo",
    kind: "pulse",
    profile: "coo",
    dueAt: 123,
    dueKey: `pulse:coo@123`,
    status,
    ts: 124,
    prompt: "Report",
  };
}
