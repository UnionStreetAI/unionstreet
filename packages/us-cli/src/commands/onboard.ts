/**
 * `us onboard` — create/review/apply an initial agent fleet from operator input.
 */
import kleur from "kleur";
import {
  applyFleetPlan,
  serializeFleetPlan,
  setDefaultProfile,
  validateFleetPlan,
  writeFleetPlanFile,
  type FleetPlan,
  type FleetPlanAgent,
} from "@unionstreet/server";
import { setup } from "./setup.ts";

export interface OnboardArgs {
  name?: string;
  mission?: string;
  root?: string;
  department?: string | string[];
  plugin?: string | string[];
  skill?: string | string[];
  mcp?: string | string[];
  modelProvider?: string;
  model?: string;
  out?: string;
  apply?: boolean;
  replace?: boolean;
  skipSetup?: boolean;
  json?: boolean;
}

interface DepartmentSpec {
  id: string;
  label: string;
}

interface DepartmentPreset {
  id: string;
  label: string;
  mission: string;
  leadTitle: string;
  specialistTitle: string;
  leadSoul: string[];
  specialistSoul: string[];
  pulseInstructions: string;
  plugins: string[];
  mcp: string[];
}

const DEFAULT_DEPARTMENTS = ["operations", "go-to-market", "finance", "engineering"];
const DEFAULT_MISSION = "Operate a useful local Union Street agent fleet.";
const DEPARTMENT_PRESETS: Record<string, DepartmentPreset> = {
  operations: {
    id: "operations",
    label: "Operations",
    mission: "Keep the fleet's work queue, runbooks, releases, incidents, and cross-functional follow-through boringly reliable.",
    leadTitle: "VP Operations",
    specialistTitle: "Operations Specialist",
    leadSoul: [
      "Own operating cadence, blocker removal, runbooks, and cross-department follow-through.",
      "Convert ambiguous status into owners, dates, risks, and escalation paths.",
      "Keep incident/release work auditable without turning routine check-ins into noise.",
    ],
    specialistSoul: [
      "Maintain runbooks, checklist hygiene, release notes, incident summaries, and operational handoffs.",
      "Prefer concrete evidence, timestamps, owners, and next actions over broad status prose.",
    ],
    pulseInstructions: "Review stale work, missing owners, aging blockers, release readiness, and operational handoffs; escalate only material risk.",
    plugins: ["vercel", "cloudflare"],
    mcp: ["linear"],
  },
  "go-to-market": {
    id: "go-to-market",
    label: "GTM",
    mission: "Turn product and market signals into pipeline, customer proof, launch plans, and revenue-facing execution.",
    leadTitle: "VP GTM",
    specialistTitle: "GTM Specialist",
    leadSoul: [
      "Own pipeline-oriented planning, launches, customer proof, competitive notes, and handoffs to support and finance.",
      "Keep GTM output tactical: segments, accounts, messages, dates, owners, blockers, and measurable next steps.",
      "Coordinate with engineering without inventing product commitments.",
    ],
    specialistSoul: [
      "Draft account research, campaign briefs, launch checklists, customer notes, and field-ready summaries.",
      "Separate facts from guesses and flag missing CRM or customer context explicitly.",
    ],
    pulseInstructions: "Review pipeline blockers, launch dependencies, customer follow-ups, messaging gaps, and promised deliverables.",
    plugins: ["gtm", "stripe"],
    mcp: ["linear"],
  },
  gtm: {
    id: "go-to-market",
    label: "GTM",
    mission: "Turn product and market signals into pipeline, customer proof, launch plans, and revenue-facing execution.",
    leadTitle: "VP GTM",
    specialistTitle: "GTM Specialist",
    leadSoul: [
      "Own pipeline-oriented planning, launches, customer proof, competitive notes, and handoffs to support and finance.",
      "Keep GTM output tactical: segments, accounts, messages, dates, owners, blockers, and measurable next steps.",
      "Coordinate with engineering without inventing product commitments.",
    ],
    specialistSoul: [
      "Draft account research, campaign briefs, launch checklists, customer notes, and field-ready summaries.",
      "Separate facts from guesses and flag missing CRM or customer context explicitly.",
    ],
    pulseInstructions: "Review pipeline blockers, launch dependencies, customer follow-ups, messaging gaps, and promised deliverables.",
    plugins: ["gtm", "stripe"],
    mcp: ["linear"],
  },
  finance: {
    id: "finance",
    label: "Finance",
    mission: "Protect cash, billing hygiene, revenue visibility, budget awareness, and approval discipline.",
    leadTitle: "VP Finance",
    specialistTitle: "Finance Specialist",
    leadSoul: [
      "Own billing readiness, forecast hygiene, spend awareness, approval gates, and financial risk reporting.",
      "Keep numbers traceable to source systems or label them estimates.",
      "Escalate approval-sensitive work instead of silently taking action.",
    ],
    specialistSoul: [
      "Prepare invoice checks, revenue notes, budget variance summaries, and approval-ready finance packets.",
      "Never blur confirmed financial records with estimates or assumptions.",
    ],
    pulseInstructions: "Review billing blockers, forecast deltas, approval-needed spend, missing financial evidence, and revenue-risk handoffs.",
    plugins: ["stripe"],
    mcp: ["linear"],
  },
  engineering: {
    id: "engineering",
    label: "Engineering",
    mission: "Ship reliable code, review architecture, manage incidents, harden tests, and keep technical decisions reviewable.",
    leadTitle: "VP Engineering",
    specialistTitle: "Engineering Specialist",
    leadSoul: [
      "Own technical quality, code review posture, reliability, test strategy, and implementation delegation.",
      "Turn product or operator asks into scoped engineering work with acceptance criteria and verification.",
      "Prefer small reviewable changes, reproducible tests, and explicit risk notes.",
    ],
    specialistSoul: [
      "Execute focused implementation, debugging, review, and test-hardening work with clear evidence.",
      "Report exact files, commands, failures, and residual risks instead of generic progress.",
    ],
    pulseInstructions: "Review failing tests, open PRs, architectural risks, dependency drift, release blockers, and missing verification.",
    plugins: ["github"],
    mcp: ["linear"],
  },
};

