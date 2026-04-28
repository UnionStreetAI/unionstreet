import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { listProfiles } from "./profile.ts";
import { readAgentPack, type AgentPack, type AgentPackSchedule } from "./agent-pack.ts";
import { SCHEDULER_RUNS_PATH } from "./paths.ts";
import { writeEvent } from "./events.ts";
import { runAgentPrompt } from "./prompt-runner.ts";

export type SchedulerJobKind = "pulse" | "schedule";
export type SchedulerRunStatus = "claimed" | "running" | "complete" | "failed";

export interface SchedulerJob {
  id: string;
  kind: SchedulerJobKind;
  profile: string;
  name: string;
  prompt: string;
  deliverables: string[];
  cadence: string;
  timezone: string;
  enabled: boolean;
}

export interface DueSchedulerJob extends SchedulerJob {
  dueAt: number;
  dueKey: string;
}

export interface SchedulerRun {
  id: string;
  jobId: string;
  kind: SchedulerJobKind;
  profile: string;
  dueAt: number;
  dueKey: string;
  status: SchedulerRunStatus;
  ts: number;
  prompt: string;
  trace?: string;
  sessionId?: string;
  result?: unknown;
  error?: string;
}

export interface SchedulerExecutorResult {
  trace?: string;
  sessionId?: string;
  result?: unknown;
}

export type SchedulerExecutor = (job: DueSchedulerJob, run: SchedulerRun) => Promise<SchedulerExecutorResult | void>;

const PULSE_INTERVAL_MS = 30 * 60 * 1000;

export async function listSchedulerJobs(profiles?: string[]): Promise<SchedulerJob[]> {
  const profileList = profiles ?? await listProfiles();
  const out: SchedulerJob[] = [];
  for (const profile of profileList) {
    const pack = await readOptionalAgentPack(profile);
    if (!pack) continue;
    out.push(...jobsFromPack(pack));
  }
  return out.sort((a, b) => a.profile.localeCompare(b.profile) || a.id.localeCompare(b.id));
}

export async function dueSchedulerJobs(now = Date.now(), profiles?: string[]): Promise<DueSchedulerJob[]> {
  const jobs = (await listSchedulerJobs(profiles)).filter((job) => job.enabled);
  const runs = await readSchedulerRuns();
  const out: DueSchedulerJob[] = [];
  for (const job of jobs) {
    const dueAt = latestDueAt(job, now, runs);
    if (!dueAt) continue;
    const dueKey = `${job.id}@${dueAt}`;
    if (runs.some((run) => run.jobId === job.id && run.dueAt === dueAt && run.status !== "failed")) continue;
    const due = { ...job, dueAt, dueKey };
    out.push(due);
    await writeEvent({
      type: "scheduler.due",
      actor: job.profile,
      subject: job.profile,
      resource: job.id,
      outcome: "info",
      payload: { kind: job.kind, dueAt, dueKey, cadence: job.cadence },
    });
  }
  return out.sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
}

export async function claimDueSchedulerJobs(now = Date.now(), profiles?: string[]): Promise<SchedulerRun[]> {
  const due = await dueSchedulerJobs(now, profiles);
  const claimed: SchedulerRun[] = [];
  for (const job of due) {
    const run: SchedulerRun = {
      id: randomUUID(),
      jobId: job.id,
      kind: job.kind,
      profile: job.profile,
      dueAt: job.dueAt,
      dueKey: job.dueKey,
      status: "claimed",
      ts: Date.now(),
      prompt: job.prompt,
    };
    await appendSchedulerRun(run);
    await writeEvent({
      type: "scheduler.run.claim",
      actor: job.profile,
      subject: job.profile,
      resource: job.id,
      outcome: "success",
      payload: { runId: run.id, kind: job.kind, dueAt: job.dueAt, dueKey: job.dueKey },
    });
    claimed.push(run);
  }
  return claimed;
}

export async function executeSchedulerRun(
  run: SchedulerRun,
  executor: SchedulerExecutor = defaultSchedulerExecutor,
): Promise<SchedulerRun> {
  const job = (await listSchedulerJobs([run.profile])).find((candidate) => candidate.id === run.jobId);
  if (!job) throw new Error(`scheduler job "${run.jobId}" no longer exists`);
  const due: DueSchedulerJob = { ...job, dueAt: run.dueAt, dueKey: run.dueKey };
  const running: SchedulerRun = { ...run, status: "running", ts: Date.now() };
  await appendSchedulerRun(running);
  await writeEvent({
    type: "scheduler.run.start",
    actor: run.profile,
    subject: run.profile,
    resource: run.jobId,
    outcome: "info",
    payload: { runId: run.id, kind: run.kind, dueAt: run.dueAt },
  });

  try {
    const result = await executor(due, run);
    const complete: SchedulerRun = {
      ...run,
      status: "complete",
      ts: Date.now(),
      ...(result?.trace ? { trace: result.trace } : {}),
      ...(result?.sessionId ? { sessionId: result.sessionId } : {}),
      ...(result?.result !== undefined ? { result: result.result } : {}),
    };
    await appendSchedulerRun(complete);
    await writeEvent({
      type: "scheduler.run.complete",
      actor: run.profile,
      subject: run.profile,
      resource: run.jobId,
      trace: complete.trace,
      sessionId: complete.sessionId,
      outcome: "success",
      payload: { runId: run.id, kind: run.kind, dueAt: run.dueAt },
    });
    return complete;
  } catch (error) {
    const failed: SchedulerRun = {
      ...run,
      status: "failed",
      ts: Date.now(),
      error: (error as Error).message,
    };
    await appendSchedulerRun(failed);
    await writeEvent({
      type: "scheduler.run.fail",
      actor: run.profile,
      subject: run.profile,
      resource: run.jobId,
      outcome: "failure",
      reason: failed.error,
      payload: { runId: run.id, kind: run.kind, dueAt: run.dueAt },
    });
    return failed;
  }
}

