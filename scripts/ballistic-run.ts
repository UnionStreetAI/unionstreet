#!/usr/bin/env bun
import { createHmac } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = process.cwd();
const usHome = await mkdtemp(join(tmpdir(), "union-street-ballistic-"));
const workdir = await mkdtemp(join(tmpdir(), "union-street-ballistic-work-"));
const token = "ballistic-runtime-token";
const webhookSecret = "ballistic-webhook-secret";
const canary = "BALLISTIC_SECRET_DO_NOT_LEAK";

try {
  process.env.US_HOME = usHome;
  process.env.US_PEER_CALL_STUB = "1";
  process.env.US_STREAM_MODEL_STUB = "1";
  process.env.US_MEMORY_SYNC = "0";
  process.env.US_USAGE_DISABLE_MODELS_DEV_COSTS = "1";
  process.env.US_WEBHOOK_SECRET = webhookSecret;

  await run(["bun", "run", "packages/us-cli/src/index.ts", "federation", "demo-org", "--profiles", "--mcp"]);

  const core = await import("../packages/server/src/index.ts");
  const runtime = await import("../packages/server/src/http/index.ts");
  const handler = runtime.createRuntimeFetchHandler({ cwd: workdir, authToken: token });
  const trace = core.createLashTrace();

  await seedSecrets(core);
  await poisonAppendOnlyLogs(core);

  await concurrentRuntimeFire(handler, core, trace);
  await concurrentPromptAndPeerFire(core, trace);
  await assertIdempotency(handler);
  await assertSystemStillCoherent(handler, core, trace);
  await assertNoSecretLeaks(core);

  console.log("ballistic run passed");
} finally {
  delete process.env.US_WEBHOOK_SECRET;
  await rm(usHome, { recursive: true, force: true });
  await rm(workdir, { recursive: true, force: true });
}

async function seedSecrets(core: typeof import("../packages/server/src/index.ts")): Promise<void> {
  await writeFile(core.GLOBAL_AUTH_PROFILES_PATH, JSON.stringify({
    providers: {
      codex: {
        kind: "api_key",
        api_key: canary,
        accounting: { mode: "free" },
      },
    },
    mcp: {},
  }, null, 2), { mode: 0o600 });
  await core.writeEvent({
    type: "audit.test",
    actor: "coo",
    outcome: "success",
    reason: `authorization=Bearer ${canary}`,
    payload: {
      api_key: canary,
      nested: { accessToken: canary },
    },
  });
}

async function poisonAppendOnlyLogs(core: typeof import("../packages/server/src/index.ts")): Promise<void> {
  await mkdir(dirname(core.EVENTS_PATH), { recursive: true });
  await mkdir(dirname(core.USAGE_PATH), { recursive: true });
  await mkdir(core.profilePaths("coo").memoryDir, { recursive: true });
  await appendFile(core.EVENTS_PATH, "{ this is not json\n", { mode: 0o600 });
  await appendFile(core.USAGE_PATH, "{ this is not json\n", { mode: 0o600 });
  const memoryPath = join(core.profilePaths("coo").memoryDir, "events.jsonl");
  await appendFile(memoryPath, "{ this is not json\n", { mode: 0o600 });
}

