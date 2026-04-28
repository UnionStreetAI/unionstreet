import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const usHome = await mkdtemp(join(tmpdir(), "union-street-runtime-test-"));
const workdir = await mkdtemp(join(tmpdir(), "union-street-runtime-work-"));
process.env.US_HOME = usHome;
process.env.HOME = workdir;
process.env.US_MEMORY_SYNC = "0";
process.env.US_PEER_CALL_STUB = "1";
process.env.US_STREAM_MODEL_STUB = "1";
process.env.US_USAGE_DISABLE_MODELS_DEV_COSTS = "1";

const core = await import("@unionstreet/us-core");
const runtime = await import("./index.ts");
const demo = core.buildDemoFederationConfig();
const demoProfiles = demo.org.map((node) => node.id);

let fetchHandler!: ReturnType<typeof runtime.createRuntimeFetchHandler>;

beforeAll(async () => {
  await writeFile(core.FEDERATION_PATH, JSON.stringify(demo.config, null, 2));
  const packsById = new Map(core.buildDemoAgentPacks(demo.org).map((pack) => [pack.id, pack]));
  for (const node of demo.org) {
    await core.initProfile(node.id, { role: node.roles[0] ?? "agent", capabilities: node.roles });
    const pack = packsById.get(node.id);
    if (pack) await core.writeAgentPack(node.id, pack);
  }
  await writeFile(
    join(workdir, ".mcp.json"),
    JSON.stringify({
      mcp: {
        github: { type: "remote", url: "https://mcp.example.com/github", enabled: true, oauth: true },
        linear: { type: "remote", url: "https://mcp.example.com/linear", enabled: true, oauth: true },
      },
    }),
  );
  fetchHandler = runtime.createRuntimeFetchHandler({ cwd: workdir });
});

afterAll(async () => {
  await rm(usHome, { recursive: true, force: true });
  await rm(workdir, { recursive: true, force: true });
});

test("GETHealth_WhenRuntimeIsConfigured_ReturnsLiveHeadNodeMetadata", async () => {
  const healthRoute = "/health";

  const { response, body } = await fetchJson(healthRoute);

  expectStatus(response, 200, "health route should be available before auth so local TUI/dashboard startup can probe the head node");
  expect(body.ok, "Health responses must expose ok=true for process supervisors and browser dashboards.").toBe(true);
  expect(body.version, "Health responses must report the runtime package version for operator diagnostics.").toBe(runtime.VERSION);
  expect(typeof body.runtimeId, "Health responses must identify the running head-node instance, not just package metadata.").toBe("string");
  expect(typeof body.uptimeMs, "Health responses must expose runtime uptime so clients can distinguish live process state from static fixtures.").toBe("number");
  expect(body.usHome, "Health responses must identify the active US_HOME so tests and operators can detect accidental fixture state.").toBe(usHome);
  expect(typeof body.ts, "Health responses must include a numeric timestamp so clients can detect stale cached responses.").toBe("number");
});

test("GETRuntime_WhenHeadNodeIsRunning_ReturnsConcreteProcessStateAndRoutes", async () => {
  const runtimeRoute = "/api/runtime";

  const { response, body } = await fetchJson(runtimeRoute);

  expectStatus(response, 200, "runtime process route should expose the live head-node process");
  expect(typeof body.runtimeId, "Runtime process state must include a stable runtime id for this server instance.").toBe("string");
  expect(body.usHome, "Runtime process state must report the active US_HOME backing the control plane.").toBe(usHome);
  expect(body.cwd, "Runtime process state must report the cwd used for MCP discovery and tool execution.").toBe(workdir);
  expect(body.profiles, "Runtime process state must count persisted profiles instead of returning static fixture text.").toBe(20);
  expect(body.endpoints, "Runtime process state must advertise the agent prompt execution route.").toContain("/api/agents");
});