export async function onboard(args: OnboardArgs = {}): Promise<boolean> {
  const root = normalizeId(args.root ?? "coo");
  const plan = createOnboardingFleetPlan(args, root);

  if (!args.skipSetup) {
    const setupOk = await setup({ profile: root });
    if (!setupOk) return false;
  }

  const validation = await validateFleetPlan(plan, { allowExisting: args.replace === true || root === plan.root });
  if (args.out) await writeFleetPlanFile(args.out, plan);

  if (args.json) {
    console.log(JSON.stringify({ plan, validation }, null, 2));
  } else {
    printOnboardingPlan(plan, validation, args.out);
  }

  if (!validation.ok) return false;
  if (!args.apply) return true;

  const result = await applyFleetPlan(plan, { overwrite: args.replace === true });
  if (result.applied) {
    await setDefaultProfile(plan.root);
    console.log(kleur.green(`applied ${result.profiles.length} agents; default profile is ${plan.root}`));
  }
  return result.applied;
}

export function createOnboardingFleetPlan(args: OnboardArgs = {}, root = normalizeId(args.root ?? "coo")): FleetPlan {
  const name = normalizeName(args.name ?? "local-agent-fleet");
  const mission = String(args.mission ?? DEFAULT_MISSION).trim() || DEFAULT_MISSION;
  const departments = normalizeDepartments(args.department);
  const plugins = normalizeList(args.plugin);
  const skills = normalizeList(args.skill);
  const mcp = normalizeList(args.mcp);
  const model = {
    provider: args.modelProvider ?? "codex",
    id: args.model ?? "gpt-5.4",
  };

  const agents: FleetPlanAgent[] = [
    {
      id: root,
      displayName: "COO",
      title: "Chief Operating Agent",
      groups: ["executives", "operations"],
      roles: ["executive", "operator"],
      soul: [
        "Own the operating rhythm for the whole agent fleet.",
        "Delegate through departments, preserve traceability, and escalate material blockers.",
      ].join(" "),
      model,
      cli: ["delegate", "report", "read", "write", "shell"],
      ...(plugins.length ? { plugins } : {}),
      ...(skills.length ? { plugins: unique([...plugins, ...skills]) } : {}),
      permissions: ["manager:read", "direct_reports:delegate", "memory:read", "memory:write"],
      memory: { provider: "honcho", peerProfile: root, sharedNamespaces: ["institutional"] },
      pulse: {
        enabled: true,
        cadence: "every 30m",
        instructions: "Inspect the fleet for blocked work, stale context, missing memory, and unresolved reports.",
      },
    },
  ];

  for (const dept of departments) {
    const preset = presetForDepartment(dept);
    const vpId = normalizeId(`vp-${dept.id}`);
    const deptPlugins = pluginDefaultsForDepartment(preset, plugins);
    const deptMcp = mcpDefaultsForDepartment(preset, mcp);
    agents.push({
      id: vpId,
      displayName: `${preset.label} Lead`,
      title: preset.leadTitle,
      manager: root,
      groups: [dept.id],
      roles: ["vp", dept.id],
      soul: [preset.mission, ...preset.leadSoul].join(" "),
      model,
      cli: ["delegate", "report", "read", "write", "shell"],
      ...(deptMcp.length ? { mcp: deptMcp } : {}),
      ...(deptPlugins.length ? { plugins: deptPlugins } : {}),
      permissions: ["direct_reports:delegate", "manager:report", "memory:read", "memory:write"],
      memory: { provider: "honcho", peerProfile: vpId, sharedNamespaces: ["institutional", `group:${dept.id}`] },
      pulse: {
        enabled: true,
        cadence: "every 30m",
        instructions: preset.pulseInstructions,
      },
    });
    const specialistId = normalizeId(`${dept.id}-specialist`);
    agents.push({
      id: specialistId,
      displayName: preset.specialistTitle,
      title: preset.specialistTitle,
      manager: vpId,
      groups: [dept.id],
      roles: ["ic", dept.id],
      soul: [preset.mission, ...preset.specialistSoul].join(" "),
      model,
      cli: ["report", "read", "write", "shell"],
      ...(deptMcp.length ? { mcp: deptMcp } : {}),
      ...(deptPlugins.length ? { plugins: deptPlugins } : {}),
      permissions: ["manager:report", "memory:read", "memory:write"],
      memory: { provider: "honcho", peerProfile: specialistId, sharedNamespaces: ["institutional", `group:${dept.id}`] },
    });
  }

  return {
    version: 1,
    kind: "union-street.fleet-plan",
    name,
    mission,
    root,
    generatedBy: root,
    agents,
  };
}