async function concurrentRuntimeFire(
  handler: RuntimeFetchHandler,
  core: typeof import("../packages/server/src/index.ts"),
  trace: string,
): Promise<void> {
  const signedBody = JSON.stringify({ actor: "coo", subject: "ballistic", canary });
  const signed = createHmac("sha256", webhookSecret).update(signedBody).digest("hex");
  const cases: Array<() => Promise<Response>> = [
    () => runtimeRaw(handler, "GET", "/health"),
    () => runtimeRaw(handler, "GET", "/api/runtime", undefined, token),
    () => runtimeRaw(handler, "GET", "/api/agents", undefined, token),
    () => runtimeRaw(handler, "GET", "/api/runtimes", undefined, token),
    () => runtimeRaw(handler, "GET", "/api/events?limit=50", undefined, token),
    () => runtimeRaw(handler, "GET", "/api/usage?limit=50", undefined, token),
    () => runtimeRaw(handler, "GET", "/api/memory?limit=50", undefined, token),
    () => runtimeRaw(handler, "GET", "/api/agents/%2E%2E%2Fauth-profiles", undefined, token),
    () => runtimeRaw(handler, "GET", "/api/agents", undefined, `${token} extra`),
    () => runtimeRaw(handler, "POST", "/api/agents/coo/prompt", "{ nope", token, { "content-type": "application/json" }),
    () => runtimeRaw(handler, "POST", "/api/agents/coo/prompt", "{}", token, { "content-type": "application/json", "content-length": "999999999" }),
    () => runtimeRaw(handler, "POST", "/api/scheduler/tick", JSON.stringify({ profiles: ["../auth-profiles"], now: Date.now() }), token, { "content-type": "application/json" }),
    () => runtimeRaw(handler, "POST", "/api/fleet/validate", JSON.stringify(hostileFleetPlan()), token, { "content-type": "application/json" }),
    () => runtimeRaw(handler, "POST", "/api/webhooks/github", signedBody, token, { "content-type": "application/json", "x-hub-signature-256": "sha256=nope" }),
    () => runtimeRaw(handler, "POST", "/api/webhooks/github", signedBody, token, { "content-type": "application/json", "x-hub-signature-256": `sha256=${signed}` }),
    () => runtimeRaw(handler, "POST", "/api/peers/vp-eng/wake", JSON.stringify({
      caller: "coo",
      message: "Ballistic peer wake must survive hostile API traffic.",
      trace,
      wakeKind: "delegate",
      thread: core.createLashThread("vp-eng", trace),
    }), token, { "content-type": "application/json" }),
  ];

  const started = Date.now();
  const responses = await Promise.all(Array.from({ length: 320 }, (_, index) => cases[index % cases.length]!()));
  const buckets = countStatuses(responses);
  assert((buckets.get(500) ?? 0) === 0, `ballistic runtime fire produced 500s: ${formatBuckets(buckets)}`);
  assert((buckets.get(401) ?? 0) > 0, "ballistic runtime fire should include rejected unauthorized/forged requests");
  assert((buckets.get(400) ?? 0) > 0, "ballistic runtime fire should include rejected malformed/traversal requests");
  assert((buckets.get(413) ?? 0) > 0, "ballistic runtime fire should include rejected oversized requests");
  assert((buckets.get(200) ?? 0) > 0, "ballistic runtime fire should keep valid reads alive");
  console.log(`ballistic runtime fire: 320 mixed requests in ${Date.now() - started}ms (${formatBuckets(buckets)})`);
}

async function concurrentPromptAndPeerFire(
  core: typeof import("../packages/server/src/index.ts"),
  trace: string,
): Promise<void> {
  const tasks = [
    ...Array.from({ length: 15 }, (_, index) => core.runAgentPrompt({
      profile: "coo",
      prompt: `ballistic prompt ${index}: use ls tool and preserve trace`,
      trace,
      sessionId: `ballistic-prompt-${index}`,
    })),
    ...Array.from({ length: 15 }, (_, index) => core.peerCall({
      callingPeer: "coo",
      targetPeer: "vp-eng",
      message: `ballistic delegate ${index}`,
      trace,
      wakeKind: "delegate",
    })),
    core.peerCall({
      callingPeer: "vp-eng",
      targetPeer: "vp-ops",
      message: "lateral ballistic denial",
      trace,
      wakeKind: "delegate",
    }),
  ];
  const settled = await Promise.allSettled(tasks);
  const rejected = settled.filter((result) => result.status === "rejected");
  const denied = settled.filter((result) => result.status === "fulfilled" && "ok" in result.value && result.value.ok === false);
  assert(rejected.length === 0, `concurrent prompt/peer fire threw ${rejected.length} errors`);
  assert(denied.length === 1, "exactly one lateral peer call should be denied without throwing");
}

async function assertIdempotency(handler: RuntimeFetchHandler): Promise<void> {
  const now = Date.UTC(2026, 3, 27, 9, 45);
  const payload = { now, profiles: ["dir-eng-product"] };
  const responses = await Promise.all(Array.from({ length: 10 }, () =>
    runtimeJson(handler, "POST", "/api/scheduler/tick", payload, token),
  ));
  const claimed = responses.flatMap((response) => response.body.runs ?? []);
  const uniqueRunIds = new Set(claimed.map((run: any) => run.id));
  assert(responses.every((response) => response.status === 200), "scheduler idempotency volley should not produce non-200 responses");
  assert(uniqueRunIds.size <= 2, `scheduler idempotency volley claimed too many unique due jobs: ${uniqueRunIds.size}`);
}

