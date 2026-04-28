import { promises as fs } from "node:fs";
import yaml from "js-yaml";
import { z } from "zod";
import { profilePaths } from "./paths.ts";
import type { FederationOrgNode } from "./federation.ts";

export const AGENT_PACK_FILENAME = "agent.yaml";

export interface AgentPackModelTarget {
  provider: string;
  id: string;
}

export interface AgentPackIdentity {
  profile: string;
  subject: string;
  displayName: string;
  title: string;
  manager?: string;
  directReports: string[];
  groups: string[];
  roles: string[];
}

export interface AgentPackOidc {
  issuer: string;
  subject: string;
  audiences: string[];
  claims: {
    profile: string;
    groups: string;
    roles: string;
    principals: string;
  };
}

export interface AgentPackLash {
  thread: string;
  delegate: "direct_reports" | "descendants" | "none";
  report: "manager" | "none";
  structured: "preferred" | "required" | "optional";
}

export interface AgentPackPulse {
  enabled: boolean;
  cadence: string;
  instructions: string;
}

export interface AgentPackSchedule {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  deliverables: string[];
}

export interface AgentPackRuntime {
  environment: string;
  compute: string;
  storage: string;
  workspace: string;
  secrets: string[];
}

export interface AgentPackToolkit {
  cli: string[];
  mcp: string[];
  permissions: string[];
}

export interface AgentPackMemory {
  provider: "honcho" | "local" | "none";
  peerProfile: string;
  sharedNamespaces: string[];
}

export interface AgentPack {
  version: 1;
  id: string;
  soul: string;
  model: {
    primary: AgentPackModelTarget;
    fallback: AgentPackModelTarget[];
  };
  identity: AgentPackIdentity;
  oidc: AgentPackOidc;
  lash: AgentPackLash;
  pulse: AgentPackPulse;
  schedule: AgentPackSchedule[];
  runtime: AgentPackRuntime;
  toolkit: AgentPackToolkit;
  memory: AgentPackMemory;
}

const ModelTargetSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
});

const AgentPackSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  soul: z.string().min(1),
  model: z.object({
    primary: ModelTargetSchema,
    fallback: z.array(ModelTargetSchema).default([]),
  }),
  identity: z.object({
    profile: z.string().min(1),
    subject: z.string().min(1),
    displayName: z.string().min(1),
    title: z.string().min(1),
    manager: z.string().optional(),
    directReports: z.array(z.string()).default([]),
    groups: z.array(z.string()).default([]),
    roles: z.array(z.string()).default([]),
  }),
  oidc: z.object({
    issuer: z.string().min(1),
    subject: z.string().min(1),
    audiences: z.array(z.string()).default(["urn:union-street:agents"]),
    claims: z.object({
      profile: z.string().default("us_profile"),
      groups: z.string().default("us_groups"),
      roles: z.string().default("us_roles"),
      principals: z.string().default("us_principals"),
    }),
  }),
  lash: z.object({
    thread: z.string().min(1),
    delegate: z.enum(["direct_reports", "descendants", "none"]),
    report: z.enum(["manager", "none"]),
    structured: z.enum(["preferred", "required", "optional"]),
  }),
  pulse: z.object({
    enabled: z.boolean(),
    cadence: z.string().min(1),
    instructions: z.string().default(""),
  }),
  schedule: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    cron: z.string().min(1),
    timezone: z.string().min(1),
    prompt: z.string().default(""),
    deliverables: z.array(z.string()).default([]),
  })).default([]),
  runtime: z.object({
    environment: z.string().min(1),
    compute: z.string().min(1),
    storage: z.string().min(1),
    workspace: z.string().min(1),
    secrets: z.array(z.string()).default([]),
  }),
  toolkit: z.object({
    cli: z.array(z.string()).default([]),
    mcp: z.array(z.string()).default([]),
    permissions: z.array(z.string()).default([]),
  }),
  memory: z.object({
    provider: z.enum(["honcho", "local", "none"]),
    peerProfile: z.string().min(1),
    sharedNamespaces: z.array(z.string()).default([]),
  }),
});

export function normalizeAgentPack(value: unknown): AgentPack {
  return AgentPackSchema.parse(value) as AgentPack;
}

