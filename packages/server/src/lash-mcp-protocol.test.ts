import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const usHome = await mkdtemp(join(tmpdir(), "union-street-lash-protocol-test-"));
process.env.US_HOME = usHome;
process.env.US_MEMORY_SYNC = "0";
process.env.US_PEER_CALL_STUB = "1";

const core = await import("./index.ts");
const lashContext = await import("./lash-context.ts");
const lash = await import("./lash-mcp.ts");

type TextContent = { type: "text"; text: string };

beforeAll(async () => {
  const demo = core.buildDemoFederationConfig();
  await Bun.write(core.FEDERATION_PATH, JSON.stringify(demo.config, null, 2));
  const packsById = new Map(core.buildDemoAgentPacks(demo.org).map((pack) => [pack.id, pack]));
  for (const node of demo.org) {
    await core.initProfile(node.id, { role: node.roles[0] ?? "agent", capabilities: node.roles });
    const pack = packsById.get(node.id);
    if (pack) await core.writeAgentPack(node.id, pack);
  }
});

afterAll(async () => {
  await rm(usHome, { recursive: true, force: true });
});

async function withMcpClient<T>(
  targetPeer: string,
  callerPeer: string,
  fn: (client: Client, token: string) => Promise<T>,
  tokenOverride?: string,
): Promise<T> {
  const client = new Client({ name: "union-street-protocol-test", version: "0.0.0" });
  const server = lash.createLashPeerServer(targetPeer);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const token = tokenOverride ?? await core.mintFederatedAgentToken(callerPeer, {
    audience: [core.federatedAgentMcpAudience(targetPeer)],
  });
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: {
        token,
        clientId: `agent:${callerPeer}`,
        scopes: ["agent"],
        extra: { profile: callerPeer },
      },
    });

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return await fn(client, token);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

describe("Lash peer MCP protocol", () => {
  test("listTools_WhenConnectedToPeerServer_PublishesDelegateAndReportToolContracts", async () => {
    const tools = await withMcpClient("vp-eng", "coo", async (client) => client.listTools());

    expect(
      tools.tools.map((tool) => tool.name).sort(),
      "Every agent peer MCP server must publish both directions of the Lash coordination surface.",
    ).toEqual(["delegate", "report"]);
    expect(
      tools.tools.find((tool) => tool.name === "delegate")?.description,
      "Delegate tool metadata should identify the target peer so generic MCP clients can render it correctly.",
    ).toContain("@vp-eng");
  });

  test("callTool_WhenTransportCarriesValidFederatedToken_DelegatesAndEmitsStructuredLashEnvelope", async () => {
    const trace = core.createLashTrace();

    const result = await withMcpClient("vp-eng", "coo", async (client) =>
      client.callTool(
        {
          name: "delegate",
          arguments: {
            from: "coo",
            prompt: "Summarize engineering risk.",
            trace,
            thread: core.createLashThread("vp-eng", trace),
          },
        },
        CallToolResultSchema,
      ),
    );
    const envelope = lashContext.parseLashEnvelope(result.structuredContent);
    const content = result.content as TextContent[] | undefined;
    const text = content?.[0]?.type === "text" ? content[0].text : "";

    expect(envelope?.kind, "Valid MCP delegate calls should return a structured Lash result envelope.").toBe("result");
    expect(envelope?.trace, "Returned Lash envelope should preserve the incoming trace id for cross-agent audit.").toBe(trace);
    expect(text, "MCP delegate result should include the target peer's model/run output for the caller.").toContain("Summarize engineering risk.");
  });

  test("callTool_WhenCallerTokenAudienceTargetsDifferentPeer_ReturnsStructuredAuthError", async () => {
    const token = await core.mintFederatedAgentToken("coo", {
      audience: [core.federatedAgentMcpAudience("vp-ops")],
    });

    const result = await withMcpClient("vp-eng", "coo", async (client) =>
      client.callTool(
        {
          name: "delegate",
          arguments: {
            from: "coo",
            prompt: "This token is for a different peer.",
          },
        },
        CallToolResultSchema,
      ),
      token,
    );
    const envelope = lashContext.parseLashEnvelope(result.structuredContent);
    const content = result.content as TextContent[] | undefined;
    const text = content?.[0]?.type === "text" ? content[0].text : "";

    expect(envelope?.kind, "Wrong-audience tokens should be returned as structured Lash errors, not thrown transport crashes.").toBe("error");
    expect(text, "The MCP auth error should be visible to the caller for debugging federation misconfiguration.").toContain("audience");
  });
});
