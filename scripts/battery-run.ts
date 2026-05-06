#!/usr/bin/env bun

interface Task {
  name: string;
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
}

interface Tier {
  name: string;
  description: string;
  stages: Array<{ name: string; tasks: Task[] }>;
}

const repoRoot = process.cwd();
const args = new Set(process.argv.slice(2));
const requestedTier = readTier();

const smokeTasks: Task[] = [
  { name: "check:parallel", cmd: ["bun", "run", "check:parallel"] },
];

const adversarialTasks: Task[] = [
  { name: "stress", cmd: ["bun", "run", "test:stress"] },
  { name: "ballistic", cmd: ["bun", "run", "test:ballistic"] },
  { name: "mogadishu-mile", cmd: ["bun", "run", "test:mogadishu-mile"] },
];

const liveTasks: Task[] = [
  { name: "ultimate:live", cmd: ["bun", "run", "test:ultimate:live"] },
];

const tiers: Record<string, Tier> = {
  fast: {
    name: "fast",
    description: "Parallel typecheck, isolated tests, smoke scripts, ultimate stub run, dashboard build, and CLI smoke.",
    stages: [
      { name: "smoke and regression", tasks: smokeTasks },
    ],
  },
  adversarial: {
    name: "adversarial",
    description: "Hostile local pressure tests for runtime consistency, leak resistance, and full-org survival.",
    stages: [
      { name: "adversarial runtime battery", tasks: adversarialTasks },
    ],
  },
  full: {
    name: "full",
    description: "Fast gate plus the full hostile local battery. This is the default production-readiness local gate.",
    stages: [
      { name: "smoke and regression", tasks: smokeTasks },
      { name: "adversarial runtime battery", tasks: adversarialTasks },
    ],
  },
  live: {
    name: "live",
    description: "Optional live-provider gate. Requires provider credentials such as US_ULTIMATE_API_KEY.",
    stages: [
      { name: "live provider battery", tasks: liveTasks },
    ],
  },
};

const tier = tiers[requestedTier];
if (!tier) {
  console.error(`Unknown battery tier "${requestedTier}". Try: ${Object.keys(tiers).join(", ")}`);
  process.exit(2);
}

console.log(`\nunion-street battery: ${tier.name}`);
console.log(tier.description);

const startedAt = Date.now();
for (const stage of tier.stages) {
  await runStage(stage.name, stage.tasks);
}

console.log(`\nunion-street battery "${tier.name}" passed in ${formatDuration(Date.now() - startedAt)}`);

function readTier(): string {
  for (const arg of args) {
    if (arg.startsWith("--tier=")) return arg.slice("--tier=".length);
  }
  if (args.has("--fast")) return "fast";
  if (args.has("--adversarial")) return "adversarial";
  if (args.has("--live")) return "live";
  if (args.has("--full")) return "full";
  return "full";
}

async function runStage(label: string, tasks: Task[]): Promise<void> {
  const startedAt = Date.now();
  console.log(`\n== ${label} ==`);
  console.log(`running ${tasks.length} task${tasks.length === 1 ? "" : "s"}\n`);

  const results = await Promise.all(tasks.map(runTask));
  const failed = results.filter((result) => result.code !== 0);

  for (const result of results) {
    const status = result.code === 0 ? "pass" : `fail:${result.code}`;
    console.log(`${status.padEnd(8)} ${result.name.padEnd(24)} ${formatDuration(result.durationMs)}`);
    if (result.code !== 0) {
      if (result.stdout.trim()) console.log(indent(result.stdout.trimEnd()));
      if (result.stderr.trim()) console.error(indent(result.stderr.trimEnd()));
    }
  }

  if (failed.length) {
    console.error(`\n${label} failed: ${failed.map((result) => result.name).join(", ")}`);
    process.exit(1);
  }

  console.log(`\n${label} passed in ${formatDuration(Date.now() - startedAt)}`);
}

async function runTask(task: Task): Promise<{ name: string; code: number; durationMs: number; stdout: string; stderr: string }> {
  const startedAt = Date.now();
  const proc = Bun.spawn(task.cmd, {
    cwd: task.cwd ? `${repoRoot}/${task.cwd}` : repoRoot,
    env: { ...process.env, ...(task.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    name: task.name,
    code,
    durationMs: Date.now() - startedAt,
    stdout,
    stderr,
  };
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(2)}s`;
}

function indent(value: string): string {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}
