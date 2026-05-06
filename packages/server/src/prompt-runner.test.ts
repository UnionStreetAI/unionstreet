import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const usHome = await mkdtemp(join(tmpdir(), "union-street-prompt-runner-test-"));
process.env.US_HOME = usHome;
process.env.US_MEMORY_SYNC = "0";
process.env.US_STREAM_MODEL_STUB = "1";
process.env.US_USAGE_DISABLE_MODELS_DEV_COSTS = "1";

const core = await import("./index.ts");

beforeAll(async () => {
  const demo = core.buildDemoFederationConfig();
  await Bun.write(core.FEDERATION_PATH, JSON.stringify(demo.config, null, 2));
  const coo = demo.org.find((node) => node.id === "coo")!;
  const vpFinance = demo.org.find((node) => node.id === "vp-finance")!;
  await core.initProfile("coo", { role: "coo" });
  await core.initProfile("vp-finance", { role: "vp" });
  await createBehavioralPlugin();
  const cooPack = core.buildAgentPackFromOrgNode(coo, demo.org);
  await core.writeAgentPack("coo", {
    ...cooPack,
    toolkit: {
      ...cooPack.toolkit,
      plugins: ["behavioral-plugin"],
    },
  });
  const vpFinancePack = core.buildAgentPackFromOrgNode(vpFinance, demo.org);
  await core.writeAgentPack("vp-finance", {
    ...vpFinancePack,
    toolkit: {
      ...vpFinancePack.toolkit,
      plugins: [],
    },
  });
});

afterAll(async () => {
  await rm(usHome, { recursive: true, force: true });
  await rm(join(process.cwd(), "plugins", "behavioral-plugin"), { recursive: true, force: true });
});

