import kleur from "kleur";
import {
  dumpKubernetesManifests,
  ensureAgentWorkspace,
  listProfiles,
  renderAgentKubernetesManifests,
  resolveMemorySyncConfig,
  resolveAgentRuntime,
  validateKubernetesManifests,
  type KubernetesAgentWorkloadKind,
  type ResolvedAgentRuntime,
} from "@unionstreet/us-core";
import { startRuntimeServer } from "@unionstreet/us-runtime";

export async function runtimeStatus(profile?: string): Promise<void> {
  const profiles = profile ? [profile] : await listProfiles();
  if (!profiles.length) {
    console.log(kleur.dim("no profiles found. run `us-dev init <name>` first."));
    return;
  }
  for (const name of profiles) {
    const runtime = await resolveAgentRuntime(name);
    await printRuntime(runtime);
  }
}

export interface RuntimeEnsureOptions {
  provider?: string;
  dryRun?: boolean;
  namespace?: string;
  image?: string;
  workload?: string;
  externalSecret?: string;
}

export async function runtimeEnsure(profile: string, options: RuntimeEnsureOptions = {}): Promise<void> {
  if (options.provider === "kubernetes" && !options.dryRun) {
    throw new Error("Kubernetes reconciliation is not implemented yet. Use `us-dev runtime render <profile> --provider kubernetes` or add --dry-run.");
  }
  if (await renderKubernetesRuntimeIfRequested(profile, options)) return;
  const runtime = await ensureAgentWorkspace(profile);
  await printRuntime(runtime);
  console.log(kleur.green("workspace ensured"));
}

export async function runtimeRender(profile: string, options: RuntimeEnsureOptions = {}): Promise<void> {
  if (!options.provider) options.provider = "kubernetes";
  await renderKubernetesRuntimeIfRequested(profile, { ...options, dryRun: true });
}

async function renderKubernetesRuntimeIfRequested(profile: string, options: RuntimeEnsureOptions): Promise<boolean> {
  if (options.provider && options.provider !== "kubernetes") {
    throw new Error(`Unsupported runtime provider override "${options.provider}". Supported render provider: kubernetes.`);
  }
  if (options.workload && !readWorkloadKind(options.workload)) {
    throw new Error(`Invalid Kubernetes workload "${options.workload}". Expected Deployment, Job, or Pod.`);
  }
  if (options.dryRun && options.provider !== "kubernetes") {
    throw new Error("runtime ensure --dry-run currently requires --provider kubernetes.");
  }
  if (options.provider === "kubernetes" && options.dryRun) {
    const runtime = coerceKubernetesDryRunRuntime(await resolveAgentRuntime(profile));
    const manifests = renderAgentKubernetesManifests(runtime, {
      ...(options.namespace ? { namespace: options.namespace } : {}),
      ...(options.image ? { image: options.image } : {}),
      ...(readWorkloadKind(options.workload) ? { workloadKind: readWorkloadKind(options.workload) } : {}),
      ...(options.externalSecret ? { externalSecretName: options.externalSecret } : {}),
    });
    const validation = validateKubernetesManifests(manifests);
    if (!validation.ok) {
      throw new Error(`Rendered Kubernetes manifests failed validation:\n${validation.errors.map((error) => `- ${error}`).join("\n")}`);
    }
    process.stdout.write(dumpKubernetesManifests(manifests));
    return true;
  }
  return false;
}

function coerceKubernetesDryRunRuntime(runtime: ResolvedAgentRuntime): ResolvedAgentRuntime {
  if (runtime.workspace.provider === "kubernetes") return runtime;
  return {
    ...runtime,
    pluginId: "runtime-kubernetes",
    terraformModule: "plugins/runtime-kubernetes/terraform",
    compute: {
      ...runtime.compute,
      provider: "kubernetes",
      target: "pod",
    },
    storage: {
      ...runtime.storage,
      provider: "volume",
      mountPath: "/workspace",
      persistent: true,
    },
    ingress: {
      ...runtime.ingress,
      provider: "kubernetes-ingress",
      internalUrl: undefined,
      url: isLoopbackUrl(runtime.ingress.url) ? undefined : runtime.ingress.url,
      public: runtime.ingress.public,
    },
    workspace: {
      ...runtime.workspace,
      provider: "kubernetes",
      workdir: "/workspace",
      region: runtime.workspace.region ?? "local",
      persistent: true,
    },
    workspacePath: "/workspace",
  };
}