async function assertSystemStillCoherent(
  handler: RuntimeFetchHandler,
  core: typeof import("../packages/server/src/index.ts"),
  trace: string,
): Promise<void> {
  const runtimeInfo = await runtimeJson(handler, "GET", "/api/runtime", undefined, token);
  const agents = await runtimeJson(handler, "GET", "/api/agents", undefined, token);
  const events = await runtimeJson(handler, "GET", `/api/events?trace=${trace}&limit=1000`, undefined, token);
  const usage = await runtimeJson(handler, "GET", `/api/usage?trace=${trace}&limit=1000`, undefined, token);
  const memory = await runtimeJson(handler, "GET", `/api/memory?profile=vp-eng&trace=${trace}&limit=1000`, undefined, token);
  const readEvents = await core.queryEvents({ limit: 10_000 });
  const readUsage = await core.queryUsageRecords({ limit: 10_000 });

  assert(runtimeInfo.status === 200 && runtimeInfo.body.profiles === 40, "runtime profile count should survive ballistic fire");
  assert(agents.status === 200 && agents.body.agents.length === 40, "agent snapshots should survive ballistic fire");
  assert(events.status === 200 && events.body.events.length > 0, "trace events should survive ballistic fire");
  assert(usage.status === 200 && usage.body.summary.calls > 0, "trace usage should survive ballistic fire");
  assert(memory.status === 200 && memory.body.memory.length > 0, "trace memory should survive ballistic fire");
  assert(readEvents.length > 0, "event log should remain readable after corrupt-line injection");
  assert(readUsage.length > 0, "usage log should remain readable after corrupt-line injection");
}

async function assertNoSecretLeaks(core: typeof import("../packages/server/src/index.ts")): Promise<void> {
  const files = [
    core.EVENTS_PATH,
    core.USAGE_PATH,
    join(core.profilePaths("coo").memoryDir, "events.jsonl"),
    join(core.profilePaths("vp-eng").memoryDir, "events.jsonl"),
  ];
  for (const file of files) {
    let raw = "";
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    assert(!raw.includes(canary), `${file} leaked ballistic canary secret`);
  }
}

async function runtimeJson(
  handler: RuntimeFetchHandler,
  method: string,
  path: string,
  body?: unknown,
  bearer = token,
): Promise<{ status: number; body: any }> {
  const response = await runtimeRaw(handler, method, path, body === undefined ? undefined : JSON.stringify(body), bearer, body === undefined ? {} : { "content-type": "application/json" });
  return { status: response.status, body: await response.json() };
}

async function runtimeRaw(
  handler: RuntimeFetchHandler,
  method: string,
  path: string,
  body?: string,
  bearer?: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handler(new Request(`http://runtime.test${path}`, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body }),
  }));
}

function hostileFleetPlan(): Record<string, unknown> {
  return {
    plan: {
      version: 1,
      kind: "union-street.fleet-plan",
      name: "ballistic-invalid",
      mission: "invalid",
      root: "cycle-a",
      generatedBy: "coo",
      agents: [
        { id: "cycle-a", displayName: "Cycle A", title: "A", manager: "cycle-b", groups: ["x"], roles: ["agent"], soul: "a", model: { provider: "codex", id: "gpt-5.4" } },
        { id: "cycle-b", displayName: "Cycle B", title: "B", manager: "cycle-a", groups: ["x"], roles: ["agent"], soul: "b", model: { provider: "codex", id: "gpt-5.4" } },
      ],
    },
  };
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd: repoRoot,
    env: process.env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    throw new Error(`${cmd.join(" ")} exited ${code}`);
  }
}

function countStatuses(responses: Response[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const response of responses) out.set(response.status, (out.get(response.status) ?? 0) + 1);
  return out;
}

function formatBuckets(buckets: Map<number, number>): string {
  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([status, count]) => `${status}:${count}`).join(", ");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type RuntimeFetchHandler = (request: Request) => Promise<Response>;
