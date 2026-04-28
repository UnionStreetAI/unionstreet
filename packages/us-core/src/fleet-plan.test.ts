import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import {
  applyFleetPlan,
  buildFleetAgentPacks,
  createFleetPlanningPrompt,
  parseFleetPlanText,
  serializeFleetPlan,
  validateFleetPlan,
  type FleetPlan,
} from "./fleet-plan.ts";
import { readAgentPack } from "./agent-pack.ts";
import { readFederationConfig } from "./federation.ts";
import { FEDERATION_PATH, profilePaths } from "./paths.ts";

const createdProfiles = new Set<string>();
let federationBackup: string | undefined;
let federationExisted = false;

afterEach(async () => {
  for (const profile of createdProfiles) {
    await fs.rm(profilePaths(profile).root, { recursive: true, force: true });
  }
  createdProfiles.clear();
  if (federationBackup !== undefined) {
    await fs.mkdir(dirname(FEDERATION_PATH), { recursive: true });
    if (federationExisted) await fs.writeFile(FEDERATION_PATH, federationBackup);
    else await fs.rm(FEDERATION_PATH, { force: true });
  }
  federationBackup = undefined;
  federationExisted = false;
});

describe("fleet plans", () => {
  test("parseFleetPlanText_WhenAgentReturnsYamlFence_NormalizesTheFleetProposal", () => {
    const planText = [
      "```yaml",
      "version: 1",
      "kind: union-street.fleet-plan",
      "name: Launch Company",
      "mission: Build a tiny but capable company.",
      "root: fleet_parse_root",
      "generatedBy: coo",
      "agents:",
      "  - id: fleet_parse_root",
      "    displayName: Root Operator",
      "    title: COO",
      "    groups: [executives]",
      "    roles: [executive]",
      "    soul: Own the whole operating system.",
      "    model: { provider: codex, id: gpt-5.5 }",
      "  - id: fleet_parse_eng",
      "    displayName: Engineering VP",
      "    title: VP Engineering",
      "    manager: fleet_parse_root",
      "    groups: [engineering]",
      "    roles: [vp]",
      "    soul: Turn priorities into shippable engineering work.",
      "    model: { provider: codex, id: gpt-5.4 }",
      "```",
    ].join("\n");

    const plan = parseFleetPlanText(planText);

    expect(
      plan.agents.map((agent) => agent.id),
      "Fleet plan parsing must tolerate model markdown fences while preserving every proposed agent id for validation.",
    ).toEqual(["fleet_parse_root", "fleet_parse_eng"]);
    expect(
      plan.agents[1]?.manager,
      "Parsed non-root agents must preserve their manager because Lash visibility and OIDC policy are derived from this edge.",
    ).toBe("fleet_parse_root");
    expect(
      serializeFleetPlan(plan),
      "Serialized fleet plans must stay in the public YAML contract so humans can review or edit the proposal before applying.",
    ).toContain("kind: union-street.fleet-plan");
  });

  test("validateFleetPlan_WhenPlanHasCycleAndMissingRoot_ReturnsActionableErrors", async () => {
    const plan = sampleFleetPlan("fleet_cycle", [
      { id: "fleet_cycle_a", manager: "fleet_cycle_b" },
      { id: "fleet_cycle_b", manager: "fleet_cycle_a" },
    ]);

    const validation = await validateFleetPlan(plan);

    expect(
      validation.ok,
      "Validation must reject cyclic org charts before writing profiles because recursive delegation would otherwise hang or overexpose visibility.",
    ).toBe(false);
    expect(
      validation.errors.some((error) => error.includes("exactly one root")),
      `Expected a clear root-count error, got: ${validation.errors.join("; ")}`,
    ).toBe(true);
    expect(
      validation.errors.some((error) => error.includes("manager cycle detected")),
      `Expected a clear cycle error, got: ${validation.errors.join("; ")}`,
    ).toBe(true);
  });

  test("buildFleetAgentPacks_WhenGivenPlan_DerivesLashThreadsAndDirectReports", () => {
    const plan = sampleFleetPlan("fleet_pack", [
      { id: "fleet_pack_root" },
      { id: "fleet_pack_vp", manager: "fleet_pack_root", mcp: ["github"] },
      { id: "fleet_pack_mgr", manager: "fleet_pack_vp" },
    ]);

    const packs = buildFleetAgentPacks(plan);

    expect(
      packs.get("fleet_pack_root")?.identity.directReports,
      "The root pack must derive direct reports from the proposed graph rather than trusting model-supplied duplicated fields.",
    ).toEqual(["fleet_pack_vp"]);
    expect(
      packs.get("fleet_pack_root")?.lash.delegate,
      "The root agent must get descendant delegation authority so the human can ask it to drive the whole generated fleet.",
    ).toBe("descendants");
    expect(
      packs.get("fleet_pack_vp")?.lash.thread,
      "Generated Lash threads must encode manager/child routing so reports can flow upward on the same chain.",
    ).toBe("lash:fleet_pack_root/fleet_pack_vp");
    expect(
      packs.get("fleet_pack_vp")?.toolkit.mcp,
      "Requested MCP tools must land in the atomic pack for that specific agent, not as a global dashboard fixture.",
    ).toEqual(["github"]);
  });

  test("applyFleetPlan_WhenProfilesWouldCollide_RefusesWithoutOverwrite", async () => {
    const profile = "fleet_collision_root";
    createdProfiles.add(profile);
    await fs.mkdir(profilePaths(profile).root, { recursive: true });
    const plan = sampleFleetPlan("fleet_collision", [{ id: profile }]);

    const result = await applyFleetPlan(plan);

    expect(
      result.applied,
      "Fleet apply must fail closed when a generated agent would overwrite an existing profile without explicit replace intent.",
    ).toBe(false);
    expect(
      result.validation.errors,
      "The collision error must identify the existing profile so the operator can choose a new fleet name or apply with replacement.",
    ).toContain('profile "fleet_collision_root" already exists; pass overwrite/apply --replace to materialize intentionally');
  });

  test("applyFleetPlan_WhenValidated_WritesProfilesSoulPacksAndFederationGrants", async () => {
    await backupFederation();
    const plan = sampleFleetPlan("fleet_apply", [
      { id: "fleet_apply_root", groups: ["executives"], roles: ["executive"], mcp: ["slack"] },
      { id: "fleet_apply_vp_eng", manager: "fleet_apply_root", groups: ["engineering"], roles: ["vp"], mcp: ["github"] },
      { id: "fleet_apply_dir_eng", manager: "fleet_apply_vp_eng", groups: ["engineering"], roles: ["director"] },
    ]);
    for (const agent of plan.agents) createdProfiles.add(agent.id);

    const result = await applyFleetPlan(plan);
    const rootSoul = await fs.readFile(profilePaths("fleet_apply_root").soul, "utf8");
    const vpPack = await readAgentPack("fleet_apply_vp_eng");
    const federation = await readFederationConfig();

    expect(
      result.applied,
      "A valid fleet plan should materialize deterministically after validation succeeds.",
    ).toBe(true);
    expect(
      rootSoul,
      "Applying a generated fleet must write the head agent's proposed soul into SOUL.md so the new identity is auditable and editable.",
    ).toContain("Operate the fleet_apply company");
    expect(
      vpPack.identity.manager,
      "Applied agent packs must preserve the validated manager edge because delegation and reporting depend on the atomic pack.",
    ).toBe("fleet_apply_root");
    expect(
      federation.principals.groups.engineering?.members,
      "Materialization must register generated agents into federation groups so OIDC claims and MCP policy resolve from live config.",
    ).toContain("fleet_apply_vp_eng");
    expect(
      federation.grants.some((grant) => grant.id === "fleet:fleet_apply:fleet_apply_vp_eng:mcp" && grant.servers.includes("github") && grant.requireApproval),
      "Requested MCP access must become an approval-gated federation grant for the specific agent instead of an unscoped global allow.",
    ).toBe(true);
  });

  test("createFleetPlanningPrompt_WhenGivenHumanIntent_IncludesTheYamlContractAndPolicyBoundaries", () => {
    const humanIntent = "Build the company needed to run an agent orchestration platform.";

    const prompt = createFleetPlanningPrompt("coo", humanIntent);

    expect(
      prompt,
      "The planning prompt must force a machine-readable fleet contract so the control plane can validate before any local writes.",
    ).toContain("kind: union-street.fleet-plan");
    expect(
      prompt,
      "The planning prompt must remind the model that materialization is controlled by policy, not by the generated prose.",
    ).toContain("The plan is a proposal only");
    expect(
      prompt,
      "The planning prompt must preserve the original human intent for the head agent to design around.",
    ).toContain(humanIntent);
  });
});