function printOnboardingPlan(plan: FleetPlan, validation: Awaited<ReturnType<typeof validateFleetPlan>>, out: string | undefined): void {
  console.log("");
  console.log(kleur.bold("agent fleet onboarding"));
  console.log(`  name    ${kleur.cyan(plan.name)}`);
  console.log(`  mission ${kleur.dim(plan.mission)}`);
  console.log(`  root    ${kleur.cyan(`@${plan.root}`)}`);
  console.log(`  agents  ${kleur.cyan(String(plan.agents.length))}`);
  console.log(`  groups  ${kleur.dim(validation.summary.groups.join(", ") || "none")}`);
  console.log(`  plugins ${kleur.dim(validation.summary.plugins.join(", ") || "none")}`);
  console.log(`  mcp     ${kleur.dim(validation.summary.mcpServers.join(", ") || "none")}`);
  if (out) console.log(`  wrote   ${kleur.dim(out)}`);
  for (const warning of validation.warnings) console.log(`  ${kleur.yellow("warn")}  ${warning}`);
  for (const error of validation.errors) console.log(`  ${kleur.red("error")} ${error}`);
  console.log(validation.ok ? kleur.green("  validation ok") : kleur.red("  validation failed"));
  if (!out) {
    console.log("");
    process.stdout.write(serializeFleetPlan(plan));
  }
}

function normalizeDepartments(value: string | string[] | undefined): DepartmentSpec[] {
  const raw = normalizeList(value);
  const names = raw.length ? raw : DEFAULT_DEPARTMENTS;
  const departments = names.map((item) => {
    const [idRaw, labelRaw] = item.split(":", 2);
    const normalized = normalizeId(idRaw || "department");
    const preset = DEPARTMENT_PRESETS[normalized];
    const id = preset?.id ?? normalized;
    return { id, label: labelRaw?.trim() || preset?.label || titleWords(id) };
  });
  const byId = new Map<string, DepartmentSpec>();
  for (const department of departments) byId.set(department.id, department);
  return [...byId.values()];
}

function normalizeList(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return unique(values.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean));
}

function normalizeId(value: string): string {
  const id = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(id) ? id.slice(0, 64) : `agent-${id}`.slice(0, 64);
}

function normalizeName(value: string): string {
  return normalizeId(value) || "local-agent-fleet";
}

function titleWords(value: string): string {
  return value.split(/[-_]/g).filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function presetForDepartment(department: DepartmentSpec): DepartmentPreset {
  return DEPARTMENT_PRESETS[department.id] ?? {
    id: department.id,
    label: department.label,
    mission: `Own ${department.label} execution with clear delegated work, evidence, and upward reporting.`,
    leadTitle: `VP ${department.label}`,
    specialistTitle: `${department.label} Specialist`,
    leadSoul: [
      `Translate ${department.label} priorities into concrete delegated work, crisp reports, and durable memory.`,
      "Keep authority scoped to direct reports and report material blockers upward.",
    ],
    specialistSoul: [
      `Execute focused ${department.label} tasks, use granted tools carefully, and report concise findings with evidence.`,
    ],
    pulseInstructions: `Review ${department.label} priorities, delegate only when useful, and report material changes upward.`,
    plugins: [],
    mcp: [],
  };
}

function pluginDefaultsForDepartment(preset: DepartmentPreset, requested: string[]): string[] {
  const defaults = new Set(requested);
  for (const plugin of preset.plugins) defaults.add(plugin);
  return [...defaults];
}

function mcpDefaultsForDepartment(preset: DepartmentPreset, requested: string[]): string[] {
  const defaults = new Set(requested);
  for (const server of preset.mcp) defaults.add(server);
  return [...defaults];
}
