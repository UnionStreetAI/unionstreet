import { promises as fs } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import yaml from "js-yaml";
import { US_HOME, profilePaths } from "./paths.ts";
import { readGlobalConfig } from "./global-config.ts";
import { materializeAgentSecrets, resolveSecretGrantsForAgent, type ResolvedSecretGrant } from "./secrets.ts";
import { writeEvent } from "./events.ts";
import { readAgentPack } from "./agent-pack.ts";

export type RuntimeProvider =
  | "local"
  | "docker"
  | "kubernetes"
  | "aws"
  | "gcp"
  | "azure"
  | "vercel"
  | "render"
  | "modal"
  | "daytona";

export type WorkspaceScope = "agent" | "session" | "shared";

export interface RuntimeHeadConfig {
  mode: "embedded" | "daemon" | "remote";
  provider: "local" | "kubernetes" | "aws" | "gcp" | "azure" | "vercel" | "render" | "modal" | "daytona";
  honcho?: {
    baseUrl?: string;
    workspaceId?: string;
    apiKeyEnv?: string;
  };
  endpoint?: string;
}

export interface RuntimeWorkspaceConfig {
  provider: RuntimeProvider;
  scope: WorkspaceScope;
  root?: string;
  workdir: string;
  image?: string;
  region?: string;
  size?: string;
  network?: "none" | "egress" | "private";
  persistent?: boolean;
  ttlMinutes?: number;
  plugin?: string;
  labels?: Record<string, string>;
  env?: Record<string, string>;
}

export interface RuntimeComputeConfig {
  provider: RuntimeProvider;
  target: "host" | "container" | "vm" | "pod" | "function" | "sandbox";
  image?: string;
  command?: string[];
  cpu?: string;
  memory?: string;
  gpu?: string;
  region?: string;
  minInstances?: number;
  maxInstances?: number;
}

export interface RuntimeStorageConfig {
  provider: "local" | "volume" | "s3" | "gcs" | "azure-blob" | "vercel-blob" | "render-disk" | "modal-volume" | "daytona-volume";
  bucket?: string;
  volume?: string;
  mountPath: string;
  persistent: boolean;
  encryption?: "provider-managed" | "customer-managed";
}

export interface RuntimeIngressConfig {
  provider: "local" | "http" | "vercel" | "render" | "aws-alb" | "gcp-lb" | "azure-app-gateway" | "kubernetes-ingress" | "modal" | "daytona";
  url?: string;
  internalUrl?: string;
  public: boolean;
  auth: "federation-jwt" | "oauth" | "none";
  receives: Array<"mcp" | "lash" | "webhook" | "control">;
}

export interface AgentRuntimeConfig {
  max_steps: number;
  head: RuntimeHeadConfig;
  compute: RuntimeComputeConfig;
  storage: RuntimeStorageConfig;
  ingress: RuntimeIngressConfig;
  workspace: RuntimeWorkspaceConfig;
}

export interface ResolvedAgentRuntime {
  profile: string;
  head: RuntimeHeadConfig;
  compute: RuntimeComputeConfig;
  storage: RuntimeStorageConfig;
  ingress: RuntimeIngressConfig;
  workspace: RuntimeWorkspaceConfig;
  workspacePath: string;
  pluginId: string;
  terraformModule?: string;
  secrets: ResolvedSecretGrant[];
  secretsPath?: string;
  warnings: string[];
}

export const DEFAULT_RUNTIME: AgentRuntimeConfig = {
  max_steps: 50,
  head: {
    mode: "embedded",
    provider: "local",
    honcho: {
      baseUrl: "http://127.0.0.1:8000",
      workspaceId: "local",
    },
  },
  compute: {
    provider: "local",
    target: "host",
    cpu: "shared",
    memory: "host",
  },
  storage: {
    provider: "local",
    mountPath: join(US_HOME, "workspaces"),
    persistent: true,
    encryption: "provider-managed",
  },
  ingress: {
    provider: "local",
    url: "http://127.0.0.1:0",
    public: false,
    auth: "federation-jwt",
    receives: ["mcp", "lash", "webhook", "control"],
  },
  workspace: {
    provider: "local",
    scope: "agent",
    root: join(US_HOME, "workspaces"),
    workdir: ".",
    persistent: true,
    network: "egress",
  },
};

