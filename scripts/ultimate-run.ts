#!/usr/bin/env bun
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  startDummyMcpServer,
  type DummyMcpServerHandle,
} from "../packages/server/src/dummy-mcp-server.ts";

await loadLocalEnv();

const args = new Set(process.argv.slice(2));
const live = args.has("--live");
const keep = args.has("--keep");
const provider = process.env.US_ULTIMATE_PROVIDER ?? "custom-openai-compat:gemma-thurgood-cloud";
const model = process.env.US_ULTIMATE_MODEL ?? "google/gemma-4-31B-it";
const baseUrl = process.env.US_ULTIMATE_BASE_URL ?? "https://gemma.thurgood.cloud/v1/chat/completions";
const apiKey = process.env.US_ULTIMATE_API_KEY;
const repoRoot = process.cwd();
const cli = join(repoRoot, "packages/us-cli/src/index.ts");
const usHome = await mkdtemp(join(tmpdir(), "union-street-ultimate-"));
const workdir = await mkdtemp(join(tmpdir(), "union-street-ultimate-work-"));
const previousAllowPrivateMcpUrls = process.env.US_MCP_ALLOW_PRIVATE_URLS;
let poetryMcp: DummyMcpServerHandle | undefined;
let contextMcp: DummyMcpServerHandle | undefined;

const ultimatePluginMatrix: Record<string, { plugins: string[]; skills: number; mcp: number; commands: number; tools: number }> = {
  coo: { plugins: ["github"], skills: 5, mcp: 0, commands: 7, tools: 1 },
  "vp-eng": { plugins: ["ultimate-skills-only"], skills: 1, mcp: 0, commands: 0, tools: 0 },
  "vp-ops": { plugins: ["ultimate-mcp-only"], skills: 0, mcp: 1, commands: 0, tools: 0 },
  "vp-gtm": { plugins: ["ultimate-cli-only"], skills: 0, mcp: 0, commands: 1, tools: 0 },
  "vp-finance": { plugins: ["ultimate-tools-only"], skills: 0, mcp: 0, commands: 0, tools: 1 },
  "dir-eng-product": { plugins: ["ultimate-tools-cli"], skills: 0, mcp: 0, commands: 1, tools: 1 },
  "dir-eng-infra": { plugins: ["ultimate-tools-skills"], skills: 1, mcp: 0, commands: 0, tools: 1 },
  "dir-ops-platform": { plugins: ["ultimate-tools-mcp"], skills: 0, mcp: 1, commands: 0, tools: 1 },
  "dir-ops-support": { plugins: ["ultimate-skills-mcp"], skills: 1, mcp: 1, commands: 0, tools: 0 },
  "dir-gtm-sales": { plugins: ["ultimate-skills-cli"], skills: 1, mcp: 0, commands: 1, tools: 0 },
  "dir-gtm-marketing": { plugins: ["ultimate-mcp-cli"], skills: 0, mcp: 1, commands: 1, tools: 0 },
  "dir-finance-fpna": { plugins: ["ultimate-skills-mcp-cli"], skills: 1, mcp: 1, commands: 1, tools: 0 },
  "dir-finance-revops": { plugins: ["ultimate-skills-mcp-tools"], skills: 1, mcp: 1, commands: 0, tools: 1 },
  "mgr-eng-apps": { plugins: ["ultimate-skills-cli-tools"], skills: 1, mcp: 0, commands: 1, tools: 1 },
  "mgr-eng-platform": { plugins: ["ultimate-mcp-cli-tools"], skills: 0, mcp: 1, commands: 1, tools: 1 },
  "mgr-finance-billing": { plugins: ["ultimate-all"], skills: 1, mcp: 1, commands: 1, tools: 1 },
};
const ultimateGeneratedPluginNames = [...new Set(Object.values(ultimatePluginMatrix).flatMap((item) => item.plugins).filter((name) => name.startsWith("ultimate-")))];
const ultimateTask = [
  "ULTIMATE UNION STREET INCIDENT DRILL: the control plane is under a fake enterprise readiness incident named BLACKGLASS.",
  "You must prove that agents, Lash delegation, reports, scoped plugin grants, MCP tools, custom tools, CLI affordances, runtime contracts, memory, usage, sessions, scheduler state, webhook ingress, auth gates, and event traces all stay coherent.",
  "The scenario: a customer wants one audited run that plans a production release while a GitHub integration, a dummy MCP evidence source, a Docker/Vercel/Daytona runtime strategy, billing checks, and support escalation all exist at once.",
  "Rules: do not leak credentials, do not invent external network success, preserve the trace, stay inside your org visibility, name blockers explicitly, and return decision-ready output.",
  "Every delegated agent must answer with: scope, evidence observed, plugin/tool surface expected for that agent, risk, confidence, next action.",
].join("\n");