test("GETAgents_WhenProfilesAndPacksExist_ReturnsRealAgentSnapshots", async () => {
  const agentsRoute = "/api/agents";

  const { response, body } = await fetchJson(agentsRoute);
  const coo = body.agents.find((agent: any) => agent.profile === "coo");

  expectStatus(response, 200, "agents route should return the configured org rather than dashboard fixtures");
  expect(body.agents, "The runtime must expose every persisted demo profile as an agent snapshot.").toHaveLength(20);
  expect(coo, "The agents list must include @coo because root orchestration depends on it.").toBeTruthy();
  expect(
    [...coo.pack.identity.directReports].sort(),
    "The @coo snapshot must be backed by the atomic pack direct-report list, not a flattened UI fixture.",
  ).toEqual(["vp-eng", "vp-finance", "vp-gtm", "vp-ops"]);
  expect(coo.runtime.workspace.provider, "Agent snapshots must include resolved runtime workspace contracts.").toBe("local");
});

test("GETAgentDetail_WhenProfileIsCoo_ReturnsIdentityDelegationMcpMemoryAndSessions", async () => {
  const agentRoute = "/api/agents/coo";

  const { response, body: coo } = await fetchJson(agentRoute);

  expectStatus(response, 200, "agent detail should resolve a persisted profile and pack");
  expect(coo.profile, "Agent detail must return the requested profile.").toBe("coo");
  expect(coo.principal.subject, "Agent detail must expose the OIDC subject used for token minting and audit.").toBe("agent:coo");
  expect(
    coo.delegation.some((target: any) => target.profile === "vp-eng" && target.relation === "direct_report"),
    "Agent detail must include direct-report visibility so the dashboard can show valid delegate targets.",
  ).toBe(true);
  expect(
    coo.mcp.servers.map((server: any) => server.name),
    "Agent detail must include discovered MCP servers from the local MCP config.",
  ).toContain("github");
  expect(coo.mcp.grants.github.allowed, "MCP grants must resolve per agent/server so the UI can explain tool access.").toBe(true);
  expect(coo.memory.enabled, "Tests run with memory sync disabled and the API must reflect that exact configuration.").toBe(false);
  expect(Array.isArray(coo.sessions), "Agent detail must include a sessions array even when the profile has no session files.").toBe(true);
});

test("POSTAgentPrompt_WhenPromptIsProvided_RunsRealAgentLoopAndPersistsSession", async () => {
  const promptRoute = "/api/agents/coo/prompt";

  const { response, body } = await postJson(promptRoute, { prompt: "hello from runtime prompt" });
  const sessions = await fetchJson("/api/sessions?profile=coo");
  const events = await fetchJson(`/api/events?type=prompt.run.complete&actor=coo&trace=${body.result.trace}`);
  const usage = await fetchJson(`/api/usage?actor=coo&trace=${body.result.trace}`);

  expectStatus(response, 202, "agent prompt route should execute the same core agent loop as us-dev -p");
  expect(body.result.profile, "Prompt result must identify the executing agent profile.").toBe("coo");
  expect(body.result.text, "Prompt route must return the assistant text produced by the model stream.").toContain("stub response from codex");
  expect(body.result.runId, "Prompt route must return a run id that can correlate events and session turns.").toContain("coo:");
  expect(body.result.usage.total, "Prompt result must expose provider token usage for immediate run accounting.").toBe(2);
  expect(
    sessions.body.sessions.some((session: any) => session.id === body.result.sessionId),
    "Prompt route must persist a real session file visible through the sessions API.",
  ).toBe(true);
  expect(
    events.body.events.some((event: any) => event.sessionId === body.result.sessionId),
    "Prompt route must write prompt completion events with the session id and trace.",
  ).toBe(true);
  expect(usage.body.summary.total, "Usage API must aggregate prompt token usage by trace for dashboard accounting.").toBe(2);
  expect(
    usage.body.usage.some((record: any) => record.sessionId === body.result.sessionId && record.kind === "prompt"),
    "Usage API must expose the persisted per-call ledger row for the prompt session.",
  ).toBe(true);
});

test("POSTAgentPrompt_WhenPromptIsMissing_ReturnsActionableBadRequest", async () => {
  const promptRoute = "/api/agents/coo/prompt";

  const { response, body } = await postJson(promptRoute, {});

  expectStatus(response, 400, "agent prompt route without prompt should fail as a client error");
  expect(body.error, "Missing prompt errors must use a stable code for dashboard validation.").toBe("missing_prompt");
});

