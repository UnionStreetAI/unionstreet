/**
 * `us setup` — first-run onboarding for a local Mac/Linux Union Street host.
 */
import kleur from "kleur";
import {
  doctorPlugins,
  initProfile,
  listProfiles,
  profileExists,
  readAgentPack,
  readGlobalConfig,
  resolveAuthProfiles,
  resolveMemorySyncConfig,
  resolveAgentRuntime,
  setDefaultProfile,
} from "@unionstreet/server";
import { doctor } from "./doctor.ts";

export interface SetupArgs {
  profile?: string;
  role?: string;
  capability?: string | string[];
  check?: boolean;
  skipDoctor?: boolean;
  skipPlugins?: boolean;
}

interface SetupStep {
  label: string;
  ok: boolean;
  detail?: string;
}

export async function setup(args: SetupArgs = {}): Promise<boolean> {
  const profile = normalizeProfile(args.profile) ?? "coo";
  const role = args.role ?? (profile === "coo" ? "coo" : "agent");
  const capabilities = normalizeCapabilities(args.capability) ?? (profile === "coo" ? ["executive", "delegate", "report"] : ["chat"]);
  const steps: SetupStep[] = [];

  console.log("");
  console.log(kleur.bold("Union Street setup"));
  console.log(kleur.dim("Local Mac/Linux onboarding for the v1 Honcho-backed agent runtime."));
  console.log("");

  if (!args.skipDoctor) {
    const ok = await doctor();
    steps.push({ label: "host prerequisites", ok, detail: ok ? "doctor passed" : "doctor failed" });
    if (!ok) {
      printSummary(steps);
      return false;
    }
  } else {
    steps.push({ label: "host prerequisites", ok: true, detail: "skipped" });
  }

  if (args.check) {
    const ok = await printReadiness(profile, args);
    steps.push({ label: "readiness check", ok, detail: ok ? "ready" : "needs setup" });
    printSummary(steps);
    return steps.every((step) => step.ok);
  }

  const existed = await profileExists(profile);
  const result = await initProfile(profile, { role, capabilities });
  steps.push({
    label: "profile",
    ok: true,
    detail: existed ? `filled missing files for ${profile}` : `created ${profile}`,
  });

  await setDefaultProfile(profile);
  steps.push({ label: "default profile", ok: true, detail: profile });

  if (!args.skipPlugins) {
    const pluginDoctor = await doctorPlugins();
    steps.push({
      label: "plugins",
      ok: pluginDoctor.ok,
      detail: `${pluginDoctor.plugins.length} loaded, ${pluginDoctor.invalid.length} invalid, ${pluginDoctor.warnings.length} warnings`,
    });
  } else {
    steps.push({ label: "plugins", ok: true, detail: "skipped" });
  }

  const runtime = await resolveAgentRuntime(profile);
  steps.push({
    label: "runtime",
    ok: runtime.compute.provider === "local" && runtime.compute.target === "host",
    detail: `${runtime.compute.provider}/${runtime.compute.target}`,
  });

  const memory = await resolveMemorySyncConfig(profile);
  steps.push({
    label: "memory",
    ok: memory.provider === "honcho" && memory.enabled,
    detail: `${memory.provider} workspace=${memory.workspaceId}`,
  });

  const auth = await resolveAuthProfiles(profile);
  const providers = Object.keys(auth.merged.providers);
  steps.push({
    label: "model auth",
    ok: providers.length > 0,
    detail: providers.length ? providers.join(", ") : "not configured yet",
  });

  printProfileResult(profile, result.paths.root, result.created.length, result.alreadyExisted.length);
  printSummary(steps);
  printNextSteps(profile, providers.length > 0);
  return steps.every((step) => step.ok || step.label === "model auth");
}

async function printReadiness(profile: string, args: SetupArgs): Promise<boolean> {
  const profiles = await listProfiles();
  const cfg = await readGlobalConfig();
  const hasProfile = profiles.includes(profile);
  const defaultOk = cfg.default_profile === profile;
  const pluginDoctor = args.skipPlugins ? undefined : await doctorPlugins();
  const auth = hasProfile ? await resolveAuthProfiles(profile) : undefined;
  const providers = Object.keys(auth?.merged.providers ?? {});
  let packOk = false;
  if (hasProfile) {
    try {
      const pack = await readAgentPack(profile);
      packOk = pack.id === profile && pack.memory.provider === "honcho";
    } catch {
      packOk = false;
    }
  }

  console.log(kleur.bold("readiness"));
  printCheck("profile exists", hasProfile, profile);
  printCheck("default profile", defaultOk, cfg.default_profile ?? "unset");
  printCheck("agent pack", packOk, packOk ? "honcho memory configured" : "missing or incomplete");
  if (pluginDoctor) printCheck("plugins", pluginDoctor.ok, `${pluginDoctor.plugins.length} loaded`);
  printCheck("model auth", providers.length > 0, providers.length ? providers.join(", ") : "not configured");
  console.log("");

  return hasProfile && defaultOk && packOk && (pluginDoctor?.ok ?? true);
}

function printProfileResult(profile: string, root: string, created: number, existing: number): void {
  console.log("");
  console.log(kleur.bold(`Profile "${profile}"`) + kleur.dim(`  ${root}`));
  console.log(`  ${kleur.green("created/fill")} ${created} new file${created === 1 ? "" : "s"}`);
  console.log(`  ${kleur.dim("untouched")}     ${existing} existing file${existing === 1 ? "" : "s"}`);
}

function printSummary(steps: SetupStep[]): void {
  console.log("");
  console.log(kleur.bold("setup summary"));
  for (const step of steps) {
    const tag = step.ok ? kleur.green("✓") : kleur.red("✗");
    const detail = step.detail ? kleur.dim(` ${step.detail}`) : "";
    console.log(`  ${tag} ${step.label}${detail}`);
  }
  console.log("");
}

function printNextSteps(profile: string, hasAuth: boolean): void {
  console.log(kleur.bold("next"));
  if (!hasAuth) {
    console.log(`  ${kleur.cyan("us auth codex")}      ${kleur.dim("# or: us auth claude")}`);
  }
  console.log(`  ${kleur.cyan(`us auth status ${profile}`)}`);
  console.log(`  ${kleur.cyan(`us runtime status ${profile}`)}`);
  console.log(`  ${kleur.cyan(`us chat ${profile}`)}`);
  console.log("");
}

function printCheck(label: string, ok: boolean, detail: string): void {
  const tag = ok ? kleur.green("✓") : kleur.red("✗");
  console.log(`  ${tag} ${label.padEnd(16)} ${kleur.dim(detail)}`);
}

function normalizeProfile(profile: unknown): string | undefined {
  if (typeof profile !== "string") return undefined;
  const trimmed = profile.trim();
  return trimmed.length ? trimmed : undefined;
}

function normalizeCapabilities(value: string | string[] | undefined): string[] | undefined {
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return undefined;
}
