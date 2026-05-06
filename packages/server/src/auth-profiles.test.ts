import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const usHome = await mkdtemp(join(tmpdir(), "union-street-auth-profiles-test-"));
process.env.US_HOME = usHome;

const core = await import("./index.ts");

afterAll(async () => {
  await rm(usHome, { recursive: true, force: true });
});

describe("auth profiles", () => {
  test("updateAuthProfiles_WhenFileDoesNotExist_Creates0600FileAndPersistsSections", async () => {
    const path = join(usHome, "auth", "auth-profiles.json");

    const written = await core.updateAuthProfiles(path, (current) => ({
      ...current,
      providers: {
        openai: { kind: "api_key", api_key: "sk-test", base_url: "https://api.example.test/v1" },
      },
      channels: { slack: { botToken: "xoxb" } },
    }));
    const readBack = await core.readAuthProfiles(path);
    const mode = (await stat(path)).mode & 0o777;

    expect(written.providers.openai, "The mutator result should include the provider written to disk.").toMatchObject({ kind: "api_key", api_key: "sk-test" });
    expect(readBack.channels.slack, "All auth-profile sections should round-trip, not only providers.").toEqual({ botToken: "xoxb" });
    expect(mode, "Credential files should be created with owner-only permissions.").toBe(0o600);
  });

  test("resolveAuthProfiles_WhenProfileOverridesGlobal_ReportsMergedViewAndProvenance", async () => {
    await core.updateAuthProfiles(core.GLOBAL_AUTH_PROFILES_PATH, (current) => ({
      ...current,
      providers: {
        codex: { kind: "oauth", provider: "openai-codex", access: "global-access", refresh: "global-refresh", expires: Date.now() + 60_000 },
        openai: { kind: "api_key", api_key: "global-key" },
      },
      mcp: {
        github: { kind: "api_key", api_key: "global-gh", created: 1 },
      },
    }));
    await core.initProfile("auth-prof", { role: "tester" });
    await core.updateAuthProfiles(core.profilePaths("auth-prof").authProfiles, (current) => ({
      ...current,
      providers: {
        openai: { kind: "api_key", api_key: "profile-key", base_url: "https://profile.example.test/v1" },
      },
      mcp: {
        linear: { kind: "api_key", api_key: "profile-linear", created: 2 },
      },
    }));

    const resolved = await core.resolveAuthProfiles("auth-prof");

    expect(resolved.merged.providers.codex, "Global credentials should remain visible when a profile does not override that key.").toMatchObject({ kind: "oauth", access: "global-access" });
    expect(resolved.merged.providers.openai, "Profile credentials should override global credentials by key.").toMatchObject({ kind: "api_key", api_key: "profile-key" });
    expect(resolved.source.providers, "Provider provenance should explain which file supplied each merged credential.").toMatchObject({ codex: "global", openai: "profile" });
    expect(resolved.source.mcp, "MCP provenance should include both inherited and profile-scoped credentials.").toMatchObject({ github: "global", linear: "profile" });
  });

  test("redactCred_WhenGivenProviderAndMcpCredentials_MasksSecretsButKeepsOperationalMetadata", () => {
    const provider = core.redactCred({
      kind: "api_key",
      api_key: "sk-abcdefghijklmnopqrstuvwxyz",
      base_url: "https://api.example.test/v1",
      accounting: { mode: "free", note: "internal" },
    });
    const mcp = core.redactMcpCred({
      kind: "oauth",
      access: "access-secret",
      refresh: "refresh-secret",
      expires: Date.now() + 10_000,
      created: 1,
      scope: "repo",
    });

    expect(provider, "Provider redaction should mask secrets while keeping routing/accounting metadata.").toMatchObject({
      kind: "api_key",
      api_key: "***wxyz",
      base_url: "https://api.example.test/v1",
      accounting: { mode: "free", note: "internal" },
    });
    expect(mcp, "MCP OAuth redaction should hide access and refresh tokens while retaining scope/lifetime.").toMatchObject({
      kind: "oauth",
      access: "***cret",
      refresh: "***cret",
      scope: "repo",
    });
  });
});
