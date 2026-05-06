#!/usr/bin/env bun
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

type RuntimeCore = typeof import("../packages/server/src/index.ts");

await loadLocalEnv();

const keep = process.argv.includes("--keep");
const live = process.argv.includes("--live");
const agenticCoo = process.argv.includes("--agentic-coo");
const provider = process.env.US_ULTIMATE_PROVIDER ?? "custom-openai-compat:gemma-thurgood-cloud";
const model = process.env.US_ULTIMATE_MODEL ?? "google/gemma-4-31B-it";
const baseUrl = process.env.US_ULTIMATE_BASE_URL ?? "https://gemma.thurgood.cloud/v1/chat/completions";
const apiKey = process.env.US_ULTIMATE_API_KEY;
const liveConcurrency = Number(process.env.US_MEMORY_200_LIVE_CONCURRENCY ?? 8);
const usHome = await mkdtemp(join(tmpdir(), "union-street-memory-200-"));
const receivedMemoryEvents: any[] = [];
const sink = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    try {
      const body = await request.json();
      receivedMemoryEvents.push(body);
      return Response.json({ ok: true });
    } catch (error) {
      return Response.json({ error: "bad_json", message: (error as Error).message }, { status: 400 });
    }
  },
});

try {
  if (live && !apiKey) throw new Error("Live 200-agent memory run requires US_ULTIMATE_API_KEY in env or .env.local.");
  if (agenticCoo && !live) throw new Error("Agentic COO mode requires --live because stubbed model streams do not make delegation decisions.");
  process.env.US_HOME = usHome;
  if (live) {
    delete process.env.US_PEER_CALL_STUB;
    delete process.env.US_STREAM_MODEL_STUB;
  } else {
    process.env.US_PEER_CALL_STUB = "1";
    process.env.US_STREAM_MODEL_STUB = "1";
  }
  process.env.US_MEMORY_SYNC = "1";
  process.env.US_MEMORY_SYNC_URL = `${sink.url}v1/workspaces/blackglass/events`;
  process.env.US_USAGE_DISABLE_MODELS_DEV_COSTS = "1";
  if (agenticCoo) {
    process.env.US_AGENTIC_PEER_WAKE = "1";
    process.env.US_AGENTIC_PEER_MAX_STEPS ??= "6";
  }

  const core = await import("../packages/server/src/index.ts");
  await core.updateAuthProfiles(core.GLOBAL_AUTH_PROFILES_PATH, (current) => ({
    ...current,
    providers: {
      ...current.providers,
      [provider]: {
        kind: "api_key",
        api_key: apiKey ?? "memory-200-stub-key",
        base_url: baseUrl,
        accounting: { mode: "free", note: "operator-provided Thurgood/Gemma fleet run endpoint" },
      },
    },
  }));
  const plan = buildTwoHundredAgentFleetPlan();
  const startedAt = Date.now();
  const applied = await core.applyFleetPlan(plan, { overwrite: true });
  assert(applied.validation.ok, `200-agent fleet should validate: ${applied.validation.errors.join("; ")}`);
  assert(applied.profiles.length === 200, `expected to materialize 200 profiles, got ${applied.profiles.length}`);
  await writeOrgAgentGuides(core, plan.agents);
  const materializedAt = Date.now();

  const agents = plan.agents.map((agent) => agent.id).sort();
  const children = childrenByManager(plan.agents);
  const parent = parentByAgent(plan.agents);
  const trace = core.createLashTrace();
  const task = crazyTask(trace);

  console.log("\n200-agent memory sync run");
  console.log(`  agents       ${agents.length}`);
  console.log(`  mode         ${agenticCoo ? "agentic coo" : live ? "live model" : "stubbed model"}`);
  console.log(`  provider     ${provider}`);
  console.log(`  model        ${model}`);
  if (live) console.log(`  concurrency  ${liveConcurrency}`);
  console.log("  memory sync  enabled");
  console.log(`  sink         ${process.env.US_MEMORY_SYNC_URL}`);
  console.log(`  trace        ${trace}`);

  if (agenticCoo) {
    await runAgenticCooMission(core, agents, trace, task, startedAt, materializedAt);
  } else {
    await runForcedTraversal(core, agents, children, parent, trace, task, startedAt, materializedAt);
  }
} finally {
  sink.stop(true);
  delete process.env.US_MEMORY_SYNC_URL;
  delete process.env.US_AGENTIC_PEER_WAKE;
  if (!keep) await rm(usHome, { recursive: true, force: true });
}