try {
  process.env.US_HOME = usHome;
  process.env.US_MEMORY_SYNC = "0";
  process.env.US_MCP_ALLOW_PRIVATE_URLS = "1";
  if (!live) process.env.US_STREAM_MODEL_STUB = "1";
  if (live && !apiKey) throw new Error("Live ultimate run requires US_ULTIMATE_API_KEY.");

  const core = await import("../packages/server/src/index.ts");
  await createUltimateMatrixPlugins();
  poetryMcp = await startDummyMcpServer({
    name: "poetry",
    token: "ultimate-poetry-token",
    toolName: "poems.read",
    poem: "Orange sparks on midnight rails / Work reports and truth prevails.",
  });
  contextMcp = await startDummyMcpServer({
    name: "context",
    token: "ultimate-context-token",
    toolName: "context.poem",
    poem: "A quiet packet crossed the wire / And lit the agent's small campfire.",
  });

  const { config, org } = core.buildDemoFederationConfig();
  config.grants.push({
    id: "ultimate-dummy-mcp",
    resource: "mcp",
    servers: ["poetry", "context"],
    tools: ["poems.*", "context.*"],
    roles: ["executive"],
  });
  const packs = new Map(core.buildDemoAgentPacks(org).map((pack) => [pack.id, pack]));
  const allAgents = org.map((node) => node.id).sort();
  const children = childrenByManager(org);
  const parent = parentByAgent(org);
  const trace = core.createLashTrace();
  const task = ultimateTask;

  await mkdir(dirname(core.FEDERATION_PATH), { recursive: true });
  await Bun.write(core.FEDERATION_PATH, JSON.stringify(config, null, 2));
  for (const node of org) {
    await core.initProfile(node.id, { role: node.roles[0] ?? "agent", capabilities: node.roles });
    const pack = packs.get(node.id);
    assert(pack, `missing generated agent pack for ${node.id}`);
    const plugins = ultimatePluginMatrix[node.id]?.plugins ?? [];
    await core.writeAgentPack(node.id, {
      ...pack,
      model: {
        primary: { provider, id: model },
        fallback: [],
      },
      toolkit: {
        ...pack.toolkit,
        plugins,
        ...(node.id === "coo" ? { mcp: [...new Set([...pack.toolkit.mcp, "poetry", "context"])].sort() } : {}),
      },
    });
  }

  await core.updateAuthProfiles(core.GLOBAL_AUTH_PROFILES_PATH, (current) => ({
    ...current,
    providers: {
      ...current.providers,
      [provider]: {
        kind: "api_key",
        api_key: apiKey ?? "ultimate-stub-key",
        base_url: baseUrl,
        accounting: { mode: "free", note: "operator-provided Gemma smoke endpoint" },
      },
    },
  }));
  await core.saveMcpApiKeyCredential({ profile: "coo", server: "poetry", apiKey: poetryMcp.token });
  await core.saveMcpApiKeyCredential({ profile: "coo", server: "context", apiKey: contextMcp.token });
  await writeFile(
    join(workdir, ".mcp.json"),
    JSON.stringify({
      mcp: {
        poetry: { type: "remote", url: poetryMcp.url, enabled: true, headers: { Authorization: "Bearer" } },
        context: { type: "remote", url: contextMcp.url, enabled: true, headers: { Authorization: "Bearer" } },
      },
    }, null, 2),
  );

  console.log(`\nultimate head-node run`);
  console.log(`  mode      ${live ? "live" : "stubbed model stream"}`);
  console.log(`  agents    ${allAgents.length}`);
  console.log(`  provider  ${provider}`);
  console.log(`  model     ${model}`);
  console.log(`  trace     ${trace}`);

  const touched = new Set<string>();
  const headText = await cliPrompt([
      task,
      "You are the head node. Acknowledge BLACKGLASS and prepare to delegate through the org chart.",
      "Use the poetry MCP tool once to add a poem/evidence shard to context before delegating.",
      "Do not reveal credentials or secrets.",
    ].join("\n"));
  touched.add("coo");
  assert(headText.trim().length > 0, "head-node CLI -p run should produce assistant text");
  if (!live) assert(headText.includes("after tool result"), "stubbed ultimate head prompt should force a real MCP tool loop before returning text");

  const delegatedEdges: string[] = [];
  for (const from of breadthFirstManagers(children, "coo")) {
    for (const to of children.get(from) ?? []) {
      await callLash(core, {
        method: "delegate",
        from,
        to,
        trace,
        prompt: [
          task,
          `Manager @${from} is delegating the portion owned by @${to}.`,
          "Stay within your direct manager/direct report visibility and answer concisely.",
        ].join("\n"),
      });
      touched.add(to);
      delegatedEdges.push(`${from}->${to}`);
    }
  }

  const reportedEdges: string[] = [];
  for (const from of [...allAgents].sort((a, b) => depthOf(b, parent) - depthOf(a, parent))) {
    const to = parent.get(from);
    if (!to) continue;
    await callLash(core, {
      method: "report",
      from,
      to,
      trace,
      prompt: [
        task,
        `Report from @${from} to direct manager @${to}.`,
        "Include completed work, blockers, confidence, and whether further delegation is needed.",
      ].join("\n"),
    });
    reportedEdges.push(`${from}->${to}`);
  }

  const missing = allAgents.filter((agent) => !touched.has(agent));
  assert(missing.length === 0, `ultimate run did not touch every agent; missing: ${missing.join(", ")}`);

  const events = await core.queryEvents({ trace, limit: 2_000 });
  const allEvents = await core.queryEvents({ limit: 5_000 });
  const usageRecords = await core.queryUsageRecords({ limit: 5_000 });
  const usage = core.summarizeUsage(usageRecords);
  const runtimeContracts = await Promise.all(allAgents.map((agent) => core.resolveAgentRuntime(agent)));
  const lashCalls = events.filter((event) => event.type === "lash.call");
  const lashAllows = events.filter((event) => event.type === "lash.allow");
  const lashCallKeys = new Set(lashCalls.map(edgeKey));
  const lashAllowKeys = new Set(lashAllows.map(edgeKey));
  const promptStarts = allEvents.filter((event) => event.type === "prompt.run.start");
  assert(promptStarts.some((event) => event.actor === "coo"), "head-node -p should emit prompt.run.start for @coo");
  assert(allEvents.some((event) => event.type === "prompt.model.start" && event.actor === "coo" && JSON.stringify(event.payload).includes(provider) && JSON.stringify(event.payload).includes(model)), `head-node -p should start ${provider}/${model}`);
  assert(allEvents.some((event) => event.type === "mcp.tool.list" && event.actor === "coo" && event.resource === "mcp:poetry" && event.outcome === "success"), "head-node -p should discover the authenticated poetry MCP server");
  assert(allEvents.some((event) => event.type === "mcp.tool.call" && event.actor === "coo" && String(event.resource).includes("mcp:")), "head-node -p should execute at least one authenticated dummy MCP tool");
  assert(allEvents.some((event) => event.type === "prompt.tool.call" && event.actor === "coo" && String(event.resource).includes("tool:mcp_")), "head-node -p should route dummy MCP calls through the normal model tool path");
  assert(allAgents.every((agent) => usageRecords.some((record) => record.actor === agent)), "every agent should produce usage records during the ultimate traversal");
  assert(runtimeContracts.length === allAgents.length, "every agent should resolve a runtime contract during the ultimate run");
  assert(runtimeContracts.every((contract) => contract.profile && contract.head && contract.compute && contract.storage && contract.ingress && contract.workspace), "runtime contracts should expose head/compute/storage/ingress/workspace for every agent");
  const cooPlugins = await core.resolvePluginsForAgent("coo", repoRoot);
  assert(cooPlugins.plugins.some((plugin) => plugin.manifest.name === "github"), "@coo should resolve the GitHub plugin from toolkit.plugins");
  const matrixSummary: string[] = [];
  for (const [agent, expected] of Object.entries(ultimatePluginMatrix).sort(([a], [b]) => a.localeCompare(b))) {
    const resolved = await core.resolvePluginCapabilitiesForAgent(agent, repoRoot);
    assertArrayEqual(resolved.requested, expected.plugins, `@${agent} should request exactly its assigned matrix plugin(s)`);
    assertArrayEqual(resolved.plugins.map((plugin) => plugin.manifest.name), expected.plugins, `@${agent} should resolve exactly its assigned matrix plugin(s)`);
    assert(resolved.skills.length === expected.skills, `@${agent} expected ${expected.skills} plugin skills, got ${resolved.skills.length}`);
    assert(resolved.mcpConfigs.length === expected.mcp, `@${agent} expected ${expected.mcp} plugin MCP configs, got ${resolved.mcpConfigs.length}`);
    assert(resolved.commands.length === expected.commands, `@${agent} expected ${expected.commands} plugin CLI affordances, got ${resolved.commands.length}`);
    assert(resolved.tools.length === expected.tools, `@${agent} expected ${expected.tools} plugin custom tools, got ${resolved.tools.length}`);
    if (expected.tools && expected.plugins.some((name) => name.startsWith("ultimate-"))) {
      const result = await resolved.tools[0]!.execute({ value: agent }, { cwd: repoRoot });
      assert(result.includes(agent), `@${agent} plugin custom tool should execute with agent-specific input`);
    }
    matrixSummary.push(`${agent}:${expected.plugins.join("+") || "none"}[s${resolved.skills.length}/m${resolved.mcpConfigs.length}/c${resolved.commands.length}/t${resolved.tools.length}]`);
  }
  for (const agent of allAgents.filter((id) => !ultimatePluginMatrix[id])) {
    const resolved = await core.resolvePluginCapabilitiesForAgent(agent, repoRoot);
    assert(resolved.plugins.length === 0, `@${agent} should not receive a matrix plugin`);
  }
  assert(lashCalls.length >= delegatedEdges.length + reportedEdges.length, `expected at least ${delegatedEdges.length + reportedEdges.length} Lash calls, got ${lashCalls.length}`);
  assert(lashAllows.length >= delegatedEdges.length + reportedEdges.length, `expected at least ${delegatedEdges.length + reportedEdges.length} Lash allow events, got ${lashAllows.length}`);
  for (const edge of delegatedEdges) {
    assert(lashCallKeys.has(`delegate:${edge}`), `delegation edge ${edge} should have a matching lash.call event`);
    assert(lashAllowKeys.has(`delegate:${edge}`), `delegation edge ${edge} should have a matching lash.allow event`);
  }
  for (const edge of reportedEdges) {
    assert(lashCallKeys.has(`report:${edge}`), `report edge ${edge} should have a matching lash.call event`);
    assert(lashAllowKeys.has(`report:${edge}`), `report edge ${edge} should have a matching lash.allow event`);
  }
  assert(events.every((event) => !["lash.call", "lash.allow"].includes(event.type) || event.threadId), "every Lash call/allow event should preserve a thread id");

  for (const agent of allAgents) {
    const sessionsDir = join(usHome, "profiles", agent, "sessions");
    const hasSession = await directoryHasJsonl(sessionsDir);
    assert(hasSession, `@${agent} should have at least one persisted session after the ultimate run`);
    const memory = await core.queryMemoryEvents({ peer: agent, trace, limit: 100 });
    assert(memory.length > 0, `@${agent} should have trace-scoped memory events after delegation/report traversal`);
  }

  const apiSummary = await smashRuntimeApi(core, allAgents, trace);

  console.log(`\nultimate smoke passed`);
  console.log(`  head text bytes     ${headText.length}`);
  console.log(`  delegated edges     ${delegatedEdges.length}`);
  console.log(`  reported edges      ${reportedEdges.length}`);
  console.log(`  touched agents      ${touched.size}/${allAgents.length}`);
  console.log(`  lash call events    ${lashCalls.length}`);
  console.log(`  lash allow events   ${lashAllows.length}`);
  console.log(`  dummy mcp servers   poetry, context`);
  console.log(`  scoped plugins      ${matrixSummary.join(" ")}`);
  console.log(`  runtime api smash   ${apiSummary}`);
  console.log(`  model calls         ${usage.calls}`);
  console.log(`  tokens              ${usage.total} total · ${usage.input} in · ${usage.output} out · ${usage.reasoning} reasoning · ${usage.cacheRead} cache read · ${usage.cacheWrite} cache write`);
  console.log(`  cost                $${(usage.costMicroUsd / 1_000_000).toFixed(6)}`);
  if (keep) console.log(`  US_HOME             ${usHome}`);
} finally {
  if (previousAllowPrivateMcpUrls === undefined) delete process.env.US_MCP_ALLOW_PRIVATE_URLS;
  else process.env.US_MCP_ALLOW_PRIVATE_URLS = previousAllowPrivateMcpUrls;
  poetryMcp?.stop();
  contextMcp?.stop();
  if (!keep) {
    await rm(usHome, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
    for (const name of ultimateGeneratedPluginNames) await rm(join(repoRoot, "plugins", name), { recursive: true, force: true });
  }
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

async function cliPrompt(prompt: string): Promise<string> {
  const env = {
    ...process.env,
    US_HOME: usHome,
    US_MEMORY_SYNC: "0",
    US_MCP_ALLOW_PRIVATE_URLS: "1",
    ...(live ? {} : { US_STREAM_MODEL_STUB: "1" }),
  };
  const proc = Bun.spawn(["bun", "run", cli, "coo", "-p", prompt], {
    cwd: workdir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`head-node CLI -p exited ${code}: ${redact(stderr || stdout)}`);
  }
  return stdout;
}

async function smashRuntimeApi(
  core: typeof import("../packages/server/src/index.ts"),
  allAgents: string[],
  trace: string,
): Promise<string> {
  const token = "ultimate-runtime-token";
  const previousWebhookSecret = process.env.US_WEBHOOK_SECRET;
  process.env.US_WEBHOOK_SECRET = "ultimate-webhook-secret";
  const handler = core.createRuntimeFetchHandler({ cwd: workdir, authToken: token });

  try {
    const health = await runtimeJson(handler, "GET", "/health");
    assert(health.status === 200 && health.body.ok === true, "runtime API health should stay unauthenticated and live");

    const unauthorized = await runtimeJson(handler, "GET", "/api/agents");
    assert(unauthorized.status === 401 && unauthorized.body.error === "unauthorized", "runtime API should reject unsigned reads when a bearer token is configured");
    const bearerSmuggling = await runtimeJson(handler, "GET", "/api/agents", undefined, `${token} extra`);
    assert(bearerSmuggling.status === 401 && bearerSmuggling.body.error === "unauthorized", "runtime API should reject bearer token smuggling attempts");

    const runtimeInfo = await runtimeJson(handler, "GET", "/api/runtime", undefined, token);
    assert(runtimeInfo.status === 200 && runtimeInfo.body.profiles === allAgents.length, "runtime API should report the live profile count");
    const traversal = await runtimeJson(handler, "GET", "/api/agents/%2E%2E%2Fauth-profiles", undefined, token);
    assert(traversal.status === 400 && traversal.body.error === "invalid_profile", "runtime API should reject profile traversal during ultimate smash");
    const malformedPrompt = await runtimeRaw(handler, "POST", "/api/agents/coo/prompt", "{ nope", token, { "content-type": "application/json" });
    const malformedPromptBody = await malformedPrompt.json() as any;
    assert(malformedPrompt.status === 400 && malformedPromptBody.error === "malformed_json", "runtime API should reject malformed prompt JSON during ultimate smash");

    const agents = await runtimeJson(handler, "GET", "/api/agents", undefined, token);
    assert(agents.status === 200 && agents.body.agents.length === allAgents.length, "runtime API should return every materialized agent");

    const runtimes = await runtimeJson(handler, "GET", "/api/runtimes", undefined, token);
    assert(runtimes.status === 200 && runtimes.body.runtimes.length === allAgents.length, "runtime API should return every runtime contract");

    const ensure = await runtimeJson(handler, "POST", "/api/runtimes/coo/ensure", {}, token);
    assert(ensure.status === 200 && typeof ensure.body.workspacePath === "string" && ensure.body.workspacePath.endsWith("/workspaces/coo"), "runtime API should ensure a local COO workspace");

    const schedule = await runtimeJson(handler, "POST", "/api/scheduler/jobs", {
      owner: "coo",
      name: "BLACKGLASS runtime-created escalation",
      cron: "20 14 * * THU",
      timezone: "America/Los_Angeles",
      prompt: "Escalate the highest-risk BLACKGLASS release blocker and return one owner.",
      deliverables: ["risk", "owner", "deadline"],
      route: ["coo", "vp-eng", "dir-eng-infra"],
    }, token);
    assert(schedule.status === 201 && schedule.body.schedule?.route?.join(">") === "coo>vp-eng>dir-eng-infra", "runtime API should persist an ordered scheduler route");

    const due = await runtimeJson(handler, "GET", `/api/scheduler/due?profile=coo&now=${Date.UTC(2026, 3, 27, 9, 15)}`, undefined, token);
    assert(due.status === 200 && due.body.due.some((job: any) => job.id === "pulse:coo"), "runtime API should expose deterministic due scheduler jobs");

    const tick = await runtimeJson(handler, "POST", "/api/scheduler/tick", { now: Date.UTC(2026, 3, 27, 9, 45), profiles: ["mgr-finance-billing"] }, token);
    assert(tick.status === 200 && tick.body.runs.every((run: any) => run.status === "claimed"), "runtime API scheduler tick should claim due work without executing by default");

    const peerWake = await runtimeJson(handler, "POST", "/api/peers/vp-eng/wake", {
      caller: "coo",
      message: "BLACKGLASS runtime API peer wake: verify engineering readiness through the same server surface.",
      trace,
      wakeKind: "delegate",
      thread: core.createLashThread("vp-eng", trace),
    }, token);
    assert(peerWake.status === 202 && peerWake.body.result?.ok === true, "runtime API peer wake should route through the same Lash semantics");

    const memory = await runtimeJson(handler, "GET", `/api/memory?profile=vp-eng&trace=${trace}`, undefined, token);
    assert(memory.status === 200 && memory.body.memory.length > 0, "runtime API should expose trace-scoped memory after peer wake");

    const sessions = await runtimeJson(handler, "GET", "/api/sessions?profile=vp-eng", undefined, token);
    assert(sessions.status === 200 && sessions.body.sessions.length > 0, "runtime API should expose persisted sessions");

    const invalidFleet = await runtimeJson(handler, "POST", "/api/fleet/validate", {
      plan: {
        version: 1,
        kind: "union-street.fleet-plan",
        name: "invalid-blackglass",
        mission: "invalid",
        root: "cycle-a",
        generatedBy: "coo",
        agents: [
          { id: "cycle-a", displayName: "Cycle A", title: "A", manager: "cycle-b", groups: ["x"], roles: ["agent"], soul: "a", model: { provider: "codex", id: "gpt-5.4" } },
          { id: "cycle-b", displayName: "Cycle B", title: "B", manager: "cycle-a", groups: ["x"], roles: ["agent"], soul: "b", model: { provider: "codex", id: "gpt-5.4" } },
        ],
      },
    }, token);
    assert(invalidFleet.status === 200 && invalidFleet.body.validation?.ok === false, "runtime API fleet validation should reject invalid org graphs without writing profiles");

    const webhookBody = JSON.stringify({ actor: "vp-eng", subject: "blackglass", trace, status: "received" });
    const unsignedWebhook = await runtimeRaw(handler, "POST", "/api/webhooks/github", webhookBody, token, { "content-type": "application/json" });
    assert(unsignedWebhook.status === 401, "runtime API webhook ingress should require a signature when a webhook secret is configured");
    const signedWebhook = await runtimeRaw(handler, "POST", "/api/webhooks/github", webhookBody, token, {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "ultimate-webhook-secret").update(webhookBody).digest("hex")}`,
    });
    const signedWebhookBody = await signedWebhook.json() as any;
    assert(signedWebhook.status === 202 && signedWebhookBody.event?.type === "webhook.received", "runtime API webhook ingress should accept valid HMAC signatures and write audit events");

    const events = await runtimeJson(handler, "GET", `/api/events?trace=${trace}&limit=1000`, undefined, token);
    assert(events.status === 200 && events.body.events.some((event: any) => event.type === "lash.call"), "runtime API events should expose trace-linked Lash audit records");

    const usage = await runtimeJson(handler, "GET", `/api/usage?trace=${trace}&limit=1000`, undefined, token);
    assert(usage.status === 200 && usage.body.usage.length > 0 && usage.body.summary.calls > 0, "runtime API usage should expose trace-linked accounting summary");

    return [
      "health",
      "auth",
      `${agents.body.agents.length} agents`,
      `${runtimes.body.runtimes.length} runtimes`,
      "workspace",
      "scheduler",
      "peer-wake",
      "memory",
      "sessions",
      "fleet-validate",
      "webhook-hmac",
      "events",
      "usage",
    ].join("/");
  } finally {
    if (previousWebhookSecret === undefined) delete process.env.US_WEBHOOK_SECRET;
    else process.env.US_WEBHOOK_SECRET = previousWebhookSecret;
  }
}

async function runtimeJson(
  handler: RuntimeFetchHandler,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: any }> {
  const response = await runtimeRaw(
    handler,
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body),
    token,
    body === undefined ? undefined : { "content-type": "application/json" },
  );
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

async function createUltimateMatrixPlugins(): Promise<void> {
  const cases = [
    { name: "ultimate-skills-only", skills: true },
    { name: "ultimate-mcp-only", mcp: true },
    { name: "ultimate-cli-only", cli: true },
    { name: "ultimate-tools-only", tools: true },
    { name: "ultimate-tools-cli", tools: true, cli: true },
    { name: "ultimate-tools-skills", tools: true, skills: true },
    { name: "ultimate-tools-mcp", tools: true, mcp: true },
    { name: "ultimate-skills-mcp", skills: true, mcp: true },
    { name: "ultimate-skills-cli", skills: true, cli: true },
    { name: "ultimate-mcp-cli", mcp: true, cli: true },
    { name: "ultimate-skills-mcp-cli", skills: true, mcp: true, cli: true },
    { name: "ultimate-skills-mcp-tools", skills: true, mcp: true, tools: true },
    { name: "ultimate-skills-cli-tools", skills: true, cli: true, tools: true },
    { name: "ultimate-mcp-cli-tools", mcp: true, cli: true, tools: true },
    { name: "ultimate-all", skills: true, mcp: true, cli: true, tools: true },
  ];
  for (const item of cases) await createUltimatePlugin(item);
}

async function createUltimatePlugin(item: { name: string; skills?: boolean; mcp?: boolean; cli?: boolean; tools?: boolean }): Promise<void> {
  const pluginRoot = join(repoRoot, "plugins", item.name);
  await rm(pluginRoot, { recursive: true, force: true });
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(join(pluginRoot, "README.md"), `# ${item.name}\n`);
  const kind: string[] = [];
  const capabilities: Record<string, string[]> = {};
  const entrypoints: Record<string, string> = {};
  if (item.skills) {
    kind.push("skills");
    capabilities.skills = [`${item.name}-skill`];
    entrypoints.skills = "./skills";
    await mkdir(join(pluginRoot, "skills", `${item.name}-skill`), { recursive: true });
    await writeFile(join(pluginRoot, "skills", `${item.name}-skill`, "SKILL.md"), [
      "---",
      `name: ${item.name}-skill`,
      `description: ${item.name} ultimate skill`,
      "---",
      "",
      `# ${item.name} Skill`,
      "",
      "This skill exists to prove scoped plugin skill loading in the ultimate smoke.",
    ].join("\n"));
  }
  if (item.mcp) {
    kind.push("mcp");
    capabilities.mcp = [item.name];
    entrypoints.mcp = "./.mcp.json";
    await writeFile(join(pluginRoot, ".mcp.json"), JSON.stringify({
      mcpServers: {
        [item.name]: {
          command: "node",
          args: ["server.js"],
        },
      },
    }, null, 2));
  }
  if (item.cli) {
    capabilities.commands = [`${item.name} do`];
  }
  if (item.tools) {
    kind.push("tools");
    capabilities.tools = ["ping"];
    entrypoints.tools = "./tools";
    await mkdir(join(pluginRoot, "tools"), { recursive: true });
    await writeFile(join(pluginRoot, "tools", "ping.ts"), [
      "export default {",
      "  description: 'Ultimate matrix ping tool',",
      "  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },",
      "  async execute(args, context) { return `${context.plugin.name}:${args.value}`; }",
      "};",
    ].join("\n"));
  }
  await writeFile(join(pluginRoot, "unionstreet.plugin.json"), JSON.stringify({
    schema_version: "v1",
    name: item.name,
    version: "0.1.0",
    description: `${item.name} ultimate matrix plugin`,
    kind: kind.length ? [...new Set(kind)].sort() : ["apps"],
    capabilities,
    entrypoints,
    permissions: {},
  }, null, 2));
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
  for (let index = 0; index < queue.length; index++) {
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
    depth++;
    current = parent.get(current)!;
  }
  return depth;
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertArrayEqual(actual: string[], expected: string[], message: string): void {
  const left = [...actual].sort();
  const right = [...expected].sort();
  assert(left.length === right.length && left.every((value, index) => value === right[index]), `${message}: expected [${right.join(", ")}], got [${left.join(", ")}]`);
}

function edgeKey(event: { actor?: string; target?: string; payload?: unknown }): string {
  const method = typeof event.payload === "object" && event.payload && "method" in event.payload
    ? String((event.payload as { method?: unknown }).method)
    : "unknown";
  return `${method}:${event.actor}->${event.target}`;
}

function redact(value: string): string {
  const key = process.env.US_ULTIMATE_API_KEY;
  return key ? value.replaceAll(key, "[redacted]") : value;
}

async function loadLocalEnv(): Promise<void> {
  let raw = "";
  try {
    raw = await readFile(".env.local", "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    if (!key.startsWith("US_ULTIMATE_")) continue;
    process.env[key] ??= unquote(trimmed.slice(index + 1).trim());
  }
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
