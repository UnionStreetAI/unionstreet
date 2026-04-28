import { promises as fs } from "node:fs";
import yaml from "js-yaml";
import { buildAgentPackFromOrgNode, writeAgentPack, type AgentPack, type AgentPackModelTarget, type AgentPackSchedule } from "./agent-pack.ts";
import { readFederationConfig, writeFederationConfig, type FederationConfig, type FederationGrant, type FederationOrgNode, type FederationPrincipal } from "./federation.ts";
import { profilePaths } from "./paths.ts";
import { initProfile, profileExists } from "./profile.ts";
import { writeEvent } from "./events.ts";

export interface FleetPlan {
  version: 1;
  kind: "union-street.fleet-plan";
  name: string;
  mission: string;
  root: string;
  generatedBy: string;
  agents: FleetPlanAgent[];
}

export interface FleetPlanAgent {
  id: string;
  displayName: string;
  title: string;
  manager?: string;
  groups: string[];
  roles: string[];
  soul: string;
  model: AgentPackModelTarget;
  fallback?: AgentPackModelTarget[];
  mcp?: string[];
  cli?: string[];
  permissions?: string[];
  secrets?: string[];
  runtime?: Partial<AgentPack["runtime"]>;
  pulse?: Partial<AgentPack["pulse"]>;
  schedule?: AgentPackSchedule[];
  memory?: Partial<AgentPack["memory"]>;
}

export interface FleetPlanValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  summary: {
    agents: number;
    root: string;
    groups: string[];
    roles: string[];
    mcpServers: string[];
  };
}

export interface FleetApplyResult {
  applied: boolean;
  profiles: string[];
  federationPath: string;
  validation: FleetPlanValidation;
}

export interface FleetApplyOptions {
  overwrite?: boolean;
  dryRun?: boolean;
}

const AGENT_ID = /^[a-z][a-z0-9_-]{0,63}$/;

export function createFleetPlanningPrompt(profile: string, userPrompt: string): string {
  return [
    "You are designing an operating fleet for Union Street.",
    "Return only a YAML document matching kind: union-street.fleet-plan and version: 1.",
    "Do not include markdown fences or commentary.",
    "The plan is a proposal only; the control plane validates and materializes it.",
    "",
    "Required top-level fields:",
    "version, kind, name, mission, root, generatedBy, agents.",
    "",
    "Each agent requires:",
    "id, displayName, title, manager when not root, groups, roles, soul, model { provider, id }.",
    "",
    "Optional agent fields:",
    "fallback, mcp, cli, permissions, secrets, runtime, pulse, schedule, memory.",
    "",
    "Policy constraints:",
    "- exactly one root agent with no manager",
    "- every non-root agent reports to an agent in this plan",
    "- no cycles",
    "- keep MCP/tooling scoped to the role",
    "- prefer local/host runtime unless a role clearly needs another environment",
    "- pulse should describe repeatable self-check instructions, not a one-off task",
    "",
    `generatedBy: ${profile}`,
    "",
    "Human request:",
    userPrompt.trim(),
  ].join("\n");
}

export function parseFleetPlanText(text: string): FleetPlan {
  const candidate = extractYamlDocument(text);
  return normalizeFleetPlan(yaml.load(candidate));
}

export function serializeFleetPlan(plan: FleetPlan): string {
  return yaml.dump(normalizeFleetPlan(plan), { lineWidth: 100, noRefs: true });
}

export function normalizeFleetPlan(value: unknown): FleetPlan {
  if (!isRecord(value)) throw new Error("fleet plan must be a YAML object");
  const agents = readArray(value.agents).map(normalizeFleetAgent);
  const version = Number(value.version);
  return {
    version: (version === 1 ? 1 : version) as 1,
    kind: (readString(value.kind) ?? "") as "union-street.fleet-plan",
    name: readString(value.name) ?? "",
    mission: readString(value.mission) ?? "",
    root: readString(value.root) ?? agents.find((agent) => !agent.manager)?.id ?? "",
    generatedBy: readString(value.generatedBy) ?? readString(value.generated_by) ?? "",
    agents,
  };
}

export async function readFleetPlanFile(path: string): Promise<FleetPlan> {
  return normalizeFleetPlan(yaml.load(await fs.readFile(path, "utf8")));
}

export async function writeFleetPlanFile(path: string, plan: FleetPlan): Promise<void> {
  await fs.writeFile(path, serializeFleetPlan(plan));
}

