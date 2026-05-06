import { afterEach, describe, expect, test } from "bun:test";
import {
  createSchedulerJob,
  ensureAgentRuntime,
  loadRuntimeModels,
  planFleet,
  runSchedulerTick,
  sendAgentPrompt,
  streamRuntimeEvents,
  type RuntimeContract,
  type RuntimeSchedulerRun,
} from "./runtime-client.ts";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: unknown;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("dashboard runtime client adapter", () => {
  test("readRoutes_WhenCalled_DelegateToSdkWithDashboardDefaultBaseUrl", async () => {
    const { requests } = mockRuntimeFetch((request) => {
      if (request.url.includes("/api/models")) {
        return Response.json({ groups: [{ id: "codex", label: "Codex", authMethod: "oauth", state: "live", models: [] }] });
      }
      return Response.json(runtimeContract("coo"));
    });

    await expect(loadRuntimeModels("coo")).resolves.toEqual([{ id: "codex", label: "Codex", authMethod: "oauth", state: "live", models: [] }]);
    await expect(ensureAgentRuntime("coo")).resolves.toEqual(runtimeContract("coo"));

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", "http://127.0.0.1:8787/api/models?profile=coo"],
      ["POST", "http://127.0.0.1:8787/api/runtimes/coo/ensure"],
    ]);
  });

  test("promptAndFleetRoutes_WhenCalled_PreserveLegacyDashboardFunctionShapes", async () => {
    const plan = {
      version: 1 as const,
      kind: "union-street.fleet-plan" as const,
      name: "fleet",
      mission: "mission",
      root: "coo",
      generatedBy: "coo",
      agents: [],
    };
    const { requests } = mockRuntimeFetch((request) => {
      if (request.url.endsWith("/prompt")) return Response.json({ result: { text: "ok", trace: "trace" } }, { status: 202 });
      if (request.url.endsWith("/fleet/plan")) return Response.json({ plan, validation: { ok: true, errors: [], warnings: [], summary: {} } });
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    });

    await expect(sendAgentPrompt("coo", {
      prompt: "ship",
      model: { provider: "codex", id: "gpt-5.4" },
    })).resolves.toEqual({ text: "ok", trace: "trace" });
    await expect(planFleet({ profile: "coo", prompt: "design" })).resolves.toMatchObject({ plan });

    expect(requests.map((request) => [request.method, request.url, request.body])).toEqual([
      ["POST", "http://127.0.0.1:8787/api/agents/coo/prompt", {
        prompt: "ship",
        model: { provider: "codex", id: "gpt-5.4" },
      }],
      ["POST", "http://127.0.0.1:8787/api/fleet/plan", { profile: "coo", prompt: "design" }],
    ]);
  });

  test("schedulerWrappers_WhenCalled_ReturnLegacyEnvelopesExpectedByUi", async () => {
    const { requests } = mockRuntimeFetch((request) => {
      if (request.url.endsWith("/api/scheduler/tick")) return Response.json({ runs: [schedulerRun("run-1")] });
      if (request.url.endsWith("/api/scheduler/jobs")) return Response.json({ schedule: { id: "weekly" } }, { status: 201 });
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    });

    await expect(runSchedulerTick({ now: 123, profiles: ["coo"], execute: true })).resolves.toEqual({
      runs: [schedulerRun("run-1")],
    });
    await expect(createSchedulerJob({
      owner: "coo",
      name: "Weekly",
      cron: "0 9 * * MON",
      timezone: "UTC",
      prompt: "Report",
      deliverables: ["summary"],
      route: ["coo"],
    })).resolves.toEqual({ schedule: { id: "weekly" } });

    expect(requests.map((request) => [request.method, request.url, request.body])).toEqual([
      ["POST", "http://127.0.0.1:8787/api/scheduler/tick", { now: 123, profiles: ["coo"], execute: true }],
      ["POST", "http://127.0.0.1:8787/api/scheduler/jobs", {
        owner: "coo",
        name: "Weekly",
        cron: "0 9 * * MON",
        timezone: "UTC",
        prompt: "Report",
        deliverables: ["summary"],
        route: ["coo"],
      }],
    ]);
  });

  test("streamRuntimeEvents_WhenCalled_DelegatesSseParsingToSdk", async () => {
    const events: unknown[] = [];
    const errors: string[] = [];
    const { requests } = mockRuntimeFetch(() => new Response(fragmentedTextStream([
      "event: audit.test\n",
      "data: {\"ts\":1,\"type\":\"audit.test\",\"actor\":\"coo\"}\n\n",
      "event: error\n",
      "data: {\"message\":\"stream warning\"}\n\n",
    ]), {
      headers: { "content-type": "text/event-stream" },
    }));

    await streamRuntimeEvents({
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
      onError: (error) => errors.push(error.message),
    });

    expect(requests[0]!.url).toBe("http://127.0.0.1:8787/api/events/stream?limit=100");
    expect(events).toEqual([{ ts: 1, type: "audit.test", actor: "coo" }]);
    expect(errors).toEqual(["stream warning"]);
  });
});

function mockRuntimeFetch(responseFor: (request: CapturedRequest) => Response): { requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const captured = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await readRequestBody(request),
    };
    requests.push(captured);
    return responseFor(captured);
  }) as typeof fetch;
  return { requests };
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

function schedulerRun(id: string): RuntimeSchedulerRun {
  return {
    id,
    jobId: "pulse:coo",
    kind: "pulse",
    profile: "coo",
    dueAt: 123,
    dueKey: "pulse:coo@123",
    status: "claimed",
    ts: 124,
    prompt: "Report",
  };
}