const PROVIDER_PLUGIN: Record<RuntimeProvider, string> = {
  local: "runtime-local",
  docker: "runtime-docker",
  kubernetes: "runtime-kubernetes",
  aws: "runtime-aws",
  gcp: "runtime-gcp",
  azure: "runtime-azure",
  vercel: "runtime-vercel",
  render: "runtime-render",
  modal: "runtime-modal",
  daytona: "runtime-daytona",
};

export async function resolveAgentRuntime(profile: string): Promise<ResolvedAgentRuntime> {
  const global = await readGlobalConfig();
  const globalRuntime = isRecord(global.runtime) ? global.runtime : {};
  const profileRuntime = await readProfileRuntime(profile);
  const packRuntime = await readAgentPackRuntime(profile);
  const runtime = normalizeAgentRuntime(mergeRecords(DEFAULT_RUNTIME as unknown as Record<string, unknown>, globalRuntime, profileRuntime, packRuntime));
  const workspacePath = resolveWorkspacePath(profile, runtime.workspace);
  const pluginId = runtime.workspace.plugin ?? PROVIDER_PLUGIN[runtime.workspace.provider];
  const secrets = await resolveSecretGrantsForAgent(profile);
  return {
    profile,
    head: runtime.head,
    compute: runtime.compute,
    storage: runtime.storage,
    ingress: runtime.ingress,
    workspace: runtime.workspace,
    workspacePath,
    pluginId,
    terraformModule: runtime.workspace.provider === "local" ? undefined : `plugins/${pluginId}/terraform`,
    secrets,
    warnings: runtimeWarnings(runtime),
  };
}

export async function ensureAgentWorkspace(profile: string): Promise<ResolvedAgentRuntime> {
  const resolved = await resolveAgentRuntime(profile);
  if (resolved.workspace.provider === "local" || resolved.workspace.provider === "docker") {
    await fs.mkdir(resolved.workspacePath, { recursive: true });
    const materialized = await materializeAgentSecrets(profile, resolved.workspacePath);
    resolved.secrets = materialized.grants;
    if (materialized.path) resolved.secretsPath = materialized.path;
    resolved.warnings.push(...materialized.warnings);
  }
  await writeEvent({
    type: "runtime.workspace.ensure",
    actor: profile,
    subject: profile,
    resource: resolved.workspacePath,
    outcome: "success",
    severity: resolved.warnings.length ? "warn" : "info",
    payload: {
      provider: resolved.workspace.provider,
      compute: resolved.compute.provider,
      storage: resolved.storage.provider,
      ingress: resolved.ingress.provider,
      pluginId: resolved.pluginId,
      secretsPath: resolved.secretsPath,
      warnings: resolved.warnings,
    },
  });
  return resolved;
}

