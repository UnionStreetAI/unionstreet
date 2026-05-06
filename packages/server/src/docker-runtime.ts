import { mkdir } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import type { ResolvedAgentRuntime } from "./cloud-runtime.ts";
import { US_HOME } from "./paths.ts";

const DEFAULT_AGENT_IMAGE = "ghcr.io/unionstreet/agent-runtime:latest";
const DEFAULT_CONTAINER_PORT = 8787;

export interface DockerRuntimePlanOptions {
  image?: string;
  name?: string;
  dryRun?: boolean;
}

export interface DockerRuntimePlan {
  provider: "docker";
  profile: string;
  containerName: string;
  image: string;
  workspaceSource: string;
  workspaceTarget: string;
  homeSource: string;
  homeTarget: string;
  port: number;
  env: Record<string, string>;
  labels: Record<string, string>;
  command: string[];
  createArgs: string[];
}

export interface DockerRuntimeStatus {
  provider: "docker";
  profile: string;
  containerName: string;
  exists: boolean;
  running: boolean;
  image?: string;
  status?: string;
  ports?: string;
}

export function renderAgentDockerPlan(runtime: ResolvedAgentRuntime, options: DockerRuntimePlanOptions = {}): DockerRuntimePlan {
  const port = readPort(runtime.ingress.internalUrl ?? runtime.ingress.url) ?? DEFAULT_CONTAINER_PORT;
  const containerName = dockerName(options.name ?? `us-agent-${runtime.profile}`);
  const workspaceTarget = runtime.storage.mountPath || runtime.workspace.workdir || "/workspace";
  const workspaceSource = dockerHostWorkspacePath(runtime);
  const homeSource = resolvePath(US_HOME.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
  const homeTarget = "/home/bun/.us";
  const image = options.image ?? runtime.compute.image ?? runtime.workspace.image ?? DEFAULT_AGENT_IMAGE;
  const env = runtimeConfigEnv(runtime, port);
  const labels = {
    "app.unionstreet.io/component": "agent-runtime",
    "app.unionstreet.io/profile": runtime.profile,
    "app.unionstreet.io/plugin": runtime.pluginId,
  };
  const command = runtime.compute.command ?? [];
  const createArgs = [
    "run",
    "-d",
    "--name",
    containerName,
    "--label",
    `app.unionstreet.io/component=${labels["app.unionstreet.io/component"]}`,
    "--label",
    `app.unionstreet.io/profile=${labels["app.unionstreet.io/profile"]}`,
    "--label",
    `app.unionstreet.io/plugin=${labels["app.unionstreet.io/plugin"]}`,
    "--workdir",
    workspaceTarget,
    "--mount",
    `type=bind,source=${workspaceSource},target=${workspaceTarget}`,
    "--mount",
    `type=bind,source=${homeSource},target=${homeTarget}`,
    "-p",
    `127.0.0.1::${port}`,
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    image,
    ...command,
  ];
  return {
    provider: "docker",
    profile: runtime.profile,
    containerName,
    image,
    workspaceSource,
    workspaceTarget,
    homeSource,
    homeTarget,
    port,
    env,
    labels,
    command,
    createArgs,
  };
}

export async function ensureAgentDockerRuntime(runtime: ResolvedAgentRuntime, options: DockerRuntimePlanOptions = {}): Promise<{ plan: DockerRuntimePlan; status: DockerRuntimeStatus; created: boolean }> {
  const plan = renderAgentDockerPlan(runtime, options);
  await mkdir(plan.workspaceSource, { recursive: true });
  const before = await dockerRuntimeStatus(runtime, { name: plan.containerName });
  if (before.running) return { plan, status: before, created: false };
  if (before.exists) {
    await runDocker(["rm", plan.containerName]);
  }
  if (options.dryRun) {
    return { plan, status: { provider: "docker", profile: runtime.profile, containerName: plan.containerName, exists: false, running: false }, created: false };
  }
  await runDocker(plan.createArgs);
  return { plan, status: await dockerRuntimeStatus(runtime, { name: plan.containerName }), created: true };
}

export async function dockerRuntimeStatus(runtime: ResolvedAgentRuntime, options: { name?: string } = {}): Promise<DockerRuntimeStatus> {
  const containerName = dockerName(options.name ?? `us-agent-${runtime.profile}`);
  const result = await runDocker([
    "ps",
    "-a",
    "--filter",
    `name=^/${containerName}$`,
    "--format",
    "{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}",
  ], { allowFailure: true });
  const line = result.stdout.trim().split("\n").find(Boolean);
  if (!line) return { provider: "docker", profile: runtime.profile, containerName, exists: false, running: false };
  const [name, image, status, ports] = line.split("\t");
  return {
    provider: "docker",
    profile: runtime.profile,
    containerName: name || containerName,
    exists: true,
    running: status?.startsWith("Up") ?? false,
    ...(image ? { image } : {}),
    ...(status ? { status } : {}),
    ...(ports ? { ports } : {}),
  };
}

export async function destroyAgentDockerRuntime(runtime: ResolvedAgentRuntime, options: { name?: string } = {}): Promise<DockerRuntimeStatus> {
  const before = await dockerRuntimeStatus(runtime, options);
  if (!before.exists) return before;
  await runDocker(["rm", "-f", before.containerName]);
  return dockerRuntimeStatus(runtime, options);
}

export function dockerRuntimeControlUrl(status: DockerRuntimeStatus, port = DEFAULT_CONTAINER_PORT): string | undefined {
  if (!status.running || !status.ports) return undefined;
  const escaped = String(port).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = status.ports.match(new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|localhost|::1):([0-9]+)->${escaped}/tcp`));
  return match?.[1] ? `http://127.0.0.1:${match[1]}` : undefined;
}

export function dumpDockerPlan(plan: DockerRuntimePlan): string {
  return [
    `# Docker runtime plan for @${plan.profile}`,
    `container: ${plan.containerName}`,
    `image: ${plan.image}`,
    `workspace: ${plan.workspaceSource} -> ${plan.workspaceTarget}`,
    `us_home: ${plan.homeSource} -> ${plan.homeTarget}`,
    "",
    "docker " + plan.createArgs.map(shellQuote).join(" "),
    "",
  ].join("\n");
}

function dockerHostWorkspacePath(runtime: ResolvedAgentRuntime): string {
  const root = runtime.workspace.root ?? join(US_HOME, "workspaces");
  const scope = runtime.workspace.scope === "shared" ? "shared" : runtime.profile;
  const workdir = runtime.workspace.workdir === "." ? "" : runtime.workspace.workdir.replace(/^\/+/, "");
  return resolvePath(root.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"), scope, workdir);
}

function runtimeConfigEnv(runtime: ResolvedAgentRuntime, port: number): Record<string, string> {
  return {
    ...runtime.workspace.env,
    US_PROFILE: runtime.profile,
    US_RUNTIME_PLUGIN: runtime.pluginId,
    US_HEAD_MODE: runtime.head.mode,
    US_HEAD_PROVIDER: runtime.head.provider,
    US_WORKSPACE_SCOPE: runtime.workspace.scope,
    US_WORKSPACE_PATH: runtime.storage.mountPath || runtime.workspacePath,
    US_STORAGE_PROVIDER: runtime.storage.provider,
    US_STORAGE_MOUNT: runtime.storage.mountPath,
    US_INGRESS_PROVIDER: runtime.ingress.provider,
    US_INGRESS_PUBLIC: String(runtime.ingress.public),
    US_INGRESS_AUTH: runtime.ingress.auth,
    US_AGENT_SECRET_GRANTS: runtime.secrets.filter((secret) => secret.allowed).map((secret) => secret.id).join(","),
    PORT: String(port),
    ...(runtime.head.endpoint ? { US_HEAD_ENDPOINT: runtime.head.endpoint } : {}),
    ...(runtime.ingress.url ? { US_INGRESS_URL: runtime.ingress.url } : {}),
    ...(runtime.ingress.internalUrl ? { US_INGRESS_INTERNAL_URL: runtime.ingress.internalUrl } : {}),
    ...(runtime.head.honcho?.baseUrl ? { HONCHO_BASE_URL: runtime.head.honcho.baseUrl } : {}),
    ...(runtime.head.honcho?.workspaceId ? { HONCHO_WORKSPACE_ID: runtime.head.honcho.workspaceId } : {}),
  };
}

async function runDocker(args: string[], options: { allowFailure?: boolean } = {}): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 && !options.allowFailure) {
    throw new Error(`docker ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`);
  }
  return { stdout, stderr };
}

function dockerName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "us-agent";
}

function readPort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  try {
    const port = Number(new URL(value).port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=,@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