async function backupFederation(): Promise<void> {
  try {
    federationBackup = await fs.readFile(FEDERATION_PATH, "utf8");
    federationExisted = true;
  } catch {
    federationBackup = "";
    federationExisted = false;
  }
}

function sampleFleetPlan(name: string, agents: Array<Partial<FleetPlan["agents"][number]> & { id: string }>): FleetPlan {
  return {
    version: 1,
    kind: "union-street.fleet-plan",
    name,
    mission: `Operate the ${name} company.`,
    root: agents.find((agent) => !agent.manager)?.id ?? agents[0]?.id ?? "",
    generatedBy: "coo",
    agents: agents.map((agent) => ({
      id: agent.id,
      displayName: agent.displayName ?? agent.id.replace(/_/g, " "),
      title: agent.title ?? "Generated Agent",
      ...(agent.manager ? { manager: agent.manager } : {}),
      groups: agent.groups ?? ["generated"],
      roles: agent.roles ?? ["agent"],
      soul: agent.soul ?? `Operate the ${name} company as @${agent.id}.`,
      model: agent.model ?? { provider: "codex", id: "gpt-5.4" },
      ...(agent.fallback ? { fallback: agent.fallback } : {}),
      ...(agent.mcp ? { mcp: agent.mcp } : {}),
      ...(agent.cli ? { cli: agent.cli } : {}),
      ...(agent.permissions ? { permissions: agent.permissions } : {}),
      ...(agent.secrets ? { secrets: agent.secrets } : {}),
      ...(agent.runtime ? { runtime: agent.runtime } : {}),
      ...(agent.pulse ? { pulse: agent.pulse } : {}),
      ...(agent.schedule ? { schedule: agent.schedule } : {}),
      ...(agent.memory ? { memory: agent.memory } : {}),
    })),
  };
}