test("GETRuntimes_WhenNoProfileFilterIsProvided_ReturnsEveryRuntimeContract", async () => {
  const runtimesRoute = "/api/runtimes";

  const { response, body } = await fetchJson(runtimesRoute);

  expectStatus(response, 200, "runtime list should resolve all configured agents");
  expect(body.runtimes, "The runtime list must include one workspace contract per demo agent.").toHaveLength(20);
  expect(
    body.runtimes.every((item: any) => item.workspacePath.includes("workspaces")),
    "Every runtime contract must include a concrete workspace path; cloud/local plugins cannot be abstract placeholders.",
  ).toBe(true);
});

test("GETRuntimes_WhenProfileFilterContainsTwoAgents_ReturnsOnlyThoseContracts", async () => {
  const filteredRoute = "/api/runtimes?profile=coo,vp-eng";

  const { response, body } = await fetchJson(filteredRoute);

  expectStatus(response, 200, "runtime profile filters should support dashboard-scoped refreshes");
  expect(
    body.runtimes.map((item: any) => item.profile).sort(),
    "Profile-scoped runtime queries must not leak unrelated agent contracts.",
  ).toEqual(["coo", "vp-eng"]);
});

test("GETRuntimeDetail_WhenProfileIsVpEngineering_ReturnsPluginAndWarningsShape", async () => {
  const runtimeRoute = "/api/runtimes/vp-eng";

  const { response, body } = await fetchJson(runtimeRoute);

  expectStatus(response, 200, "runtime detail should resolve a persisted agent runtime");
  expect(body.profile, "Runtime detail must return the requested profile.").toBe("vp-eng");
  expect(body.pluginId, "Local demo runtime should resolve through the first-party local runtime plugin.").toBe("runtime-local");
  expect(Array.isArray(body.warnings), "Runtime detail must always expose warnings as an array for strict UI handling.").toBe(true);
});

test("POSTRuntimeEnsure_WhenWorkspaceIsLocal_CreatesWorkspaceAndAuditEvent", async () => {
  const ensureRoute = "/api/runtimes/coo/ensure";
  const since = Date.now() - 1;

  const { response, body } = await postJson(ensureRoute);
  const events = await fetchJson(`/api/events?type=runtime.workspace.ensure&actor=coo&since=${since}`);

  expectStatus(response, 200, "workspace ensure should materialize a configured runtime workspace");
  expect(body.profile, "Workspace ensure must return the profile whose workspace was materialized.").toBe("coo");
  expect(body.workspacePath.endsWith("/workspaces/coo"), "Workspace ensure must create the profile-specific workspace path.").toBe(true);
  expectStatus(events.response, 200, "workspace ensure audit query should succeed");
  expect(
    events.body.events.some((event: any) => event.outcome === "success" && event.resource === body.workspacePath),
    "Workspace ensure must write a success audit event for the materialized path.",
  ).toBe(true);
});

test("GETEvents_WhenFilteredByActorTypeAndTrace_ReturnsOnlyMatchingAuditEvents", async () => {
  const trace = "trace-events-filter";
  await core.writeEvent({ type: "audit.test", actor: "vp-eng", trace, outcome: "info", payload: { ok: true } });
  await core.writeEvent({ type: "audit.test", actor: "coo", trace, outcome: "info", payload: { ok: false } });

  const { response, body } = await fetchJson(`/api/events?actor=vp-eng&type=audit.test&trace=${trace}&limit=5`);

  expectStatus(response, 200, "events query should filter append-only audit state");
  expect(body.events, "Actor/type/trace filters must return only the matching event, not every audit.test event in the log.").toHaveLength(1);
  expect(body.events[0].actor, "Filtered events must preserve the requested actor.").toBe("vp-eng");
  expect(body.events[0].type, "Filtered events must preserve the requested event type.").toBe("audit.test");
  expect(body.events[0].trace, "Filtered events must preserve the requested trace for Lash/run correlation.").toBe(trace);
});

