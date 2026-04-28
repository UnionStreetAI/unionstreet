import kleur from "kleur";
import {
  ensureAgentWorkspace,
  listProfiles,
  resolveMemorySyncConfig,
  resolveAgentRuntime,
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

export async function runtimeEnsure(profile: string): Promise<void> {
  const runtime = await ensureAgentWorkspace(profile);
  await printRuntime(runtime);
  console.log(kleur.green("workspace ensured"));
}

export async function runtimeServe(options: { port?: string | number; host?: string } = {}): Promise<void> {
  const port = options.port === undefined ? 8787 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid runtime port "${options.port}".`);
  }
  const handle = startRuntimeServer({
    hostname: options.host ?? "127.0.0.1",
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
