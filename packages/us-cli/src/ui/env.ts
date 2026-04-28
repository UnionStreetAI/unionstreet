/**
 * Ambient environment detection for the bottom status bar.
 *
 * All detectors run with a 200ms cap, never throw, and produce structured
 * results the StatusBar can render however it wants. Detection is a pull
 * model — call `detectEnv(cwd)` on mount and on refresh signals (e.g.,
 * after a bash tool call completes). No polling.
 *
 * Detectors:
 *   - git    — branch, dirty marker, in-progress state (rebase/merge/cherry)
 *   - python — VIRTUAL_ENV basename
 *   - node   — package manager from lockfile presence
 *   - docker — non-default context
 *   - aws    — AWS_PROFILE env var
 *   - k8s    — current-context, only if ~/.kube/config exists
 *   - tf     — Terraform workspace, only if .terraform/ exists
 *   - nix    — IN_NIX_SHELL env var
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "bun";

const TIMEOUT_MS = 200;

export interface GitInfo {
  branch: string;
  dirty: boolean;
  /** "rebasing" | "merging" | "cherry-pick" | "bisecting" | undefined */
  inProgress?: "rebasing" | "merging" | "cherry-pick" | "bisecting";
}

export interface EnvInfo {
  cwd: string;
  git?: GitInfo;
  python?: { venv: string };
  node?: { manager: "bun" | "pnpm" | "yarn" | "npm" };
  docker?: { context: string };
  aws?: { profile: string };
  k8s?: { context: string };
  tf?: { workspace: string };
  nix?: { name: string };
}

/** Compact home dir to ~ for display. */
export function compactPath(p: string): string {
  const home = process.env.HOME ?? "";
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

export async function detectEnv(cwd: string): Promise<EnvInfo> {
  const [git, python, node, docker, aws, k8s, tf, nix] = await Promise.all([
    detectGit(cwd),
    detectPython(),
    detectNode(cwd),
    detectDocker(),
    detectAWS(),
    detectK8s(),
    detectTerraform(cwd),
    detectNix(),
  ]);
  return { cwd, git, python, node, docker, aws, k8s, tf, nix };
}

// ---------- helpers ----------

async function run(
  cmd: string[],
  opts: { cwd?: string } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  try {
    const proc = spawn(cmd, {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, TIMEOUT_MS);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    clearTimeout(timer);
    if (timedOut) return { ok: false, stdout, stderr, exitCode: -1 };
    return { ok: proc.exitCode === 0, stdout, stderr, exitCode: proc.exitCode ?? -1 };
  } catch {
    return { ok: false, stdout: "", stderr: "", exitCode: -1 };
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------- detectors ----------

async function detectGit(cwd: string): Promise<GitInfo | undefined> {
  const repo = await run(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
  if (!repo.ok) return undefined;
  const root = repo.stdout.trim();

  const headRef = await run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  let branch = headRef.ok ? headRef.stdout.trim() : "?";
  if (branch === "HEAD") {
    // detached — use short SHA
    const sha = await run(["git", "-C", cwd, "rev-parse", "--short", "HEAD"]);
    branch = sha.ok ? `(${sha.stdout.trim()})` : "(detached)";
  }

  const status = await run(["git", "-C", cwd, "status", "--porcelain"]);
  const dirty = status.ok && status.stdout.trim().length > 0;

  let inProgress: GitInfo["inProgress"];
  if (await exists(join(root, ".git", "rebase-merge"))) inProgress = "rebasing";
  else if (await exists(join(root, ".git", "rebase-apply"))) inProgress = "rebasing";
  else if (await exists(join(root, ".git", "MERGE_HEAD"))) inProgress = "merging";
  else if (await exists(join(root, ".git", "CHERRY_PICK_HEAD"))) inProgress = "cherry-pick";
  else if (await exists(join(root, ".git", "BISECT_LOG"))) inProgress = "bisecting";

  return { branch, dirty, inProgress };
}

async function detectPython(): Promise<EnvInfo["python"]> {
  const venv = process.env.VIRTUAL_ENV;
  if (!venv) return undefined;
  return { venv: basename(venv) };
}

async function detectNode(cwd: string): Promise<EnvInfo["node"]> {
  // Walk up to find the closest package.json (max 6 levels).
  let dir = cwd;
  for (let i = 0; i < 6; i++) {
    if (await exists(join(dir, "package.json"))) {
      if (await exists(join(dir, "bun.lock")) || await exists(join(dir, "bun.lockb")))
        return { manager: "bun" };
      if (await exists(join(dir, "pnpm-lock.yaml"))) return { manager: "pnpm" };
      if (await exists(join(dir, "yarn.lock"))) return { manager: "yarn" };
      if (await exists(join(dir, "package-lock.json"))) return { manager: "npm" };
      return { manager: "npm" }; // package.json with no lockfile → assume npm
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

async function detectDocker(): Promise<EnvInfo["docker"]> {
  // Skip if `docker` isn't installed.
  const which = await run(["which", "docker"]);
  if (!which.ok) return undefined;
  const ctx = await run(["docker", "context", "show"]);
  if (!ctx.ok) return undefined;
  const name = ctx.stdout.trim();
  if (!name || name === "default") return undefined;
  return { context: name };
}

async function detectAWS(): Promise<EnvInfo["aws"]> {
  const profile = process.env.AWS_PROFILE;
  if (!profile) return undefined;
  return { profile };
}

async function detectK8s(): Promise<EnvInfo["k8s"]> {
  // Only shell out if a kubeconfig exists; otherwise this is a 200ms tax for nothing.
  const cfg = process.env.KUBECONFIG ?? join(homedir(), ".kube", "config");
  if (!(await exists(cfg))) return undefined;
  const ctx = await run(["kubectl", "config", "current-context"]);
  if (!ctx.ok) return undefined;
  const name = ctx.stdout.trim();
  if (!name) return undefined;
  return { context: name };
}

async function detectTerraform(cwd: string): Promise<EnvInfo["tf"]> {
  if (!(await exists(join(cwd, ".terraform")))) return undefined;
  // workspace name lives in .terraform/environment (legacy) or via `terraform workspace show`
  try {
    const raw = await fs.readFile(join(cwd, ".terraform", "environment"), "utf8");
    return { workspace: raw.trim() };
  } catch {
    const out = await run(["terraform", "workspace", "show"], { cwd });
    if (!out.ok) return undefined;
    return { workspace: out.stdout.trim() };
  }
}

async function detectNix(): Promise<EnvInfo["nix"]> {
  const v = process.env.IN_NIX_SHELL;
  if (!v) return undefined;
  return { name: process.env.name ?? v };
}