export async function readSchedulerRuns(): Promise<SchedulerRun[]> {
  let raw: string;
  try {
    raw = await fs.readFile(SCHEDULER_RUNS_PATH, "utf8");
  } catch {
    return [];
  }
  const out: SchedulerRun[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SchedulerRun);
    } catch {
      // Keep the append log readable even if a partial line appears.
    }
  }
  return out;
}

async function appendSchedulerRun(run: SchedulerRun): Promise<void> {
  await fs.mkdir(dirname(SCHEDULER_RUNS_PATH), { recursive: true });
  await fs.appendFile(SCHEDULER_RUNS_PATH, JSON.stringify(run) + "\n", { mode: 0o600 });
}

async function defaultSchedulerExecutor(job: DueSchedulerJob, run: SchedulerRun): Promise<SchedulerExecutorResult> {
  const prompt = await runAgentPrompt({
    profile: job.profile,
    prompt: job.prompt,
    trace: `scheduler:${run.id}`,
    sessionId: `scheduler-${job.profile}-${job.kind}-${job.dueAt}`,
  });

  return {
    trace: prompt.trace,
    sessionId: prompt.sessionId,
    result: {
      text: prompt.text,
      provider: prompt.provider,
      model: prompt.model,
      steps: prompt.steps,
      toolCalls: prompt.toolCalls,
      usage: prompt.usage,
      deliverables: job.deliverables,
    },
  };
}

function jobsFromPack(pack: AgentPack): SchedulerJob[] {
  const jobs: SchedulerJob[] = [];
  if (pack.pulse.enabled) {
    jobs.push({
      id: `pulse:${pack.id}`,
      kind: "pulse",
      profile: pack.id,
      name: "Pulse",
      prompt: pack.pulse.instructions,
      deliverables: ["status summary", "material blockers", "next delegation or report action"],
      cadence: "every 30m",
      timezone: "local",
      enabled: true,
    });
  }
  for (const schedule of pack.schedule) {
    jobs.push(scheduleJob(pack, schedule));
  }
  return jobs;
}

function scheduleJob(pack: AgentPack, schedule: AgentPackSchedule): SchedulerJob {
  return {
    id: `schedule:${pack.id}:${schedule.id}`,
    kind: "schedule",
    profile: pack.id,
    name: schedule.name,
    prompt: schedule.prompt,
    deliverables: schedule.deliverables,
    cadence: schedule.cron,
    timezone: schedule.timezone,
    enabled: true,
  };
}

function latestDueAt(job: SchedulerJob, now: number, runs: SchedulerRun[]): number | undefined {
  if (job.kind === "pulse") {
    const lastTerminal = latestTerminalRun(job.id, runs);
    if (!lastTerminal) return floorToInterval(now, PULSE_INTERVAL_MS);
    const next = floorToInterval(lastTerminal.dueAt + PULSE_INTERVAL_MS, PULSE_INTERVAL_MS);
    return next <= now ? next : undefined;
  }
  return latestCronDueAt(job.cadence, now);
}

function latestTerminalRun(jobId: string, runs: SchedulerRun[]): SchedulerRun | undefined {
  return runs
    .filter((run) => run.jobId === jobId && (run.status === "complete" || run.status === "claimed" || run.status === "running"))
    .sort((a, b) => b.dueAt - a.dueAt)[0];
}

function floorToInterval(value: number, interval: number): number {
  return Math.floor(value / interval) * interval;
}

function latestCronDueAt(cron: string, now: number): number | undefined {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const [minuteRaw, hourRaw, _dom, _month, dowRaw] = parts;
  const minute = readCronNumber(minuteRaw, 0, 59);
  const hour = readCronNumber(hourRaw, 0, 23);
  if (minute === undefined || hour === undefined) return undefined;
  const allowedDow = readDowSet(dowRaw);
  if (!allowedDow) return undefined;
  const cursor = new Date(now);
  cursor.setSeconds(0, 0);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    if (cursor.getMinutes() === minute && cursor.getHours() === hour && allowedDow.has(cursor.getDay()) && cursor.getTime() <= now) {
      return cursor.getTime();
    }
    cursor.setMinutes(cursor.getMinutes() - 1);
  }
  return undefined;
}

function readCronNumber(value: string | undefined, min: number, max: number): number | undefined {
  if (!value || value === "*") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

function readDowSet(value: string | undefined): Set<number> | undefined {
  if (!value || value === "*") return new Set([0, 1, 2, 3, 4, 5, 6]);
  const map: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
  const out = new Set<number>();
  for (const part of value.split(",")) {
    const normalized = part.trim().toUpperCase();
    const n = map[normalized] ?? Number(normalized);
    if (!Number.isInteger(n) || n < 0 || n > 7) return undefined;
    out.add(n === 7 ? 0 : n);
  }
  return out;
}

async function readOptionalAgentPack(profile: string): Promise<AgentPack | undefined> {
  try {
    return await readAgentPack(profile);
  } catch {
    return undefined;
  }
}