export async function validateFleetPlan(plan: FleetPlan, options: { allowExisting?: boolean } = {}): Promise<FleetPlanValidation> {
  const normalized = normalizeFleetPlan(plan);
  const errors: string[] = [];
  const warnings: string[] = [];
  const byId = new Map<string, FleetPlanAgent>();
  const roots = normalized.agents.filter((agent) => !agent.manager);

  if (normalized.kind !== "union-street.fleet-plan") errors.push("kind must be union-street.fleet-plan");
  if (normalized.version !== 1) errors.push("version must be 1");
  if (!normalized.name.trim()) errors.push("name is required");
  if (!normalized.generatedBy) errors.push("generatedBy is required for audit");
  if (!normalized.mission.trim()) errors.push("mission is required");
  if (!normalized.root.trim()) errors.push("root is required");
  if (roots.length !== 1) errors.push(`fleet plan must have exactly one root agent, found ${roots.length}`);
  if (normalized.root && !normalized.agents.some((agent) => agent.id === normalized.root)) errors.push(`root "${normalized.root}" is not in agents`);
  if (roots[0] && normalized.root && roots[0].id !== normalized.root) errors.push(`root "${normalized.root}" must be the only agent without a manager`);

  for (const agent of normalized.agents) {
    if (!AGENT_ID.test(agent.id)) errors.push(`agent id "${agent.id}" is invalid; use lowercase letters, digits, "_" or "-" and start with a letter`);
    if (byId.has(agent.id)) errors.push(`duplicate agent id "${agent.id}"`);
    byId.set(agent.id, agent);
    if (!agent.displayName.trim()) errors.push(`agent "${agent.id}" is missing displayName`);
    if (!agent.title.trim()) errors.push(`agent "${agent.id}" is missing title`);
    if (!agent.soul.trim()) errors.push(`agent "${agent.id}" is missing soul instructions`);
    if (!agent.model.provider || !agent.model.id) errors.push(`agent "${agent.id}" must declare model.provider and model.id`);
    if (agent.manager === agent.id) errors.push(`agent "${agent.id}" cannot manage itself`);
    if (!agent.groups.length) warnings.push(`agent "${agent.id}" has no groups; policy will only match direct agent grants`);
    if (!agent.roles.length) warnings.push(`agent "${agent.id}" has no roles; role-based governance will not apply`);
    if (!options.allowExisting && await profileExists(agent.id)) errors.push(`profile "${agent.id}" already exists; pass overwrite/apply --replace to materialize intentionally`);
  }

  for (const agent of normalized.agents) {
    if (agent.manager && !byId.has(agent.manager)) errors.push(`agent "${agent.id}" manager "${agent.manager}" is not in the plan`);
  }
  for (const cycle of findManagerCycles(normalized.agents)) errors.push(`manager cycle detected: ${cycle.join(" -> ")}`);

  const groups = unique(normalized.agents.flatMap((agent) => agent.groups));
  const roles = unique(["agent", ...normalized.agents.flatMap((agent) => agent.roles)]);
  const mcpServers = unique(normalized.agents.flatMap((agent) => agent.mcp ?? []));
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      agents: normalized.agents.length,
      root: normalized.root,
      groups,
      roles,
      mcpServers,
    },
  };
}

export async function applyFleetPlan(plan: FleetPlan, options: FleetApplyOptions = {}): Promise<FleetApplyResult> {
  const normalized = normalizeFleetPlan(plan);
  const validation = await validateFleetPlan(normalized, { allowExisting: options.overwrite === true });
  if (!validation.ok) {
    await writeEvent({
      type: "fleet.apply.reject",
      actor: normalized.generatedBy,
      resource: `fleet:${normalized.name}`,
      outcome: "deny",
      reason: validation.errors.join("; "),
      payload: { errors: validation.errors, warnings: validation.warnings },
    });
    return {
      applied: false,
      profiles: [],
      federationPath: "",
      validation,
    };
  }
  if (options.dryRun) {
    return {
      applied: false,
      profiles: normalized.agents.map((agent) => agent.id),
      federationPath: "",
      validation,
    };
  }

  const packs = buildFleetAgentPacks(normalized);
  for (const agent of normalized.agents) {
    await initProfile(agent.id, { role: agent.title, capabilities: agent.roles });
    await fs.writeFile(profilePaths(agent.id).soul, normalizeSoul(agent));
    await writeAgentPack(agent.id, packs.get(agent.id)!);
  }

  const federation = await mergeFleetIntoFederation(await readFederationConfig().catch(() => undefined), normalized);
  await writeFederationConfig(federation);
  await writeEvent({
    type: "fleet.apply.complete",
    actor: normalized.generatedBy,
    subject: normalized.root,
    resource: `fleet:${normalized.name}`,
    outcome: "success",
    payload: {
      agents: normalized.agents.map((agent) => agent.id),
      groups: validation.summary.groups,
      mcpServers: validation.summary.mcpServers,
    },
  });
  return {
    applied: true,
    profiles: normalized.agents.map((agent) => agent.id),
    federationPath: "federation.yaml",
    validation,
  };
}

