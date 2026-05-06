import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const usHome = await mkdtemp(join(tmpdir(), "union-street-federation-adversarial-"));
process.env.US_HOME = usHome;
process.env.US_MEMORY_SYNC = "0";

const core = await import("./index.ts");
const demo = core.buildDemoFederationConfig();

beforeAll(async () => {
  const config = structuredClone(demo.config);
  config.principals.agents["dir-eng-infra"]!.manager = "mgr-eng-platform";
  config.principals.agents["mgr-eng-platform"]!.manager = "dir-eng-infra";
  config.principals.agents["dir-ops-support"]!.manager = "ghost-manager";
  config.principals.agents["mgr-finance-billing"]!.disabled = true;
  config.principals.agents["mgr-ops-qa"]!.external = {
    ...config.principals.agents["mgr-ops-qa"]!.external,
    okta: "00u-duplicate-subject",
  };
  config.principals.agents["mgr-ops-sre"]!.external = {
    ...config.principals.agents["mgr-ops-sre"]!.external,
    okta: "00u-duplicate-subject",
  };
  await Bun.write(core.FEDERATION_PATH, JSON.stringify(config, null, 2));

  const packsById = new Map(core.buildDemoAgentPacks(demo.org).map((pack) => [pack.id, pack]));
  for (const node of demo.org) {
    await core.initProfile(node.id, { role: node.roles[0] ?? "agent", capabilities: node.roles });
    const pack = packsById.get(node.id);
    if (!pack) continue;
    await core.writeAgentPack(node.id, {
      ...pack,
      oidc: node.id === "vp-eng"
        ? { ...pack.oidc, subject: "agent:vp-eng-pack-subject" }
        : pack.oidc,
    });
  }
});

afterAll(async () => {
  await rm(usHome, { recursive: true, force: true });
});

describe("adversarial federation fixtures", () => {
  test("resolveDelegationTargets_WhenFederationGraphContainsManagerCycle_ReturnsBoundedVisibilityWithoutLooping", async () => {
    const targets = await core.resolveDelegationTargets("dir-eng-infra");

    expect(
      targets.map((target) => target.profile),
      "A manager cycle must not hang target resolution or expand visibility beyond the one-up/direct-report contract.",
    ).toEqual(expect.arrayContaining(["mgr-eng-platform"]));
    expect(
      targets.length,
      "Cycle handling should stay bounded; resolving one agent must not walk the whole enterprise graph.",
    ).toBeLessThanOrEqual(2);
  });

  test("canDelegateTo_WhenManagerIsOrphaned_DeniesDelegationToPhantomIdentity", async () => {
    const targets = await core.resolveDelegationTargets("dir-ops-support");
    const decision = await core.canDelegateTo("dir-ops-support", "ghost-manager");

    expect(
      targets.map((target) => target.profile),
      "Missing manager identities must not appear as visible delegation targets.",
    ).not.toContain("ghost-manager");
    expect(
      decision.allowed,
      "Agents whose manager points at a missing identity must not be able to delegate/report to that phantom principal.",
    ).toBe(false);
    expect(
      decision.reason,
      "Orphan-manager denials should still include the visible target set for CLI/dashboard diagnosis.",
    ).toContain("Visible targets");
  });

  test("resolveDelegationTargets_WhenFederationDisablesAgent_RemovesItFromManagerVisibility", async () => {
    const targets = await core.resolveDelegationTargets("vp-finance");

    expect(
      targets.map((target) => target.profile),
      "Disabled agents must not be visible delegation targets even if stale packs still list them as direct reports.",
    ).not.toContain("mgr-finance-billing");
    await expect(
      core.resolveAgentPrincipal("mgr-finance-billing"),
      "Disabled agents must not resolve as live federated principals for token minting or MCP policy.",
    ).rejects.toThrow("disabled");
  });

  test("mintFederatedAgentToken_WhenPackSubjectDiffersFromFederationSubject_VerifiesOnlyAgainstPackIdentity", async () => {
    const token = await core.mintFederatedAgentToken("vp-eng", { audience: ["union-street-demo"], ttlSeconds: 60 });

    const verified = await core.verifyFederatedAgentToken(token, { audience: "union-street-demo" });

    expect(
      verified.sub,
      "Agent pack OIDC subject must be authoritative so atomic agent packs can rotate identity without relying on stale federation rows.",
    ).toBe("agent:vp-eng-pack-subject");
    expect(
      verified.us_profile,
      "Subject rotation must not change the stable profile used by audit and policy surfaces.",
    ).toBe("vp-eng");
  });
});
