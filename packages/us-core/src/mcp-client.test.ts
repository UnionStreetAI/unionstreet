import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDummyMcpServer, type DummyMcpServerHandle } from "./dummy-mcp-server.ts";

const usHome = await mkdtemp(join(tmpdir(), "union-street-mcp-client-test-"));
const workdir = await mkdtemp(join(tmpdir(), "union-street-mcp-client-work-"));
process.env.US_HOME = usHome;
process.env.US_MEMORY_SYNC = "0";
process.env.US_STREAM_MODEL_STUB = "1";
process.env.US_USAGE_DISABLE_MODELS_DEV_COSTS = "1";
process.env.US_MCP_ALLOW_PRIVATE_URLS = "1";

const core = await import("./index.ts");

let poetry!: DummyMcpServerHandle;
let context!: DummyMcpServerHandle;

beforeAll(async () => {
  poetry = await startDummyMcpServer({
    name: "poetry",
    token: "poetry-token",
    toolName: "poems.read",
    poem: "Orange sparks on midnight rails / Work reports and truth prevails.",
  });
  context = await startDummyMcpServer({
    name: "context",
    token: "context-token",
    toolName: "context.poem",
    poem: "A quiet packet crossed the wire / And lit the agent's small campfire.",
  });

  const demo = core.buildDemoFederationConfig();
  demo.config.grants.push({
    id: "dummy-mcp-poetry-context",
    resource: "mcp",
    servers: ["poetry", "context"],
    tools: ["poems.*", "context.*"],
    roles: ["executive"],
  });
  await Bun.write(core.FEDERATION_PATH, JSON.stringify(demo.config, null, 2));
  const coo = demo.org.find((node) => node.id === "coo")!;
  await core.initProfile("coo", { role: "executive", capabilities: coo.roles });
  const pack = core.buildAgentPackFromOrgNode(coo, demo.org);
  await core.writeAgentPack("coo", {
    ...pack,
    toolkit: { ...pack.toolkit, mcp: ["poetry", "context"] },
    model: { primary: { provider: "codex", id: "gpt-5.5" }, fallback: [] },
  });
  await core.saveMcpApiKeyCredential({ profile: "coo", server: "poetry", apiKey: "poetry-token" });
  await core.saveMcpApiKeyCredential({ profile: "coo", server: "context", apiKey: "context-token" });
  await writeFile(
    join(workdir, ".mcp.json"),
    JSON.stringify({
      mcp: {
        poetry: { type: "remote", url: poetry.url, enabled: true, headers: { Authorization: "Bearer" } },
        context: { type: "remote", url: context.url, enabled: true, headers: { Authorization: "Bearer" } },
      },
    }, null, 2),
  );
});

afterAll(async () => {
  poetry?.stop();
  context?.stop();
  await rm(usHome, { recursive: true, force: true });
  await rm(workdir, { recursive: true, force: true });
});

