/**
 * Profile path layout. One directory per profile under `~/.us/profiles/<name>`.
 * Layout follows the openclaw bootstrap convention (SOUL/IDENTITY/AGENTS/...)
 * adapted to US's profile-as-peer model.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProfilePaths } from "./index.ts";

export const US_HOME = process.env.US_HOME ?? join(homedir(), ".us");
export const PROFILES_DIR = join(US_HOME, "profiles");
export const REGISTRY_PATH = join(US_HOME, "registry.json");
export const FEDERATION_PATH = join(US_HOME, "federation.yaml");
export const FEDERATION_KEYS_PATH = join(US_HOME, "federation-keys.json");
export const EVENTS_DIR = join(US_HOME, "events");
export const EVENTS_PATH = join(EVENTS_DIR, "events.jsonl");
export const USAGE_DIR = join(US_HOME, "usage");
export const USAGE_PATH = join(USAGE_DIR, "usage.jsonl");
export const SCHEDULER_DIR = join(US_HOME, "scheduler");
export const SCHEDULER_RUNS_PATH = join(SCHEDULER_DIR, "runs.jsonl");
/** Shared credential store, used by every profile unless overridden. */
export const GLOBAL_AUTH_PROFILES_PATH = join(US_HOME, "auth-profiles.json");

export function profilePaths(name: string): ProfilePaths {
  const root = join(PROFILES_DIR, name);
  return {
    root,
    soul: join(root, "SOUL.md"),
    identity: join(root, "IDENTITY.md"),
    agents: join(root, "AGENTS.md"),
    user: join(root, "USER.md"),
    tools: join(root, "TOOLS.md"),
    memory: join(root, "MEMORY.md"),
    memoryDir: join(root, "memory"),
    sessions: join(root, "sessions"),
    skills: join(root, "skills"),
    agentPack: join(root, "agent.yaml"),
    authProfiles: join(root, "auth-profiles.json"),
    config: join(root, "config.yaml"),
    env: join(root, ".env"),
    state: join(root, "state.db"),
  };
}
