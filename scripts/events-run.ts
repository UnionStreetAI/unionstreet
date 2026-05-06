#!/usr/bin/env bun
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = process.cwd();
const cli = join(repoRoot, "packages/us-cli/src/index.ts");
const usHome = await mkdtemp(join(tmpdir(), "union-street-events-"));
const workdir = await mkdtemp(join(tmpdir(), "union-street-events-work-"));

try {
  const env = { US_HOME: usHome, US_PEER_CALL_STUB: "1", US_MEMORY_SYNC: "0" };
  await cliRun(["federation", "demo-org", "--profiles", "--mcp"], env, workdir);
  await cliRun(["coo", "mcp", "auth", "linear", "--api-key", "linear-secret-token"], env, workdir);
  await cliRun(["mcp", "auth", "github", "--profile", "mgr-eng-platform", "--api-key", "github-secret-token"], env, workdir);

  process.env.US_HOME = usHome;
  process.env.US_PEER_CALL_STUB = "1";
  process.env.US_MEMORY_SYNC = "0";
  const core = await import("../packages/server/src/index.ts");

  const secretPath = join(usHome, "secrets/local.env");
  await core.writeGlobalConfig({
    default_profile: "coo",
    memory: { sync: { enabled: false } },
    secrets: {
      providers: {
        local: { type: "env_file", path: "$US_HOME/secrets/local.env" },
      },
      entries: {
        "github-engineering-write": {
          provider: "local",
          env: { GITHUB_TOKEN: "US_GITHUB_ENGINEERING_TOKEN" },
          audience: { groups: ["engineering"], roles: ["manager"] },
        },
      },
    },
  });
  await mkdir(dirname(secretPath), { recursive: true });
  await writeFile(secretPath, "US_GITHUB_ENGINEERING_TOKEN=github-runtime-secret\n", { mode: 0o600 });

  const managerPack = await core.readAgentPack("mgr-eng-platform");
  await core.writeAgentPack("mgr-eng-platform", {
    ...managerPack,
    runtime: { ...managerPack.runtime, secrets: ["github-engineering-write"] },
  });

  await core.writeEvent({
    type: "audit.test",
    actor: "coo",
    subject: "coo",
    outcome: "info",
    payload: {
      api_key: "must-not-leak",
      nested: { accessToken: "also-secret", harmless: "visible" },
    },
  });

  await core.ensureAgentWorkspace("mgr-eng-platform");
  const token = await core.mintFederatedAgentToken("vp-eng", { audience: ["union-street-demo"], ttlSeconds: 60 });
  await core.verifyFederatedAgentToken(token, { audience: "union-street-demo" });
  await assertRejects(
    () => core.verifyFederatedAgentToken(token, { audience: core.federatedAgentMcpAudience("coo") }),
    "audience mismatch",
  );

  const servers = [
    { name: "github", source: "events", enabled: true, transport: "remote" as const, url: "https://mcp.example.com/github", auth: "oauth" as const },
    { name: "linear", source: "events", enabled: true, transport: "remote" as const, url: "https://mcp.example.com/linear", auth: "oauth" as const },
    { name: "stripe", source: "events", enabled: false, transport: "remote" as const, url: "https://mcp.example.com/stripe", auth: "oauth" as const },
  ];
  await core.resolveMcpGrantsForAgent("coo", servers);
  await core.resolveMcpGrantsForAgent("mgr-eng-platform", servers);

  await core.callLashPeerTool({
    targetPeer: "vp-eng",
    method: "delegate",
    arguments: {
      from: "coo",
      prompt: "Events smoke delegate.",
      trace: "trace_events_allowed",
      thread: core.createLashThread("vp-eng", "trace_events_allowed"),
    },
  });
  await core.callLashPeerTool({
    targetPeer: "mgr-eng-platform",
    method: "delegate",
    arguments: {
      from: "vp-eng",
      prompt: "This should be denied.",
      trace: "trace_events_denied",
      thread: core.createLashThread("mgr-eng-platform", "trace_events_denied"),
    },
  });

  const all = await core.readEvents();
  assert(all.length >= 20, `expected lots of events, got ${all.length}`);
  assert(await has(core, { type: "mcp.auth.save", actor: "coo", resource: "mcp:linear" }), "missing coo Linear MCP auth event");
  assert(await has(core, { type: "mcp.auth.save", actor: "mgr-eng-platform", resource: "mcp:github" }), "missing manager GitHub MCP auth event");
  assert(await has(core, { type: "runtime.workspace.ensure", actor: "mgr-eng-platform" }), "missing workspace ensure event");
  assert(await has(core, { type: "secret.grant.resolve", actor: "mgr-eng-platform", resource: "secret:github-engineering-write", outcome: "allow" }), "missing secret allow event");
  assert(await has(core, { type: "secret.materialize", actor: "mgr-eng-platform", outcome: "success" }), "missing secret materialize event");
  assert(await has(core, { type: "federation.token.mint", actor: "vp-eng", outcome: "success" }), "missing token mint event");
  assert(await has(core, { type: "federation.token.verify", actor: "vp-eng", outcome: "success" }), "missing token verify event");
  assert(await has(core, { type: "federation.token.reject", actor: "vp-eng", outcome: "deny" }), "missing token reject event");
  assert(await has(core, { type: "federation.mcp.grant.resolve", actor: "mgr-eng-platform", resource: "mcp:linear", outcome: "deny" }), "missing MCP denial event");
  assert(await has(core, { type: "lash.call", actor: "coo", target: "vp-eng", trace: "trace_events_allowed" }), "missing Lash call event");
  assert(await has(core, { type: "lash.allow", actor: "coo", target: "vp-eng", trace: "trace_events_allowed", outcome: "allow" }), "missing Lash allow event");
  assert(await has(core, { type: "lash.deny", actor: "vp-eng", target: "mgr-eng-platform", trace: "trace_events_denied", outcome: "deny" }), "missing Lash deny event");
  assert(await has(core, { type: "memory.write", actor: "vp-eng", trace: "trace_events_allowed" }), "missing memory mirror event");

  const cooEvents = await core.queryEvents({ actor: "coo", limit: 100 });
  assert(cooEvents.every((event) => event.actor === "coo"), "actor query leaked non-coo events");
  const denied = await core.queryEvents({ outcome: "deny", limit: 100 });
  assert(denied.length >= 3, "expected multiple deny events");
  const trace = await core.queryEvents({ trace: "trace_events_allowed", limit: 100 });
  assert(trace.some((event) => event.type === "lash.allow"), "trace query should include Lash allow");
  const tail = await core.tailEvents(5);
  assert(tail.length === 5, "tailEvents should honor limit");
  assert(tail.every((event, index) => index === 0 || tail[index - 1]!.ts >= event.ts), "tailEvents should be newest first");

  const eventsFile = await stat(core.EVENTS_PATH);
  assert(eventsFile.isFile(), "events file should exist");
  assert((eventsFile.mode & 0o777) === 0o600, `events file mode should be 0600, got ${(eventsFile.mode & 0o777).toString(8)}`);
  const rawEvents = await readFile(core.EVENTS_PATH, "utf8");
  assert(!rawEvents.includes("linear-secret-token"), "MCP API key leaked into events");
  assert(!rawEvents.includes("github-secret-token"), "GitHub MCP API key leaked into events");
  assert(!rawEvents.includes("github-runtime-secret"), "runtime secret leaked into events");
  assert(!rawEvents.includes("must-not-leak"), "redaction failed for api_key payload");
  assert(!rawEvents.includes("also-secret"), "redaction failed for nested access token payload");

  const cliJson = await cliRun(["events", "query", "--agent", "coo", "--limit", "3", "--json"], env, workdir, { stdout: "pipe" });
  const parsed = JSON.parse(cliJson.stdout) as Array<{ actor?: string }>;
  assert(parsed.length <= 3, "events CLI should honor --limit");
  assert(parsed.every((event) => event.actor === "coo"), "events CLI --agent should filter actor");

  console.log(`\nEvents smoke passed with ${all.length} events at ${core.EVENTS_PATH}`);
} finally {
  await rm(usHome, { recursive: true, force: true });
  await rm(workdir, { recursive: true, force: true });
}