export function buildFleetAgentPacks(plan: FleetPlan): Map<string, AgentPack> {
  const normalized = normalizeFleetPlan(plan);
  const org = normalized.agents.map((agent): FederationOrgNode => ({
    id: agent.id,
    displayName: agent.displayName,
    title: agent.title,
    ...(agent.manager ? { manager: agent.manager } : {}),
    roles: agent.roles,
    groups: agent.groups,
  }));
  const agentsById = new Map(normalized.agents.map((agent) => [agent.id, agent]));
  const packs = new Map<string, AgentPack>();
  for (const node of org) {
    const agent = agentsById.get(node.id)!;
    const pack = buildAgentPackFromOrgNode(node, org);
    packs.set(node.id, {
      ...pack,
      model: {
        primary: agent.model,
        fallback: agent.fallback ?? pack.model.fallback,
      },
      pulse: {
        ...pack.pulse,
        ...agent.pulse,
        instructions: agent.pulse?.instructions ?? pack.pulse.instructions,
      },
      schedule: agent.schedule ?? pack.schedule,
      runtime: {
        ...pack.runtime,
        ...agent.runtime,
        secrets: agent.secrets ?? agent.runtime?.secrets ?? pack.runtime.secrets,
      },
      toolkit: {
        cli: agent.cli ?? pack.toolkit.cli,
        mcp: agent.mcp ?? pack.toolkit.mcp,
        permissions: agent.permissions ?? pack.toolkit.permissions,
      },
      memory: {
        ...pack.memory,
        ...agent.memory,
      },
    });
  }
  return packs;
}

async function mergeFleetIntoFederation(current: FederationConfig | undefined, plan: FleetPlan): Promise<FederationConfig> {
  const base = current ?? {
    version: 1 as const,
    issuer: "urn:union-street:local",
    audiences: ["urn:union-street:agents"],
    principals: { humans: {}, agents: {}, groups: {}, roles: {}, services: {} },
    grants: [],
    oidcProviders: {},
  };
  const next: FederationConfig = {
    ...base,
    principals: {
      humans: { ...base.principals.humans },
      agents: { ...base.principals.agents },
      groups: { ...base.principals.groups },
      roles: { ...base.principals.roles },
      services: { ...base.principals.services },
    },
    grants: base.grants.filter((grant) => !grant.id?.startsWith(`fleet:${plan.name}:`)),
    oidcProviders: { ...base.oidcProviders },
  };
  next.principals.groups["all-agents"] = {
    id: "all-agents",
    kind: "group",
    displayName: "All agents",
    roles: unique([...(next.principals.groups["all-agents"]?.roles ?? []), "agent"]),
    members: unique([...(next.principals.groups["all-agents"]?.members ?? []), ...plan.agents.map((agent) => agent.id)]),
  };
  for (const role of unique(["agent", ...plan.agents.flatMap((agent) => agent.roles)])) {
    next.principals.roles[role] = next.principals.roles[role] ?? { id: role, kind: "role", displayName: titleWords(role) };
  }
  for (const groupId of unique(plan.agents.flatMap((agent) => agent.groups))) {
    const existing = next.principals.groups[groupId];
    next.principals.groups[groupId] = {
      id: groupId,
      kind: "group",
      displayName: existing?.displayName ?? titleWords(groupId),
      roles: unique([...(existing?.roles ?? []), groupId]),
      members: unique([...(existing?.members ?? []), ...plan.agents.filter((agent) => agent.groups.includes(groupId)).map((agent) => agent.id)]),
    };
    next.principals.roles[groupId] = next.principals.roles[groupId] ?? { id: groupId, kind: "role", displayName: titleWords(groupId) };
  }
  for (const agent of plan.agents) {
    next.principals.agents[agent.id] = {
      id: agent.id,
      kind: "agent",
      displayName: `${agent.displayName} Agent`,
      title: agent.title,
      ...(agent.manager ? { manager: agent.manager } : {}),
      roles: agent.roles,
      groups: agent.groups,
    };
  }
  for (const agent of plan.agents) {
    if (!agent.mcp?.length) continue;
    next.grants.push({
      id: `fleet:${plan.name}:${agent.id}:mcp`,
      resource: "mcp",
      agents: [agent.id],
      servers: agent.mcp,
      tools: ["*"],
      requireApproval: true,
    } satisfies FederationGrant);
  }
  return next;
}

