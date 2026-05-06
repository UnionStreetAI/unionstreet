import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDummyMcpServer, type DummyMcpServerHandle } from "../dummy-mcp-server.ts";

const usHome = await mkdtemp(join(tmpdir(), "union-street-runtime-test-"));
const workdir = await mkdtemp(join(tmpdir(), "union-street-runtime-work-"));
const previousAllowPrivateMcpUrls = process.env.US_MCP_ALLOW_PRIVATE_URLS;
const originalFetch = globalThis.fetch;
process.env.US_HOME = usHome;
process.env.HOME = workdir;
process.env.US_MEMORY_SYNC = "0";
process.env.US_PEER_CALL_STUB = "1";
process.env.US_STREAM_MODEL_STUB = "1";
process.env.US_USAGE_DISABLE_MODELS_DEV_COSTS = "1";
process.env.US_MCP_ALLOW_PRIVATE_URLS = "1";

const core = await import("@unionstreet/server");
const runtime = await import("./index.ts");
const demo = core.buildDemoFederationConfig();
const demoProfiles = demo.org.map((node) => node.id);

let fetchHandler!: ReturnType<typeof runtime.createRuntimeFetchHandler>;
let poetry!: DummyMcpServerHandle;
let context!: DummyMcpServerHandle;

beforeAll(async () => {
  poetry = await startDummyMcpServer({
    name: "poetry",
    token: "poetry-token",
    toolName: "poems.read",
    poem: "Twenty agents wake in line / Truth moves upward, work refines.",
  });
  context = await startDummyMcpServer({
    name: "context",
    token: "context-token",
    toolName: "context.poem",
    poem: "A head node hums with steady flame / Every report preserves its name.",
  });
  demo.config.grants.push({
    id: "runtime-dummy-mcp",
    resource: "mcp",
    servers: ["poetry", "context"],
    tools: ["poems.*", "context.*"],
    roles: ["executive"],
  });
  await writeFile(core.FEDERATION_PATH, JSON.stringify(demo.config, null, 2));
  const packsById = new Map(core.buildDemoAgentPacks(demo.org).map((pack) => [pack.id, pack]));
  for (const node of demo.org) {
    await core.initProfile(node.id, { role: node.roles[0] ?? "agent", capabilities: node.roles });
    const pack = packsById.get(node.id);
    if (pack) await core.writeAgentPack(node.id, pack);
  }
  await core.saveMcpApiKeyCredential({ profile: "coo", server: "poetry", apiKey: "poetry-token" });
  await core.saveMcpApiKeyCredential({ profile: "coo", server: "context", apiKey: "context-token" });
  await writeFile(
    join(workdir, ".mcp.json"),
    JSON.stringify({
      mcp: {
        github: { type: "remote", url: "https://mcp.example.com/github", enabled: true, oauth: true },
        linear: { type: "remote", url: "https://mcp.example.com/linear", enabled: true, oauth: true },
        poetry: { type: "remote", url: poetry.url, enabled: true, headers: { Authorization: "Bearer" } },
        context: { type: "remote", url: context.url, enabled: true, headers: { Authorization: "Bearer" } },
      },
    }),
  );
  fetchHandler = runtime.createRuntimeFetchHandler({ cwd: workdir });
});