async function runForcedTraversal(
  core: RuntimeCore,
  agents: string[],
  children: Map<string, string[]>,
  parent: Map<string, string>,
  trace: string,
  task: string,
  startedAt: number,
  materializedAt: number,
): Promise<void> {
  const downByDepth = new Map<number, number>();
  const upByDepth = new Map<number, number>();
  const responseSamples: Array<{ edge: string; bytes: number; text: string }> = [];
  const delegatedEdges: string[] = [];
  const delegateStartedAt = Date.now();
  for (const from of breadthFirstManagers(children, "coo")) {
    const calls = (children.get(from) ?? []).map((to) => async () => {
      const text = await callLash(core, {
        method: "delegate",
        from,
        to,
        trace,
        prompt: [
          task,
          `Delegation from @${from} to @${to}: own your shard of the BLACKGLASS HYDRA incident.`,
          "Return exactly: scope, evidence, blast radius, rollback condition, memory note, confidence, next action.",
          live ? "Hard cap: 80 words. No preamble." : "",
        ].join("\n"),
      });
      const edge = `${from}->${to}`;
      downByDepth.set(depthOf(to, parent), (downByDepth.get(depthOf(to, parent)) ?? 0) + 1);
      maybeSample(responseSamples, edge, text);
      delegatedEdges.push(`${from}->${to}`);
    });
    await runInBatches(calls, live ? liveConcurrency : 32, live ? `delegate ${from}` : undefined);
  }
  const delegatedAt = Date.now();

  const reportedEdges: string[] = [];
  const reportCalls = [...agents]
    .sort((a, b) => depthOf(b, parent) - depthOf(a, parent))
    .flatMap((from) => {
      const to = parent.get(from);
      if (!to) return [];
      return [async () => {
        const text = await callLash(core, {
          method: "report",
          from,
          to,
          trace,
          prompt: [
            task,
            `Report from @${from} to @${to}: collapse your shard into command-ready evidence.`,
            "Do not hide uncertainty. Name the single thing that would break production first.",
            live ? "Hard cap: 80 words. No preamble." : "",
          ].join("\n"),
        });
        const edge = `${from}->${to}`;
        upByDepth.set(depthOf(from, parent), (upByDepth.get(depthOf(from, parent)) ?? 0) + 1);
        maybeSample(responseSamples, edge, text);
        reportedEdges.push(edge);
      }];
    });
  await runInBatches(reportCalls, live ? liveConcurrency : 32, live ? "report up" : undefined);
  const reportedAt = Date.now();

  const events = await core.queryEvents({ trace, limit: 20_000 });
  const usage = await core.queryUsageRecords({ trace, limit: 20_000 });
  const memoryCounts = new Map<string, number>();
  for (const agent of agents) {
    const memory = await core.queryMemoryEvents({ peer: agent, trace, limit: 1_000 });
    memoryCounts.set(agent, memory.length);
  }
  const missingMemory = agents.filter((agent) => (memoryCounts.get(agent) ?? 0) === 0);
  const lashCalls = events.filter((event) => event.type === "lash.call");
  const memoryWrites = events.filter((event) => event.type === "memory.write");
  const syncedTraceEvents = receivedMemoryEvents.filter((item) => item?.event?.trace === trace);
  const providers = new Set(receivedMemoryEvents.map((item) => item?.provider));
  const workspaces = new Set(receivedMemoryEvents.map((item) => item?.workspaceId));
  const auditedAt = Date.now();

  assert(delegatedEdges.length === 199, `expected 199 delegated edges, got ${delegatedEdges.length}`);
  assert(reportedEdges.length === 199, `expected 199 report edges, got ${reportedEdges.length}`);
  assert(lashCalls.length === 398, `expected 398 Lash calls, got ${lashCalls.length}`);
  assert(usage.length === 398, `expected 398 Lash usage records, got ${usage.length}`);
  assert(missingMemory.length === 0, `every agent should have trace-scoped memory; missing ${missingMemory.join(", ")}`);
  assert(memoryWrites.length >= 398 * 3, `expected at least ${398 * 3} trace-scoped memory.write audit events, got ${memoryWrites.length}`);
  assert(receivedMemoryEvents.length >= 398 * 4, `expected memory sink to receive session metadata plus trace events, got ${receivedMemoryEvents.length}`);
  assert(syncedTraceEvents.length >= 398 * 3, `expected remote memory sink to receive trace events, got ${syncedTraceEvents.length}`);
  assert(providers.has("honcho"), `memory sync should identify honcho provider, got ${[...providers].join(", ")}`);
  assert(workspaces.size >= 180, `memory sync should preserve per-agent workspace ids, got ${workspaces.size}`);

  console.log("200-agent memory sync passed");
  console.log(`  delegated    ${delegatedEdges.length}`);
  console.log(`  reported     ${reportedEdges.length}`);
  console.log(`  lash calls   ${lashCalls.length}`);
  console.log(`  usage        ${usage.length}`);
  console.log(`  memory audit ${memoryWrites.length}`);
  console.log(`  sink posts   ${receivedMemoryEvents.length}`);
  console.log(`  trace posts  ${syncedTraceEvents.length}`);
  console.log(`  workspaces   ${workspaces.size}`);
  console.log(`  down layers  ${formatDepths(downByDepth)}`);
  console.log(`  up layers    ${formatDepths(upByDepth)}`);
  console.log(`  timings      materialize=${materializedAt - startedAt}ms delegate=${delegatedAt - delegateStartedAt}ms report=${reportedAt - delegatedAt}ms audit=${auditedAt - reportedAt}ms total=${auditedAt - startedAt}ms`);
  console.log(`  throughput   ${((delegatedEdges.length + reportedEdges.length) / Math.max(1, (reportedAt - delegateStartedAt) / 1000)).toFixed(2)} lash/s · ${(receivedMemoryEvents.length / Math.max(1, (auditedAt - delegateStartedAt) / 1000)).toFixed(2)} memory-posts/s`);
  for (const sample of responseSamples) {
    console.log(`  sample       ${sample.edge} ${sample.bytes}B ${sample.text.replace(/\s+/g, " ").slice(0, 180)}`);
  }
  console.log(`  us_home      ${usHome}${keep ? " (kept)" : ""}`);
}

