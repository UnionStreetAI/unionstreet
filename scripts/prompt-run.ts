#!/usr/bin/env bun
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = process.cwd();
const cli = join(repoRoot, "packages/us-cli/src/index.ts");
const usHome = await mkdtemp(join(tmpdir(), "union-street-prompt-"));
const workdir = await mkdtemp(join(tmpdir(), "union-street-prompt-work-"));

try {
  const env = {
    US_HOME: usHome,
    US_MEMORY_SYNC: "0",
    US_PEER_CALL_STUB: "1",
    US_STREAM_MODEL_STUB: "1",
  };
  await cliRun(["federation", "demo-org", "--profiles"], env, workdir);

  process.env.US_HOME = usHome;
  process.env.US_MEMORY_SYNC = "0";
  process.env.US_PEER_CALL_STUB = "1";
  process.env.US_STREAM_MODEL_STUB = "1";
  const core = await import("../packages/server/src/index.ts");

  const basic = await cliRun(["coo", "-p", "hello from prompt smoke"], env, workdir, { stdout: "pipe" });
  assert(
    basic.stdout.includes("stub response from codex/gpt-5.5: hello from prompt smoke"),
    "basic prompt should stream primary model response",
  );

  const firstSession = await newestSession(core, "coo");
  const firstSessionRaw = await readFile(firstSession.file, "utf8");
  assert(firstSessionRaw.includes("\"kind\":\"session_meta\""), "prompt session should persist metadata");
  assert(firstSessionRaw.includes("\"role\":\"user\""), "prompt session should persist user turn");
  assert(firstSessionRaw.includes("\"role\":\"assistant\""), "prompt session should persist assistant turn");
  assert(firstSessionRaw.includes("\"trace\":\""), "prompt session should persist trace");
  assert(firstSessionRaw.includes("\"runId\":\"coo:"), "prompt session should persist run id");
  assert(firstSessionRaw.includes("\"provider\":\"codex\""), "prompt session should persist provider");
  assert(firstSessionRaw.includes("\"model\":\"gpt-5.5\""), "prompt session should persist primary model");
  assert(await has(core, { type: "prompt.run.start", actor: "coo" }), "missing prompt start event");
  assert(await has(core, { type: "prompt.model.start", actor: "coo" }), "missing prompt model start event");
  assert(await has(core, { type: "prompt.run.complete", actor: "coo", outcome: "success" }), "missing prompt complete event");

  const tool = await cliRun(["coo", "-p", "please use ls tool"], env, workdir, { stdout: "pipe" });
  assert(tool.stdout.includes("after tool result"), "tool prompt should continue after tool result");
  const toolSession = await newestSession(core, "coo");
  const toolSessionRaw = await readFile(toolSession.file, "utf8");
  assert(toolSessionRaw.includes("\"role\":\"tool\""), "tool prompt should persist tool result");
  assert(toolSessionRaw.includes("\"name\":\"ls\""), "tool prompt should persist tool name");
  assert(await has(core, { type: "prompt.tool.call", actor: "coo", resource: "tool:ls" }), "missing prompt tool event");

  const fallbackEnv = { ...env, US_STREAM_MODEL_STUB_FAIL_PROVIDER: "codex/gpt-5.5" };
  const fallback = await cliRun(["coo", "-p", "fallback please"], fallbackEnv, workdir, { stdout: "pipe" });
  assert(
    fallback.stdout.includes("stub response from codex/gpt-5.4-mini: fallback please"),
    "retryable primary failure should fall back to the next model",
  );
  assert(fallback.stderr.includes("[fallback] codex/gpt-5.4-mini"), "fallback should be visible on stderr");
  const fallbackSession = await newestSession(core, "coo");
  const fallbackSessionRaw = await readFile(fallbackSession.file, "utf8");
  assert(fallbackSessionRaw.includes("\"model\":\"gpt-5.4-mini\""), "fallback session should record selected fallback model");
  assert(await has(core, { type: "prompt.model.fallback", actor: "coo" }), "missing prompt fallback event");

  const failEnv = {
    ...env,
    US_STREAM_MODEL_STUB_FAIL_PROVIDER: "codex/gpt-5.5,codex/gpt-5.4-mini",
  };
  await cliRun(["coo", "-p", "this should fail"], failEnv, workdir, { expectedCode: 1, stdout: "pipe" });
  assert(await has(core, { type: "prompt.run.fail", actor: "coo", outcome: "failure" }), "missing prompt failure event");

  const promptEvents = await core.queryEvents({
    type: [
      "prompt.run.start",
      "prompt.model.start",
      "prompt.model.fallback",
      "prompt.tool.call",
      "prompt.run.complete",
      "prompt.run.fail",
    ],
    actor: "coo",
    limit: 1000,
  });
  assert(promptEvents.length >= 13, `expected rich prompt event trail, got ${promptEvents.length}`);

  console.log(`\nPrompt smoke passed with ${promptEvents.length} prompt events under ${usHome}`);
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

async function newestSession(
  core: typeof import("../packages/server/src/index.ts"),
  profile: string,
): Promise<import("../packages/server/src/index.ts").SessionInfo> {
  const sessions = await core.listSessions(profile);
  assert(sessions.length > 0, `expected at least one session for ${profile}`);
  return sessions[0]!;
}

async function has(
  core: typeof import("../packages/server/src/index.ts"),
  query: Parameters<typeof core.queryEvents>[0],
): Promise<boolean> {
  return (await core.queryEvents({ ...query, limit: 1000 })).length > 0;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
