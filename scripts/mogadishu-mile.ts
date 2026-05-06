#!/usr/bin/env bun
import { createHmac } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = process.cwd();
const usHome = await mkdtemp(join(tmpdir(), "union-street-mogadishu-mile-"));
const workdir = await mkdtemp(join(tmpdir(), "union-street-mogadishu-mile-work-"));
const token = "mogadishu-mile-runtime-token";
const webhookSecret = "mogadishu-mile-webhook-secret";
const canary = "MOGADISHU_MILE_SECRET_DO_NOT_LEAK";
const runtimeVolleySize = 640;
const realHttpVolleySize = 192;
const fuzzVolleySize = 240;
const missionPrompt = [
  "MOGADISHU MILE FULL-ORG INCIDENT RUN.",
  "The head agent is moving a release convoy through a broken enterprise deployment while the control plane is under active attack.",
  "You must invoke the org, preserve the trace, keep work progressing, and return decision-ready evidence from engineering, operations, GTM, finance, support, infra, runtime, plugin, memory, scheduler, event, and usage surfaces.",
  "Every agent must answer with: assigned scope, observed evidence, blockers, risk, confidence, and next action.",
  "Do not leak credentials. Do not invent cloud success. Do not skip chain-of-command boundaries. Do not collapse partial failures into success.",
].join("\n");

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

  await assertProgressCheckpoint(handler, core, trace, "initial");
  await Promise.all([
    corruptLogsUnderFire(core),
    concurrentRuntimeFire(handler, core, trace),
    seededFuzzFire(handler),
    runFullOrgMission(core, trace),
  ]);
  await realHttpRuntimeFire(runtime, workdir);
  await fullOrgSchedulerExecution(handler, core);
  await assertIdempotency(handler);
  await assertSystemStillCoherent(handler, core, trace);
  await assertNoSecretLeaks(core);

  console.log("mogadishu mile passed");
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

async function corruptLogsUnderFire(core: typeof import("../packages/server/src/index.ts")): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    await Promise.all([
      appendFile(core.EVENTS_PATH, `{ mid-fire event corruption ${index}\n`),
      appendFile(core.USAGE_PATH, `{ mid-fire usage corruption ${index}\n`),
      appendFile(join(core.profilePaths("vp-eng").memoryDir, "events.jsonl"), `{ mid-fire memory corruption ${index}\n`),
    ]);
    await Bun.sleep(5);
  }
}

async function concurrentRuntimeFire(
  handler: RuntimeFetchHandler,
  core: typeof import("../packages/server/src/index.ts"),
  trace: string,
): Promise<void> {
  const signedBody = JSON.stringify({ actor: "coo", subject: "Mogadishu Mile", canary });
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
      message: "Mogadishu Mile peer wake must survive hostile API traffic.",
      trace,
      wakeKind: "delegate",
      thread: core.createLashThread("vp-eng", trace),
    }), token, { "content-type": "application/json" }),
  ];

  const started = Date.now();
  const responses = await Promise.all(Array.from({ length: runtimeVolleySize }, (_, index) => cases[index % cases.length]!()));
  const buckets = countStatuses(responses);
  assertExactBuckets(buckets, new Map([
    [200, 320],
    [202, 80],
    [400, 120],
    [401, 80],
    [413, 40],
  ]), "handler runtime fire");
  console.log(`mogadishu mile handler fire: ${runtimeVolleySize} mixed requests in ${Date.now() - started}ms (${formatBuckets(buckets)})`);
}