function normalizeFleetAgent(value: unknown): FleetPlanAgent {
  if (!isRecord(value)) throw new Error("fleet plan agents must be YAML objects");
  const model = readRecord(value.model);
  return {
    id: readString(value.id) ?? "",
    displayName: readString(value.displayName) ?? readString(value.display_name) ?? readString(value.name) ?? "",
    title: readString(value.title) ?? "",
    ...(readString(value.manager) ? { manager: readString(value.manager) } : {}),
    groups: readStringArray(value.groups),
    roles: readStringArray(value.roles),
    soul: readString(value.soul) ?? "",
    model: {
      provider: readString(model.provider) ?? "",
      id: readString(model.id) ?? "",
    },
    ...(readModelTargets(value.fallback).length ? { fallback: readModelTargets(value.fallback) } : {}),
    ...(readStringArray(value.mcp).length ? { mcp: readStringArray(value.mcp) } : {}),
    ...(readStringArray(value.cli).length ? { cli: readStringArray(value.cli) } : {}),
    ...(readStringArray(value.permissions).length ? { permissions: readStringArray(value.permissions) } : {}),
    ...(readStringArray(value.secrets).length ? { secrets: readStringArray(value.secrets) } : {}),
    ...(isRecord(value.runtime) ? { runtime: normalizeRuntime(value.runtime) } : {}),
    ...(isRecord(value.pulse) ? { pulse: normalizePulse(value.pulse) } : {}),
    ...(readSchedule(value.schedule).length ? { schedule: readSchedule(value.schedule) } : {}),
    ...(isRecord(value.memory) ? { memory: normalizeMemory(value.memory) } : {}),
  };
}

function normalizeRuntime(value: Record<string, unknown>): Partial<AgentPack["runtime"]> {
  return {
    ...(readString(value.environment) ? { environment: readString(value.environment) } : {}),
    ...(readString(value.compute) ? { compute: readString(value.compute) } : {}),
    ...(readString(value.storage) ? { storage: readString(value.storage) } : {}),
    ...(readString(value.workspace) ? { workspace: readString(value.workspace) } : {}),
    ...(readStringArray(value.secrets).length ? { secrets: readStringArray(value.secrets) } : {}),
  };
}

function normalizePulse(value: Record<string, unknown>): Partial<AgentPack["pulse"]> {
  return {
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    ...(readString(value.cadence) ? { cadence: readString(value.cadence) } : {}),
    ...(readString(value.instructions) ? { instructions: readString(value.instructions) } : {}),
  };
}

function normalizeMemory(value: Record<string, unknown>): Partial<AgentPack["memory"]> {
  const provider = readString(value.provider);
  return {
    ...(provider === "honcho" || provider === "local" || provider === "none" ? { provider } : {}),
    ...(readString(value.peerProfile) ? { peerProfile: readString(value.peerProfile) } : {}),
    ...(readStringArray(value.sharedNamespaces).length ? { sharedNamespaces: readStringArray(value.sharedNamespaces) } : {}),
  };
}

function readSchedule(value: unknown): AgentPackSchedule[] {
  return readArray(value).map((item, index) => {
    const raw = readRecord(item);
    return {
      id: readString(raw.id) ?? `schedule-${index + 1}`,
      name: readString(raw.name) ?? `Schedule ${index + 1}`,
      cron: readString(raw.cron) ?? "0 9 * * MON",
      timezone: readString(raw.timezone) ?? "America/Los_Angeles",
      prompt: readString(raw.prompt) ?? "",
      deliverables: readStringArray(raw.deliverables),
    };
  });
}

function readModelTargets(value: unknown): AgentPackModelTarget[] {
  return readArray(value).map((item) => {
    const raw = readRecord(item);
    return { provider: readString(raw.provider) ?? "", id: readString(raw.id) ?? "" };
  }).filter((item) => item.provider && item.id);
}

function normalizeSoul(agent: FleetPlanAgent): string {
  return agent.soul.trim().startsWith("#") ? `${agent.soul.trim()}\n` : `# ${agent.displayName}\n\n${agent.soul.trim()}\n`;
}

function extractYamlDocument(text: string): string {
  const fence = text.match(/```(?:ya?ml)?\s*([\s\S]*?)```/i);
  return (fence?.[1] ?? text).trim();
}

function findManagerCycles(agents: FleetPlanAgent[]): string[][] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const cycles: string[][] = [];
  for (const agent of agents) {
    const seen = new Set<string>();
    let current: FleetPlanAgent | undefined = agent;
    while (current?.manager) {
      if (seen.has(current.id)) {
        cycles.push([...seen, current.id]);
        break;
      }
      seen.add(current.id);
      current = byId.get(current.manager);
    }
  }
  return cycles;
}

function titleWords(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