describe("remote MCP client tools", () => {
  test("resolveMcpToolsForAgent_WhenAgentHasGrantAndCredential_ListsTwoAuthenticatedRemoteTools", async () => {
    const tools = await core.resolveMcpToolsForAgent("coo", workdir);

    expect(
      tools.map((tool) => tool.definition.name).sort(),
      "Granted authenticated remote MCP tools should be exposed as model-safe function names.",
    ).toEqual(["mcp_context_context_poem", "mcp_poetry_poems_read"]);
    expect(
      tools.every((tool) => tool.definition.parameters.type === "object"),
      "Remote MCP input schemas should be preserved for model tool arguments.",
    ).toBe(true);
  });

  test("runAgentPrompt_WhenStubModelRequestsMcpPoem_ExecutesRemoteMcpToolAndPersistsAuditUsageAndSession", async () => {
    const result = await core.runAgentPrompt({
      profile: "coo",
      cwd: workdir,
      sessionId: "mcp-poem-session",
      trace: "trace-mcp-poem",
      prompt: "please use the poetry mcp tool to add a poem to context",
    });
    const sessionRaw = await Bun.file(result.sessionFile).text();
    const events = await core.queryEvents({ trace: "trace-mcp-poem", limit: 50 });
    const listEvents = await core.queryEvents({ type: "mcp.tool.list", actor: "coo", outcome: "success", limit: 10 });
    const usage = await core.queryUsageRecords({ trace: "trace-mcp-poem", limit: 10 });

    expect(result.steps, "A remote MCP tool call should force the agent loop through a follow-up model step.").toBe(2);
    expect(result.toolCalls.map((call) => call.name), "The result should expose the model-safe MCP tool name that was executed.").toEqual(["mcp_context_context_poem"]);
    expect(sessionRaw, "The transcript should persist the remote MCP tool output as context for the follow-up step.").toContain("A quiet packet crossed the wire");
    expect(
      events.map((event) => event.type),
      "Remote MCP execution should produce call, prompt tool, and prompt completion events on the same trace.",
    ).toEqual(expect.arrayContaining(["mcp.tool.call", "prompt.tool.call", "prompt.run.complete"]));
    expect(
      listEvents.some((event) => event.resource === "mcp:context"),
      "Remote MCP discovery should be audited before the tool is exposed to the model.",
    ).toBe(true);
    expect(
      usage.reduce((total, record) => total + record.usage.total, 0),
      "MCP-backed prompt runs should still record model token usage across both model steps.",
    ).toBe(4);
  });

  test("resolveMcpToolsForAgent_WhenCredentialIsWrong_DoesNotExposeUnauthenticatedServerToolsAndAuditsFailure", async () => {
    await core.saveMcpApiKeyCredential({ profile: "coo", server: "poetry", apiKey: "wrong-token" });

    const tools = await core.resolveMcpToolsForAgent("coo", workdir);
    const failures = await core.queryEvents({ type: "mcp.tool.list", actor: "coo", outcome: "failure", limit: 10 });

    expect(
      tools.map((tool) => tool.definition.name),
      "A server with invalid bearer auth should not leak its tool surface to the model.",
    ).not.toContain("mcp_poetry_poems_read");
    expect(
      failures.some((event) => event.resource === "mcp:poetry" && event.reason?.includes("401")),
      "Failed MCP discovery should be audited with the HTTP auth failure for operator diagnosis.",
    ).toBe(true);
  });

  test("resolveMcpToolsForAgent_WhenRemoteServerHangs_TimesOutDiscoveryAndFailsClosed", async () => {
    const slowServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const previousTimeout = process.env.US_MCP_HTTP_TIMEOUT_MS;
    process.env.US_MCP_HTTP_TIMEOUT_MS = "50";
    try {
      const federation = await core.readFederationConfig();
      await Bun.write(core.FEDERATION_PATH, JSON.stringify({
        ...federation,
        grants: [
          ...federation.grants,
          {
            id: "dummy-mcp-slow",
            resource: "mcp",
            servers: ["slow"],
            tools: ["*"],
            roles: ["executive"],
          },
        ],
      }, null, 2));
      const pack = await core.readAgentPack("coo");
      await core.writeAgentPack("coo", {
        ...pack,
        toolkit: { ...pack.toolkit, mcp: [...new Set([...pack.toolkit.mcp, "slow"])] },
      });
      await core.saveMcpApiKeyCredential({ profile: "coo", server: "slow", apiKey: "slow-token" });
      await writeFile(
        join(workdir, ".mcp.json"),
        JSON.stringify({
          mcp: {
            poetry: { type: "remote", url: poetry.url, enabled: true, headers: { Authorization: "Bearer" } },
            context: { type: "remote", url: context.url, enabled: true, headers: { Authorization: "Bearer" } },
            slow: { type: "remote", url: `http://127.0.0.1:${slowServer.port}`, enabled: true, headers: { Authorization: "Bearer" } },
          },
        }, null, 2),
      );

      const tools = await core.resolveMcpToolsForAgent("coo", workdir);
      const failures = await core.queryEvents({ type: "mcp.tool.list", actor: "coo", outcome: "failure", limit: 20 });

      expect(
        tools.map((tool) => tool.definition.name),
        "A hanging MCP server must not expose partial or speculative tools to the model after the HTTP timeout.",
      ).not.toContain("mcp_slow_tool");
      expect(
        failures.some((event) => event.resource === "mcp:slow" && event.reason?.includes("timed out")),
        "MCP discovery timeouts must be audited so operators can distinguish auth failures from dead remotes.",
      ).toBe(true);
    } finally {
      if (previousTimeout === undefined) delete process.env.US_MCP_HTTP_TIMEOUT_MS;
      else process.env.US_MCP_HTTP_TIMEOUT_MS = previousTimeout;
      slowServer.stop(true);
    }
  });

  test("resolveMcpToolsForAgent_WhenRemoteUrlTargetsMetadataService_FailsClosedBeforeNetworkCall", async () => {
    const previousAllowPrivate = process.env.US_MCP_ALLOW_PRIVATE_URLS;
    delete process.env.US_MCP_ALLOW_PRIVATE_URLS;
    const federation = await core.readFederationConfig();
    try {
      await Bun.write(core.FEDERATION_PATH, JSON.stringify({
        ...federation,
        grants: [
          ...federation.grants,
          {
            id: "dummy-mcp-metadata",
            resource: "mcp",
            servers: ["metadata"],
            tools: ["*"],
            roles: ["executive"],
          },
        ],
      }, null, 2));
      const pack = await core.readAgentPack("coo");
      await core.writeAgentPack("coo", {
        ...pack,
        toolkit: { ...pack.toolkit, mcp: [...new Set([...pack.toolkit.mcp, "metadata"])] },
      });
      await core.saveMcpApiKeyCredential({ profile: "coo", server: "metadata", apiKey: "metadata-token" });
      await writeFile(
        join(workdir, ".mcp.json"),
        JSON.stringify({
          mcp: {
            metadata: { type: "remote", url: "http://169.254.169.254/latest/meta-data", enabled: true, headers: { Authorization: "Bearer" } },
          },
        }, null, 2),
      );

      const tools = await core.resolveMcpToolsForAgent("coo", workdir);
      const failures = await core.queryEvents({ type: "mcp.tool.list", actor: "coo", outcome: "failure", limit: 20 });

      expect(
        tools.map((tool) => tool.definition.name),
        "MCP URLs pointing at cloud metadata services must not expose any tools to the model.",
      ).not.toContain("mcp_metadata_tool");
      expect(
        failures.some((event) => event.resource === "mcp:metadata" && event.reason?.includes("private, local, loopback, or metadata host")),
        "Unsafe MCP URL rejections must be audited so operators can fix poisoned or risky MCP config.",
      ).toBe(true);
    } finally {
      if (previousAllowPrivate === undefined) delete process.env.US_MCP_ALLOW_PRIVATE_URLS;
      else process.env.US_MCP_ALLOW_PRIVATE_URLS = previousAllowPrivate;
    }
  });
});
