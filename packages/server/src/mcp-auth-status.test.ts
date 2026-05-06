import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const usHome = await mkdtemp(join(tmpdir(), "union-street-mcp-test-"));
const workdir = await mkdtemp(join(tmpdir(), "union-street-mcp-work-"));
process.env.US_HOME = usHome;
process.env.HOME = workdir;
process.env.US_MEMORY_SYNC = "0";

const core = await import("./index.ts");
const mcpAuth = await import("./mcp-auth.ts");
const mcpOAuth = await import("./mcp-oauth.ts");
const mcpStatus = await import("./mcp-status.ts");
const lashMcp = await import("./lash-mcp.ts");

beforeAll(async () => {
  const demo = core.buildDemoFederationConfig();
  await Bun.write(core.FEDERATION_PATH, JSON.stringify(demo.config, null, 2));
  const packs = new Map(core.buildDemoAgentPacks(demo.org).map((pack) => [pack.id, pack]));
  for (const node of demo.org) {
    await core.initProfile(node.id, { role: node.roles[0] ?? "agent", capabilities: node.roles });
    const pack = packs.get(node.id);
    if (pack) await core.writeAgentPack(node.id, pack);
  }
});

afterAll(async () => {
  await rm(usHome, { recursive: true, force: true });
  await rm(workdir, { recursive: true, force: true });
});