export async function runtimeServe(options: { port?: string | number; host?: string } = {}): Promise<void> {
  const port = options.port === undefined ? 8787 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid runtime port "${options.port}".`);
  }
  const host = options.host ?? "127.0.0.1";
  if (isPublicRuntimeHost(host) && !process.env.US_RUNTIME_BEARER_TOKEN?.trim()) {
    throw new Error("runtime serve requires US_RUNTIME_BEARER_TOKEN when binding outside loopback.");
  }
  const handle = startRuntimeServer({
    hostname: host,
    port,
    cwd: process.cwd(),
  });
  console.log(kleur.green("runtime control plane listening"));
  console.log(`  url  ${kleur.cyan(handle.url)}`);
  console.log(`  api  ${kleur.dim(`${handle.url}/api/agents`)}`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      handle.stop();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function printRuntime(runtime: ResolvedAgentRuntime): Promise<void> {
  const memorySync = await resolveMemorySyncConfig(runtime.profile);
  console.log(kleur.bold(`@${runtime.profile}`));
  console.log(`  head       ${kleur.cyan(`${runtime.head.mode}/${runtime.head.provider}`)}${runtime.head.endpoint ? kleur.dim(`  ${runtime.head.endpoint}`) : ""}`);
  console.log(`  honcho     ${kleur.dim(runtime.head.honcho?.baseUrl ?? "none")}  ${kleur.dim(runtime.head.honcho?.workspaceId ?? "")}`);
  console.log(`  memory     ${memorySync.enabled ? kleur.green("sync on") : kleur.dim("sync off")}  ${kleur.dim(memorySync.url ?? "local only")}`);
  console.log(`  compute    ${kleur.cyan(`${runtime.compute.provider}/${runtime.compute.target}`)}  ${kleur.dim([runtime.compute.cpu, runtime.compute.memory, runtime.compute.gpu].filter(Boolean).join(" ") || "default")}`);
  console.log(`  storage    ${kleur.cyan(runtime.storage.provider)}  ${kleur.dim(runtime.storage.mountPath)}${runtime.storage.persistent ? kleur.dim("  persistent") : ""}`);
  console.log(`  ingress    ${kleur.cyan(runtime.ingress.provider)}  ${kleur.dim(runtime.ingress.url ?? runtime.ingress.internalUrl ?? "no url")}  ${kleur.dim(runtime.ingress.auth)}`);
  console.log(`  workspace  ${kleur.cyan(runtime.workspace.provider)}  ${kleur.dim(runtime.workspace.scope)}`);
  console.log(`  path       ${kleur.dim(runtime.workspacePath)}`);
  const allowedSecrets = runtime.secrets.filter((secret) => secret.allowed).length;
  const deniedSecrets = runtime.secrets.length - allowedSecrets;
  const missingSecretVars = runtime.secrets.reduce((count, secret) => count + secret.missing.length, 0);
  console.log(`  secrets    ${kleur.cyan(String(allowedSecrets))} granted${deniedSecrets ? kleur.yellow(`  ${deniedSecrets} blocked`) : ""}${missingSecretVars ? kleur.yellow(`  ${missingSecretVars} missing`) : ""}`);
  if (runtime.secretsPath) console.log(`  secretsenv ${kleur.dim(runtime.secretsPath)}`);
  console.log(`  plugin     ${kleur.dim(runtime.pluginId)}`);
  if (runtime.terraformModule) console.log(`  terraform  ${kleur.dim(runtime.terraformModule)}`);
  for (const warning of runtime.warnings) console.log(`  ${kleur.yellow("warn")}      ${warning}`);
  console.log("");
}

function readWorkloadKind(value: string | undefined): KubernetesAgentWorkloadKind | undefined {
  if (value === "Deployment" || value === "Job" || value === "Pod") return value;
  if (value === "deployment") return "Deployment";
  if (value === "job") return "Job";
  if (value === "pod") return "Pod";
  return undefined;
}

function isLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const host = new URL(value).hostname;
    return isLoopbackHost(host);
  } catch {
    return false;
  }
}

function isPublicRuntimeHost(host: string): boolean {
  return !isLoopbackHost(host);
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