test("GETEventsStream_WhenMatchingEventAlreadyExists_EmitsServerSentEventFrame", async () => {
  const trace = "trace-events-stream";
  await core.writeEvent({ type: "audit.test", actor: "coo", trace, outcome: "info", payload: { stream: true } });

  const response = await fetchHandler(new Request(`http://runtime.test/api/events/stream?actor=coo&type=audit.test&trace=${trace}&limit=1`));
  const reader = response.body!.getReader();
  const first = await reader.read();
  await reader.cancel();
  const text = new TextDecoder().decode(first.value);

  expectStatus(response, 200, "SSE event stream should open for browser dashboard subscriptions");
  expect(response.headers.get("content-type"), "SSE endpoint must advertise text/event-stream.").toContain("text/event-stream");
  expect(text, "SSE stream must include the matching event name so clients can route typed events.").toContain("event: audit.test");
  expect(text, "SSE stream must include event JSON with the requested actor.").toContain("\"actor\":\"coo\"");
  expect(text, "SSE stream must include the requested trace so clients can stitch runtime timelines.").toContain(trace);
});

test("GETMemory_WhenProfileKindAndTraceAreProvided_ReturnsMatchingMemoryEvents", async () => {
  const trace = "trace-memory-query";
  await core.writeMemoryEvent({
    kind: "session.message",
    peer: "coo",
    sessionId: "memory-test",
    trace,
    role: "assistant",
    payload: { text: "stored" },
  });

  const { response, body } = await fetchJson(`/api/memory?profile=coo&kind=session.message&trace=${trace}`);

  expectStatus(response, 200, "memory query should read durable Honcho-style memory events");
  expect(body.memory, "Profile/kind/trace filters must return the exact memory event written by this test.").toHaveLength(1);
  expect(body.memory[0].peer, "Memory events must preserve the peer profile for per-agent memory views.").toBe("coo");
  expect(body.memory[0].payload.text, "Memory events must preserve payload content for editable memory inspection.").toBe("stored");
});

test("GETMemoryAnchors_WhenProfileIsProvided_ReturnsDurableEditableAnchors", async () => {
  const store = new core.FileMemoryStore();
  await store.writeAnchor({
    id: "anchor-runtime-test",
    peer: "coo",
    sessionId: "memory-test",
    model: "gpt-5.5",
    summary: "Anchor body",
    isUpdate: false,
    tokensBefore: 100,
    tokensAfter: 20,
    droppedCount: 3,
    ts: Date.now(),
  });
  await store.close();

  const { response, body } = await fetchJson("/api/memory/anchors?profile=coo");

  expectStatus(response, 200, "memory anchors should be readable by explicit profile");
  expect(body.anchors[0].id, "Memory anchor API must expose the durable anchor id so dashboard edits can target it.").toBe("anchor-runtime-test");
});

test("GETMemoryAnchors_WhenProfileIsMissing_ReturnsActionableBadRequest", async () => {
  const route = "/api/memory/anchors";

  const { response, body } = await fetchJson(route);

  expectStatus(response, 400, "memory anchors without profile should fail as a client error");
  expect(body.error, "Missing-profile errors must use a stable code for dashboard form validation.").toBe("missing_profile");
});

test("GETSessions_WhenProfileHasSessionFile_ReturnsThatSession", async () => {
  const paths = core.profilePaths("coo");
  await writeFile(join(paths.sessions, "manual-session.jsonl"), `${JSON.stringify({ role: "user", content: "hello", ts: Date.now() })}\n`);

  const { response, body } = await fetchJson("/api/sessions?profile=coo");

  expectStatus(response, 200, "sessions query should read profile-local session files");
  expect(
    body.sessions.some((session: any) => session.id === "manual-session"),
    "Sessions API must derive session ids from JSONL files so /resume and dashboard session lists agree.",
  ).toBe(true);
});

test("GETSessions_WhenProfileIsMissing_ReturnsActionableBadRequest", async () => {
  const route = "/api/sessions";

  const { response, body } = await fetchJson(route);

  expectStatus(response, 400, "sessions without profile should fail as a client error");
  expect(body.error, "Missing-profile session errors must use a stable code for UI handling.").toBe("missing_profile");
});

test("GETSchedulerJobs_WhenNoFilterIsProvided_ReturnsPulseAndCalendarJobsForEveryAgent", async () => {
  const route = "/api/scheduler/jobs";

  const { response, body } = await fetchJson(route);

  expectStatus(response, 200, "scheduler jobs route should expose configured pulse and calendar jobs");
  expect(body.jobs, "The demo org must compile to two scheduler jobs per agent: pulse plus weekly schedule.").toHaveLength(40);
  expect(body.jobs.some((job: any) => job.id === "pulse:coo"), "Scheduler jobs must include the COO heartbeat pulse.").toBe(true);
  expect(body.jobs.some((job: any) => job.id === "schedule:coo:weekly-status"), "Scheduler jobs must include the COO weekly schedule.").toBe(true);
});