async function runAgenticCooMission(
  core: RuntimeCore,
  agents: string[],
  trace: string,
  task: string,
  startedAt: number,
  materializedAt: number,
): Promise<void> {
  const missionStartedAt = Date.now();
  const result = await core.runAgentPrompt({
    profile: "coo",
    trace,
    sessionId: `agentic-coo-${trace}`,
    model: { provider, id: model },
    maxSteps: Number(process.env.US_AGENTIC_COO_MAX_STEPS ?? 18),
    prompt: [
      task,
      "",
      "You are @coo. You own this incident, but you should not blast every agent by default.",
      "Decide which VPs or direct reports to delegate to. Give them self-contained tasks.",
      "You must delegate to at least one direct report because the incident spans domains you cannot verify alone.",
      "Ask delegates to use their own judgment and delegate further only if their shard requires it.",
      "Stop when you have enough evidence to produce a decision-ready command brief.",
      "Hard cap final response: 300 words.",
    ].join("\n"),
  });
  const missionCompletedAt = Date.now();
  const events = await core.queryEvents({ trace, limit: 20_000 });
  const usage = await core.queryUsageRecords({ trace, limit: 20_000 });
  const lashCalls = events.filter((event) => event.type === "lash.call");
  const lashAllows = events.filter((event) => event.type === "lash.allow");
  const toolCalls = events.filter((event) => event.type === "prompt.tool.call");
  const memoryWrites = events.filter((event) => event.type === "memory.write");
  const syncedTraceEvents = receivedMemoryEvents.filter((item) => item?.event?.trace === trace);
  const touched = new Set<string>(["coo"]);
  for (const event of events) {
    if (event.actor) touched.add(event.actor);
    if (event.target) touched.add(event.target);
  }
  const layers = new Map<number, number>();
  const parent = parentByAgent(buildTwoHundredAgentFleetPlan().agents);
  for (const agent of touched) layers.set(depthOf(agent, parent), (layers.get(depthOf(agent, parent)) ?? 0) + 1);

  assert(result.text.trim().length > 0, "agentic COO mission should produce a final response");
  assert(lashCalls.length > 0, "agentic COO should delegate at least once instead of only answering locally");
  assert(syncedTraceEvents.length > 0, "agentic COO mission should produce trace-scoped memory sync events");

  console.log("agentic COO mission passed");
  console.log(`  touched      ${touched.size}/${agents.length}`);
  console.log(`  layers       ${formatDepths(layers)}`);
  console.log(`  lash calls   ${lashCalls.length}`);
  console.log(`  lash allows  ${lashAllows.length}`);
  console.log(`  tool calls   ${toolCalls.length}`);
  console.log(`  usage        ${usage.length}`);
  console.log(`  memory audit ${memoryWrites.length}`);
  console.log(`  trace posts  ${syncedTraceEvents.length}`);
  console.log(`  timings      materialize=${materializedAt - startedAt}ms mission=${missionCompletedAt - missionStartedAt}ms total=${missionCompletedAt - startedAt}ms`);
  console.log(`  final        ${result.text.replace(/\s+/g, " ").slice(0, 800)}`);
  console.log(`  us_home      ${usHome}${keep ? " (kept)" : ""}`);
}

