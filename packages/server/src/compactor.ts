/**
 * Compaction orchestrator.
 *
 *   1. Decide where to cut (`findCutPoint`).
 *   2. Build a summarization prompt (opencode-style anchored Markdown
 *      template). If a previous anchor exists, ask the model to UPDATE it
 *      rather than generate from scratch.
 *   3. Stream the summary from the model.
 *   4. Replace the cut prefix in the message list with a single system
 *      message tagged with ANCHOR_MARKER.
 *   5. Persist the new anchor to the MemoryStore (file today, honcho
 *      tomorrow).
 *
 * Pure-ish — depends on a `streamModel` callback so this module is decoupled
 * from any specific provider. ai-codex's streamCodex satisfies the shape.
 */
import { streamCodex, type ChatMessage, type ToolCall } from "@unionstreet/ai-codex";
import {
  ANCHOR_MARKER,
  estimateMessagesTokens,
  findCutPoint,
  findExistingAnchor,
  resolvePreserveBudget,
  type CompactionSettings,
} from "./compaction.ts";
import type { MemoryStore, AnchorRecord } from "./memory.ts";

const SUMMARY_TEMPLATE = `Output exactly this Markdown structure and keep the section order unchanged:
---
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
---

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

const SUMMARIZER_SYSTEM_PROMPT = `You are summarizing a coding-agent conversation so the agent can keep working without the full transcript. Your output IS the agent's working memory — be precise, brief, and faithful.`;

// ----- input/output -----

export interface CompactInput {
  messages: ChatMessage[];
  /** Auth token + model + accountId etc. */
  token: string;
  /** Model used to summarize. Often a smaller/cheaper one than the chat model. */
  summarizerModel: string;
  /** Context window of the chat model (used to compute preserve budget). */
  contextWindow: number;
  settings: CompactionSettings;
  /** Identity for the resulting anchor. */
  peer: string;
  sessionId: string;
  trace?: string;
  /** Where to persist. */
  memory: MemoryStore;
  /** Truncated tool results before passing to summarizer. */
  truncateToolOutput?: number;
  /** Test/plugin seam: override the model-backed summarizer. */
  summarize?: (input: SummarizerInput) => Promise<string>;
  signal?: AbortSignal;
}

export interface SummarizerInput {
  token: string;
  model: string;
  messages: ChatMessage[];
  previousSummary?: string;
  signal?: AbortSignal;
}

export interface CompactResult {
  /** New message list — head + anchor + recent. */
  messages: ChatMessage[];
  anchor: AnchorRecord;
  tokensBefore: number;
  tokensAfter: number;
  droppedCount: number;
  /** Whether we cut mid-turn (no clean boundary). */
  splitMidTurn: boolean;
}

// ----- main -----

export async function compactSession(input: CompactInput): Promise<CompactResult> {
  const tokensBefore = estimateMessagesTokens(input.messages);
  const preserveBudget = resolvePreserveBudget(input.settings, input.contextWindow);

  const cut = findCutPoint(input.messages, preserveBudget, input.settings.tailTurns);
  const droppedRaw = input.messages.slice(0, cut.cutIndex);
  const kept = input.messages.slice(cut.cutIndex);

  // Detect existing anchor among the dropped messages — strip it from the
  // dropped slice (we'll regenerate one) and treat its content as the
  // previousSummary input to the LLM.
  const existing = findExistingAnchor(droppedRaw);
  const previousSummary = existing?.content;
  const dropped = existing
    ? [...droppedRaw.slice(0, existing.index), ...droppedRaw.slice(existing.index + 1)]
    : droppedRaw;

  // Truncate tool outputs in the dropped slice before sending to summarizer
  // (saves tokens, the long stdout was already used by the agent earlier).
  const truncatedDropped = truncateToolOutputs(
    dropped,
    input.truncateToolOutput ?? input.settings.truncateToolOutput,
  );

  const summarize = input.summarize ?? runSummarizer;
  const summary = normalizeSummary(await summarize({
    token: input.token,
    model: input.summarizerModel,
    messages: truncatedDropped,
    previousSummary,
    signal: input.signal,
  }));

  const anchorMessage: ChatMessage = {
    role: "system",
    content: `${ANCHOR_MARKER}\n\n${summary}`,
  };

  // Reconstruct the head: keep all leading system messages from kept's left
  // edge that came from the original messages (the base system prompt). We
  // assume the base prompt is the FIRST system message in the original list.
  const headSystemMessages: ChatMessage[] = [];
  for (let i = 0; i < input.messages.length; i++) {
    const m = input.messages[i]!;
    if (m.role !== "system") break;
    if (m.content.startsWith(ANCHOR_MARKER)) continue;
    headSystemMessages.push(m);
  }

  const newMessages: ChatMessage[] = sanitizeToolPairsForCompaction([
    ...headSystemMessages,
    anchorMessage,
    ...kept.filter((m) => m.role !== "system" || !m.content.startsWith(ANCHOR_MARKER)),
  ]);

  const tokensAfter = estimateMessagesTokens(newMessages);

  const anchor: AnchorRecord = {
    id: cryptoId(),
    peer: input.peer,
    sessionId: input.sessionId,
    trace: input.trace,
    model: input.summarizerModel,
    summary,
    isUpdate: previousSummary !== undefined,
    tokensBefore,
    tokensAfter,
    droppedCount: dropped.length,
    ts: Date.now(),
  };

  await input.memory.writeAnchor(anchor);

  return {
    messages: newMessages,
    anchor,
    tokensBefore,
    tokensAfter,
    droppedCount: dropped.length,
    splitMidTurn: cut.splitMidTurn,
  };
}

