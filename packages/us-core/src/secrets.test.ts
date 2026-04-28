import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const usHome = await mkdtemp(join(tmpdir(), "union-street-secrets-test-"));
const workspace = await mkdtemp(join(tmpdir(), "union-street-secrets-work-"));
process.env.US_HOME = usHome;
process.env.US_MEMORY_SYNC = "0";

const core = await import("./index.ts");
const secrets = await import("./secrets.ts");

beforeAll(async () => {
  const demo = core.buildDemoFederationConfig();
  await Bun.write(core.FEDERATION_PATH, JSON.stringify(demo.config, null, 2));
  const packs = new Map(core.buildDemoAgentPacks(demo.org).map((pack) => [pack.id, pack]));
  for (const node of demo.org) {
    await core.initProfile(node.id, { role: node.roles[0] ?? "agent", capabilities: node.roles });
    const pack = packs.get(node.id);
    if (!pack) continue;
    if (node.id === "dir-gtm-sales") {
      await core.writeAgentPack(node.id, {
        ...pack,
        runtime: { ...pack.runtime, secrets: ["salesforce", "github"] },
      });
    } else if (node.id === "mgr-eng-platform") {
      await core.writeAgentPack(node.id, {
        ...pack,
        runtime: { ...pack.runtime, secrets: ["github", "missing-provider"] },
      });
    } else {
      await core.writeAgentPack(node.id, pack);
    }
  }

  const envPath = join(usHome, "provider.env");
  process.env.SALESFORCE_SOURCE = "sf-token";
  process.env.GITHUB_SOURCE = "gh-token";
  await writeFile(envPath, [
    "# comments should be ignored",
    "SALESFORCE_SOURCE='sf-token'",
    "GITHUB_SOURCE=gh-token",
    "EMPTY_LINE_OK=",
  ].join("\n"));
  await core.writeGlobalConfig({
    secrets: {
      providers: {
        local: { type: "env_file", path: "$US_HOME/provider.env" },
        undefinedProvider: { type: "env_file", path: "$US_HOME/missing.env" },
      },
      entries: {
        salesforce: {
          provider: "local",
          env: { SALESFORCE_API_KEY: "SALESFORCE_SOURCE" },
          audience: { groups: ["go-to-market"] },
        },
        github: {
          provider: "local",
          env: { GITHUB_TOKEN: "GITHUB_SOURCE" },
          audience: { groups: ["engineering"] },
        },
        "missing-provider": {
          provider: "does-not-exist",
          env: { MISSING: "MISSING_SOURCE" },
          audience: { groups: ["engineering"] },
        },
        "missing-env": {
          provider: "undefinedProvider",
          env: { REQUIRED_TOKEN: "NOT_IN_FILE" },
          audience: { groups: ["engineering"] },
        },
      },
    },
  });
});

afterAll(async () => {
  await rm(usHome, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

describe("agent secrets", () => {
  test("resolveSecretGrantsForAgent_WhenAgentRequestsMixedAudienceSecrets_AllowsOnlyMatchingAudience", async () => {
    const grants = await secrets.resolveSecretGrantsForAgent("dir-gtm-sales");
    const byId = Object.fromEntries(grants.map((grant) => [grant.id, grant]));

    expect(
      byId.salesforce,
      "A sales director in the go-to-market group should be allowed to request Salesforce credentials.",
    ).toMatchObject({ allowed: true, provider: "local", env: ["SALESFORCE_API_KEY"] });
    expect(
      byId.github,
      "A sales director that requests GitHub should be denied because it is outside the engineering audience.",
    ).toMatchObject({ allowed: false, reason: "@dir-gtm-sales is not in the grant audience" });
  });

  test("materializeAgentSecrets_WhenAllowedSecretExists_WritesEnvFileWithOnlyPermittedValues", async () => {
    const result = await secrets.materializeAgentSecrets("dir-gtm-sales", workspace);

    expect(result.path, "Materialization should create an env file when at least one permitted secret resolves.").toBe(join(workspace, ".us-secrets.env"));
    expect(result.env, "Only allowed and present secrets should be materialized for this agent.").toEqual({ SALESFORCE_API_KEY: "sf-token" });
    expect(result.warnings, "Denied grants should not become missing-secret warnings because they were intentionally withheld.").toEqual([]);

    const written = await readFile(result.path!, "utf8");
    expect(written, "Serialized env files should use JSON string quoting so values with shell-sensitive characters remain safe.").toBe("SALESFORCE_API_KEY=\"sf-token\"\n");
  });

  test("materializeAgentSecrets_WhenProviderOrEnvIsMissing_ReportsActionableWarningsWithoutWritingSecrets", async () => {
    const pack = await core.readAgentPack("mgr-eng-platform");
    await core.writeAgentPack("mgr-eng-platform", {
      ...pack,
      runtime: { ...pack.runtime, secrets: ["missing-provider", "missing-env"] },
    });

    const result = await secrets.materializeAgentSecrets("mgr-eng-platform", join(workspace, "missing"));

    expect(
      result.grants.find((grant) => grant.id === "missing-provider"),
      "Undefined providers should produce a denied grant before any env file is read.",
    ).toMatchObject({ allowed: false, reason: 'secret provider "does-not-exist" is not defined' });
    expect(
      result.grants.find((grant) => grant.id === "missing-env")?.missing,
      "Allowed grants with absent source variables should report the target env names that could not be materialized.",
    ).toEqual(["REQUIRED_TOKEN"]);
    expect(result.path, "If no values were materialized, no .us-secrets.env file should be written.").toBeUndefined();
    expect(result.warnings, "Missing source variables should be surfaced as operator-facing warnings.").toEqual([
      'secret grant "missing-env" is missing REQUIRED_TOKEN',
    ]);
  });

  test("dumpSecretRegistry_WhenRegistryIsProvided_EmitsYamlForReview", () => {
    const rendered = secrets.dumpSecretRegistry({
      providers: { local: { type: "env_file", path: "$US_HOME/provider.env" } },
      entries: {
        github: {
          provider: "local",
          env: { GITHUB_TOKEN: "GITHUB_SOURCE" },
          audience: { agents: [], groups: ["engineering"], roles: [], principals: [] },
        },
      },
    });

    expect(rendered, "Secret registries should round-trip to human-reviewable YAML for CLI/editor workflows.").toContain("github:");
    expect(rendered, "Secret registry dumps should preserve audience selectors so reviews can spot overbroad grants.").toContain("engineering");
  });
});