export async function readAgentPack(profile: string): Promise<AgentPack> {
  const raw = await fs.readFile(profilePaths(profile).agentPack, "utf8");
  return normalizeAgentPack(yaml.load(raw));
}

export async function writeAgentPack(profile: string, pack: AgentPack): Promise<void> {
  const normalized = normalizeAgentPack(pack);
  await fs.mkdir(profilePaths(profile).root, { recursive: true });
  await fs.writeFile(profilePaths(profile).agentPack, yaml.dump(normalized, { lineWidth: 100 }));
}

export function buildDemoAgentPacks(org: FederationOrgNode[]): AgentPack[] {
  return org.map((node) => buildAgentPackFromOrgNode(node, org));
}

export function buildAgentPackFromOrgNode(
  node: FederationOrgNode,
  org: FederationOrgNode[],
): AgentPack {
  const directReports = org.filter((candidate) => candidate.manager === node.id).map((candidate) => candidate.id);
  const department = node.groups.find((group) => group !== "executives") ?? "executives";
  const isRoot = !node.manager;
  const fallback = department === "engineering"
    ? [{ provider: "codex", id: "gpt-5.3-codex-spark" }]
    : [{ provider: "codex", id: "gpt-5.4-mini" }];

  return {
    version: 1,
    id: node.id,
    soul: `./SOUL.md`,
    model: {
      primary: { provider: "codex", id: isRoot ? "gpt-5.5" : "gpt-5.4" },
      fallback,
    },
    identity: {
      profile: node.id,
      subject: `agent:${node.id}`,
      displayName: node.displayName,
      title: node.title,
      ...(node.manager ? { manager: node.manager } : {}),
      directReports,
      groups: node.groups,
      roles: node.roles,
    },
    oidc: {
      issuer: "urn:union-street:demo-enterprise",
      subject: `agent:${node.id}`,
      audiences: ["urn:union-street:agents", "union-street-demo"],
      claims: {
        profile: "us_profile",
        groups: "us_groups",
        roles: "us_roles",
        principals: "us_principals",
      },
    },
    lash: {
      thread: `lash:${node.manager ?? node.id}/${node.id}`,
      delegate: isRoot ? "descendants" : directReports.length ? "direct_reports" : "none",
      report: node.manager ? "manager" : "none",
      structured: "preferred",
    },
    pulse: {
      enabled: true,
      cadence: "every 30m",
      instructions: [
        `Inspect open work for @${node.id}.`,
        "Delegate only to visible direct reports.",
        "Report material blockers upward through Lash.",
        "Propose instruction changes when the pulse becomes stale or noisy.",
      ].join("\n"),
    },
    schedule: [
      {
        id: "weekly-status",
        name: "Weekly status sync",
        cron: "0 9 * * MON",
        timezone: "America/Los_Angeles",
        prompt: `Wake @${node.id} for a scoped status review. Preserve Lash visibility and summarize only decision-ready work.`,
        deliverables: ["status summary", "material risks", "next delegation or report action"],
      },
    ],
    runtime: {
      environment: "local/host",
      compute: "local",
      storage: "local",
      workspace: `profiles/${node.id}/workspace`,
      secrets: [`profile:${node.id}`],
    },
    toolkit: {
      cli: ["delegate", "report", "read", "write", "shell"],
      mcp: mcpServersForGroups(node.groups),
      permissions: ["manager:read", "direct_reports:delegate", "memory:read", "memory:write"],
    },
    memory: {
      provider: "honcho",
      peerProfile: node.id,
      sharedNamespaces: ["institutional", `group:${department}`],
    },
  };
}

function mcpServersForGroups(groups: string[]): string[] {
  const servers = new Set<string>();
  if (groups.includes("executives")) ["github", "linear", "slack"].forEach((server) => servers.add(server));
  if (groups.includes("engineering")) servers.add("github");
  if (groups.includes("operations")) ["linear", "slack"].forEach((server) => servers.add(server));
  if (groups.includes("go-to-market")) ["hubspot", "slack"].forEach((server) => servers.add(server));
  if (groups.includes("finance")) ["stripe", "quickbooks"].forEach((server) => servers.add(server));
  return [...servers].sort();
}