test("GETSchedulerDue_WhenSuppliedDeterministicTime_ReturnsOnlyDueJobs", async () => {
  const monday0915 = Date.UTC(2026, 3, 27, 9, 15);

  const { response, body } = await fetchJson(`/api/scheduler/due?profile=coo&now=${monday0915}`);

  expectStatus(response, 200, "scheduler due route should accept deterministic test time");
  expect(
    body.due.map((job: any) => job.id).sort(),
    "At Monday 09:15 UTC, @coo should have exactly its pulse and weekly status schedule due.",
  ).toEqual(["pulse:coo", "schedule:coo:weekly-status"]);
});

test("POSTSchedulerTick_WhenJobsAreDue_ClaimsWorkWithoutExecutingIt", async () => {
  const now = Date.UTC(2026, 3, 27, 9, 45);

  const { response, body } = await postJson("/api/scheduler/tick", { now, profiles: ["vp-eng"] });
  const runs = await fetchJson("/api/scheduler/runs");

  expectStatus(response, 200, "scheduler tick should claim due work for the requested profiles");
  expect(body.runs.every((run: any) => run.status === "claimed"), "Scheduler tick must claim jobs without pretending to execute prompts.").toBe(true);
  expect(body.runs.some((run: any) => run.jobId === "pulse:vp-eng"), "Scheduler tick must claim VP Engineering's pulse at the deterministic time.").toBe(true);
  expectStatus(runs.response, 200, "scheduler runs route should expose claimed work");
  expect(
    runs.body.runs.some((run: any) => run.profile === "vp-eng" && run.status === "claimed"),
    "Claimed scheduler work must be durable and visible through /api/scheduler/runs.",
  ).toBe(true);
});

test("POSTSchedulerTick_WhenExecuteIsTrue_RunsClaimedJobsThroughAgentPromptLoop", async () => {
  const now = Date.UTC(2026, 3, 27, 10, 45);

  const { response, body } = await postJson("/api/scheduler/tick", { now, profiles: ["vp-gtm"], execute: true });
  const completed = body.runs.filter((run: any) => run.status === "complete");

  expectStatus(response, 200, "scheduler tick with execute=true should claim and execute due work");
  expect(completed.length, "Executing scheduler tick must return completed runs, not only claimed placeholders.").toBeGreaterThan(0);
  expect(
    completed.every((run: any) => run.trace && run.sessionId && run.result?.text?.includes("stub response from codex")),
    "Executed scheduler runs must contain prompt trace, session id, and model output.",
  ).toBe(true);
  expect(
    completed.every((run: any) => run.result?.usage?.total === 2),
    "Executed scheduler runs must carry provider token usage into the scheduler result ledger.",
  ).toBe(true);
});

test("POSTWebhookIngress_WhenActorHeaderAndJsonPayloadAreProvided_RecordsSanitizedAuditEvent", async () => {
  const webhookRequest = new Request("http://runtime.test/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "issues",
      "x-union-street-actor": "vp-eng",
    },
    body: JSON.stringify({ subject: "repo:union-street", action: "opened" }),
  });

  const response = await fetchHandler(webhookRequest);
  const body = await response.json() as any;
  const events = await fetchJson("/api/events?type=webhook.received&actor=vp-eng");

  expectStatus(response, 202, "webhook ingress should accept valid JSON webhook payloads");
  expect(body.event.type, "Webhook ingress must persist received webhooks as typed control-plane events.").toBe("webhook.received");
  expect(body.event.actor, "Webhook ingress must prefer the explicit Union Street actor header for audit attribution.").toBe("vp-eng");
  expect(body.event.resource, "Webhook ingress resources must be namespaced by source.").toBe("webhook:github");
  expect(
    events.body.events.some((event: any) => event.payload.source === "github"),
    "Webhook events must be queryable after ingestion for audit logs and dashboard timelines.",
  ).toBe(true);
});

test("GETUnknownApiRoute_WhenPathIsUnsupported_ReturnsStable404Json", async () => {
  const unknownRoute = "/api/nope";

  const { response, body } = await fetchJson(unknownRoute);

  expectStatus(response, 404, "unknown API routes must fail hard instead of falling through to a dashboard shell");
  expect(body.error, "Unknown API route errors must expose a stable not_found code.").toBe("not_found");
});