describe("agent prompt runner", () => {
  test("runAgentPrompt_WhenProfileOrPromptIsMissing_FailsBeforeCreatingRunArtifacts", async () => {
    const emptyProfile = () => core.runAgentPrompt({ profile: "", prompt: "hello" });
    const emptyPrompt = () => core.runAgentPrompt({ profile: "coo", prompt: "   " });
    const missingProfile = () => core.runAgentPrompt({ profile: "missing-agent", prompt: "hello" });

    await expect(emptyProfile(), "An empty profile should fail before filesystem/model work begins.").rejects.toThrow("profile is required");
    await expect(emptyPrompt(), "Blank prompts should fail before creating sessions.").rejects.toThrow("prompt is required");
    await expect(missingProfile(), "Missing profiles should fail with an operator-actionable message.").rejects.toThrow('Profile "missing-agent" does not exist.');
  });

  test("runAgentPrompt_WhenStubbedModelReturnsText_PersistsSessionEventsUsageAndTranscript", async () => {
    const textChunks: string[] = [];

    const result = await core.runAgentPrompt({
      profile: "@coo",
      prompt: "hello load-bearing prompt",
      trace: "trace-prompt-runner",
      sessionId: "session-prompt-runner",
      onText(text) {
        textChunks.push(text);
      },
    });
    const sessionRaw = await readFile(result.sessionFile, "utf8");
    const events = await core.queryEvents({ trace: "trace-prompt-runner" });
    const usage = await core.queryUsageRecords({ actor: "coo", trace: "trace-prompt-runner" });

    expect(result.text, "The prompt runner should return the assistant text from the selected model.").toContain("stub response from codex/gpt-5.5: hello load-bearing prompt");
    expect(textChunks.join(""), "Text callbacks should stream the same content returned in the final result.").toBe(result.text);
    expect(result.sessionId, "Explicit session ids should be respected so /resume can reconnect to the same file.").toBe("session-prompt-runner");
    expect(sessionRaw, "Prompt sessions should persist metadata, user, and assistant turns as JSONL.").toContain("\"kind\":\"session_meta\"");
    expect(sessionRaw, "Prompt sessions should persist provider/model metadata for resume.").toContain("\"model\":\"gpt-5.5\"");
    expect(events.map((event) => event.type), "Prompt runs should emit start, model start, usage, and completion events.").toEqual(expect.arrayContaining([
      "prompt.run.start",
      "prompt.model.start",
      "model.usage",
      "prompt.run.complete",
    ]));
    expect(usage[0]?.usage, "Prompt runs should write token usage records for /cost and accounting.").toEqual({ input: 1, output: 1, reasoning: 0, cache_read: 0, cache_write: 0, total: 2 });
  });

  test("runAgentPrompt_WhenToolCallIsReturned_ExecutesToolAndContinuesConversation", async () => {
    const toolResults: Array<{ name: string; result: string }> = [];

    const result = await core.runAgentPrompt({
      profile: "coo",
      prompt: "please use ls tool",
      trace: "trace-prompt-tool",
      sessionId: "session-prompt-tool",
      cwd: usHome,
      onToolResult(name, toolResult) {
        toolResults.push({ name, result: toolResult });
      },
    });
    const sessionRaw = await readFile(result.sessionFile, "utf8");
    const events = await core.queryEvents({ trace: "trace-prompt-tool" });

    expect(result.steps, "Tool calls should cause the runner to perform a second model step after tool output.").toBe(2);
    expect(result.toolCalls.map((call) => call.name), "The returned result should include every tool call executed during the run.").toEqual(["ls"]);
    expect(toolResults[0]?.name, "Tool result callbacks should identify the executed tool.").toBe("ls");
    expect(sessionRaw, "Tool results should be persisted into the transcript before the follow-up model step.").toContain("\"role\":\"tool\"");
    expect(events.map((event) => event.type), "Tool execution should emit a prompt.tool.call audit event.").toContain("prompt.tool.call");
  });

  test("runAgentPrompt_WhenPluginIsGranted_LoadsSkillContentAndExecutesPluginCustomTool", async () => {
    const result = await core.runAgentPrompt({
      profile: "coo",
      prompt: "please use the plugin echo tool",
      trace: "trace-plugin-tool-granted",
      sessionId: "session-plugin-tool-granted",
      cwd: process.cwd(),
    });
    const sessionRaw = await readFile(result.sessionFile, "utf8");
    const events = await core.queryEvents({ trace: "trace-plugin-tool-granted" });

    expect(result.steps, "Granted plugin custom tools should run through the normal multi-step model/tool loop.").toBe(2);
    expect(result.toolCalls.map((call) => call.name), "The model should see and call the plugin-scoped custom tool.").toEqual(["behavioral_plugin_plugin_echo"]);
    expect(sessionRaw, "Plugin custom tool results should be persisted into the transcript like built-in tools.").toContain("behavioral-plugin:");
    expect(events.some((event) => event.type === "prompt.tool.call" && event.resource === "tool:behavioral_plugin_plugin_echo"), "Plugin custom tool execution should emit the normal prompt.tool.call audit event.").toBe(true);

    const skillResult = await core.runAgentPrompt({
      profile: "coo",
      prompt: "confirm plugin skill loaded",
      trace: "trace-plugin-skill-granted",
      sessionId: "session-plugin-skill-granted",
      cwd: process.cwd(),
    });
    expect(skillResult.text, "Granted plugin skills should be injected into the model system prompt.").toContain("plugin skill loaded for coo");
  });

  test("runAgentPrompt_WhenPluginIsNotGranted_DoesNotExposeSkillOrCustomToolEvenIfInstalled", async () => {
    const result = await core.runAgentPrompt({
      profile: "vp-finance",
      prompt: "please use the plugin echo tool",
      trace: "trace-plugin-tool-denied",
      sessionId: "session-plugin-tool-denied",
      cwd: process.cwd(),
    });
    expect(result.toolCalls, "Installed but ungranted plugin custom tools should be absent from the model tool list.").toEqual([]);
    expect(result.text, "Without the plugin tool, the stub should fall back to a plain assistant response.").toContain("please use the plugin echo tool");

    const skillResult = await core.runAgentPrompt({
      profile: "vp-finance",
      prompt: "confirm plugin skill loaded",
      trace: "trace-plugin-skill-denied",
      sessionId: "session-plugin-skill-denied",
      cwd: process.cwd(),
    });
    expect(skillResult.text, "Installed but ungranted plugin skills should not enter this agent's system prompt.").toContain("plugin skill missing for vp-finance");
  });
});

async function createBehavioralPlugin(): Promise<void> {
  const pluginRoot = join(process.cwd(), "plugins", "behavioral-plugin");
  await rm(pluginRoot, { recursive: true, force: true });
  await mkdir(join(pluginRoot, "skills", "behavioral-plugin-skill"), { recursive: true });
  await mkdir(join(pluginRoot, "tools"), { recursive: true });
  await writeFile(join(pluginRoot, "README.md"), "# behavioral-plugin\n");
  await writeFile(join(pluginRoot, "skills", "behavioral-plugin-skill", "SKILL.md"), [
    "---",
    "name: behavioral-plugin-skill",
    "description: Behavioral prompt-runner skill",
    "---",
    "",
    "# Behavioral Plugin Skill",
    "",
    "This text must appear only for agents explicitly granted behavioral-plugin.",
  ].join("\n"));
  await writeFile(join(pluginRoot, "tools", "plugin-echo.ts"), [
    "export default {",
    "  description: 'Echo a message with plugin context',",
    "  parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },",
    "  async execute(args, context) { return `${context.plugin.name}:${args.message}`; }",
    "};",
  ].join("\n"));
  await writeFile(join(pluginRoot, "unionstreet.plugin.json"), JSON.stringify({
    schema_version: "v1",
    name: "behavioral-plugin",
    version: "0.1.0",
    description: "Behavioral prompt-runner test plugin",
    kind: ["skills", "tools"],
    capabilities: {
      skills: ["behavioral-plugin-skill"],
      tools: ["plugin-echo"],
    },
    entrypoints: {
      skills: "./skills",
      tools: "./tools",
    },
    permissions: {},
  }, null, 2));
}
