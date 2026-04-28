#!/usr/bin/env bun
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

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

try {
  process.env.US_HOME = usHome;
  process.env.US_MEMORY_SYNC = "0";
  if (!live) process.env.US_STREAM_MODEL_STUB = "1";
  if (live && !apiKey) throw new Error("Live ultimate run requires US_ULTIMATE_API_KEY.");

  const core = await import("../packages/us-core/src/index.ts");
  const { config, org } = core.buildDemoFederationConfig();
  const packs = new Map(core.buildDemoAgentPacks(org).map((pack) => [pack.id, pack]));
  const allAgents = org.map((node) => node.id).sort();
  const children = childrenByManager(org);
  const parent = parentByAgent(org);
  const trace = core.createLashTrace();
  const task = [
    "Ultimate Union Street smoke task.",
    "Every agent should receive scoped work through its manager, preserve Lash visibility, and report concise readiness upward.",
    "Return only operational readiness, blockers, and the next action.",
  ].join(" ");

  await mkdir(dirname(core.FEDERATION_PATH), { recursive: true });
  await Bun.write(core.FEDERATION_PATH, JSON.stringify(config, null, 2));
  for (const node of org) {
    await core.initProfile(node.id, { role: node.roles[0] ?? "agent", capabilities: node.roles });
    const pack = packs.get(node.id);
    assert(pack, `missing generated agent pack for ${node.id}`);
    await core.writeAgentPack(node.id, {
      ...pack,
      model: {
        primary: { provider, id: model },
        fallback: [],
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

  console.log(`\nultimate head-node run`);
  console.log(`  mode      ${live ? "live" : "stubbed model stream"}`);
  console.log(`  agents    ${allAgents.length}`);
  console.log(`  provider  ${provider}`);
  console.log(`  model     ${model}`);
  console.log(`  trace     ${trace}`);

  const touched = new Set<string>();
  const headText = await cliPrompt([
      task,
      "You are the head node. Acknowledge the task and prepare to delegate through the org chart.",
      "Do not reveal credentials or secrets.",
    ].join("\n"));
  touched.add("coo");
  assert(headText.trim().length > 0, "head-node CLI -p run should produce assistant text");

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
  const lashCalls = events.filter((event) => event.type === "lash.call");
  const lashAllows = events.filter((event) => event.type === "lash.allow");
  const promptStarts = allEvents.filter((event) => event.type === "prompt.run.start");
  assert(promptStarts.some((event) => event.actor === "coo"), "head-node -p should emit prompt.run.start for @coo");
  assert(allEvents.some((event) => event.type === "prompt.model.start" && event.actor === "coo" && JSON.stringify(event.payload).includes(provider) && JSON.stringify(event.payload).includes(model)), `head-node -p should start ${provider}/${model}`);
  assert(lashCalls.length >= delegatedEdges.length + reportedEdges.length, `expected at least ${delegatedEdges.length + reportedEdges.length} Lash calls, got ${lashCalls.length}`);
  assert(lashAllows.length >= delegatedEdges.length + reportedEdges.length, `expected at least ${delegatedEdges.length + reportedEdges.length} Lash allow events, got ${lashAllows.length}`);

  for (const agent of allAgents) {
    const sessionsDir = join(usHome, "profiles", agent, "sessions");
    const hasSession = await directoryHasJsonl(sessionsDir);
    assert(hasSession, `@${agent} should have at least one persisted session after the ultimate run`);
  }

  console.log(`\nultimate smoke passed`);
  console.log(`  head text bytes     ${headText.length}`);
  console.log(`  delegated edges     ${delegatedEdges.length}`);
  console.log(`  reported edges      ${reportedEdges.length}`);
  console.log(`  touched agents      ${touched.size}/${allAgents.length}`);
  console.log(`  lash call events    ${lashCalls.length}`);
  console.log(`  lash allow events   ${lashAllows.length}`);
  console.log(`  model calls         ${usage.calls}`);
  console.log(`  tokens              ${usage.total} total · ${usage.input} in · ${usage.output} out · ${usage.reasoning} reasoning · ${usage.cacheRead} cache read · ${usage.cacheWrite} cache write`);
  console.log(`  cost                $${(usage.costMicroUsd / 1_000_000).toFixed(6)}`);
  if (keep) console.log(`  US_HOME             ${usHome}`);
} finally {
  if (!keep) {
    await rm(usHome, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }
}

async function callLash(
  core: typeof import("../packages/us-core/src/index.ts"),
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
