import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@unionstreet/ai-codex";
import type { AnchorRecord, MemoryStore } from "./memory.ts";
import { ANCHOR_MARKER } from "./compaction.ts";
import { compactSession, sanitizeToolPairsForCompaction, type SummarizerInput } from "./compactor.ts";

describe("compactor hygiene", () => {
  test("sanitizeToolPairsForCompaction_WhenToolResultLost_AddsStubResultAfterAssistantCall", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      {
        role: "assistant",
        content: "checking",
        tool_calls: [{ id: "call-1", name: "ls", arguments: "{}" }],
      },
      { role: "user", content: "next" },
    ];

    const sanitized = sanitizeToolPairsForCompaction(messages);

    expect(
      sanitized,
      "When compaction preserves an assistant tool call but removes its result, the chat history must get a stub tool result so OpenAI-compatible APIs do not reject the next request.",
    ).toEqual([
      { role: "system", content: "system" },
      {
        role: "assistant",
        content: "checking",
        tool_calls: [{ id: "call-1", name: "ls", arguments: "{}" }],
      },
      { role: "tool", tool_call_id: "call-1", content: "[Tool result removed during context compaction.]" },
      { role: "user", content: "next" },
    ]);
  });

  test("sanitizeToolPairsForCompaction_WhenToolResultIsOrphaned_RemovesIt", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "tool", tool_call_id: "missing-call", content: "orphaned stdout" },
      { role: "user", content: "continue" },
    ];

    const sanitized = sanitizeToolPairsForCompaction(messages);

    expect(
      sanitized,
      "When compaction removes an assistant call but leaves the result, the orphaned tool result must be dropped because providers require tool messages to reference an in-context call.",
    ).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "continue" },
    ]);
  });
});