describe("MCP auth and status", () => {
  test("saveMcpApiKeyCredential_WhenProfileExists_StoresProfileScopedCredentialAndRedactedStatus", async () => {
    await mcpAuth.saveMcpApiKeyCredential({
      profile: "dir-gtm-sales",
      server: "@Salesforce",
      apiKey: "sf-secret",
      header: "X-Salesforce-Key",
      provider: "salesforce",
    });

    const cred = await mcpAuth.getMcpCredential("dir-gtm-sales", "salesforce");
    const status = await mcpAuth.getMcpCredentialStatus("dir-gtm-sales", "salesforce");

    expect(
      cred,
      "Agent-scoped MCP API keys must be stored under the normalized server name so `us coo mcp auth [linear]` style commands are stable.",
    ).toMatchObject({ kind: "api_key", api_key: "sf-secret", header: "X-Salesforce-Key", provider: "salesforce" });
    expect(status, "Credential status should expose configuration/source metadata without leaking the API key.").toMatchObject({
      server: "salesforce",
      configured: true,
      source: "profile",
      kind: "api_key",
    });
  });

  test("saveMcpOAuthCredential_WhenExpiresAtIsProvided_ReportsRemainingLifetime", async () => {
    const expiresAt = Date.now() + 60_000;

    await mcpAuth.saveMcpOAuthCredential({
      profile: "vp-eng",
      server: "github",
      accessToken: "gho-access",
      refreshToken: "gho-refresh",
      expiresAt,
      scope: "repo read:org",
    });

    const status = await mcpAuth.getMcpCredentialStatus("vp-eng", "github");

    expect(status.configured, "OAuth MCP credentials should be visible as configured after save.").toBe(true);
    expect(status.kind, "OAuth MCP credentials must retain their kind so auth refresh flows can distinguish them from API keys.").toBe("oauth");
    expect(
      status.expiresInSeconds && status.expiresInSeconds > 0 && status.expiresInSeconds <= 60,
      "OAuth credential status should report a bounded remaining lifetime for dashboards and doctor checks.",
    ).toBe(true);
  });

  test("inspectMcpStatus_WhenLocalConfigHasCommentsAndOAuthMetadata_ReturnsServersCredentialsAndGrants", async () => {
    await writeFile(
      join(workdir, ".mcp.json"),
      `{
        // local project MCP config
        "mcp": {
          "github": {
            "type": "remote",
            "url": "https://mcp.example.com/github",
            "oauth": {
              "authorizationUrl": "https://github.example.com/oauth/authorize",
              "tokenUrl": "https://github.example.com/oauth/token",
              "clientId": "client-1",
              "redirectUri": "http://localhost/callback",
              "scope": ["repo", "read:org"]
            }
          },
          "local-shell": {
            "command": ["bun", "run", "mcp-server"],
            "env": { "TOKEN": "TOKEN_ENV" }
          }
        }
      }`,
    );

    const status = await mcpStatus.inspectMcpStatus(workdir, "vp-eng");
    const github = status.servers.find((server) => server.name === "github");
    const localShell = status.servers.find((server) => server.name === "local-shell");

    expect(github, "MCP status should parse JSONC-style local config and discover remote OAuth servers.").toMatchObject({
      name: "github",
      transport: "remote",
      auth: "oauth",
      credential: { configured: true, kind: "oauth", source: "profile" },
      oauth: {
        authorizationUrl: "https://github.example.com/oauth/authorize",
        tokenUrl: "https://github.example.com/oauth/token",
        clientId: "client-1",
        redirectUri: "http://localhost/callback",
        scope: "repo read:org",
      },
    });
    expect(localShell, "MCP status should discover command-based local servers and classify env-based auth.").toMatchObject({
      name: "local-shell",
      transport: "local",
      command: "bun run mcp-server",
      auth: "env",
    });
    expect(status.grants.github?.allowed, "VP Engineering should receive the GitHub MCP grant from its engineering group.").toBe(true);
    expect(status.identity?.profile, "Profile-scoped MCP status should include resolved federated identity for the dashboard.").toBe("vp-eng");
  });

  test("startAndExchangeMcpOAuth_WhenCallbackUrlIsPasted_ValidatesStateAndExchangesToken", async () => {
    const originalFetch = globalThis.fetch;
    let tokenBody = "";
    globalThis.fetch = (async (_url, init) => {
      tokenBody = String(init?.body ?? "");
      return Response.json({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: "120",
        scope: "repo",
        token_type: "Bearer",
      });
    }) as typeof fetch;
    try {
      const started = mcpOAuth.startMcpOAuth({
        authorizationUrl: "https://auth.example.com/authorize",
        tokenUrl: "https://auth.example.com/token",
        clientId: "client-1",
        redirectUri: "urn:ietf:wg:oauth:2.0:oob",
        scope: "repo",
      });

      const token = await mcpOAuth.exchangeMcpOAuthCallback(started, `https://device/callback?code=abc&state=${started.state}`);

      expect(started.url, "OAuth start should generate a PKCE authorization URL users can open from remote/cloud devices.").toContain("code_challenge_method=S256");
      expect(tokenBody, "OAuth token exchange must send the pasted callback code plus PKCE verifier to the token endpoint.").toContain("code=abc");
      expect(token.accessToken, "Token exchange should normalize provider access_token to accessToken.").toBe("access-1");
      expect(token.refreshToken, "Token exchange should preserve refresh_token when providers return it.").toBe("refresh-1");
      expect(token.tokenType, "Token exchange should preserve token_type for downstream auth materialization.").toBe("Bearer");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Lash MCP server", () => {
  test("callLashPeerTool_WhenDelegateIsAllowed_ReturnsLashEnvelopeAndAuditEvents", async () => {
    process.env.US_PEER_CALL_STUB = "1";
    const trace = core.createLashTrace();

    const result = await lashMcp.callLashPeerTool({
      targetPeer: "vp-eng",
      method: "delegate",
      arguments: {
        from: "coo",
        prompt: "Check engineering posture.",
        trace,
        thread: core.createLashThread("vp-eng", trace),
      },
    });

    const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
    const events = await core.queryEvents({ trace, limit: 20 });

    expect(text, "Allowed Lash MCP delegate calls should return a serialized Lash envelope from the target peer.").toContain("Check engineering posture.");
    expect(
      events.map((event) => event.type),
      "Lash MCP calls should emit call and allow audit events around the peer wake.",
    ).toEqual(expect.arrayContaining(["lash.call", "lash.allow"]));
  });

  test("callLashPeerTool_WhenReportDoesNotTargetManager_ReturnsLashError", async () => {
    const trace = core.createLashTrace();

    const result = await lashMcp.callLashPeerTool({
      targetPeer: "vp-ops",
      method: "report",
      arguments: {
        from: "vp-eng",
        prompt: "wrong manager",
        trace,
        thread: core.createLashThread("vp-ops", trace),
      },
    });

    const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";

    expect(text, "Report calls that target anything other than the caller's direct manager should return a structured Lash error.").toContain("can only delegate");
  });
});