function normalizeAgentRuntime(value: Record<string, unknown>): AgentRuntimeConfig {
  const runtime = isRecord(value.runtime) ? value.runtime : value;
  const headRaw = isRecord(runtime.head) ? runtime.head : {};
  const computeRaw = isRecord(runtime.compute) ? runtime.compute : {};
  const storageRaw = isRecord(runtime.storage) ? runtime.storage : {};
  const ingressRaw = isRecord(runtime.ingress) ? runtime.ingress : {};
  const workspaceRaw = isRecord(runtime.workspace) ? runtime.workspace : {};
  const defaultWorkspace = DEFAULT_RUNTIME.workspace;
  const provider = readProvider(workspaceRaw.provider) ?? defaultWorkspace.provider;
  return {
    max_steps: readPositiveInt(runtime.max_steps) ?? DEFAULT_RUNTIME.max_steps,
    head: {
      mode: readEnum(headRaw.mode, ["embedded", "daemon", "remote"]) ?? DEFAULT_RUNTIME.head.mode,
      provider: readEnum(headRaw.provider, ["local", "kubernetes", "aws", "gcp", "azure", "vercel", "render", "modal", "daytona"]) ?? DEFAULT_RUNTIME.head.provider,
      ...(isRecord(headRaw.honcho) ? { honcho: normalizeHoncho(headRaw.honcho) } : DEFAULT_RUNTIME.head.honcho ? { honcho: DEFAULT_RUNTIME.head.honcho } : {}),
      ...(readString(headRaw.endpoint) ? { endpoint: readString(headRaw.endpoint) } : {}),
    },
    compute: {
      provider: readProvider(computeRaw.provider) ?? provider,
      target: readEnum(computeRaw.target, ["host", "container", "vm", "pod", "function", "sandbox"]) ?? computeTargetFor(provider),
      ...(readString(computeRaw.image) ? { image: readString(computeRaw.image) } : {}),
      ...(readStringArray(computeRaw.command) ? { command: readStringArray(computeRaw.command) } : {}),
      ...(readString(computeRaw.cpu) ? { cpu: readString(computeRaw.cpu) } : DEFAULT_RUNTIME.compute.cpu ? { cpu: DEFAULT_RUNTIME.compute.cpu } : {}),
      ...(readString(computeRaw.memory) ? { memory: readString(computeRaw.memory) } : DEFAULT_RUNTIME.compute.memory ? { memory: DEFAULT_RUNTIME.compute.memory } : {}),
      ...(readString(computeRaw.gpu) ? { gpu: readString(computeRaw.gpu) } : {}),
      ...(readString(computeRaw.region) ? { region: readString(computeRaw.region) } : readString(workspaceRaw.region) ? { region: readString(workspaceRaw.region) } : {}),
      ...(readPositiveInt(computeRaw.minInstances) ? { minInstances: readPositiveInt(computeRaw.minInstances) } : {}),
      ...(readPositiveInt(computeRaw.maxInstances) ? { maxInstances: readPositiveInt(computeRaw.maxInstances) } : {}),
    },
    storage: {
      provider: readEnum(storageRaw.provider, ["local", "volume", "s3", "gcs", "azure-blob", "vercel-blob", "render-disk", "modal-volume", "daytona-volume"]) ?? storageProviderFor(provider),
      ...(readString(storageRaw.bucket) ? { bucket: readString(storageRaw.bucket) } : {}),
      ...(readString(storageRaw.volume) ? { volume: readString(storageRaw.volume) } : {}),
      mountPath: readString(storageRaw.mountPath) ?? defaultStorageMountPathFor(provider, workspaceRaw),
      persistent: typeof storageRaw.persistent === "boolean" ? storageRaw.persistent : true,
      encryption: readEnum(storageRaw.encryption, ["provider-managed", "customer-managed"]) ?? "provider-managed",
    },
    ingress: {
      provider: readEnum(ingressRaw.provider, ["local", "http", "vercel", "render", "aws-alb", "gcp-lb", "azure-app-gateway", "kubernetes-ingress", "modal", "daytona"]) ?? ingressProviderFor(provider),
      ...(readString(ingressRaw.url) ? { url: readString(ingressRaw.url) } : DEFAULT_RUNTIME.ingress.url ? { url: DEFAULT_RUNTIME.ingress.url } : {}),
      ...(readString(ingressRaw.internalUrl) ? { internalUrl: readString(ingressRaw.internalUrl) } : {}),
      public: typeof ingressRaw.public === "boolean" ? ingressRaw.public : false,
      auth: readEnum(ingressRaw.auth, ["federation-jwt", "oauth", "none"]) ?? "federation-jwt",
      receives: readReceives(ingressRaw.receives),
    },
    workspace: {
      provider,
      scope: readEnum(workspaceRaw.scope, ["agent", "session", "shared"]) ?? defaultWorkspace.scope,
      root: readString(workspaceRaw.root) ?? defaultWorkspace.root,
      workdir: readString(workspaceRaw.workdir) ?? defaultWorkspace.workdir,
      ...(readString(workspaceRaw.image) ? { image: readString(workspaceRaw.image) } : {}),
      ...(readString(workspaceRaw.region) ? { region: readString(workspaceRaw.region) } : {}),
      ...(readString(workspaceRaw.size) ? { size: readString(workspaceRaw.size) } : {}),
      network: readEnum(workspaceRaw.network, ["none", "egress", "private"]) ?? defaultWorkspace.network,
      persistent: typeof workspaceRaw.persistent === "boolean" ? workspaceRaw.persistent : defaultWorkspace.persistent,
      ...(readPositiveInt(workspaceRaw.ttlMinutes) ? { ttlMinutes: readPositiveInt(workspaceRaw.ttlMinutes) } : {}),
      ...(readString(workspaceRaw.plugin) ? { plugin: readString(workspaceRaw.plugin) } : {}),
      ...(isStringMap(workspaceRaw.labels) ? { labels: workspaceRaw.labels } : {}),
      ...(isStringMap(workspaceRaw.env) ? { env: workspaceRaw.env } : {}),
    },
  };
}

