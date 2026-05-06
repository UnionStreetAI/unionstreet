import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@unionstreet/ai-codex";
import {
  ANCHOR_MARKER,
  DEFAULT_COMPACTION,
  estimateMessagesTokens,
  estimateTokens,
  findCutPoint,
  findExistingAnchor,
  resolvePreserveBudget,
  shouldCompact,
} from "./compaction.ts";

describe("compaction pure functions", () => {
  test("estimateTokens_WhenMessagesContainTextAndToolCalls_ReturnsConservativeCharBasedCounts", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "x".repeat(9) },
      { role: "user", content: "y".repeat(8) },
      { role: "assistant", content: "done", tool_calls: [{ id: "call-1", name: "ls", arguments: "{\"path\":\".\"}" }] },
      { role: "tool", tool_call_id: "call-1", content: "z".repeat(10) },
    ];

    const counts = messages.map(estimateTokens);
    const total = estimateMessagesTokens(messages);

    expect(counts, "Token estimates should use ceil(chars/4) for every message role so fallback compaction is deterministic without tokenizer access.").toEqual([3, 2, 5, 3]);
    expect(total, "Message-list estimates must be the sum of each message estimate because cut-point budgets depend on additive pressure.").toBe(13);
  });

  test("resolvePreserveBudget_WhenAutoIsConfigured_ClampsToHermesStyleBounds", () => {
    const smallWindow = resolvePreserveBudget(DEFAULT_COMPACTION, 1_000);
    const normalWindow = resolvePreserveBudget(DEFAULT_COMPACTION, 20_000);
    const hugeWindow = resolvePreserveBudget(DEFAULT_COMPACTION, 1_000_000);

    expect(smallWindow, "Auto preserve budget must not fall below the lower guardrail or tiny contexts lose all useful tail context.").toBe(2_000);
    expect(normalWindow, "Auto preserve budget should use 25% of the context window while inside guardrails.").toBe(5_000);
    expect(hugeWindow, "Auto preserve budget must cap at the upper guardrail so huge-context models do not preserve too much stale history.").toBe(8_000);
  });

  test("shouldCompact_WhenDisabledOrBelowThreshold_ReturnsFalseUntilReserveIsConsumed", () => {
    const enabled = { ...DEFAULT_COMPACTION, reserveTokens: 2_000 };
    const disabled = { ...enabled, enabled: false };

    const disabledResult = shouldCompact({ usageTokens: 9_000, contextWindow: 10_000, settings: disabled });
    const below = shouldCompact({ usageTokens: 7_999, contextWindow: 10_000, settings: enabled });
    const atThreshold = shouldCompact({ usageTokens: 8_000, contextWindow: 10_000, settings: enabled });

    expect(disabledResult, "Disabled compaction must never fire regardless of token pressure.").toBe(false);
    expect(below, "Compaction must not fire before usage reaches contextWindow - reserveTokens.").toBe(false);
    expect(atThreshold, "Compaction must fire as soon as usage reaches contextWindow - reserveTokens.").toBe(true);
  });

  test("findCutPoint_WhenOnlySystemMessagesExist_ReturnsEndWithoutMidTurnSplit", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "base" },
      { role: "system", content: `${ANCHOR_MARKER}\n\nold` },
    ];

    const cut = findCutPoint(messages, 100, 2);

    expect(cut, "All-system histories have no conversation tail, so the cut point should be the end and never marked as a mid-turn split.").toEqual({
      cutIndex: 2,
      splitMidTurn: false,
    });
  });

  test("findCutPoint_WhenTailTurnsConfigured_PreservesLastUserAnchoredTurns", () => {
    const messages = turns(5);

    const cut = findCutPoint(messages, 1, 2);

    expect(cut.cutIndex, "With tailTurns=2, the first kept message should be the second-newest user turn even when token budget is tiny.").toBe(7);
    expect(messages[cut.cutIndex]?.role, "Cut points should land on a user boundary for preserved user-anchored turns.").toBe("user");
    expect(cut.splitMidTurn, "Cutting at a user boundary must not be considered a mid-turn split.").toBe(false);
  });

  test("findCutPoint_WhenPreserveBudgetReachesAssistantCall_DoesNotCutAtToolResult", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "base" },
      { role: "user", content: "old" },
      { role: "assistant", content: "using tool", tool_calls: [{ id: "call-1", name: "read", arguments: "{}" }] },
      { role: "tool", tool_call_id: "call-1", content: "x".repeat(80) },
      { role: "user", content: "new" },
    ];

    const cut = findCutPoint(messages, 10, 1);

    expect(cut.cutIndex, "When walking backward hits a tool result immediately before the protected tail, the cut must advance to the protected user turn rather than keeping an orphaned tool result.").toBe(4);
    expect(messages[cut.cutIndex]?.role, "The resulting cut point should be provider-valid because it starts at the next user turn after the dropped tool pair.").toBe("user");
    expect(cut.splitMidTurn, "Keeping an assistant tool-call boundary is valid and should not be classified as a mid-turn split.").toBe(false);
  });

  test("findExistingAnchor_WhenAnchorMarkerExists_ReturnsIndexAndContent", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "base" },
      { role: "system", content: `${ANCHOR_MARKER}\n\n## Goal\n- old` },
      { role: "user", content: "continue" },
    ];

    const anchor = findExistingAnchor(messages);

    expect(anchor?.index, "Existing anchor lookup must return the exact system-message index so the orchestrator can remove and replace it.").toBe(1);
    expect(anchor?.content, "Existing anchor lookup must preserve full content so iterative compaction can update the prior summary.").toContain("## Goal");
  });
});

function turns(count: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: "base" }];
  for (let i = 1; i <= count; i++) {
    messages.push({ role: "user", content: `user ${i}` });
    messages.push({ role: "assistant", content: `assistant ${i}` });
  }
  return messages;
}
