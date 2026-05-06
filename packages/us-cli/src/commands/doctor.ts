/**
 * `us doctor` — verify prerequisites.
 *
 * Checks (in order):
 *   1. Bun (always passes — we're running under it)
 *   2. Node >=20 compatibility surface
 *   3. Git
 *   4. Local Honcho prerequisites: Postgres, pgvector, uv
 *
 * Prints platform-specific remediation commands for any failure. Union Street
 * can write local JSONL memory events, but a ready local v1 machine includes
 * the Honcho/Postgres/pgvector stack because memory peering is core behavior.
 */
import { spawn } from "bun";
import kleur from "kleur";
import { platform } from "node:os";

type CheckResult = {
  name: string;
  ok: boolean;
  required: boolean;
  detail?: string;
  fix?: string;
};

type SupportedPlatform = "darwin" | "linux" | "other";

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
    required: true,
    detail: `${Bun.version}`,
  };
}

async function checkNode(): Promise<CheckResult> {
  const major = Number(process.versions.node.split(".")[0] ?? "0");
  return {
    name: "Node compatibility",
    ok: major >= 20,
    required: true,
    detail: process.versions.node,
    fix: installHint("node"),
  };
}

async function checkGit(): Promise<CheckResult> {
  const path = await which("git");
  if (!path) {
    return {
      name: "Git",
      ok: false,
      required: true,
      fix: installHint("git"),
    };
  }
  const { stdout } = await run(["git", "--version"]);
  return {
    name: "Git",
    ok: true,
    required: true,
    detail: stdout.trim(),
  };
}

async function checkPsql(): Promise<CheckResult> {
  const path = await which("psql");
  if (!path) {
    return {
      name: "Postgres psql (Honcho memory)",
      ok: false,
      required: true,
      fix: installHint("postgres"),
    };
  }
  const { stdout } = await run(["psql", "--version"]);
  return {
    name: "Postgres psql (Honcho memory)",
    ok: true,
    required: true,
    detail: stdout.trim(),
  };
}

async function checkPgServer(): Promise<CheckResult> {
  const path = await which("psql");
  if (!path) {
    return {
      name: "Postgres server (Honcho memory)",
      ok: false,
      required: true,
      detail: "psql not found",
      fix: installHint("postgres"),
    };
  }
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
      name: "Postgres server (Honcho memory)",
      ok: false,
      required: true,
      detail: stderr.trim().split("\n")[0],
      fix: startPostgresHint(),
    };
  }
  return { name: "Postgres server (Honcho memory)", ok: true, required: true };
}

async function checkPgvector(): Promise<CheckResult> {
  const path = await which("psql");
  if (!path) {
    return {
      name: "pgvector extension (Honcho memory)",
      ok: false,
      required: true,
      detail: "psql not found",
      fix: installHint("pgvector"),
    };
  }
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
      name: "pgvector extension (Honcho memory)",
      ok: false,
      required: true,
      fix: installHint("pgvector"),
    };
  }
  return { name: "pgvector extension (Honcho memory)", ok: true, required: true, detail: "available" };
}

async function checkUv(): Promise<CheckResult> {
  const path = await which("uv");
  if (!path) {
    return {
      name: "uv (Honcho memory)",
      ok: false,
      required: true,
      fix: "curl -LsSf https://astral.sh/uv/install.sh | sh",
    };
  }
  const { stdout } = await run(["uv", "--version"]);
  return { name: "uv (Honcho memory)", ok: true, required: true, detail: stdout.trim() };
}

function currentPlatform(): SupportedPlatform {
  const os = platform();
  if (os === "darwin" || os === "linux") return os;
  return "other";
}

export function installHint(tool: "git" | "node" | "postgres" | "pgvector"): string {
  const os = currentPlatform();
  if (os === "darwin") {
    switch (tool) {
      case "git":
        return "xcode-select --install  # or: brew install git";
      case "node":
        return "brew install node@20";
      case "postgres":
        return "brew install postgresql@17 pgvector && brew services start postgresql@17";
      case "pgvector":
        return "brew install pgvector  # then restart Postgres if needed";
    }
  }
  if (os === "linux") {
    switch (tool) {
      case "git":
        return "Install git with your distro package manager, e.g. sudo apt-get install git";
      case "node":
        return "Install Node 20+ with your distro package manager, mise, asdf, fnm, or nvm";
      case "postgres":
        return "Install postgresql-client and a local Postgres 16/17 server with pgvector";
      case "pgvector":
        return "Install the pgvector package/extension matching your Postgres version";
    }
  }
  switch (tool) {
    case "git":
      return "Install git for this platform";
    case "node":
      return "Install Node 20+ for this platform";
    case "postgres":
      return "Install Postgres and pgvector for this platform";
    case "pgvector":
      return "Install pgvector for this platform";
  }
}

function startPostgresHint(): string {
  const os = currentPlatform();
  if (os === "darwin") return "brew services start postgresql@17";
  if (os === "linux") return "Start your local Postgres service, e.g. sudo systemctl start postgresql";
  return "Start your local Postgres service";
}

export function requiredChecksPassed(checks: CheckResult[]): boolean {
  return checks.filter((c) => c.required).every((c) => c.ok);
}

export async function doctor(): Promise<boolean> {
  console.log(kleur.bold("\nus doctor\n"));

  const checks = [
    await checkBun(),
    await checkNode(),
    await checkGit(),
    await checkPsql(),
    await checkPgServer(),
    await checkPgvector(),
    await checkUv(),
  ];

  for (const c of checks) {
    const tag = c.ok ? kleur.green("✓") : c.required ? kleur.red("✗") : kleur.yellow("!");
    const detail = c.detail ? kleur.dim(` ${c.detail}`) : "";
    console.log(`  ${tag} ${c.name}${detail}`);
    if (!c.ok && c.fix) {
      console.log(`    ${kleur.yellow("→")} ${kleur.cyan(c.fix)}`);
    }
  }

  const allOk = requiredChecksPassed(checks);
  console.log("");
  if (allOk) {
    console.log(kleur.green("All checks passed. Ready to run `us init <name>`.\n"));
  } else {
    console.log(kleur.red("Required prerequisites missing. Fix the red items above, then re-run `us doctor`.\n"));
  }
  return allOk;
}
