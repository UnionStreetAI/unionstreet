import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  await core.initProfile("coo", { role: "coo" });
  await core.writeAgentPack("coo", core.buildAgentPackFromOrgNode(coo, demo.org));
});

afterAll(async () => {
  await rm(usHome, { recursive: true, force: true });
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
});