// ----- summarizer call -----

async function runSummarizer(input: SummarizerInput): Promise<string> {
  const userPrompt = buildSummaryPrompt(input);
  const messages: ChatMessage[] = [
    { role: "system", content: SUMMARIZER_SYSTEM_PROMPT },
    {
      role: "user",
      content: serializeForSummarizer(input.messages) + "\n\n" + userPrompt,
    },
  ];

  let summary = "";
  for await (const ev of streamCodex({
    token: input.token,
    model: input.model,
    system: SUMMARIZER_SYSTEM_PROMPT,
    messages,
    signal: input.signal,
    textVerbosity: "low",
  })) {
    if (ev.type === "text-delta") summary += ev.text;
    else if (ev.type === "error") throw new Error(`compaction summary failed: ${ev.error}`);
  }
  return normalizeSummary(summary);
}

function normalizeSummary(summary: string): string {
  return summary.trim() || "(empty summary)";
}

function buildSummaryPrompt(input: { previousSummary?: string }): string {
  const anchor = input.previousSummary
    ? [
        "Update the anchored summary below using the conversation history above.",
        "Preserve still-true details, remove stale details, and merge in the new facts.",
        "<previous-summary>",
        input.previousSummary,
        "</previous-summary>",
      ].join("\n")
    : "Create a new anchored summary from the conversation history above.";
  return [anchor, SUMMARY_TEMPLATE].join("\n\n");
}

function serializeForSummarizer(messages: ChatMessage[]): string {
  const lines: string[] = ["<conversation>"];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") lines.push(`<user>\n${m.content}\n</user>`);
    else if (m.role === "assistant") {
      const parts: string[] = [];
      if (m.content) parts.push(m.content);
      for (const c of m.tool_calls ?? []) {
        parts.push(`<tool-call name="${c.name}">${c.arguments}</tool-call>`);
      }
      lines.push(`<assistant>\n${parts.join("\n")}\n</assistant>`);
    } else if (m.role === "tool") {
      lines.push(`<tool-result>${m.content}</tool-result>`);
    }
  }
  lines.push("</conversation>");
  return lines.join("\n");
}

function truncateToolOutputs(messages: ChatMessage[], cap: number): ChatMessage[] {
  if (cap <= 0) return messages;
  return messages.map((m) => {
    if (m.role !== "tool") return m;
    if (m.content.length <= cap) return m;
    return {
      ...m,
      content: m.content.slice(0, cap) + `\n\n[truncated for compaction — original was ${m.content.length} bytes]`,
    };
  });
}

export function sanitizeToolPairsForCompaction(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const pending = new Set<string>();

  for (const message of messages) {
    if (message.role === "assistant") {
      out.push(message);
      for (const call of message.tool_calls ?? []) {
        if (call.id) pending.add(call.id);
      }
      continue;
    }

    if (message.role === "tool") {
      if (!pending.has(message.tool_call_id)) continue;
      out.push(message);
      pending.delete(message.tool_call_id);
      continue;
    }

    out.push(message);
  }

  if (pending.size === 0) return out;

  const patched: ChatMessage[] = [];
  for (const message of out) {
    patched.push(message);
    if (message.role !== "assistant") continue;
    for (const call of message.tool_calls ?? []) {
      if (!pending.has(call.id)) continue;
      patched.push({
        role: "tool",
        tool_call_id: call.id,
        content: "[Tool result removed during context compaction.]",
      });
      pending.delete(call.id);
    }
  }
  return patched;
}

function cryptoId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
}

// ----- pi-style "I just want to compact, here are the args" facade -----

/**
 * Convenience: returns true if the current usage tells us we should
 * compact. Wraps `shouldCompact` from `compaction.ts` with the bits a
 * caller usually has in hand.
 */
export { shouldCompact, DEFAULT_COMPACTION } from "./compaction.ts";
export type { CompactionSettings, CutPointResult } from "./compaction.ts";