function buildTwoHundredAgentFleetPlan() {
  const groups = ["engineering", "operations", "go-to-market", "finance", "security", "support", "platform", "data", "legal"];
  const agents: any[] = [{
    id: "coo",
    displayName: "COO Agent",
    title: "Blackglass Incident Commander",
    groups: ["executives"],
    roles: ["executive", "commander"],
    soul: "Own the BLACKGLASS incident end to end. Preserve traces, memory, and chain of command.",
    model: { provider, id: model },
  }];

  const vps = Array.from({ length: 9 }, (_, index) => addAgent({
    id: `vp-${slug(groups[index]!)}`,
    manager: "coo",
    displayName: `${title(groups[index]!)} VP Agent`,
    title: `${title(groups[index]!)} Vice President`,
    groups: [groups[index]!],
    roles: ["vp", "manager"],
  }));
  const directors = Array.from({ length: 30 }, (_, index) => addAgent({
    id: `dir-${index.toString().padStart(2, "0")}`,
    manager: vps[index % vps.length]!.id,
    displayName: `Director ${index.toString().padStart(2, "0")} Agent`,
    title: `Incident Director ${index.toString().padStart(2, "0")}`,
    groups: [groups[index % groups.length]!],
    roles: ["director", "manager"],
  }));
  const managers = Array.from({ length: 60 }, (_, index) => addAgent({
    id: `mgr-${index.toString().padStart(2, "0")}`,
    manager: directors[index % directors.length]!.id,
    displayName: `Manager ${index.toString().padStart(2, "0")} Agent`,
    title: `Response Manager ${index.toString().padStart(2, "0")}`,
    groups: [groups[index % groups.length]!],
    roles: ["manager"],
  }));
  Array.from({ length: 100 }, (_, index) => addAgent({
    id: `ic-${index.toString().padStart(3, "0")}`,
    manager: managers[index % managers.length]!.id,
    displayName: `Specialist ${index.toString().padStart(3, "0")} Agent`,
    title: `Blast-Radius Specialist ${index.toString().padStart(3, "0")}`,
    groups: [groups[index % groups.length]!],
    roles: ["agent", index % 5 === 0 ? "operator" : "specialist"],
  }));

  function addAgent(input: {
    id: string;
    manager: string;
    displayName: string;
    title: string;
    groups: string[];
    roles: string[];
  }) {
    const agent = {
      ...input,
      soul: `You are ${input.displayName}. Handle only your shard, preserve Lash trace, and write memory-worthy evidence.`,
      model: { provider, id: model },
      memory: { provider: "honcho", peerProfile: input.id, sharedNamespaces: ["blackglass", ...input.groups.map((group) => `group:${group}`)] },
      pulse: { enabled: true, cadence: "every 30m", instructions: "Check BLACKGLASS blockers, write memory, and report only material changes." },
    };
    agents.push(agent);
    return agent;
  }

  return {
    version: 1,
    kind: "union-street.fleet-plan",
    name: "blackglass-200-memory",
    mission: "Two hundred agents execute a memory-synced BLACKGLASS enterprise incident drill.",
    root: "coo",
    generatedBy: "memory-200-run",
    agents,
  };
}

