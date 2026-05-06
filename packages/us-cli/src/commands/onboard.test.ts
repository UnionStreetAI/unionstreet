import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const usHome = await mkdtemp(join(tmpdir(), "union-street-cli-onboard-test-"));
const workdir = await mkdtemp(join(tmpdir(), "union-street-cli-onboard-work-"));
process.env.US_HOME = usHome;
process.env.HOME = workdir;
process.env.US_MEMORY_SYNC = "1";

const core = await import("@unionstreet/server");
const { createOnboardingFleetPlan, onboard } = await import("./onboard.ts");

afterAll(async () => {
  await rm(usHome, { recursive: true, force: true });
  await rm(workdir, { recursive: true, force: true });
});

async function captureOutput(fn: () => Promise<boolean>): Promise<{ ok: boolean; output: string }> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const ok = await fn();
    return { ok, output: logs.join("\n") };
  } finally {
    console.log = originalLog;
  }
}

describe("onboard command", () => {
  test("createOnboardingFleetPlan_WhenNoDepartmentsAreProvided_UsesTacticalCompanyDefaults", async () => {
    const plan = createOnboardingFleetPlan({ root: "coo" });
    const validation = await core.validateFleetPlan(plan, { allowExisting: true });
    const packs = core.buildFleetAgentPacks(plan);

    expect(validation.ok, `Default onboarding plan should validate; errors=${validation.errors.join("; ")}`).toBe(true);
    expect(
      plan.agents.filter((agent) => agent.roles.includes("vp")).map((agent) => agent.groups[0]),
      "The shipped onboarding shape should start with the obvious company departments instead of a generic demo org.",
    ).toEqual(["operations", "go-to-market", "finance", "engineering"]);
    expect(
      plan.agents.find((agent) => agent.id === "vp-operations")?.soul,
      "Operations default should teach tactical operating rhythm instead of bland department prose.",
    ).toContain("runbooks");
    expect(
      plan.agents.find((agent) => agent.id === "vp-finance")?.soul,
      "Finance default should include finance-specific approval and evidence posture.",
    ).toContain("approval");
    expect(
      packs.get("vp-engineering")?.toolkit.plugins,
      "Engineering defaults should grant the GitHub CLI plugin as a capability bundle.",
    ).toEqual(["github"]);
    expect(
      packs.get("vp-go-to-market")?.toolkit.plugins,
      "GTM defaults should bake in the marketing skill graph alongside Stripe revenue tooling.",
    ).toEqual(["gtm", "stripe"]);
    expect(
      packs.get("vp-operations")?.toolkit.mcp,
      "Department defaults should grant Linear through MCP for work tracking, not GitHub MCP.",
    ).toEqual(["linear"]);
  });

  test("createOnboardingFleetPlan_WhenDepartmentsSkillsAndPluginsAreProvided_BuildsReviewableOrg", async () => {
    const plan = createOnboardingFleetPlan({
      name: "Operator Company",
      mission: "Run a serious local agent org.",
      root: "head-agent",
      department: ["engineering:Engineering", "finance:Finance"],
      plugin: ["github"],
      skill: ["pr-review"],
      mcp: ["linear"],
    });
    const validation = await core.validateFleetPlan(plan, { allowExisting: true });
    const packs = core.buildFleetAgentPacks(plan);

    expect(validation.ok, `Generated onboarding plan should validate; errors=${validation.errors.join("; ")}`).toBe(true);
    expect(plan.agents.map((agent) => agent.id), "Onboarding should create a root, a departmental lead, and a specialist per department.").toEqual([
      "head-agent",
      "vp-engineering",
      "engineering-specialist",
      "vp-finance",
      "finance-specialist",
    ]);
    expect(
      packs.get("vp-engineering")?.toolkit.plugins,
      "Department agents should receive configured plugin/skill bundles through the agent pack toolkit.",
    ).toEqual(["github"]);
    expect(
      packs.get("head-agent")?.toolkit.plugins,
      "The head agent should receive requested global plugin and skill bundles for orchestration behavior.",
    ).toEqual(["github", "pr-review"]);
    expect(
      packs.get("vp-engineering")?.toolkit.mcp,
      "Department-specific MCP grants should be carried into generated agent packs without auto-adding GitHub MCP.",
    ).toEqual(["linear"]);
  });

  test("onboard_WhenWritingPlan_WritesYamlWithoutApplyingProfiles", async () => {
    const out = join(workdir, "fleet-onboard.yaml");
    const { ok, output } = await captureOutput(() =>
      onboard({
        name: "Local Fleet",
        root: "local-head",
        department: "engineering",
        plugin: "github",
        out,
        skipSetup: true,
      }),
    );
    const yaml = await readFile(out, "utf8");

    expect(ok, "Onboarding should succeed in review-only mode when the generated plan validates.").toBe(true);
    expect(output, "The CLI should summarize the generated fleet for human review.").toContain("agent fleet onboarding");
    expect(yaml, "Review-only onboarding should write the public fleet-plan contract.").toContain("kind: union-street.fleet-plan");
    expect(await core.profileExists("local-head"), "Review-only onboarding must not create profiles until --apply is passed.").toBe(false);
  });
});