async function realHttpRuntimeFire(
  runtime: typeof import("../packages/server/src/http/index.ts"),
  cwd: string,
): Promise<void> {
  const server = runtime.startRuntimeServer({ cwd, authToken: token, hostname: "127.0.0.1", port: 0 });
  try {
    await waitForHttpServer(server.url);
    const tooLargeBody = JSON.stringify({ prompt: "x".repeat(1_000_001) });
    const cases: Array<() => Promise<Response>> = [
      () => fetch(`${server.url}/health`),
      () => fetch(`${server.url}/api/runtime`, { headers: bearer(token) }),
      () => fetch(`${server.url}/api/agents`, { headers: bearer(token) }),
      () => fetch(`${server.url}/api/agents`, { headers: bearer(`${token} smuggled`) }),
      () => fetch(`${server.url}/api/agents/%2E%2E%2Fauth-profiles`, { headers: bearer(token) }),
      () => fetch(`${server.url}/api/agents/coo/prompt`, { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: "{ nope" }),
      () => fetch(`${server.url}/api/agents/coo/prompt`, { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: tooLargeBody }),
      () => fetch(`${server.url}/api/peers/vp-eng/wake`, { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify({ caller: "coo", message: "real listener must advance", trace: "mogadishu-real-http", wakeKind: "delegate" }) }),
    ];
    const started = Date.now();
    const responses = await runInBatches(
      Array.from({ length: realHttpVolleySize }, (_, index) => () => fetchNoThrow(cases[index % cases.length]!)),
      32,
    );
    const buckets = countStatuses(responses);
    assertExactBuckets(buckets, new Map([
      [200, 72],
      [202, 24],
      [400, 48],
      [401, 24],
      [413, 24],
    ]), "real HTTP runtime fire");
    console.log(`mogadishu mile real http fire: ${realHttpVolleySize} requests in ${Date.now() - started}ms (${formatBuckets(buckets)})`);
  } finally {
    server.stop();
  }
}

async function waitForHttpServer(url: string): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.status === 200) return;
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await Bun.sleep(20);
  }
  throw new Error(`real HTTP runtime did not become ready: ${lastError}`);
}

async function fetchNoThrow(fetcher: () => Promise<Response>): Promise<Response> {
  try {
    return await fetcher();
  } catch (error) {
    return new Response(JSON.stringify({ error: "network_error", message: (error as Error).message }), { status: 599 });
  }
}

async function runInBatches<T>(tasks: Array<() => Promise<T>>, size: number): Promise<T[]> {
  const out: T[] = [];
  for (let index = 0; index < tasks.length; index += size) {
    out.push(...await Promise.all(tasks.slice(index, index + size).map((task) => task())));
  }
  return out;
}

async function seededFuzzFire(handler: RuntimeFetchHandler): Promise<void> {
  const random = mulberry32(0x4d4f4741);
  const profiles = ["coo", "vp-eng", "../auth-profiles", "%2E%2E%2Fauth-profiles", "", "vp-eng%00", "dir-eng-product"];
  const paths = [
    () => `/api/agents/${pick(profiles, random)}`,
    () => `/api/scheduler/jobs?profile=${encodeURIComponent(pick(profiles, random))}`,
    () => `/api/events?limit=${Math.floor(random() * 1_000_000)}`,
    () => `/api/usage?trace=${encodeURIComponent(`trace-${Math.floor(random() * 100)}`)}`,
    () => `/api/memory?profile=${encodeURIComponent(pick(profiles, random))}&limit=${Math.floor(random() * 500)}`,
    () => `/api/webhooks/${encodeURIComponent(pick(["github", "../github", "stripe", "gitlab"], random))}`,
    () => `/api/not-a-route/${Math.floor(random() * 10_000)}`,
  ];
  const bodies = ["", "{", "[]", "null", JSON.stringify({ prompt: canary }), JSON.stringify({ profiles: ["../auth-profiles"] })];
  const methods = ["GET", "POST", "PUT", "DELETE"];
  const started = Date.now();
  const responses = await Promise.all(Array.from({ length: fuzzVolleySize }, () => {
    const method = pick(methods, random);
    const body = method === "GET" ? undefined : pick(bodies, random);
    const auth = random() < 0.72 ? token : random() < 0.5 ? `${token} injected` : undefined;
    const headers = body === undefined ? {} : { "content-type": random() < 0.5 ? "application/json" : "text/plain" };
    return runtimeRaw(handler, method, pick(paths, random)(), body, auth, headers);
  }));
  const buckets = countStatuses(responses);
  const allowed = new Set([200, 202, 400, 401, 404, 405, 413, 422]);
  for (const response of responses) assert(allowed.has(response.status), `seeded fuzz returned unexpected status ${response.status}`);
  assert((buckets.get(500) ?? 0) === 0, `seeded fuzz produced 500s: ${formatBuckets(buckets)}`);
  assert((buckets.get(401) ?? 0) >= 30, `seeded fuzz should deny many auth mutations: ${formatBuckets(buckets)}`);
  assert((buckets.get(400) ?? 0) + (buckets.get(404) ?? 0) + (buckets.get(405) ?? 0) >= 80, `seeded fuzz should reject many malformed routes/bodies: ${formatBuckets(buckets)}`);
  console.log(`mogadishu mile seeded fuzz: ${fuzzVolleySize} requests in ${Date.now() - started}ms (${formatBuckets(buckets)})`);
}

