#!/usr/bin/env bun
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = process.cwd();
const cli = join(repoRoot, "packages/us-cli/src/index.ts");
const usHome = await mkdtemp(join(tmpdir(), "union-street-scheduler-"));
const workdir = await mkdtemp(join(tmpdir(), "union-street-scheduler-work-"));

try {
  const env = { US_HOME: usHome, US_PEER_CALL_STUB: "1", US_STREAM_MODEL_STUB: "1", US_MEMORY_SYNC: "0" };
  await cliRun(["federation", "demo-org", "--profiles"], env, workdir);

  process.env.US_HOME = usHome;
  process.env.US_PEER_CALL_STUB = "1";
  process.env.US_STREAM_MODEL_STUB = "1";
  process.env.US_MEMORY_SYNC = "0";
  const core = await import("../packages/us-core/src/index.ts");

  const monday0915 = Date.UTC(2026, 3, 27, 9, 15);
  const jobs = await core.listSchedulerJobs();
  const pulseJobs = jobs.filter((job) => job.kind === "pulse");
  const scheduleJobs = jobs.filter((job) => job.kind === "schedule");
  assert(jobs.length === 40, `expected 40 scheduler jobs, got ${jobs.length}`);
  assert(pulseJobs.length === 20, `expected 20 pulse jobs, got ${pulseJobs.length}`);
  assert(scheduleJobs.length === 20, `expected 20 schedule jobs, got ${scheduleJobs.length}`);
  assert(pulseJobs.every((job) => job.cadence === "every 30m"), "all pulse jobs should use fixed 30m cadence");

  const due = await core.dueSchedulerJobs(monday0915);
  assert(due.length === 40, `expected 40 jobs due on first scan, got ${due.length}`);
  assert(due.some((job) => job.id === "pulse:coo"), "coo pulse should be due");
  assert(due.some((job) => job.id === "schedule:coo:weekly-status"), "coo weekly schedule should be due");

  const claimed = await core.claimDueSchedulerJobs(monday0915);
  assert(claimed.length === 40, `expected 40 claimed jobs, got ${claimed.length}`);
  const claimedAgain = await core.claimDueSchedulerJobs(monday0915);
  assert(claimedAgain.length === 0, "claiming same due window twice should be idempotent");

  const cooPulse = claimed.find((run) => run.jobId === "pulse:coo");
  assert(cooPulse, "expected claimed coo pulse run");
  const complete = await core.executeSchedulerRun(cooPulse);
  assert(complete.status === "complete", "agent executor should complete coo pulse");
  assert(complete.trace?.startsWith("scheduler:"), "completed run should have scheduler trace");
  assert(complete.sessionId?.startsWith("scheduler-coo-pulse-"), `completed run should persist a scheduler session id, got ${complete.sessionId ?? "<none>"}`);
  assert(isPromptResult(complete.result), "completed scheduler run should store real prompt result metadata");
  assert(complete.result.text.includes("stub response from"), "completed scheduler run should contain model output text");
  assert(complete.result.provider === "codex", `expected scheduler run provider codex, got ${complete.result.provider}`);
  assert(complete.result.model === "gpt-5.5", `expected scheduler run model gpt-5.5 from the coo profile, got ${complete.result.model}`);
  assert(complete.result.steps === 1, `expected scheduler run to finish in one model step, got ${complete.result.steps}`);
  assert(complete.result.usage.total === 2, `expected scheduler run to persist token usage total 2, got ${complete.result.usage.total}`);

  const failRun = claimed.find((run) => run.jobId === "pulse:vp-eng");
  assert(failRun, "expected claimed vp-eng pulse run");
  const failed = await core.executeSchedulerRun(failRun, async () => {
    throw new Error("simulated scheduler failure");
  });
  assert(failed.status === "failed", "failing executor should mark run failed");
  assert(failed.error === "simulated scheduler failure", "failed run should record error");

  const firstPulseDueAt = cooPulse.dueAt;
  const nextDueTooEarly = await core.dueSchedulerJobs(firstPulseDueAt + 29 * 60 * 1000);
  assert(!nextDueTooEarly.some((job) => job.id === "pulse:coo"), "coo pulse should not be due before 30m");
  const nextDue = await core.dueSchedulerJobs(firstPulseDueAt + 31 * 60 * 1000);
  assert(nextDue.some((job) => job.id === "pulse:coo"), "coo pulse should be due after 30m");
  assert(!nextDue.some((job) => job.id === "schedule:coo:weekly-status"), "weekly schedule should not recur after 30m");

  const cooOnly = await core.dueSchedulerJobs(firstPulseDueAt + 31 * 60 * 1000, ["coo"]);
  assert(cooOnly.every((job) => job.profile === "coo"), "profile-scoped due query leaked another profile");

  const events = await core.queryEvents({ type: ["scheduler.due", "scheduler.run.claim", "scheduler.run.start", "scheduler.run.complete", "scheduler.run.fail"], limit: 1000 });
  assert(events.some((event) => event.type === "scheduler.due" && event.resource === "pulse:coo"), "missing scheduler due event");
  assert(events.some((event) => event.type === "scheduler.run.claim" && event.resource === "pulse:coo"), "missing scheduler claim event");
  assert(events.some((event) => event.type === "scheduler.run.start" && event.resource === "pulse:coo"), "missing scheduler start event");
  assert(events.some((event) => event.type === "scheduler.run.complete" && event.resource === "pulse:coo"), "missing scheduler complete event");
  assert(events.some((event) => event.type === "scheduler.run.fail" && event.resource === "pulse:vp-eng"), "missing scheduler fail event");

  const runs = await core.readSchedulerRuns();
  assert(runs.some((run) => run.status === "claimed"), "run log should contain claimed entries");
  assert(runs.some((run) => run.status === "running"), "run log should contain running entries");
  assert(runs.some((run) => run.status === "complete"), "run log should contain complete entries");
  assert(runs.some((run) => run.status === "failed"), "run log should contain failed entries");
  const runFile = await stat(core.SCHEDULER_RUNS_PATH);
  assert(runFile.isFile(), "scheduler run log should exist");
  assert((runFile.mode & 0o777) === 0o600, `scheduler run log should be 0600, got ${(runFile.mode & 0o777).toString(8)}`);

  const status = await cliRun(["scheduler", "status", "--profile", "coo", "--now", String(firstPulseDueAt + 31 * 60 * 1000)], env, workdir, { stdout: "pipe" });
  assert(status.stdout.includes("pulse:coo"), "scheduler CLI status should include pulse:coo");
  const tick = await cliRun(["scheduler", "tick", "--profile", "coo", "--now", String(firstPulseDueAt + 31 * 60 * 1000), "--execute"], env, workdir, { stdout: "pipe" });
  assert(tick.stdout.includes("claimed 1 scheduler run"), "scheduler CLI tick should claim one coo run");

  const rawRuns = await readFile(core.SCHEDULER_RUNS_PATH, "utf8");
  assert(!rawRuns.includes("api_key"), "scheduler run log should not contain secret-looking payloads");
  const afterCliRuns = await core.readSchedulerRuns();
  const cliComplete = afterCliRuns.find((run) => run.profile === "coo" && run.jobId === "pulse:coo" && run.status === "complete" && run.dueAt === firstPulseDueAt + 30 * 60 * 1000);
  assert(cliComplete, "scheduler CLI --execute should complete the claimed coo pulse");
  assert(isPromptResult(cliComplete.result), "scheduler CLI --execute should store real prompt result metadata");
  assert(cliComplete.result.text.includes("stub response from"), "scheduler CLI --execute should wake the agent model loop");
  assert(cliComplete.result.usage.total === 2, "scheduler CLI --execute should persist token usage for accounting");

  console.log(`\nScheduler smoke passed with ${runs.length} run-log entries at ${core.SCHEDULER_RUNS_PATH}`);
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isPromptResult(value: unknown): value is {
  text: string;
  provider: string;
  model: string;
  steps: number;
  toolCalls: unknown[];
  usage: { total: number; input: number; output: number };
  deliverables: unknown[];
} {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.text === "string"
    && typeof record.provider === "string"
    && typeof record.model === "string"
    && typeof record.steps === "number"
    && Array.isArray(record.toolCalls)
    && Boolean(record.usage)
    && typeof (record.usage as Record<string, unknown>).total === "number"
    && typeof (record.usage as Record<string, unknown>).input === "number"
    && typeof (record.usage as Record<string, unknown>).output === "number"
    && Array.isArray(record.deliverables);
}
