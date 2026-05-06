#!/usr/bin/env bun

const repoRoot = process.cwd();
const patterns = [
  "packages/**/*.test.ts",
  "packages/**/*.test.tsx",
  "scripts/**/*.test.ts",
];

const files = [...new Set((await Promise.all(patterns.map(async (pattern) => {
  const glob = new Bun.Glob(pattern);
  const matches: string[] = [];
  for await (const file of glob.scan({ cwd: repoRoot, absolute: false, onlyFiles: true })) {
    matches.push(file);
  }
  return matches;
}))).flat())].sort();

if (!files.length) {
  console.log("No test files found.");
  process.exit(0);
}

const startedAt = Date.now();
const failures: Array<{ file: string; code: number; stdout: string; stderr: string }> = [];

console.log(`Running ${files.length} isolated test file${files.length === 1 ? "" : "s"}\n`);

for (const file of files) {
  const proc = Bun.spawn(["bun", "test", file], {
    cwd: repoRoot,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code === 0) {
    console.log(`pass ${file}`);
  } else {
    console.error(`fail ${file}`);
    failures.push({ file, code, stdout, stderr });
  }
}

if (failures.length) {
  console.error(`\n${failures.length} isolated test file${failures.length === 1 ? "" : "s"} failed:\n`);
  for (const failure of failures) {
    console.error(`== ${failure.file} (exit ${failure.code}) ==`);
    if (failure.stdout.trim()) console.error(failure.stdout.trimEnd());
    if (failure.stderr.trim()) console.error(failure.stderr.trimEnd());
    console.error("");
  }
  process.exit(1);
}

console.log(`\nAll isolated test files passed in ${formatDuration(Date.now() - startedAt)}`);

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(2)}s`;
}