async function concurrentPromptAndPeerFire(
  core: typeof import("../packages/server/src/index.ts"),
  trace: string,
): Promise<void> {
  const tasks = [
    ...Array.from({ length: 15 }, (_, index) => core.runAgentPrompt({
      profile: "coo",
      prompt: `mogadishu mile prompt ${index}: use ls tool and preserve trace`,
      trace,
      sessionId: `mogadishu-mile-prompt-${index}`,
    })),
    ...Array.from({ length: 15 }, (_, index) => core.peerCall({
      callingPeer: "coo",
      targetPeer: "vp-eng",
      message: `mogadishu mile delegate ${index}`,
      trace,
      wakeKind: "delegate",
    })),
    core.peerCall({
      callingPeer: "vp-eng",
      targetPeer: "vp-ops",
      message: "lateral mogadishu mile denial",
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

async function runFullOrgMission(
  core: typeof import("../packages/server/src/index.ts"),
  trace: string,
): Promise<void> {
  const { org } = core.buildDemoFederationConfig();
  const allAgents = org.map((node) => node.id).sort();
  const children = childrenByManager(org);
  const parent = parentByAgent(org);
  const touched = new Set<string>();
  const delegatedEdges: string[] = [];
  const reportedEdges: string[] = [];

  const head = await core.runAgentPrompt({
    profile: "coo",
    prompt: [
      missionPrompt,
      "",
      "You are @coo, the head agent. Start the incident run, name the expected delegation tree, and set the operating constraints before reports flow back.",
    ].join("\n"),
    trace,
    sessionId: "mogadishu-mile-head-mission",
  });
  touched.add("coo");
  assert(head.text.trim().length > 0, "head mission prompt should produce assistant text");
  assert(head.usage.total > 0, "head mission prompt should write nonzero usage");

  for (const from of breadthFirstManagers(children, "coo")) {
    for (const to of children.get(from) ?? []) {
      await callLash(core, {
        method: "delegate",
        from,
        to,
        trace,
        prompt: [
          missionPrompt,
          "",
          `@${from} is delegating your slice to @${to} while runtime attacks continue.`,
          "Return only your scoped evidence, blockers, risk, confidence, and next action.",
        ].join("\n"),
      });
      touched.add(to);
      delegatedEdges.push(`${from}->${to}`);
    }
  }

  for (const from of [...allAgents].sort((a, b) => depthOf(b, parent) - depthOf(a, parent))) {
    const to = parent.get(from);
    if (!to) continue;
    await callLash(core, {
      method: "report",
      from,
      to,
      trace,
      prompt: [
        missionPrompt,
        "",
        `@${from} is reporting back to direct manager @${to}.`,
        "Summarize what survived, what broke, and what the manager must escalate.",
      ].join("\n"),
    });
    reportedEdges.push(`${from}->${to}`);
  }

  await concurrentPromptAndPeerFire(core, trace);

  const missing = allAgents.filter((agent) => !touched.has(agent));
  assert(missing.length === 0, `full-org mission did not touch every agent; missing: ${missing.join(", ")}`);

  const events = await core.queryEvents({ trace, limit: 10_000 });
  const usage = await core.queryUsageRecords({ trace, limit: 10_000 });
  const lashCalls = events.filter((event: any) => event.type === "lash.call");
  const lashAllows = events.filter((event: any) => event.type === "lash.allow");
  const callKeys = new Set(lashCalls.map(edgeKey));
  const allowKeys = new Set(lashAllows.map(edgeKey));
  assert(lashCalls.length >= delegatedEdges.length + reportedEdges.length, `full-org mission expected Lash calls for every edge, got ${lashCalls.length}`);
  assert(lashAllows.length >= delegatedEdges.length + reportedEdges.length, `full-org mission expected Lash allow events for every edge, got ${lashAllows.length}`);
  for (const edge of delegatedEdges) {
    assert(callKeys.has(`delegate:${edge}`), `missing delegate lash.call edge ${edge}`);
    assert(allowKeys.has(`delegate:${edge}`), `missing delegate lash.allow edge ${edge}`);
  }
  for (const edge of reportedEdges) {
    assert(callKeys.has(`report:${edge}`), `missing report lash.call edge ${edge}`);
    assert(allowKeys.has(`report:${edge}`), `missing report lash.allow edge ${edge}`);
  }
  assert(allAgents.every((agent) => usage.some((record: any) => record.actor === agent)), "full-org mission should write usage for every agent");
  for (const agent of allAgents) {
    assert(await directoryHasJsonl(join(usHome, "profiles", agent, "sessions")), `@${agent} should persist a session during full-org mission`);
    const memory = await core.queryMemoryEvents({ peer: agent, trace, limit: 100 });
    assert(memory.length > 0, `@${agent} should persist trace-scoped memory during full-org mission`);
  }
  console.log(`mogadishu mile mission: head prompt + ${delegatedEdges.length} delegations + ${reportedEdges.length} reports touched ${touched.size}/${allAgents.length} agents`);
}

async function callLash(
  core: typeof import("../packages/server/src/index.ts"),
  input: { method: "delegate" | "report"; from: string; to: string; trace: string; prompt: string },
): Promise<void> {
  const result = await core.callLashPeerTool({
    targetPeer: input.to,
    method: input.method,
    arguments: {
      from: input.from,
      prompt: input.prompt,
      trace: input.trace,
      thread: core.createLashThread(input.to, input.trace),
    },
  });
  const structured = result.structuredContent as { kind?: string; error?: { message?: string } } | undefined;
  if (structured?.kind === "error") {
    throw new Error(`${input.method} ${input.from}->${input.to} failed: ${structured.error?.message ?? "unknown Lash error"}`);
  }
}

async function fullOrgSchedulerExecution(
  handler: RuntimeFetchHandler,
  core: typeof import("../packages/server/src/index.ts"),
): Promise<void> {
  const beforeUsage = (await core.queryUsageRecords({ limit: 50_000 })).length;
  const now = Date.UTC(2026, 3, 27, 9, 15);
  const response = await runtimeJson(handler, "POST", "/api/scheduler/tick", { now, execute: true }, token);
  assert(response.status === 200, `full-org scheduler execution should return 200, got ${response.status}`);
  const completed = (response.body.runs ?? []).filter((run: any) => run.status === "complete");
  assert(completed.length === 80, `full-org scheduler execution should complete 80 runs, completed ${completed.length}`);
  assert(completed.every((run: any) => run.trace?.startsWith("scheduler:") && run.sessionId), "every scheduler run should preserve trace and session id");
  assert(completed.every((run: any) => run.result?.usage?.total > 0), "every scheduler run should carry usage from the prompt runner");
  const afterUsage = (await core.queryUsageRecords({ limit: 50_000 })).length;
  assert(afterUsage >= beforeUsage + 80, `scheduler execution should append at least 80 usage records, before=${beforeUsage} after=${afterUsage}`);
}

async function assertIdempotency(handler: RuntimeFetchHandler): Promise<void> {
  const now = Date.UTC(2026, 3, 27, 9, 45);
  const payload = { now, profiles: ["dir-eng-product"] };
  const due = await runtimeJson(handler, "GET", `/api/scheduler/due?profile=dir-eng-product&now=${now}`, undefined, token);
  assert(due.status === 200, `scheduler due preflight should return 200, got ${due.status}`);
  const expectedDueKeys = new Set((due.body.due ?? []).map((job: any) => `${job.id}:${job.dueAt}`));
  assert(expectedDueKeys.size > 0, "scheduler idempotency preflight should find due work to claim");
  const responses = await Promise.all(Array.from({ length: 10 }, () =>
    runtimeJson(handler, "POST", "/api/scheduler/tick", payload, token),
  ));
  const claimed = responses.flatMap((response) => response.body.runs ?? []);
  const uniqueRunIds = new Set(claimed.map((run: any) => run.id));
  const uniqueDueKeys = new Set(claimed.map((run: any) => `${run.jobId}:${run.dueAt}`));
  assert(responses.every((response) => response.status === 200), "scheduler idempotency volley should not produce non-200 responses");
  assert(uniqueRunIds.size === claimed.length, "scheduler idempotency volley should not return the same run id twice");
  assert(uniqueDueKeys.size === expectedDueKeys.size, `scheduler idempotency volley should claim exactly preflight due jobs once each, expected ${expectedDueKeys.size}, got ${uniqueDueKeys.size}`);
  for (const dueKey of uniqueDueKeys) assert(expectedDueKeys.has(dueKey), `scheduler idempotency volley claimed unexpected due key ${dueKey}`);
}

async function assertProgressCheckpoint(
  handler: RuntimeFetchHandler,
  core: typeof import("../packages/server/src/index.ts"),
  trace: string,
  label: string,
): Promise<void> {
  const runtimeInfo = await runtimeJson(handler, "GET", "/api/runtime", undefined, token);
  const agents = await runtimeJson(handler, "GET", "/api/agents", undefined, token);
  const events = await core.queryEvents({ limit: 10_000 });
  assert(runtimeInfo.status === 200 && runtimeInfo.body.profiles === 40, `${label} checkpoint should see 40 profiles`);
  assert(agents.status === 200 && agents.body.agents.length === 40, `${label} checkpoint should see 40 agent snapshots`);
  assert(events.some((event: any) => event.trace === trace || event.type === "audit.test"), `${label} checkpoint should see traceable audit progress`);
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
  const schedulerRuns = await runtimeJson(handler, "GET", "/api/scheduler/runs?limit=1000", undefined, token);
  const readEvents = await core.queryEvents({ limit: 10_000 });
  const readUsage = await core.queryUsageRecords({ limit: 10_000 });

  assert(runtimeInfo.status === 200 && runtimeInfo.body.profiles === 40, "runtime profile count should survive Mogadishu Mile fire");
  assert(agents.status === 200 && agents.body.agents.length === 40, "agent snapshots should survive Mogadishu Mile fire");
  assert(events.status === 200 && events.body.events.length > 0, "trace events should survive Mogadishu Mile fire");
  assert(usage.status === 200 && usage.body.summary.calls > 0, "trace usage should survive Mogadishu Mile fire");
  assert(memory.status === 200 && memory.body.memory.length > 0, "trace memory should survive Mogadishu Mile fire");
  assert(schedulerRuns.status === 200 && schedulerRuns.body.runs.some((run: any) => run.status === "complete"), "completed scheduler runs should remain readable after Mogadishu Mile fire");
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
    assert(!raw.includes(canary), `${file} leaked mogadishu mile canary secret`);
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
      name: "mogadishu-mile-invalid",
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

function childrenByManager(org: Array<{ id: string; manager?: string }>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const node of org) {
    if (!node.manager) continue;
    const children = out.get(node.manager) ?? [];
    children.push(node.id);
    out.set(node.manager, children);
  }
  for (const children of out.values()) children.sort();
  return out;
}

function parentByAgent(org: Array<{ id: string; manager?: string }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of org) {
    if (node.manager) out.set(node.id, node.manager);
  }
  return out;
}

function breadthFirstManagers(children: Map<string, string[]>, root: string): string[] {
  const out: string[] = [];
  const queue = [root];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    out.push(current);
    queue.push(...(children.get(current) ?? []));
  }
  return out;
}

function depthOf(agent: string, parent: Map<string, string>): number {
  let depth = 0;
  let current = agent;
  while (parent.has(current)) {
    depth += 1;
    current = parent.get(current)!;
  }
  return depth;
}

function edgeKey(event: { actor?: string; target?: string; payload?: unknown }): string {
  const payload = event.payload as { method?: string; from?: string; target?: string } | undefined;
  return `${payload?.method}:${payload?.from ?? event.actor}->${payload?.target ?? event.target}`;
}

async function directoryHasJsonl(path: string): Promise<boolean> {
  try {
    const files = (await readdir(path)).filter((file) => file.endsWith(".jsonl")).sort();
    if (!files.length) return false;
    const sample = await readFile(join(path, files[0]!), "utf8");
    return sample.trim().length > 0;
  } catch {
    return false;
  }
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

function assertExactBuckets(actual: Map<number, number>, expected: Map<number, number>, label: string): void {
  const actualKeys = [...actual.keys()].sort((a, b) => a - b);
  const expectedKeys = [...expected.keys()].sort((a, b) => a - b);
  assert(JSON.stringify(actualKeys) === JSON.stringify(expectedKeys), `${label} status keys changed: expected ${formatBuckets(expected)}, got ${formatBuckets(actual)}`);
  for (const [status, count] of expected) {
    assert(actual.get(status) === count, `${label} status ${status} changed: expected ${count}, got ${actual.get(status) ?? 0}; all ${formatBuckets(actual)}`);
  }
}

function formatBuckets(buckets: Map<number, number>): string {
  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([status, count]) => `${status}:${count}`).join(", ");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function bearer(value: string): Record<string, string> {
  return { authorization: `Bearer ${value}` };
}

function pick<T>(items: T[], random: () => number): T {
  return items[Math.floor(random() * items.length) % items.length]!;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

type RuntimeFetchHandler = (request: Request) => Promise<Response>;