describe("compactSession", () => {
  test("compactSession_WhenSummarizerSucceeds_ReplacesDroppedPrefixWithAnchorAndPersistsMemory", async () => {
    const memory = new InMemoryAnchors();
    const messages = [
      { role: "system", content: "base system" },
      ...conversationTurns(5),
    ] satisfies ChatMessage[];

    const result = await compactSession({
      messages,
      token: fakeJwt(),
      summarizerModel: "gpt-summary",
      contextWindow: 20_000,
      settings: settings({ preserveRecentTokens: 1, tailTurns: 2 }),
      peer: "coo",
      sessionId: "session-1",
      trace: "trace-1",
      memory,
      summarize: async () => "## Goal\n- keep working",
    });

    expect(result.messages[0], "The base system prompt must remain first after compaction because agent identity and policy live there.").toEqual({ role: "system", content: "base system" });
    expect(
      result.messages[1],
      "The dropped prefix should be replaced by a system compaction anchor that downstream prompts can trust as working memory.",
    ).toEqual({ role: "system", content: `${ANCHOR_MARKER}\n\n## Goal\n- keep working` });
    expect(
      result.messages.filter((message) => message.role === "user").map((message) => message.content),
      "The most recent two user-anchored turns must survive intact after compaction.",
    ).toEqual(["user 4", "user 5"]);
    expect(result.anchor.peer, "Persisted anchors must retain the producing agent so memory lookup remains agent-scoped.").toBe("coo");
    expect(result.anchor.sessionId, "Persisted anchors must retain the session id for replay and audit correlation.").toBe("session-1");
    expect(result.anchor.trace, "Persisted anchors must retain the Lash trace when available so cross-agent memory remains attributable.").toBe("trace-1");
    expect(result.anchor.isUpdate, "A first compaction without a prior anchor should be marked as a fresh anchor.").toBe(false);
    expect(memory.writes, "compactSession must persist exactly one memory anchor for every successful compaction.").toHaveLength(1);
  });

  test("compactSession_WhenPreviousAnchorIsDropped_AsksSummarizerToUpdateIt", async () => {
    const memory = new InMemoryAnchors();
    let seen: SummarizerInput | undefined;
    const messages = [
      { role: "system", content: "base system" },
      { role: "system", content: `${ANCHOR_MARKER}\n\n## Goal\n- previous` },
      ...conversationTurns(4),
    ] satisfies ChatMessage[];

    const result = await compactSession({
      messages,
      token: fakeJwt(),
      summarizerModel: "gpt-summary",
      contextWindow: 20_000,
      settings: settings({ preserveRecentTokens: 1, tailTurns: 1 }),
      peer: "coo",
      sessionId: "session-1",
      memory,
      summarize: async (input) => {
        seen = input;
        return "## Goal\n- updated";
      },
    });

    expect(seen?.previousSummary, "When an old anchor falls into the dropped prefix, the summarizer must receive it for iterative update instead of starting from scratch.").toContain("previous");
    expect(
      seen?.messages.some((message) => message.role === "system" && message.content.startsWith(ANCHOR_MARKER)),
      "The previous anchor itself should be removed from the transcript sent to the summarizer to avoid double-counting stale summaries.",
    ).toBe(false);
    expect(result.anchor.isUpdate, "The resulting anchor must be flagged as an update so memory consumers can distinguish iterative compactions.").toBe(true);
    expect(result.messages[1]?.role === "system" ? result.messages[1].content : "", "The new context anchor should contain the updated summary.").toContain("updated");
  });

  test("compactSession_WhenToolOutputIsDropped_TruncatesBeforeSummarization", async () => {
    let seenToolContent = "";
    const messages: ChatMessage[] = [
      { role: "system", content: "base system" },
      { role: "user", content: "inspect logs" },
      { role: "assistant", content: "using tool", tool_calls: [{ id: "call-1", name: "bash", arguments: "{\"cmd\":\"logs\"}" }] },
      { role: "tool", tool_call_id: "call-1", content: "A".repeat(120) },
      { role: "user", content: "current ask" },
      { role: "assistant", content: "current answer" },
    ];

    await compactSession({
      messages,
      token: fakeJwt(),
      summarizerModel: "gpt-summary",
      contextWindow: 20_000,
      settings: settings({ preserveRecentTokens: 1, tailTurns: 1, truncateToolOutput: 16 }),
      peer: "coo",
      sessionId: "session-1",
      memory: new InMemoryAnchors(),
      summarize: async (input) => {
        seenToolContent = input.messages.find((message) => message.role === "tool")?.content ?? "";
        return "summary";
      },
    });

    expect(seenToolContent.startsWith("A".repeat(16)), "Dropped tool output should preserve the first cap bytes so the summary sees the important prefix.").toBe(true);
    expect(seenToolContent, "Dropped tool output should include an explicit truncation marker with the original size for auditability.").toContain("original was 120 bytes");
    expect(seenToolContent.length < 120, "The summarizer must not receive full verbose tool output once the truncation cap is exceeded.").toBe(true);
  });

  test("compactSession_WhenSummarizerReturnsWhitespace_StoresEmptySummarySentinel", async () => {
    const result = await compactSession({
      messages: [{ role: "system", content: "base" }, ...conversationTurns(3)],
      token: fakeJwt(),
      summarizerModel: "gpt-summary",
      contextWindow: 20_000,
      settings: settings({ preserveRecentTokens: 1, tailTurns: 1 }),
      peer: "coo",
      sessionId: "session-1",
      memory: new InMemoryAnchors(),
      summarize: async () => "   \n  ",
    });

    expect(result.anchor.summary, "Whitespace-only summaries should normalize to a visible sentinel rather than creating an empty system anchor.").toBe("(empty summary)");
    expect(result.messages[1]?.role === "system" ? result.messages[1].content : "", "The inserted anchor should also contain the empty-summary sentinel.").toContain("(empty summary)");
  });

  test("compactSession_WhenSummarizerFails_DoesNotPersistAnchor", async () => {
    const memory = new InMemoryAnchors();

    const act = compactSession({
      messages: [{ role: "system", content: "base" }, ...conversationTurns(3)],
      token: fakeJwt(),
      summarizerModel: "gpt-summary",
      contextWindow: 20_000,
      settings: settings({ preserveRecentTokens: 1, tailTurns: 1 }),
      peer: "coo",
      sessionId: "session-1",
      memory,
      summarize: async () => {
        throw new Error("summarizer unavailable");
      },
    });

    await expect(act, "Summarizer failures should reject the compaction so callers keep the original message stack.").rejects.toThrow("summarizer unavailable");
    expect(memory.writes, "A failed compaction must not write a partial or misleading memory anchor.").toHaveLength(0);
  });
});

function conversationTurns(count: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 1; i <= count; i++) {
    messages.push({ role: "user", content: `user ${i}` });
    messages.push({ role: "assistant", content: `assistant ${i}` });
  }
  return messages;
}

function settings(overrides: Partial<Parameters<typeof compactSession>[0]["settings"]> = {}): Parameters<typeof compactSession>[0]["settings"] {
  return {
    enabled: true,
    reserveTokens: 1_000,
    preserveRecentTokens: 1,
    tailTurns: 1,
    truncateToolOutput: 64,
    protectedTools: [],
    ...overrides,
  };
}

function fakeJwt(): string {
  return [
    btoa(JSON.stringify({ alg: "none" })),
    btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } })),
    "sig",
  ].join(".");
}

class InMemoryAnchors implements MemoryStore {
  writes: AnchorRecord[] = [];

  async writeAnchor(record: AnchorRecord): Promise<void> {
    this.writes.push(record);
  }

  async recentAnchors(peer: string, limit = 10): Promise<AnchorRecord[]> {
    return this.writes.filter((record) => record.peer === peer).slice(-limit).reverse();
  }

  async latestAnchor(peer: string): Promise<AnchorRecord | undefined> {
    for (let i = this.writes.length - 1; i >= 0; i--) {
      const record = this.writes[i]!;
      if (record.peer === peer) return record;
    }
    return undefined;
  }

  async close(): Promise<void> {}
}
