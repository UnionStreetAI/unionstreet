import kleur from "kleur";
import {
  claimDueSchedulerJobs,
  dueSchedulerJobs,
  executeSchedulerRun,
  listSchedulerJobs,
  readSchedulerRuns,
} from "@unionstreet/server";

interface SchedulerOptions {
  profile?: string;
  now?: string | number;
  execute?: boolean;
}

export async function schedulerCommand(action: string | undefined, options: SchedulerOptions = {}): Promise<void> {
  const profiles = options.profile ? [options.profile.replace(/^@+/, "")] : undefined;
  const now = readNow(options.now);
  switch (action ?? "status") {
    case "status":
      await schedulerStatus(profiles, now);
      return;
    case "due":
      await printDue(await dueSchedulerJobs(now, profiles));
      return;
    case "tick": {
      const claimed = await claimDueSchedulerJobs(now, profiles);
      if (options.execute) {
        for (const run of claimed) await executeSchedulerRun(run);
      }
      console.log(kleur.green(`claimed ${claimed.length} scheduler run${claimed.length === 1 ? "" : "s"}`));
      return;
    }
    case "runs":
      await printRuns(await readSchedulerRuns());
      return;
    default:
      throw new Error(`Unknown scheduler action "${action}". Try: status | due | tick | runs`);
  }
}

async function schedulerStatus(profiles: string[] | undefined, now: number): Promise<void> {
  const jobs = await listSchedulerJobs(profiles);
  const due = await dueSchedulerJobs(now, profiles);
  console.log("");
  console.log(kleur.bold("scheduler"));
  console.log(`  jobs ${kleur.cyan(String(jobs.length))}  due ${due.length ? kleur.yellow(String(due.length)) : kleur.dim("0")}`);
  for (const job of jobs) {
    const isDue = due.some((item) => item.id === job.id);
    console.log(`  ${isDue ? kleur.yellow("due") : kleur.dim("   ")} ${kleur.cyan(job.id.padEnd(34))} @${job.profile}  ${kleur.dim(job.cadence)}`);
  }
  console.log("");
}

async function printDue(due: Awaited<ReturnType<typeof dueSchedulerJobs>>): Promise<void> {
  console.log("");
  console.log(kleur.bold("due scheduler jobs"));
  if (!due.length) console.log(kleur.dim("  none"));
  for (const job of due) {
    console.log(`  ${kleur.yellow("due")} ${kleur.cyan(job.id)} @${job.profile} ${kleur.dim(new Date(job.dueAt).toISOString())}`);
  }
  console.log("");
}

async function printRuns(runs: Awaited<ReturnType<typeof readSchedulerRuns>>): Promise<void> {
  console.log("");
  console.log(kleur.bold("scheduler runs"));
  if (!runs.length) console.log(kleur.dim("  none"));
  for (const run of runs.slice(-50).reverse()) {
    const color = run.status === "failed" ? kleur.red : run.status === "complete" ? kleur.green : kleur.yellow;
    console.log(`  ${color(run.status.padEnd(8))} ${kleur.cyan(run.jobId)} @${run.profile} ${kleur.dim(new Date(run.ts).toISOString())}`);
  }
  console.log("");
}

function readNow(value: string | number | undefined): number {
  if (value === undefined) return Date.now();
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) throw new Error(`Invalid --now value "${value}". Use epoch seconds/ms or ISO date.`);
  return parsed;
}
