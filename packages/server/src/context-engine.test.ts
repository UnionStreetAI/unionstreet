import { describe, expect, test } from "bun:test";
import { createContextEngine, DEFAULT_CONTEXT_ENGINE_CONFIG } from "./context-engine.ts";
import type { ChatMessage } from "@unionstreet/ai-codex";

describe("context engine", () => {
  test("createContextEngine_WhenUsingDefaultConfig_ReturnsHermesStyleCompressorThresholds", () => {
    const engine = createContextEngine(DEFAULT_CONTEXT_ENGINE_CONFIG);

    engine.onSessionStart("coo-session");
    engine.updateModel("gpt-test", 200_000);

    const status = engine.getStatus();

    expect(status.name, "The default engine must remain the built-in compressor unless an agent pack explicitly selects another engine.").toBe("compressor");
    expect(status.sessionId, "Session lifecycle must attach the active chat session to engine status for dashboard/runtime inspection.").toBe("coo-session");
    expect(status.thresholdTokens, "The agent compressor threshold should match Hermes' 50% default for normal in-loop compaction.").toBe(100_000);
    expect(status.gatewayHygieneTokens, "The pre-agent hygiene threshold should match Hermes' 85% safety-net threshold.").toBe(170_000);
    expect(status.compressionCount, "Starting a session should reset compression counters so /new and /resume do not inherit old state.").toBe(0);
  });

  test("shouldCompress_WhenUsageCrossesAgentThreshold_ReturnsTrueOnlyAtThreshold", () => {
    const engine = createContextEngine(DEFAULT_CONTEXT_ENGINE_CONFIG);
    engine.onSessionStart("coo-session");
    engine.updateModel("gpt-test", 100_000);

    const below = engine.shouldCompress(49_999);
    const atThreshold = engine.shouldCompress(50_000);

    expect(below, "The engine must not compact before the configured threshold or long sessions will churn summaries every turn.").toBe(false);
    expect(atThreshold, "The engine must request compaction as soon as usage reaches the configured threshold.").toBe(true);
  });

  test("shouldGatewayHygiene_WhenNoUsageExists_FallsBackToMessageEstimate", () => {
    const engine = createContextEngine(DEFAULT_CONTEXT_ENGINE_CONFIG);
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "x".repeat(4_000) },
      { role: "assistant", content: "y".repeat(4_000) },
      { role: "user", content: "z".repeat(4_000) },
    ];
    engine.onSessionStart("coo-session");
    engine.updateModel("gpt-test", 3_000);

    const shouldHygiene = engine.shouldGatewayHygiene(messages);

    expect(
      shouldHygiene,
      "Gateway hygiene must use a rough message estimate when no provider usage is available so oversized resumed sessions are still protected before the next API call.",
    ).toBe(true);
  });

  test("updateFromUsage_WhenProviderReportsBuckets_TracksPromptCompletionAndPressure", () => {
    const engine = createContextEngine(DEFAULT_CONTEXT_ENGINE_CONFIG);
    engine.onSessionStart("coo-session");
    engine.updateModel("gpt-test", 10_000);

    engine.updateFromUsage({
      input: 2_000,
      output: 300,
      reasoning: 100,
      cache_read: 500,
      cache_write: 50,
      total: 2_950,
    });

    const status = engine.getStatus();

    expect(status.lastPromptTokens, "Prompt usage should include non-cached input plus cache read/write buckets for context pressure.").toBe(2_550);
    expect(status.lastCompletionTokens, "Completion usage should include visible output plus hidden reasoning tokens.").toBe(400);
    expect(status.lastTotalTokens, "Engine status must keep the provider-reported total for /cost and compaction decisions.").toBe(2_950);
    expect(status.pressure, "Pressure should be total tokens divided by the active model context window.").toBe(0.295);
  });
});
