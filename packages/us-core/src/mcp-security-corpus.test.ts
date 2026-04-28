import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const usHome = await mkdtemp(join(tmpdir(), "union-street-mcp-security-corpus-"));
const workdir = await mkdtemp(join(tmpdir(), "union-street-mcp-security-work-"));
const previousAllowPrivateMcpUrls = process.env.US_MCP_ALLOW_PRIVATE_URLS;
process.env.US_HOME = usHome;
process.env.US_MEMORY_SYNC = "0";
process.env.US_STREAM_MODEL_STUB = "1";
process.env.US_USAGE_DISABLE_MODELS_DEV_COSTS = "1";
delete process.env.US_MCP_ALLOW_PRIVATE_URLS;

const core = await import("./index.ts");

beforeAll(async () => {
  const demo = core.buildDemoFederationConfig();
  demo.config.grants.push({
    id: "unsafe-mcp-corpus",
    resource: "mcp",
    servers: ["metadata", "loopback", "embedded", "fileproto", "localdomain", "testnet"],
    tools: ["*"],
    roles: ["executive"],
  });
  await Bun.write(core.FEDERATION_PATH, JSON.stringify(demo.config, null, 2));
  const coo = demo.org.find((node) => node.id === "coo")!;
  await core.initProfile("coo", { role: "executive", capabilities: coo.roles });
  await core.writeAgentPack("coo", core.buildAgentPackFromOrgNode(coo, demo.org));

  for (const server of ["metadata", "loopback", "embedded", "fileproto", "localdomain", "testnet"]) {
    await core.saveMcpApiKeyCredential({ profile: "coo", server, apiKey: `${server}-token` });
  }
  await writeFile(
    join(workdir, ".mcp.json"),
    JSON.stringify({
      mcp: {
        metadata: { type: "remote", url: "http://169.254.169.254/latest/meta-data", enabled: true },
        loopback: { type: "remote", url: "http://[::1]:9191/mcp", enabled: true },
        embedded: { type: "remote", url: "https://user:pass@mcp.example.com/mcp", enabled: true },
        fileproto: { type: "remote", url: "file:///tmp/mcp.sock", enabled: true },
        localdomain: { type: "remote", url: "http://tool.localhost/mcp", enabled: true },
        testnet: { type: "remote", url: "http://192.168.1.10/mcp", enabled: true },
      },
    }, null, 2),
  );
});

afterAll(async () => {
  if (previousAllowPrivateMcpUrls === undefined) delete process.env.US_MCP_ALLOW_PRIVATE_URLS;
  else process.env.US_MCP_ALLOW_PRIVATE_URLS = previousAllowPrivateMcpUrls;
  await rm(usHome, { recursive: true, force: true });
  await rm(workdir, { recursive: true, force: true });
});

describe("MCP URL security corpus", () => {
  test("resolveMcpToolsForAgent_WhenConfigContainsUnsafeRemoteUrls_FailsClosedAndAuditsEveryRejection", async () => {
    const unsafeServers = ["metadata", "loopback", "embedded", "fileproto", "localdomain", "testnet"];

    const tools = await core.resolveMcpToolsForAgent("coo", workdir);
    const failures = await core.queryEvents({ type: "mcp.tool.list", actor: "coo", outcome: "failure", limit: 50 });
    const failureByResource = new Map(failures.map((event) => [event.resource, event.reason ?? ""]));

    expect(
      tools,
      "Unsafe MCP URLs must not expose any remote tools to the model, even when the agent has grants and credentials.",
    ).toEqual([]);
    for (const server of unsafeServers) {
      expect(
        failureByResource.has(`mcp:${server}`),
        `Unsafe MCP server '${server}' must produce an audit failure so operators can find poisoned config.`,
      ).toBe(true);
    }
    expect(
      failureByResource.get("mcp:embedded"),
      "MCP URLs with embedded credentials must be rejected before fetch so secrets never enter outbound URL logs.",
    ).toContain("embedded credentials");
    expect(
      failureByResource.get("mcp:fileproto"),
      "Non-HTTP MCP transports in remote config must be rejected before fetch.",
    ).toContain("protocol");
    for (const server of ["metadata", "loopback", "localdomain", "testnet"]) {
      expect(
        failureByResource.get(`mcp:${server}`),
        `Private/local MCP target '${server}' must be rejected before any network request is attempted.`,
      ).toContain("private, local, loopback, or metadata");
    }
  });
});