function crazyTask(trace: string): string {
  return [
    "BLACKGLASS HYDRA 200-AGENT INCIDENT.",
    `Trace: ${trace}`,
    "A production release, plugin rollout, runtime migration, customer escalation, billing reconciliation, security investigation, and memory-sync migration are all failing at once.",
    "The org must split the work without losing chain-of-command, leaking secrets, fabricating cloud success, or dropping memory writes.",
    "Assume partial outage: GitHub webhooks are delayed, Vercel and Docker sandboxes disagree, Daytona is paused, Stripe invoices are duplicated, Neon read replicas lag, and legal needs an audit packet in one hour.",
    "Each agent must preserve the trace, write memory-worthy evidence, state confidence, and identify the first production breaker in its shard.",
  ].join("\n");
}

function childrenByManager(agents: Array<{ id: string; manager?: string }>): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const agent of agents) {
    if (!agent.manager) continue;
    const existing = children.get(agent.manager) ?? [];
    existing.push(agent.id);
    children.set(agent.manager, existing);
  }
  return children;
}

function parentByAgent(agents: Array<{ id: string; manager?: string }>): Map<string, string> {
  const parent = new Map<string, string>();
  for (const agent of agents) if (agent.manager) parent.set(agent.id, agent.manager);
  return parent;
}

async function writeOrgAgentGuides(core: RuntimeCore, agents: Array<{ id: string; manager?: string; title: string; groups: string[] }>): Promise<void> {
  const children = childrenByManager(agents);
  for (const agent of agents) {
    const directReports = children.get(agent.id) ?? [];
    await writeFile(core.profilePaths(agent.id).agents, [
      "# AGENTS",
      "",
      `You are @${agent.id} (${agent.title}).`,
      agent.manager ? `Your manager is @${agent.manager}. Use the report tool only for material upward truth.` : "You are the root incident commander.",
      directReports.length
        ? `Your direct reports are: ${directReports.map((id) => `@${id}`).join(", ")}. Use delegate only with these exact peer ids unless org visibility explicitly lists another target.`
        : "You have no direct reports. Do not delegate unless a visible peer is explicitly listed by the runtime.",
      `Groups: ${agent.groups.join(", ") || "(none)"}.`,
      "Do not invent peer ids such as researcher. If a needed role is absent, report that staffing gap.",
      "When using delegate, make one tool call per peer with a single JSON object.",
      "Always preserve the Lash trace.",
    ].join("\n") + "\n");
  }
}

function breadthFirstManagers(children: Map<string, string[]>, root: string): string[] {
  const managers: string[] = [];
  const queue = [root];
  while (queue.length) {
    const current = queue.shift()!;
    const directReports = children.get(current) ?? [];
    if (directReports.length) managers.push(current);
    queue.push(...directReports);
  }
  return managers;
}

function depthOf(agent: string, parent: Map<string, string>): number {
  let depth = 0;
  let cursor = agent;
  while (parent.has(cursor)) {
    depth += 1;
    cursor = parent.get(cursor)!;
  }
  return depth;
}

async function callLash(
  core: RuntimeCore,
  input: { method: "delegate" | "report"; from: string; to: string; trace: string; prompt: string },
): Promise<string> {
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
  assert(structured?.kind !== "error", `${input.method} ${input.from}->${input.to} failed: ${structured?.error?.message ?? "unknown Lash error"}`);
  const content = (result as any).content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part?.text === "string" ? part.text : "").filter(Boolean).join("\n");
}

async function runInBatches(tasks: Array<() => Promise<void>>, size: number, label?: string): Promise<void> {
  const started = Date.now();
  for (let index = 0; index < tasks.length; index += size) {
    await Promise.all(tasks.slice(index, index + size).map((task) => task()));
    if (label) {
      const done = Math.min(index + size, tasks.length);
      console.log(`  progress     ${label} ${done}/${tasks.length} ${Date.now() - started}ms`);
    }
  }
}

function slug(value: string): string {
  return value.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function title(value: string): string {
  return value.split("-").map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(" ");
}

function formatDepths(depths: Map<number, number>): string {
  return [...depths.entries()].sort(([a], [b]) => a - b).map(([depth, count]) => `d${depth}:${count}`).join(" ");
}

function maybeSample(samples: Array<{ edge: string; bytes: number; text: string }>, edge: string, text: string): void {
  if (samples.length >= 8) return;
  samples.push({ edge, bytes: text.length, text });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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