interface RunOptions {
  expectedCode?: number;
  stdout?: "inherit" | "pipe";
}

async function cliRun(
  args: string[],
  env: Record<string, string>,
  cwd: string,
  options: RunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  console.log(`\n$ us-dev ${args.join(" ")}`);
  const proc = Bun.spawn(["bun", "run", cli, ...args], {
    env: { ...process.env, ...env },
    cwd,
    stdout: options.stdout ?? "inherit",
    stderr: options.stdout === "pipe" ? "pipe" : "inherit",
  });
  const stdout = options.stdout === "pipe" ? await new Response(proc.stdout).text() : "";
  const stderr = options.stdout === "pipe" ? await new Response(proc.stderr).text() : "";
  const code = await proc.exited;
  const expected = options.expectedCode ?? 0;
  if (code !== expected) {
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    throw new Error(`Expected exit ${expected}, got ${code}`);
  }
  return { stdout, stderr };
}

async function has(
  core: typeof import("../packages/server/src/index.ts"),
  query: Parameters<typeof core.queryEvents>[0],
): Promise<boolean> {
  return (await core.queryEvents({ ...query, limit: 1000 })).length > 0;
}

async function assertRejects(fn: () => Promise<unknown>, messageNeedle: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = (error as Error).message;
    assert(message.includes(messageNeedle), `expected rejection to include "${messageNeedle}", got "${message}"`);
    return;
  }
  throw new Error(`expected promise to reject with "${messageNeedle}"`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
