#!/usr/bin/env bun

interface Task {
  name: string;
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
}

const repoRoot = process.cwd();
const args = new Set(process.argv.slice(2));
const typecheckOnly = args.has("--typecheck-only");

const typecheckTasks: Task[] = [
  { name: "typecheck:ai-codex", cmd: ["bun", "run", "typecheck"], cwd: "packages/ai-codex" },
  { name: "typecheck:us-auth", cmd: ["bun", "run", "typecheck"], cwd: "packages/us-auth" },
  { name: "typecheck:us-core", cmd: ["bun", "run", "typecheck"], cwd: "packages/us-core" },
  { name: "typecheck:us-runtime", cmd: ["bun", "run", "typecheck"], cwd: "packages/us-runtime" },
  { name: "typecheck:us-cli", cmd: ["bun", "run", "typecheck"], cwd: "packages/us-cli" },
  { name: "typecheck:us-dashboard", cmd: ["bun", "run", "typecheck"], cwd: "packages/us-dashboard" },
];

const verificationTasks: Task[] = [
  { name: "bun:test", cmd: ["bun", "test"] },
  { name: "smoke:prompt", cmd: ["bun", "run", "test:prompt"] },
  { name: "smoke:events", cmd: ["bun", "run", "test:events"] },
  { name: "smoke:scheduler", cmd: ["bun", "run", "test:scheduler"] },
  { name: "smoke:ultimate", cmd: ["bun", "run", "test:ultimate"] },
  { name: "dashboard:build", cmd: ["bun", "run", "build"], cwd: "packages/us-dashboard" },
];

await runStage("parallel typecheck", typecheckTasks);

if (!typecheckOnly) {
  await runStage("parallel verification", verificationTasks);
  await runStage("end-to-end smoke", [
    { name: "smoke:full-run", cmd: ["bun", "run", "scripts/full-run.ts", "--skip-typecheck", "--skip-tests"] },
  ]);
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
