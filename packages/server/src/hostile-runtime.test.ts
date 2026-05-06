import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const usHome = await mkdtemp(join(tmpdir(), "union-street-hostile-runtime-test-"));
const workdir = await mkdtemp(join(tmpdir(), "union-street-hostile-runtime-work-"));
process.env.US_HOME = usHome;
process.env.US_MEMORY_SYNC = "0";
process.env.US_STREAM_MODEL_STUB = "1";
process.env.US_PEER_CALL_STUB = "1";

const core = await import("./index.ts");
const runtime = await import("./http/index.ts");

beforeAll(async () => {
  await core.initProfile("coo", { role: "coo" });
});

afterAll(async () => {
  await rm(usHome, { recursive: true, force: true });
  await rm(workdir, { recursive: true, force: true });
});

describe("hostile runtime requests", () => {
  test("RuntimeBearerGate_WhenLookalikeAuthorizationIsProvided_RejectsEverythingExceptExactBearer", async () => {
    const handler = runtime.createRuntimeFetchHandler({ cwd: workdir, authToken: "hostile-secret" });
    const cases: Array<[string, string | undefined, number]> = [
      ["missing", undefined, 401],
      ["lowercase scheme", "bearer hostile-secret", 401],
      ["wrong prefix", "Token hostile-secret", 401],
      ["suffix smuggling", "Bearer hostile-secretx", 401],
      ["embedded whitespace", "Bearer hostile-secret extra", 401],
      ["exact", "Bearer hostile-secret", 200],
    ];

    for (const [label, authorization, expected] of cases) {
      const response = await handler(new Request("http://runtime.test/api/runtime", {
        headers: authorization ? { authorization } : {},
      }));

      expect(response.status, `${label} authorization should produce HTTP ${expected}`).toBe(expected);
    }
  });

  test("RuntimeApi_WhenHostileInputsHitCommonRoutes_ReturnsStableErrorsWithoutSideEffects", async () => {
    const secure = runtime.createRuntimeFetchHandler({ cwd: workdir, authToken: "hostile-secret" });
    const insecure = runtime.createRuntimeFetchHandler({ cwd: workdir, authToken: undefined });

    const traversal = await runtimeJson(secure, "GET", "/api/agents/%2E%2E%2Fauth-profiles", undefined, "hostile-secret");
    const filteredTraversal = await runtimeJson(secure, "GET", "/api/runtimes?profile=coo,%2E%2E%2Fauth-profiles", undefined, "hostile-secret");
    const malformedPrompt = await runtimeRaw(secure, "POST", "/api/agents/coo/prompt", "{ nope", "hostile-secret", { "content-type": "application/json" });
    const malformedPromptBody = await malformedPrompt.json() as any;
    const hugePrompt = await runtimeRaw(secure, "POST", "/api/agents/coo/prompt", "{}", "hostile-secret", {
      "content-type": "application/json",
      "content-length": "999999999",
    });
    const hugePromptBody = await hugePrompt.json() as any;
    const hostileTick = await runtimeJson(secure, "POST", "/api/scheduler/tick", { profiles: ["../auth-profiles"], now: Date.now() }, "hostile-secret");
    const unauthenticatedApply = await runtimeJson(insecure, "POST", "/api/fleet/apply", { plan: { agents: [] } }, "ignored-token");

    expect(traversal, "Profile path traversal in route segments must fail before any profile file can be read.").toMatchObject({ status: 400, body: { error: "invalid_profile" } });
    expect(filteredTraversal, "Profile path traversal in filters must fail before runtime contracts are resolved.").toMatchObject({ status: 400, body: { error: "invalid_profile" } });
    expect(malformedPrompt.status, "Malformed JSON should fail as a client error before prompt execution.").toBe(400);
    expect(malformedPromptBody.error, "Malformed JSON must have a stable error code.").toBe("malformed_json");
    expect(hugePrompt.status, "Hostile content-length should be rejected before body parsing or prompt execution.").toBe(413);
    expect(hugePromptBody.error, "Oversized bodies must have a stable error code.").toBe("body_too_large");
    expect(hostileTick, "Scheduler profile traversal should fail before claiming any work.").toMatchObject({ status: 400, body: { error: "invalid_profile" } });
    expect(unauthenticatedApply, "Fleet apply mutates local profiles and must fail closed without configured write auth.").toMatchObject({ status: 401, body: { error: "write_auth_required" } });
  });

  test("WebhookIngress_WhenSignatureIsWrong_DoesNotPersistReceivedEvent", async () => {
    const previous = process.env.US_WEBHOOK_SECRET;
    process.env.US_WEBHOOK_SECRET = "hostile-webhook-secret";
    const handler = runtime.createRuntimeFetchHandler({ cwd: workdir, authToken: "hostile-secret" });
    const body = JSON.stringify({ actor: "coo", subject: "hostile-webhook" });

    try {
      const invalid = await runtimeRaw(handler, "POST", "/api/webhooks/githubhostile", body, "hostile-secret", {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=not-the-signature",
      });
      const invalidBody = await invalid.json() as any;
      const events = await core.queryEvents({ type: "webhook.received", resource: "webhook:githubhostile", limit: 100 });

      expect(invalid.status, "Invalid webhook signatures must fail before audit success events are written.").toBe(401);
      expect(invalidBody.error, "Invalid webhook signatures need a stable error code for integrations.").toBe("webhook_signature_invalid");
      expect(events, "Rejected webhooks must not be recorded as received webhook events.").toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.US_WEBHOOK_SECRET;
      else process.env.US_WEBHOOK_SECRET = previous;
    }
  });
});

async function runtimeJson(
  handler: RuntimeFetchHandler,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: any }> {
  const response = await runtimeRaw(handler, method, path, body === undefined ? undefined : JSON.stringify(body), token, body === undefined ? {} : { "content-type": "application/json" });
  return { status: response.status, body: await response.json() };
}

async function runtimeRaw(
  handler: RuntimeFetchHandler,
  method: string,
  path: string,
  body?: string,
  token?: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handler(new Request(`http://runtime.test${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body }),
  }));
}

type RuntimeFetchHandler = (request: Request) => Promise<Response>;
