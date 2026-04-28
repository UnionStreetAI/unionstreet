/**
 * `us doctor` — verify prerequisites.
 *
 * Checks (in order):
 *   1. Bun (always passes — we're running under it)
 *   2. Postgres binary (psql) reachable
 *   3. Postgres server reachable on default port
 *   4. pgvector extension available (probes pg_available_extensions)
 *   5. uv installed (used to manage the honcho python venv)
 *
 * Prints exact remediation commands for any failure.
 */
import { spawn } from "bun";
import kleur from "kleur";

type CheckResult = {
  name: string;
  ok: boolean;
  detail?: string;
  fix?: string;
};

async function which(cmd: string): Promise<string | null> {
  const proc = spawn(["which", cmd], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return proc.exitCode === 0 ? out.trim() : null;
}

async function run(cmd: string[], opts: { stdin?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.stdin ? "pipe" : undefined,
  });
  if (opts.stdin && proc.stdin) {
    proc.stdin.write(opts.stdin);
    proc.stdin.end();
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr };
}

async function checkBun(): Promise<CheckResult> {
  return {
    name: "Bun",
    ok: true,
    detail: `${Bun.version}`,
  };
}

async function checkPsql(): Promise<CheckResult> {
  const path = await which("psql");
  if (!path) {
    return {
      name: "Postgres (psql binary)",
      ok: false,
      fix: "brew install postgresql@17 pgvector && brew services start postgresql@17",
    };
  }
  const { stdout } = await run(["psql", "--version"]);
  return {
    name: "Postgres (psql binary)",
    ok: true,
    detail: stdout.trim(),
  };
}

async function checkPgServer(): Promise<CheckResult> {
  const { code, stderr } = await run([
    "psql",
    "-d",
    "postgres",
    "-c",
    "SELECT 1",
    "-t",
    "-A",
  ]);
  if (code !== 0) {
    return {
      name: "Postgres server reachable",
      ok: false,
      detail: stderr.trim().split("\n")[0],
      fix: "brew services start postgresql@17",
    };
  }
  return { name: "Postgres server reachable", ok: true };
}

async function checkPgvector(): Promise<CheckResult> {
  const { code, stdout } = await run([
    "psql",
    "-d",
    "postgres",
    "-t",
    "-A",
    "-c",
    "SELECT name FROM pg_available_extensions WHERE name='vector'",
  ]);
  if (code !== 0 || stdout.trim() !== "vector") {
    return {
      name: "pgvector extension",
      ok: false,
      fix: "brew install pgvector  # (may need: brew services restart postgresql@17)",
    };
  }
  return { name: "pgvector extension", ok: true, detail: "available" };
}

async function checkUv(): Promise<CheckResult> {
  const path = await which("uv");
  if (!path) {
    return {
      name: "uv (manages honcho's python venv)",
      ok: false,
      fix: "curl -LsSf https://astral.sh/uv/install.sh | sh",
    };
  }
  const { stdout } = await run(["uv", "--version"]);
  return { name: "uv (manages honcho's python venv)", ok: true, detail: stdout.trim() };
}

export async function doctor(): Promise<boolean> {
  console.log(kleur.bold("\nus doctor\n"));

  const checks = [
    await checkBun(),
    await checkPsql(),
    await checkPgServer(),
    await checkPgvector(),
    await checkUv(),
  ];

  for (const c of checks) {
    const tag = c.ok ? kleur.green("✓") : kleur.red("✗");
    const detail = c.detail ? kleur.dim(` ${c.detail}`) : "";
    console.log(`  ${tag} ${c.name}${detail}`);
    if (!c.ok && c.fix) {
      console.log(`    ${kleur.yellow("→")} ${kleur.cyan(c.fix)}`);
    }
  }

  const allOk = checks.every((c) => c.ok);
  console.log("");
  if (allOk) {
    console.log(kleur.green("All checks passed. Ready to run `us init <name>`.\n"));
  } else {
    console.log(kleur.red("Some prerequisites missing. Fix the items above, then re-run `us doctor`.\n"));
  }
  return allOk;
}
