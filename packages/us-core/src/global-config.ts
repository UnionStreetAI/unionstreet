/**
 * ~/.us/config.yaml — global, host-wide config (NOT per-profile).
 *
 * v1 keys:
 *   - default_profile: <name>   used when `us-dev chat` is run with no arg
 */
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { US_HOME } from "./paths.ts";
import { listProfiles } from "./profile.ts";

export const GLOBAL_CONFIG_PATH = join(US_HOME, "config.yaml");

export interface GlobalConfig {
  default_profile?: string;
  [key: string]: unknown;
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readGlobalConfig(): Promise<GlobalConfig> {
  if (!(await exists(GLOBAL_CONFIG_PATH))) return {};
  const raw = await fs.readFile(GLOBAL_CONFIG_PATH, "utf8");
  if (!raw.trim()) return {};
  const parsed = yaml.load(raw);
  return (parsed && typeof parsed === "object" ? (parsed as GlobalConfig) : {}) ?? {};
}

export async function writeGlobalConfig(cfg: GlobalConfig): Promise<void> {
  await fs.mkdir(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
  await fs.writeFile(GLOBAL_CONFIG_PATH, yaml.dump(cfg));
}

export async function setDefaultProfile(name: string): Promise<void> {
  const cfg = await readGlobalConfig();
  cfg.default_profile = name;
  await writeGlobalConfig(cfg);
}

export interface ResolvedDefault {
  name: string;
  source: "arg" | "config" | "single";
}

export class NoProfileError extends Error {
  constructor(message: string, public readonly available: string[]) {
    super(message);
    this.name = "NoProfileError";
  }
}

/**
 * Resolve which profile a command should target.
 *
 *   1. explicit arg wins
 *   2. ~/.us/config.yaml `default_profile`
 *   3. if exactly one profile exists, use it
 *   4. throw NoProfileError listing available profiles
 */
export async function resolveProfile(arg?: string): Promise<ResolvedDefault> {
  if (arg) return { name: arg, source: "arg" };

  const cfg = await readGlobalConfig();
  const available = await listProfiles();

  if (cfg.default_profile && available.includes(cfg.default_profile)) {
    return { name: cfg.default_profile, source: "config" };
  }

  if (available.length === 1) {
    return { name: available[0]!, source: "single" };
  }

  if (available.length === 0) {
    throw new NoProfileError(`No profiles exist. Run \`us-dev init <name>\` to create one.`, []);
  }

  throw new NoProfileError(
    `Multiple profiles, no default set. Pass a profile name or run \`us-dev profile use <name>\`.\n  Available: ${available.join(", ")}`,
    available,
  );
}