async function readProfileRuntime(profile: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(profilePaths(profile).config, "utf8");
    const parsed = yaml.load(raw);
    return isRecord(parsed) && isRecord(parsed.runtime) ? { runtime: parsed.runtime } : {};
  } catch {
    return {};
  }
}

async function readAgentPackRuntime(profile: string): Promise<Record<string, unknown>> {
  try {
    const pack = await readAgentPack(profile);
    const provider = readProvider(pack.runtime.provider);
    if (!provider) return {};
    return {
      runtime: {
        workspace: {
          provider,
          ...(pack.runtime.plugin ? { plugin: pack.runtime.plugin } : {}),
          workdir: pack.runtime.workspace,
          ...(pack.runtime.region ? { region: pack.runtime.region } : {}),
          ...(pack.runtime.image ? { image: pack.runtime.image } : {}),
          ...(pack.runtime.size ? { size: pack.runtime.size } : {}),
          ...(pack.runtime.network ? { network: pack.runtime.network } : {}),
          ...(pack.runtime.ttlMinutes ? { ttlMinutes: pack.runtime.ttlMinutes } : {}),
        },
        compute: {
          provider,
          target: computeTargetFor(provider),
          ...(pack.runtime.image ? { image: pack.runtime.image } : {}),
          ...(pack.runtime.region ? { region: pack.runtime.region } : {}),
        },
        storage: {
          provider: storageProviderFor(provider),
        },
        ingress: {
          provider: ingressProviderFor(provider),
        },
      },
    };
  } catch {
    return {};
  }
}

