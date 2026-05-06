import { describe, expect, test } from "bun:test";
import { buildDemoFederationConfig, federatedAgentMcpAudience } from "./federation.ts";

describe("federation model", () => {
  test("buildDemoFederationConfig_WhenCreatingDemoEnterprise_ReturnsCompleteOidcOrgShape", () => {
    const { config, org } = buildDemoFederationConfig();

    const coo = config.principals.agents.coo;
    const vpEngineering = config.principals.agents["vp-eng"];
    const allAgentsGroup = config.principals.groups["all-agents"];
    const engineeringMapping = config.oidcProviders.okta?.mappings?.groups?.["US Engineering"];

    expect(
      org,
      "The fake enterprise must keep the intended 40-agent org shape so runtime, delegation, and dashboard fixtures exercise a realistic hierarchy.",
    ).toHaveLength(40);
    expect(
      coo?.roles,
      "The COO must carry the executive role because root visibility and top-down delegation depend on executive policy.",
    ).toContain("executive");
    expect(
      vpEngineering?.manager,
      "VP Engineering must report to the COO so federation policy can enforce one-level-up reporting.",
    ).toBe("coo");
    expect(
      allAgentsGroup?.members,
      "The all-agents group must include every demo principal so default OIDC group claims are complete.",
    ).toHaveLength(40);
    expect(
      engineeringMapping,
      "External Okta engineering groups must map onto Union Street's internal engineering group for enterprise SSO compatibility.",
    ).toBe("engineering");
  });

  test("federatedAgentMcpAudience_WhenGivenAgentProfile_ReturnsTargetScopedAudience", () => {
    const targetProfile = "vp-eng";

    const audience = federatedAgentMcpAudience(targetProfile);

    expect(
      audience,
      "MCP tokens must be scoped to the target agent audience so a token minted for one agent cannot be replayed as a generic org token.",
    ).toBe("urn:union-street:mcp-agent:vp-eng");
  });
});