afterAll(async () => {
  if (previousAllowPrivateMcpUrls === undefined) delete process.env.US_MCP_ALLOW_PRIVATE_URLS;
  else process.env.US_MCP_ALLOW_PRIVATE_URLS = previousAllowPrivateMcpUrls;
  poetry?.stop();
  context?.stop();
  await rm(usHome, { recursive: true, force: true });
  await rm(workdir, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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
  expect(body.profiles, "Runtime process state must count persisted profiles instead of returning static fixture text.").toBe(40);
  expect(body.endpoints, "Runtime process state must advertise the agent prompt execution route.").toContain("/api/agents");
  expect(body.endpoints, "Runtime process state must advertise the OpenAPI-backed peer wake route.").toContain("POST /api/peers/:profile/wake");
});

test("GETOpenApi_WhenRequested_ReturnsCanonicalRuntimeContract", async () => {
  const { response, body } = await fetchJson("/openapi.json");

  expectStatus(response, 200, "OpenAPI route should be public so clients can discover the runtime contract before auth setup");
  expect(body.openapi, "OpenAPI document must declare the OpenAPI version.").toBe("3.1.0");
  expect(body.info.title, "OpenAPI document should name the Union Street runtime API.").toBe("Union Street Runtime API");
  expect(Object.keys(body.paths), "OpenAPI paths should include every unique runtime HTTP path.").toEqual(
    [...new Set(runtime.RUNTIME_API_ROUTES.map((route) => route.path))],
  );
  expect(body.paths["/api/agents/{profile}/prompt"].post.operationId, "Prompt operation ids should be stable for SDK generation.").toBe("postApiAgentsProfilePrompt");
  expect(body.paths["/api/scheduler/jobs"].get.operationId, "OpenAPI must preserve GET operations when a path also supports POST.").toBe("getApiSchedulerJobs");
  expect(body.paths["/api/scheduler/jobs"].post.operationId, "OpenAPI must preserve POST operations when a path also supports GET.").toBe("postApiSchedulerJobs");
  expect(body.paths["/health"].get.security, "Health must remain unauthenticated for process supervisors.").toEqual([]);
});

test("GETAgents_WhenProfilesAndPacksExist_ReturnsRealAgentSnapshots", async () => {
  const agentsRoute = "/api/agents";

  const { response, body } = await fetchJson(agentsRoute);
  const coo = body.agents.find((agent: any) => agent.profile === "coo");

  expectStatus(response, 200, "agents route should return the configured org rather than dashboard fixtures");
  expect(body.agents, "The runtime must expose every persisted demo profile as an agent snapshot.").toHaveLength(40);
  expect(coo, "The agents list must include @coo because root orchestration depends on it.").toBeTruthy();
  expect(
    [...coo.pack.identity.directReports].sort(),
    "The @coo snapshot must be backed by the atomic pack direct-report list, not a flattened UI fixture.",
  ).toEqual(["vp-eng", "vp-finance", "vp-gtm", "vp-ops"]);
  expect(coo.model, "Agent snapshots must expose the resolved primary model so dashboards do not guess from stale fixtures.").toEqual(coo.pack.model.primary);
  expect(
    coo.modelChain,
    "Agent snapshots must expose the full fallback chain so model pickers and run controls mirror prompt execution.",
  ).toEqual([coo.pack.model.primary, ...coo.pack.model.fallback]);
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

test("GETModels_WhenProfileHasProviderAuth_ReturnsAuthAwareDiscoveredModelGroups", async () => {
  await core.updateAuthProfiles(core.GLOBAL_AUTH_PROFILES_PATH, (current) => ({
    ...current,
    providers: {
      "custom-openai-compat:runtime-test": {
        kind: "api_key",
        api_key: "sk-runtime-test",
        base_url: "https://models.runtime.test/v1/chat/completions",
      },
    },
  }));
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (url) => {
    requestedUrls.push(String(url));
    if (String(url).includes("models.dev/api.json")) return Response.json({});
    if (String(url) === "https://models.runtime.test/v1/models") {
      return Response.json({ data: [{ id: "runtime-live-model", name: "Runtime Live Model", context_length: 64_000 }] });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const modelsRoute = "/api/models?profile=coo";

  const { response, body } = await fetchJson(modelsRoute);

  expectStatus(response, 200, "model discovery should be exposed through the runtime API for browser and TUI clients");
  expect(body.profile, "The runtime should echo the profile used for merged auth-profile resolution.").toBe("coo");
  expect(body.groups, "The runtime should return auth-aware model groups, not models inferred from currently configured agents.").toEqual([
    {
      id: "custom-openai-compat:runtime-test",
      label: "Test Runtime Models",
      authMethod: "api key",
      baseUrl: "https://models.runtime.test/v1",
      state: "live",
      models: [{ id: "runtime-live-model", description: "", display_name: "Runtime Live Model", context_window: 64_000 }],
    },
  ]);
  expect(
    requestedUrls,
    "The runtime model route must sanitize pasted chat-completions URLs before trying provider discovery.",
  ).toContain("https://models.runtime.test/v1/models");
  expect(JSON.stringify(body), "Model discovery responses must not leak provider API keys to the dashboard.").not.toContain("sk-runtime-test");
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

test("POSTPeerWake_WhenCallerAndTargetAreProvided_RunsLashPeerWakeThroughRuntimeApi", async () => {
  const trace = core.createLashTrace();

  const { response, body } = await postJson("/api/peers/vp-eng/wake", {
    caller: "coo",
    message: "Inspect engineering readiness from the sandbox endpoint.",
    trace,
    wakeKind: "delegate",
  });

  expectStatus(response, 202, "peer wake should be exposed as a runtime API so sandbox transports can behave like normal Lash peers");
  expect(body.result.ok, "Runtime peer wake should return the same PeerCallResult envelope shape as in-process delegation.").toBe(true);
  expect(body.result.response, "Stubbed peer wake should prove the target agent, not the caller, was woken.").toContain("@vp-eng woke via delegate from @coo");
  expect(body.result.trace, "Runtime peer wake must preserve the supplied Lash trace across transport boundaries.").toBe(trace);
  expect(body.result.thread.id, "Runtime peer wake should preserve normal target-scoped Lash thread semantics.").toBe(`vp-eng/${trace}`);
});

test("POSTAgentPrompt_WhenDashboardProvidesModelOverride_UsesSelectedModelForRunMetadataAndUsage", async () => {
  const promptRoute = "/api/agents/coo/prompt";

  const { response, body } = await postJson(promptRoute, {
    prompt: "hello from selected dashboard model",
    model: { provider: "custom-openai-compat:dashboard", id: "dashboard-picked-model" },
  });
  const usage = await fetchJson(`/api/usage?actor=coo&trace=${body.result.trace}`);

  expectStatus(response, 202, "dashboard model selection should be accepted by the real runtime prompt route");
  expect(body.result.provider, "Prompt result provider must reflect the model picker selection.").toBe("custom-openai-compat:dashboard");
  expect(body.result.model, "Prompt result model must reflect the model picker selection.").toBe("dashboard-picked-model");
  expect(
    usage.body.usage.some((record: any) => record.provider === "custom-openai-compat:dashboard" && record.model === "dashboard-picked-model"),
    "Usage accounting must persist the dashboard-selected provider/model, not the agent default.",
  ).toBe(true);
});

test("POSTAgentPrompt_WhenDashboardProvidesInvalidModelOverride_ReturnsBadRequestInsteadOfDefaultFallback", async () => {
  const promptRoute = "/api/agents/coo/prompt";

  const { response, body } = await postJson(promptRoute, {
    prompt: "hello from invalid selected dashboard model",
    model: { provider: "codex", id: "../gpt-5.4" },
  });

  expectStatus(response, 400, "invalid dashboard model override must fail before model execution");
  expect(body.error, "Invalid model override errors must use a stable dashboard validation code.").toBe("invalid_model");
});

test("POSTAgentPrompt_WhenDashboardProvidesIncompleteModelOverride_ReturnsBadRequestInsteadOfDefaultFallback", async () => {
  const promptRoute = "/api/agents/coo/prompt";

  const { response, body } = await postJson(promptRoute, {
    prompt: "hello from incomplete selected dashboard model",
    model: { provider: "codex" },
  });

  expectStatus(response, 400, "incomplete dashboard model override must not silently use the agent default");
  expect(body.message, "The error should explain that both provider and id are required.").toContain("provider and id");
});

test("POSTAgentPrompt_WhenPromptIsMissing_ReturnsActionableBadRequest", async () => {
  const promptRoute = "/api/agents/coo/prompt";

  const { response, body } = await postJson(promptRoute, {});

  expectStatus(response, 400, "agent prompt route without prompt should fail as a client error");
  expect(body.error, "Missing prompt errors must use a stable code for dashboard validation.").toBe("missing_prompt");
});

test("POSTAgentPrompt_WhenBodyIsMalformedJson_ReturnsHardBadRequest", async () => {
  const promptRoute = "/api/agents/coo/prompt";

  const response = await fetchHandler(new Request(`http://runtime.test${promptRoute}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  }));
  const body = await response.json() as any;

  expectStatus(response, 400, "malformed JSON must fail before the runtime treats the prompt as missing");
  expect(body.error, "Malformed request bodies must have their own stable error code for clients and logs.").toBe("malformed_json");
  expect(body.message, "Malformed JSON errors must include parser context so operators can debug bad webhook/prompt clients.").toContain("not valid JSON");
});

test("POSTAgentPrompt_WhenContentLengthExceedsLimit_ReturnsPayloadTooLargeBeforePromptRun", async () => {
  const promptRoute = "/api/agents/coo/prompt";

  const response = await fetchHandler(new Request(`http://runtime.test${promptRoute}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "1000001",
    },
    body: JSON.stringify({ prompt: "this should never run" }),
  }));
  const body = await response.json() as any;

  expectStatus(response, 413, "oversized prompt requests must fail before the agent loop starts");
  expect(body.error, "Oversized request bodies must use a stable error code for API clients.").toBe("body_too_large");
});

test("GETAgentDetail_WhenProfilePathTraversalIsRequested_ReturnsInvalidProfileWithoutDiskAccess", async () => {
  const traversalRoute = "/api/agents/%2E%2E%2Fauth-profiles";

  const { response, body } = await fetchJson(traversalRoute);

  expectStatus(response, 400, "profile route segments must be validated before any profile path is resolved");
  expect(body.error, "Invalid profile route errors must be stable so dashboard clients can distinguish bad input from missing agents.").toBe("invalid_profile");
});

test("GETAgentDetail_WhenProfileDoesNotExist_ReturnsProfileNotFoundInsteadOfInternalError", async () => {
  const route = "/api/agents/ghost-agent";

  const { response, body } = await fetchJson(route);

  expectStatus(response, 404, "unknown but syntactically valid profiles should not crash the runtime handler");
  expect(body.error, "Missing profiles must return a specific error code for control-plane clients.").toBe("profile_not_found");
});

test("GETRuntimes_WhenProfileFilterContainsTraversal_ReturnsInvalidProfileBeforeResolvingContracts", async () => {
  const route = "/api/runtimes?profile=coo,%2E%2E%2Fauth-profiles";

  const { response, body } = await fetchJson(route);

  expectStatus(response, 400, "runtime list profile filters must be validated before resolving workspace paths");
  expect(body.error, "Invalid runtime profile filters must use the same stable invalid_profile code as detail routes.").toBe("invalid_profile");
});

test("GETSessions_WhenProfileFilterTargetsUnknownAgent_ReturnsProfileNotFound", async () => {
  const route = "/api/sessions?profile=ghost-agent";

  const { response, body } = await fetchJson(route);

  expectStatus(response, 404, "sessions API must not silently create or inspect unknown profile paths");
  expect(body.error, "Unknown sessions profile filters must use the stable profile_not_found code.").toBe("profile_not_found");
});

test("GETMemoryAnchors_WhenProfileFilterContainsTraversal_ReturnsInvalidProfileBeforeOpeningStore", async () => {
  const route = "/api/memory/anchors?profile=%2E%2E%2Fauth-profiles";

  const { response, body } = await fetchJson(route);

  expectStatus(response, 400, "memory anchor profile filters must be validated before opening profile-scoped storage");
  expect(body.error, "Invalid memory profile filters must use the stable invalid_profile code.").toBe("invalid_profile");
});

test("GETSchedulerJobs_WhenProfileFilterTargetsUnknownAgent_ReturnsProfileNotFound", async () => {
  const route = "/api/scheduler/jobs?profile=ghost-agent";

  const { response, body } = await fetchJson(route);

  expectStatus(response, 404, "scheduler profile filters must fail closed for unknown agents instead of returning empty work");
  expect(body.error, "Unknown scheduler profile filters must use the stable profile_not_found code.").toBe("profile_not_found");
});

test("POSTSchedulerTick_WhenBodyProfilesContainTraversal_ReturnsInvalidProfileBeforeClaimingWork", async () => {
  const now = Date.UTC(2026, 3, 27, 9, 45);

  const { response, body } = await postJson("/api/scheduler/tick", {
    now,
    profiles: ["vp-eng", "../auth-profiles"],
  });

  expectStatus(response, 400, "scheduler tick body profile filters must be validated before any run can be claimed");
  expect(body.error, "Invalid scheduler body profiles must use the stable invalid_profile code.").toBe("invalid_profile");
});

test("RuntimeApi_WhenBearerTokenIsConfigured_RequiresAuthorizationOnApiRoutesButNotHealth", async () => {
  const secureHandler = runtime.createRuntimeFetchHandler({ cwd: workdir, authToken: "runtime-secret" });

  const health = await secureHandler(new Request("http://runtime.test/health"));
  const unauthorized = await secureHandler(new Request("http://runtime.test/api/runtime"));
  const authorized = await secureHandler(new Request("http://runtime.test/api/runtime", {
    headers: { authorization: "Bearer runtime-secret" },
  }));
  const unauthorizedBody = await unauthorized.json() as any;
  const authorizedBody = await authorized.json() as any;

  expectStatus(health, 200, "health must remain unauthenticated so local supervisors can detect process liveness");
  expectStatus(unauthorized, 401, "configured runtime API auth must reject missing bearer tokens");
  expect(unauthorizedBody.error, "Runtime auth failures must use a stable unauthorized code.").toBe("unauthorized");
  expectStatus(authorized, 200, "configured runtime API auth must accept the exact bearer token");
  expect(authorizedBody.usHome, "Authorized runtime responses must still expose the same live control-plane state.").toBe(usHome);
});

test("GETRuntimes_WhenNoProfileFilterIsProvided_ReturnsEveryRuntimeContract", async () => {
  const runtimesRoute = "/api/runtimes";

  const { response, body } = await fetchJson(runtimesRoute);

  expectStatus(response, 200, "runtime list should resolve all configured agents");
  expect(body.runtimes, "The runtime list must include one workspace contract per demo agent.").toHaveLength(40);
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

test("GETEvents_WhenLimitIsHuge_ClampsResultSetToRuntimeMaximum", async () => {
  const trace = "trace-events-limit";
  for (let i = 0; i < 1_020; i++) {
    await core.writeEvent({ type: "audit.test", actor: "coo", trace, outcome: "info", payload: { index: i } });
  }

  const { response, body } = await fetchJson(`/api/events?actor=coo&type=audit.test&trace=${trace}&limit=999999`);

  expectStatus(response, 200, "events queries with huge limits should still succeed");
  expect(
    body.events,
    "Runtime event queries must clamp untrusted limits so one dashboard/API request cannot force an unbounded response.",
  ).toHaveLength(1_000);
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
  expect(body.jobs, "The demo org must compile to two scheduler jobs per agent: pulse plus weekly schedule.").toHaveLength(80);
  expect(body.jobs.some((job: any) => job.id === "pulse:coo"), "Scheduler jobs must include the COO heartbeat pulse.").toBe(true);
  expect(body.jobs.some((job: any) => job.id === "schedule:coo:weekly-status"), "Scheduler jobs must include the COO weekly schedule.").toBe(true);
});

test("POSTSchedulerJobs_WhenRouteIsValid_PersistsOrderedCalendarOrchestration", async () => {
  const secureHandler = runtime.createRuntimeFetchHandler({ cwd: workdir, authToken: "scheduler-create-token" });
  const route = ["coo", "vp-eng", "dir-eng-infra"];
  const body = {
    owner: "coo",
    name: "Runtime created escalation route",
    cron: "20 14 * * THU",
    timezone: "America/Los_Angeles",
    prompt: "Escalate the highest-risk platform dependency and return the decision-ready next step.",
    deliverables: ["risk summary", "owner", "deadline"],
    route,
  };

  const created = await postJsonWithHandler(secureHandler, "/api/scheduler/jobs", body, "scheduler-create-token");
  const jobs = await fetchJson("/api/scheduler/jobs?profile=coo");

  try {
    expectStatus(created.response, 201, "scheduler job creation should write valid ordered calendar routes through the runtime API");
    expect(created.body.schedule.route, "The runtime response must echo the route that will be compiled into scheduler jobs.").toEqual(route);
    expect(
      jobs.body.jobs.some((job: any) => job.id === `schedule:coo:${created.body.schedule.id}` && job.route?.join(">") === route.join(">")),
      "A newly-created calendar route must be visible through /api/scheduler/jobs without restarting the runtime.",
    ).toBe(true);
  } finally {
    if (created.body.schedule?.id) await removeRuntimeSchedule("coo", created.body.schedule.id);
  }
});

test("POSTSchedulerJobs_WhenRuntimeHasNoBearerToken_ReturnsWriteAuthRequiredWithoutChangingCalendar", async () => {
  const insecureHandler = runtime.createRuntimeFetchHandler({ cwd: workdir, authToken: undefined });

  const { response, body } = await postJsonWithHandler(insecureHandler, "/api/scheduler/jobs", {
    owner: "coo",
    name: "Should not write",
    cron: "5 12 * * FRI",
    timezone: "UTC",
    prompt: "This should not be persisted.",
    deliverables: ["none"],
    route: ["coo"],
  }, "ignored-token");
  const pack = await core.readAgentPack("coo");

  expectStatus(response, 401, "scheduler job creation must require explicit runtime bearer auth because it mutates agent config");
  expect(body.error, "Unauthenticated calendar writes must use a stable error code for dashboard handling.").toBe("write_auth_required");
  expect(
    pack.schedule.some((schedule: any) => schedule.name === "Should not write"),
    "Unauthenticated scheduler writes must not persist a calendar event.",
  ).toBe(false);
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

test("POSTWebhookIngress_WhenSourceContainsTraversal_ReturnsInvalidSourceBeforeAuditWrite", async () => {
  const response = await fetchHandler(new Request("http://runtime.test/api/webhooks/%2E%2E%2Fgithub", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject: "repo:bad-source", action: "opened" }),
  }));
  const body = await response.json() as any;
  const events = await fetchJson("/api/events?type=webhook.received&limit=1000");

  expectStatus(response, 400, "webhook source route segments must be validated before audit/resource construction");
  expect(body.error, "Invalid webhook source errors must use a stable code.").toBe("invalid_webhook_source");
  expect(
    events.body.events.some((event: any) => event.payload?.body?.subject === "repo:bad-source"),
    "Invalid webhook sources must not create successful ingress audit events.",
  ).toBe(false);
});

test("POSTWebhookIngress_WhenSourceSecretIsConfigured_RejectsMissingSignatureBeforeAuditWrite", async () => {
  const previous = process.env.US_WEBHOOK_GITHUB_SECRET;
  process.env.US_WEBHOOK_GITHUB_SECRET = "github-webhook-secret";
  try {
    const response = await fetchHandler(new Request("http://runtime.test/api/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "repo:unsigned-webhook", action: "opened" }),
    }));
    const body = await response.json() as any;
    const events = await fetchJson("/api/events?type=webhook.received&limit=1000");

    expectStatus(response, 401, "webhook sources with configured secrets must reject unsigned payloads");
    expect(body.error, "Unsigned protected webhooks must use a stable error code.").toBe("webhook_signature_required");
    expect(
      events.body.events.some((event: any) => event.payload?.body?.subject === "repo:unsigned-webhook"),
      "Rejected webhook payloads must not be written as successful ingress audit events.",
    ).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.US_WEBHOOK_GITHUB_SECRET;
    else process.env.US_WEBHOOK_GITHUB_SECRET = previous;
  }
});

test("POSTWebhookIngress_WhenSourceSecretAndValidSignatureAreProvided_RecordsAuditEvent", async () => {
  const previous = process.env.US_WEBHOOK_GITHUB_SECRET;
  process.env.US_WEBHOOK_GITHUB_SECRET = "github-webhook-secret";
  const rawBody = JSON.stringify({ subject: "repo:union-street", action: "closed" });
  const signature = createHmac("sha256", "github-webhook-secret").update(rawBody).digest("hex");
  try {
    const response = await fetchHandler(new Request("http://runtime.test/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-us-signature": `sha256=${signature}`,
        "x-union-street-actor": "vp-eng",
      },
      body: rawBody,
    }));
    const body = await response.json() as any;

    expectStatus(response, 202, "webhook sources with configured secrets must accept valid HMAC SHA-256 signatures");
    expect(body.event.type, "Accepted signed webhooks must still persist typed ingress events.").toBe("webhook.received");
    expect(body.event.actor, "Signed webhooks must preserve the explicit runtime actor header for audit attribution.").toBe("vp-eng");
    expect(body.event.payload.body.action, "Signed webhook payloads must preserve parsed JSON for downstream routing.").toBe("closed");
  } finally {
    if (previous === undefined) delete process.env.US_WEBHOOK_GITHUB_SECRET;
    else process.env.US_WEBHOOK_GITHUB_SECRET = previous;
  }
});

test("GETUnknownApiRoute_WhenPathIsUnsupported_ReturnsStable404Json", async () => {
  const unknownRoute = "/api/nope";

  const { response, body } = await fetchJson(unknownRoute);

  expectStatus(response, 404, "unknown API routes must fail hard instead of falling through to a dashboard shell");
  expect(body.error, "Unknown API route errors must expose a stable not_found code.").toBe("not_found");
});

test("OPTIONSApiRoute_WhenBrowserPreflightArrives_ReturnsCorsHeaders", async () => {
  const request = new Request("http://runtime.test/api/agents", {
    method: "OPTIONS",
    headers: { origin: "http://127.0.0.1:5173" },
  });

  const response = await fetchHandler(request);

  expectStatus(response, 204, "CORS preflight should succeed for browser dashboard clients");
  expect(response.headers.get("access-control-allow-origin"), "Runtime API must allow browser clients from the local dashboard origin.").toBe("http://127.0.0.1:5173");
  expect(
    response.headers.get("access-control-allow-headers"),
    "CORS preflight must allow signed webhook and runtime auth headers used by browser/control-plane clients.",
  ).toContain("x-us-signature");
});

test("OPTIONSApiRoute_WhenPreflightComesFromUntrustedOrigin_DoesNotGrantCorsReadAccess", async () => {
  const response = await fetchHandler(new Request("http://runtime.test/api/agents", {
    method: "OPTIONS",
    headers: { origin: "https://evil.example" },
  }));

  expectStatus(response, 204, "preflight should remain harmless and cacheable even for disallowed origins");
  expect(
    response.headers.get("access-control-allow-origin"),
    "Runtime API must not advertise wildcard CORS access to arbitrary browser origins.",
  ).toBeNull();
  expect(response.headers.get("vary"), "CORS responses should vary by Origin once allowlisting is enforced.").toBe("Origin");
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

test("startRuntimeServer_WhenAuthTokenIsConfigured_ProtectsRealHttpApiRoutes", async () => {
  const handle = runtime.startRuntimeServer({ port: 0, hostname: "127.0.0.1", cwd: workdir, authToken: "real-runtime-secret" });
  try {
    const unauthorized = await fetch(`${handle.url}/api/runtime`);
    const authorized = await fetch(`${handle.url}/api/runtime`, {
      headers: { authorization: "Bearer real-runtime-secret" },
    });
    const unauthorizedBody = await unauthorized.json() as any;
    const authorizedBody = await authorized.json() as any;

    expectStatus(unauthorized, 401, "real HTTP runtime listeners must enforce the same bearer gate as the in-process handler");
    expect(unauthorizedBody.error, "Real HTTP auth failures must use the runtime unauthorized error code.").toBe("unauthorized");
    expectStatus(authorized, 200, "real HTTP runtime listeners must pass authorized dashboard/control-plane requests");
    expect(authorizedBody.usHome, "Authorized real HTTP runtime responses must expose the active control-plane state.").toBe(usHome);
  } finally {
    handle.stop();
  }
});

test("startRuntimeServer_WhenBearerTokenComesFromEnv_ProtectsRealHttpApiRoutes", async () => {
  const previous = process.env.US_RUNTIME_BEARER_TOKEN;
  process.env.US_RUNTIME_BEARER_TOKEN = "env-runtime-secret";
  const handle = runtime.startRuntimeServer({ port: 0, hostname: "127.0.0.1", cwd: workdir });
  try {
    const unauthorized = await fetch(`${handle.url}/api/runtime`);
    const authorized = await fetch(`${handle.url}/api/runtime`, {
      headers: { authorization: "Bearer env-runtime-secret" },
    });

    expectStatus(unauthorized, 401, "runtime listeners must honor US_RUNTIME_BEARER_TOKEN when no explicit authToken is passed");
    expectStatus(authorized, 200, "runtime listeners must accept the bearer token configured through the environment");
  } finally {
    handle.stop();
    if (previous === undefined) delete process.env.US_RUNTIME_BEARER_TOKEN;
    else process.env.US_RUNTIME_BEARER_TOKEN = previous;
  }
});

test("startRuntimeServer_WhenRestartedAfterSchedulerRun_PreservesSessionsRunsAndDoesNotDuplicateClaimedWork", async () => {
  const now = Date.UTC(2026, 5, 1, 9, 45);
  const first = runtime.startRuntimeServer({ port: 0, hostname: "127.0.0.1", cwd: workdir, authToken: "restart-secret" });
  try {
    const tick = await fetch(`${first.url}/api/scheduler/tick`, {
      method: "POST",
      headers: {
        authorization: "Bearer restart-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ now, profiles: ["dir-eng-product"], execute: true }),
    });
    const body = await tick.json() as any;

    expectStatus(tick, 200, "pre-restart scheduler execution should succeed over a real HTTP listener");
    expect(body.runs.every((run: any) => run.status === "complete"), "The pre-restart scheduler run should complete before restart.").toBe(true);
  } finally {
    first.stop();
  }

  const second = runtime.startRuntimeServer({ port: 0, hostname: "127.0.0.1", cwd: workdir, authToken: "restart-secret" });
  try {
    const sessions = await fetch(`${second.url}/api/sessions?profile=dir-eng-product`, {
      headers: { authorization: "Bearer restart-secret" },
    });
    const runs = await fetch(`${second.url}/api/scheduler/runs`, {
      headers: { authorization: "Bearer restart-secret" },
    });
    const duplicateTick = await fetch(`${second.url}/api/scheduler/tick`, {
      method: "POST",
      headers: {
        authorization: "Bearer restart-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ now, profiles: ["dir-eng-product"], execute: true }),
    });
    const sessionBody = await sessions.json() as any;
    const runsBody = await runs.json() as any;
    const duplicateBody = await duplicateTick.json() as any;

    expectStatus(sessions, 200, "restarted runtime should keep reading existing session files from US_HOME");
    expectStatus(runs, 200, "restarted runtime should keep reading existing scheduler runs from US_HOME");
    expectStatus(duplicateTick, 200, "restarted runtime should accept scheduler ticks after restart");
    expect(
      sessionBody.sessions.length,
      "Scheduler-created sessions must survive runtime process restart.",
    ).toBeGreaterThanOrEqual(2);
    expect(
      runsBody.runs.some((run: any) => run.profile === "dir-eng-product" && run.status === "complete" && run.dueAt === now - 15 * 60 * 1000),
      "Completed scheduler runs must remain readable after restart.",
    ).toBe(true);
    expect(
      duplicateBody.runs,
      "A restart must not allow the same profile/due window to be claimed twice.",
    ).toEqual([]);
  } finally {
    second.stop();
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

test("POSTSchedulerTick_WhenExecutingTheFullDemoOrg_TouchesEveryAgentAndPersistsAuditUsageAndSessions", async () => {
  const now = Date.UTC(2026, 6, 6, 9, 45);

  const { response, body } = await postJson("/api/scheduler/tick", { now, execute: true });
  const runs = body.runs as any[];
  const completed = runs.filter((run) => run.status === "complete");
  const profilesTouched = new Set(completed.map((run) => run.profile));
  const usage = await fetchJson("/api/usage?kind=prompt&limit=1000");
  const schedulerEvents = await fetchJson("/api/events?type=scheduler.run.complete&limit=1000");
  const sessions = await Promise.all([...profilesTouched].map(async (profile) => ({
    profile,
    body: (await fetchJson(`/api/sessions?profile=${profile}`)).body,
  })));

  expectStatus(response, 200, "full-org scheduler execution should complete through the runtime API");
  expect(runs, "The demo org should compile to exactly pulse plus weekly schedule for each of 40 agents.").toHaveLength(80);
  expect(completed, "Every claimed full-org scheduler run should execute to completion in the stubbed deterministic runtime.").toHaveLength(80);
  expect(
    profilesTouched.size,
    "The ultimate runtime test must touch every agent in the 40-agent enterprise graph, not just the root path.",
  ).toBe(40);
  expect(
    completed.every((run) => run.trace?.startsWith("scheduler:") && run.sessionId?.startsWith(`scheduler-${run.profile}-`)),
    "Every completed scheduler run must carry trace and session ids that stitch together audit, transcript, and usage records.",
  ).toBe(true);
  expect(
    completed.every((run) => run.result?.usage?.total === 2 && run.result?.text?.includes("stub response from codex")),
    "Every completed scheduler run must include model text and token usage from the real prompt runner path.",
  ).toBe(true);
  expect(
    usage.body.summary.calls,
    "Usage accounting must include at least one prompt ledger row for each full-org scheduler execution, regardless of whether this test is run alone or after earlier runtime prompt tests.",
  ).toBeGreaterThanOrEqual(completed.length);
  expect(
    usage.body.summary.total,
    "Usage accounting must aggregate token totals across the full 40-agent scheduler run.",
  ).toBeGreaterThanOrEqual(completed.length * 2);
  expect(
    schedulerEvents.body.events.length,
    "Scheduler completion events must include every completed full-org run.",
  ).toBeGreaterThanOrEqual(80);
  expect(
    sessions.every(({ body: sessionBody }) => sessionBody.sessions.length >= 2),
    "Every touched agent must have durable session files for its pulse and scheduled sync.",
  ).toBe(true);
});

test("POSTAgentPrompt_WhenHeadNodeUsesRemoteMcpTool_ThreadsToolCallUsageSessionAndAuditTogether", async () => {
  const prompt = "please use the poetry mcp tool to add a poem to context";

  const { response, body } = await postJson("/api/agents/coo/prompt", {
    prompt,
    sessionId: "ultimate-mcp-session",
    trace: "ultimate-mcp-trace",
  });
  const result = body.result;
  const events = await fetchJson(`/api/events?trace=${result.trace}&limit=100`);
  const listEvents = await fetchJson("/api/events?type=mcp.tool.list&actor=coo&limit=100");
  const usage = await fetchJson(`/api/usage?trace=${result.trace}&limit=20`);
  const session = await Bun.file(result.sessionFile).text();

  expectStatus(response, 202, "head-node prompt route should run the same agent loop used by us-dev -p");
  expect(result.trace, "Explicit traces must survive the runtime prompt boundary for Lash/audit correlation.").toBe("ultimate-mcp-trace");
  expect(result.sessionId, "Explicit session ids must survive the runtime prompt boundary for /resume and dashboard chat.").toBe("ultimate-mcp-session");
  expect(
    result.toolCalls.map((call: any) => call.name),
    "The model-safe remote MCP tool name should be returned in the prompt result.",
  ).toEqual(["mcp_context_context_poem"]);
  expect(
    session,
    "The runtime transcript must persist the remote MCP tool output before the follow-up assistant turn.",
  ).toContain("A head node hums with steady flame");
  expect(
    events.body.events.map((event: any) => event.type),
    "Remote MCP prompt runs must leave a complete audit trail on one trace.",
  ).toEqual(expect.arrayContaining(["prompt.run.start", "prompt.tool.call", "mcp.tool.call", "model.usage", "prompt.run.complete"]));
  expect(
    listEvents.body.events.some((event: any) => event.resource === "mcp:context" && event.outcome === "success"),
    "Remote MCP discovery should be audited before tool exposure, even though discovery is not tied to a prompt trace.",
  ).toBe(true);
  expect(
    usage.body.summary.total,
    "A remote MCP prompt run should account for both the tool-call model step and the final assistant step.",
  ).toBe(4);
});

test("POSTFleetValidate_WhenPlanHasManagerCycle_ReturnsValidationErrorsWithoutWritingProfiles", async () => {
  const plan = runtimeFleetPlan("runtime_cycle", [
    { id: "runtime_cycle_a", manager: "runtime_cycle_b" },
    { id: "runtime_cycle_b", manager: "runtime_cycle_a" },
  ]);

  const { response, body } = await postJson("/api/fleet/validate", { plan });

  expectStatus(response, 200, "fleet validation should return structured diagnostics without requiring an apply attempt");
  expect(
    body.validation.ok,
    "Runtime fleet validation must fail closed for invalid org graphs before the dashboard can offer materialization.",
  ).toBe(false);
  expect(
    body.validation.errors.some((error: string) => error.includes("manager cycle detected")),
    `Expected cycle diagnostics to reach the dashboard, got: ${body.validation.errors.join("; ")}`,
  ).toBe(true);
  expect(
    await core.profileExists("runtime_cycle_a"),
    "Validate-only requests must not create profile directories as a side effect.",
  ).toBe(false);
});

test("POSTFleetApply_WhenPlanIsValid_MaterializesProfilesAndFederationThroughRuntime", async () => {
  const plan = runtimeFleetPlan("runtime_apply", [
    { id: "runtime_apply_root", groups: ["executives"], roles: ["executive"], mcp: ["slack"] },
    { id: "runtime_apply_vp", manager: "runtime_apply_root", groups: ["engineering"], roles: ["vp"], mcp: ["github"] },
  ]);
  const secureFleetHandler = runtime.createRuntimeFetchHandler({ cwd: workdir, authToken: "fleet-apply-token" });

  const { response, body } = await postJsonWithHandler(secureFleetHandler, "/api/fleet/apply", { plan }, "fleet-apply-token");
  const agents = await fetchJson("/api/agents");
  const events = await fetchJson("/api/events?type=fleet.apply.complete&actor=coo&limit=10");
  const vpPack = await core.readAgentPack("runtime_apply_vp");

  expectStatus(response, 202, "valid fleet apply should be accepted and materialized by the runtime control plane");
  expect(
    body.applied,
    "Runtime apply responses must explicitly state that profile/federation writes happened.",
  ).toBe(true);
  expect(
    agents.body.agents.some((agent: any) => agent.profile === "runtime_apply_vp"),
    "Applied fleet agents must become visible through the live agents API without dashboard fixtures.",
  ).toBe(true);
  expect(
    vpPack.identity.manager,
    "The runtime-applied agent pack must preserve manager edges for Lash-aware delegation.",
  ).toBe("runtime_apply_root");
  expect(
    events.body.events.some((event: any) => event.resource === "fleet:runtime_apply"),
    "Fleet materialization must emit an audit event so generated org changes are accountable.",
  ).toBe(true);
});

test("POSTFleetApply_WhenRuntimeHasNoBearerToken_ReturnsWriteAuthRequiredWithoutWritingProfiles", async () => {
  const plan = runtimeFleetPlan("runtime_apply_open", [
    { id: "runtime_apply_open_root", groups: ["executives"], roles: ["executive"] },
  ]);

  const { response, body } = await postJson("/api/fleet/apply", { plan });

  expectStatus(response, 401, "fleet apply mutates profiles and federation policy, so it must require explicit bearer auth even on loopback runtimes");
  expect(
    body.error,
    "Write-auth failures need a stable code so the dashboard can explain why materialization is locked.",
  ).toBe("write_auth_required");
  expect(
    await core.profileExists("runtime_apply_open_root"),
    "Unauthenticated fleet apply must fail before creating any profile directories.",
  ).toBe(false);
});

test("POSTFleetPlan_WhenHeadAgentReturnsNonYaml_ReturnsInvalidPlanInsteadOfApplyingFallbacks", async () => {
  const route = "/api/fleet/plan";
  const secureFleetHandler = runtime.createRuntimeFetchHandler({ cwd: workdir, authToken: "fleet-plan-token" });

  const { response, body } = await postJsonWithHandler(secureFleetHandler, route, {
    profile: "coo",
    prompt: "Design the company you want to run.",
  }, "fleet-plan-token");

  expectStatus(response, 422, "the planning route should reject non-contract model output instead of treating prose as a fleet");
  expect(
    body.error,
    "Invalid generated plan errors must use a stable code for the dashboard planning modal.",
  ).toBe("invalid_fleet_plan");
  expect(
    body.result.profile,
    "Even invalid fleet plans should include prompt run metadata so operators can inspect what the head agent produced.",
  ).toBe("coo");
});

test("POSTFleetPlan_WhenRuntimeHasNoBearerToken_ReturnsWriteAuthRequiredBeforeModelExecution", async () => {
  const route = "/api/fleet/plan";

  const { response, body } = await postJson(route, {
    profile: "coo",
    prompt: "Design the company you want to run.",
  });

  expectStatus(response, 401, "fleet planning executes an agent prompt, so browser-originated planning must require explicit bearer auth");
  expect(
    body.error,
    "Fleet planning auth failures need the same stable code as fleet materialization.",
  ).toBe("write_auth_required");
});

test("GETAgents_WhenLegacyProfileIsMissingAgentPack_ReturnsPartialSnapshotInsteadOfPoisoningFleet", async () => {
  await core.initProfile("legacy-packless", { role: "operator" });
  await rm(core.profilePaths("legacy-packless").agentPack, { force: true });

  const { response, body } = await fetchJson("/api/agents");
  const legacy = body.agents.find((agent: any) => agent.profile === "legacy-packless");

  expectStatus(response, 200, "one legacy profile without agent.yaml must not make the whole fleet API unusable");
  expect(legacy, "The packless legacy profile should still appear so the dashboard can show and repair it.").toBeDefined();
  expect(legacy.pack, "The runtime should represent the missing atomic pack explicitly, not synthesize fake pack data.").toBeUndefined();
  expect(legacy.runtime.workspace, "Legacy profile config should still contribute the concrete runtime workspace contract.").toBeDefined();
});

test("GETAgents_WhenAgentPackIsCorrupt_FailsHardInsteadOfSynthesizingRuntimeConfig", async () => {
  await core.initProfile("corrupt-pack", { role: "operator" });
  await writeFile(core.profilePaths("corrupt-pack").agentPack, "version: [not valid");

  const { response, body } = await fetchJson("/api/agents");

  expectStatus(response, 500, "corrupt agent.yaml is a real configuration error and must not be treated like a missing legacy pack");
  expect(
    body.message,
    "The runtime should surface parser failure context so operators can repair the broken atomic agent pack.",
  ).toContain("unexpected end of the stream");
});

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

async function postJsonWithHandler(
  handler: ReturnType<typeof runtime.createRuntimeFetchHandler>,
  path: string,
  body: unknown,
  token: string,
): Promise<{ response: Response; body: any }> {
  const response = await handler(new Request(`http://runtime.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }));
  const parsed = await response.json();
  return { response, body: parsed };
}

function expectStatus(response: Response, expected: number, reason: string) {
  expect(response.status, `${reason}; expected HTTP ${expected}, received HTTP ${response.status}.`).toBe(expected);
}

async function removeRuntimeSchedule(profile: string, scheduleId: string) {
  const pack = await core.readAgentPack(profile);
  await core.writeAgentPack(profile, {
    ...pack,
    schedule: pack.schedule.filter((schedule: any) => schedule.id !== scheduleId),
  });
}

function runtimeFleetPlan(
  name: string,
  agents: Array<{ id: string; manager?: string; groups?: string[]; roles?: string[]; mcp?: string[] }>,
) {
  return {
    version: 1,
    kind: "union-street.fleet-plan",
    name,
    mission: `Operate ${name}.`,
    root: agents.find((agent) => !agent.manager)?.id ?? agents[0]?.id ?? "",
    generatedBy: "coo",
    agents: agents.map((agent) => ({
      id: agent.id,
      displayName: agent.id,
      title: "Runtime Generated Agent",
      ...(agent.manager ? { manager: agent.manager } : {}),
      groups: agent.groups ?? ["generated"],
      roles: agent.roles ?? ["agent"],
      soul: `Operate ${name} as @${agent.id}.`,
      model: { provider: "codex", id: "gpt-5.4" },
      ...(agent.mcp ? { mcp: agent.mcp } : {}),
    })),
  };
}

function titleCaseId(id: string): string {
  return id.split("-").map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join("");
}