function resolveWorkspacePath(profile: string, workspace: RuntimeWorkspaceConfig): string {
  const root = workspace.root ?? join(US_HOME, "workspaces");
  const scope = workspace.scope === "shared" ? "shared" : profile;
  if (workspace.provider === "docker") return workspace.workdir || "/workspace";
  if (workspace.provider !== "local") return workspace.workdir;
  return resolvePath(root.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"), scope, workspace.workdir === "." ? "" : workspace.workdir);
}

function runtimeWarnings(runtime: AgentRuntimeConfig): string[] {
  const warnings: string[] = [];
  if (runtime.head.mode === "remote" && !runtime.head.endpoint) {
    warnings.push("remote head mode requires runtime.head.endpoint before deployment");
  }
  if (!runtime.ingress.url && !runtime.ingress.internalUrl) {
    warnings.push("runtime.ingress.url or runtime.ingress.internalUrl is required for remote callbacks");
  }
  if (runtime.ingress.auth === "none" && runtime.ingress.public) {
    warnings.push("public ingress should not use auth: none");
  }
  if (!runtime.storage.mountPath) {
    warnings.push("runtime.storage.mountPath is required");
  }
  if (runtime.workspace.provider !== "local" && runtime.workspace.provider !== "docker" && !runtime.workspace.region) {
    warnings.push(`${runtime.workspace.provider} workspace should set runtime.workspace.region`);
  }
  if (runtime.workspace.provider === "docker" && !runtime.workspace.image) {
    warnings.push("docker workspace should set runtime.workspace.image");
  }
  return warnings;
}

function computeTargetFor(provider: RuntimeProvider): RuntimeComputeConfig["target"] {
  switch (provider) {
    case "local":
      return "host";
    case "docker":
      return "container";
    case "kubernetes":
      return "pod";
    case "vercel":
      return "function";
    case "render":
      return "container";
    case "modal":
    case "daytona":
      return "sandbox";
    case "aws":
    case "gcp":
    case "azure":
      return "vm";
  }
}

function storageProviderFor(provider: RuntimeProvider): RuntimeStorageConfig["provider"] {
  switch (provider) {
    case "local":
      return "local";
    case "docker":
    case "kubernetes":
      return "volume";
    case "aws":
      return "s3";
    case "gcp":
      return "gcs";
    case "azure":
      return "azure-blob";
    case "vercel":
      return "vercel-blob";
    case "render":
      return "render-disk";
    case "modal":
      return "modal-volume";
    case "daytona":
      return "daytona-volume";
  }
}

function defaultStorageMountPathFor(provider: RuntimeProvider, workspaceRaw: Record<string, unknown>): string {
  if (provider === "local") return readString(workspaceRaw.root) ?? DEFAULT_RUNTIME.storage.mountPath;
  if (provider === "docker" || provider === "kubernetes") return "/workspace";
  return readString(workspaceRaw.workdir) ?? "/workspace";
}

function ingressProviderFor(provider: RuntimeProvider): RuntimeIngressConfig["provider"] {
  switch (provider) {
    case "local":
    case "docker":
      return "local";
    case "kubernetes":
      return "kubernetes-ingress";
    case "aws":
      return "aws-alb";
    case "gcp":
      return "gcp-lb";
    case "azure":
      return "azure-app-gateway";
    case "vercel":
      return "vercel";
    case "render":
      return "render";
    case "modal":
      return "modal";
    case "daytona":
      return "daytona";
  }
}

function readReceives(value: unknown): RuntimeIngressConfig["receives"] {
  const allowed = new Set(["mcp", "lash", "webhook", "control"]);
  if (!Array.isArray(value)) return [...DEFAULT_RUNTIME.ingress.receives];
  const out = value.map((v) => String(v)).filter((v): v is RuntimeIngressConfig["receives"][number] => allowed.has(v));
  return out.length ? out : [...DEFAULT_RUNTIME.ingress.receives];
}

function normalizeHoncho(value: Record<string, unknown>): RuntimeHeadConfig["honcho"] {
  return {
    ...(readString(value.baseUrl) ? { baseUrl: readString(value.baseUrl) } : {}),
    ...(readString(value.workspaceId) ? { workspaceId: readString(value.workspaceId) } : {}),
    ...(readString(value.apiKeyEnv) ? { apiKeyEnv: readString(value.apiKeyEnv) } : {}),
  };
}

function mergeRecords(...values: Record<string, unknown>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const value of values) {
    for (const [key, next] of Object.entries(value)) {
      const current = out[key];
      out[key] = isRecord(current) && isRecord(next) ? mergeRecords(current, next) : next;
    }
  }
  return out;
}

function readProvider(value: unknown): RuntimeProvider | undefined {
  return readEnum(value, ["local", "docker", "kubernetes", "aws", "gcp", "azure", "vercel", "render", "modal", "daytona"]);
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
  return out.length ? out : undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === "string");
}