test("OPTIONSApiRoute_WhenBrowserPreflightArrives_ReturnsCorsHeaders", async () => {
  const request = new Request("http://runtime.test/api/agents", { method: "OPTIONS" });

  const response = await fetchHandler(request);

  expectStatus(response, 204, "CORS preflight should succeed for browser dashboard clients");
  expect(response.headers.get("access-control-allow-origin"), "Runtime API must allow browser clients from the local dashboard origin.").toBe("*");
});

test("startRuntimeServer_WhenStartedOnEphemeralPort_OpensRealHttpListener", async () => {
  const handle = runtime.startRuntimeServer({ port: 0, hostname: "127.0.0.1", cwd: workdir });
  try {
    const response = await fetch(`${handle.url}/health`);
    const body = await response.json() as any;

    expectStatus(response, 200, "runtime server should expose /health over a real HTTP listener");
    expect(body.ok, "Real HTTP /health response must match the in-process fetch handler contract.").toBe(true);
  } finally {
    handle.stop();
  }
});

for (const profile of demoProfiles) {
  test(`GETAgentDetail_WhenProfileIs${titleCaseId(profile)}_ReturnsAtomicPackAndPrincipal`, async () => {
    const route = `/api/agents/${profile}`;

    const { response, body } = await fetchJson(route);

    expectStatus(response, 200, `agent detail for ${profile} should resolve`);
    expect(body.profile, `Agent detail for ${profile} must echo the requested profile.`).toBe(profile);
    expect(body.pack.id, `Agent detail for ${profile} must include the matching atomic pack.`).toBe(profile);
    expect(body.pack.identity.profile, `Agent pack identity for ${profile} must be profile-stable.`).toBe(profile);
    expect(body.principal.profile, `Resolved principal for ${profile} must be profile-stable.`).toBe(profile);
    expect(body.principal.subject, `Resolved principal for ${profile} must use the agent subject convention.`).toBe(`agent:${profile}`);
  });
}

for (const profile of demoProfiles) {
  test(`GETRuntimeDetail_WhenProfileIs${titleCaseId(profile)}_ReturnsLocalWorkspaceContract`, async () => {
    const route = `/api/runtimes/${profile}`;

    const { response, body } = await fetchJson(route);

    expectStatus(response, 200, `runtime detail for ${profile} should resolve`);
    expect(body.profile, `Runtime detail for ${profile} must echo the requested profile.`).toBe(profile);
    expect(body.head.mode, `Runtime detail for ${profile} must use embedded head-node mode in local tests.`).toBe("embedded");
    expect(body.compute.provider, `Runtime detail for ${profile} must declare local compute provider.`).toBe("local");
    expect(body.storage.provider, `Runtime detail for ${profile} must declare local storage provider.`).toBe("local");
    expect(body.workspace.provider, `Runtime detail for ${profile} must declare local workspace provider.`).toBe("local");
    expect(body.workspacePath.includes(`/workspaces/${profile}`), `Runtime detail for ${profile} must point at its own workspace path.`).toBe(true);
  });
}

for (const profile of demoProfiles) {
  test(`GETSchedulerJobs_WhenProfileIs${titleCaseId(profile)}_ReturnsOnePulseAndOneCalendarJob`, async () => {
    const route = `/api/scheduler/jobs?profile=${profile}`;

    const { response, body } = await fetchJson(route);

    expectStatus(response, 200, `scheduler jobs for ${profile} should resolve`);
    expect(body.jobs, `Scheduler jobs for ${profile} must include exactly pulse plus calendar schedule.`).toHaveLength(2);
    expect(body.jobs.some((job: any) => job.id === `pulse:${profile}` && job.kind === "pulse"), `Scheduler jobs for ${profile} must include its pulse job.`).toBe(true);
    expect(body.jobs.some((job: any) => job.id.startsWith(`schedule:${profile}:`) && job.kind === "schedule"), `Scheduler jobs for ${profile} must include its calendar schedule job.`).toBe(true);
  });
}

