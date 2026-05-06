import { describe, expect, test } from "bun:test";
import { buildDemoAgentPacks, normalizeAgentPack } from "./agent-pack.ts";
import { buildDemoFederationConfig } from "./federation.ts";

describe("agent packs", () => {
  test("buildDemoAgentPacks_WhenGivenDemoOrg_ReturnsAtomicPackForEveryAgentRole", () => {
    const { org } = buildDemoFederationConfig();

    const packs = buildDemoAgentPacks(org);

    const coo = packs.find((pack) => pack.id === "coo");
    const vpEng = packs.find((pack) => pack.id === "vp-eng");
    const mgrPlatform = packs.find((pack) => pack.id === "mgr-eng-platform");

    expect(
      packs,
      "Every principal in the demo org must compile to exactly one agent pack so the control plane has no phantom or missing agents.",
    ).toHaveLength(40);
    expect(
      coo?.identity.directReports,
      "The COO pack must encode all VP direct reports; this is the root of top-down delegation and dashboard visibility.",
    ).toEqual(["vp-ops", "vp-eng", "vp-gtm", "vp-finance"]);
    expect(
      coo?.lash.delegate,
      "The COO is the only root principal allowed to delegate through descendants instead of only one level.",
    ).toBe("descendants");
    expect(
      coo?.lash.report,
      "The COO has no manager, so its report channel must be explicitly disabled.",
    ).toBe("none");
    expect(
      vpEng?.identity.manager,
      "VP Engineering must keep COO as manager so reports flow upward through Lash rather than laterally.",
    ).toBe("coo");
    expect(
      vpEng?.oidc.subject,
      "The VP Engineering OIDC subject must match the agent principal naming convention used by federation tokens.",
    ).toBe("agent:vp-eng");
    expect(
      vpEng?.oidc.audiences,
      "Agent packs must include the demo audience so default federated tokens can be verified by the local harness.",
    ).toContain("union-street-demo");
    expect(
      vpEng?.lash.delegate,
      "A VP can delegate to direct reports but must not receive root-level descendant authority.",
    ).toBe("direct_reports");
    expect(
      vpEng?.toolkit.mcp,
      "Engineering leadership must receive the GitHub MCP tool because code work needs repository access.",
    ).toContain("github");
    expect(
      mgrPlatform?.lash.delegate,
      "Managers with IC direct reports should be able to delegate one level down without inheriting root-level descendant authority.",
    ).toBe("direct_reports");
    expect(
      mgrPlatform?.lash.report,
      "Lowest-layer managers still need a manager report channel so completed work can move upward.",
    ).toBe("manager");
  });

  test("normalizeAgentPack_WhenPackRoundTripsThroughJson_PreservesRequiredRuntimeContract", () => {
    const { org } = buildDemoFederationConfig();
    const pack = buildDemoAgentPacks(org)[0]!;

    const normalized = normalizeAgentPack(JSON.parse(JSON.stringify(pack)));

    expect(
      normalized.version,
      "Serialized agent packs must keep the explicit contract version so future migrations can reject unknown shapes.",
    ).toBe(1);
    expect(
      normalized.identity.subject,
      "Normalized identity must recover the agent subject from the pack id because federation relies on stable subject claims.",
    ).toBe(`agent:${normalized.id}`);
    expect(
      normalized.schedule[0]?.cron,
      "Schedule definitions must survive JSON round-tripping because packs are intended to be durable editable config.",
    ).toBe("0 9 * * MON");
  });
});