for (const profile of demoProfiles) {
  test(`GETAgentDetail_WhenProfileIs${titleCaseId(profile)}_ReflectsDisabledHonchoMemorySync`, async () => {
    const route = `/api/agents/${profile}`;

    const { response, body } = await fetchJson(route);

    expectStatus(response, 200, `agent memory config for ${profile} should resolve`);
    expect(body.memory.enabled, `Memory sync for ${profile} must reflect US_MEMORY_SYNC=0 in this isolated test process.`).toBe(false);
    expect(body.memory.provider, `Memory sync for ${profile} must still identify Honcho as the configured memory peer provider.`).toBe("honcho");
  });
}

for (const profile of demoProfiles) {
  test(`GETAgentDetail_WhenProfileIs${titleCaseId(profile)}_ResolvesMcpServersAndBooleanGrants`, async () => {
    const route = `/api/agents/${profile}`;

    const { response, body } = await fetchJson(route);
    const serverNames = body.mcp.servers.map((server: any) => server.name);

    expectStatus(response, 200, `agent MCP config for ${profile} should resolve`);
    expect(serverNames, `MCP server list for ${profile} must include github from .mcp.json.`).toContain("github");
    expect(serverNames, `MCP server list for ${profile} must include linear from .mcp.json.`).toContain("linear");
    expect(typeof body.mcp.grants.github.allowed, `GitHub MCP grant for ${profile} must resolve to an explicit boolean.`).toBe("boolean");
    expect(typeof body.mcp.grants.linear.allowed, `Linear MCP grant for ${profile} must resolve to an explicit boolean.`).toBe("boolean");
  });
}

for (const profile of demoProfiles) {
  test(`GETSessions_WhenProfileIs${titleCaseId(profile)}_ReturnsOnlySessionFilesForThatProfile`, async () => {
    const route = `/api/sessions?profile=${profile}`;

    const { response, body } = await fetchJson(route);

    expectStatus(response, 200, `sessions for ${profile} should resolve`);
    expect(Array.isArray(body.sessions), `Sessions for ${profile} must always be an array.`).toBe(true);
    expect(
      body.sessions.every((session: any) => typeof session.id === "string" && session.file.includes(`/profiles/${profile}/sessions/`)),
      `Sessions for ${profile} must not leak files from other agent profiles.`,
    ).toBe(true);
  });
}

for (const node of demo.org) {
  test(`GETAgentDetail_WhenProfileIs${titleCaseId(node.id)}_ExposesOnlyAllowedDelegationVisibility`, async () => {
    const directReports = demo.org.filter((candidate) => candidate.manager === node.id).map((candidate) => candidate.id);
    const unrelatedPeer = demo.org.find((candidate) => candidate.id !== node.id && candidate.id !== node.manager && candidate.manager !== node.id && candidate.manager !== node.manager);

    const { response, body } = await fetchJson(`/api/agents/${node.id}`);
    const visible = new Set(body.delegation.map((target: any) => target.profile));

    expectStatus(response, 200, `delegation snapshot for ${node.id} should resolve`);
    for (const report of directReports) {
      expect(visible.has(report), `${node.id} must be able to delegate to direct report ${report}.`).toBe(true);
    }
    if (node.manager) {
      expect(visible.has(node.manager), `${node.id} must be able to report one level up to manager ${node.manager}.`).toBe(true);
      if (unrelatedPeer) {
        expect(visible.has(unrelatedPeer.id), `${node.id} must not see unrelated peer ${unrelatedPeer.id}; lateral delegation must be blocked.`).toBe(false);
      }
    } else {
      expect(visible.size, `${node.id} is root and must see every other agent for top-down orchestration.`).toBe(demo.org.length - 1);
    }
  });
}

async function fetchJson(path: string): Promise<{ response: Response; body: any }> {
  const response = await fetchHandler(new Request(`http://runtime.test${path}`));
  const body = await response.json();
  return { response, body };
}

async function postJson(path: string, body?: unknown): Promise<{ response: Response; body: any }> {
  const response = await fetchHandler(new Request(`http://runtime.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const parsed = await response.json();
  return { response, body: parsed };
}

function expectStatus(response: Response, expected: number, reason: string) {
  expect(response.status, `${reason}; expected HTTP ${expected}, received HTTP ${response.status}.`).toBe(expected);
}

function titleCaseId(id: string): string {
  return id.split("-").map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join("");
}
