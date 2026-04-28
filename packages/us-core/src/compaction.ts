/**
 * Pure functions for context compaction.
 *
 * No I/O, no LLM calls. The orchestrator (`compactor.ts`) calls into these
 * to decide when and where to cut.
 *
 * Design — borrowed from pi (cut-point detection) and opencode (anchored
 * structured summary, last-N-turns protected, tool-output truncation):
 *
 *   - `estimateTokens` — char-based fallback (chars/4) for messages with
 *     no real usage data. Conservative.
 *   - `shouldCompact` — fires when usage.total > contextWindow - reserveTokens.
 *   - `findCutPoint` — walks back from newest, accumulating estimated
 *     tokens, stops at keepRecentTokens. NEVER cuts at a `tool` message
 *     (it must follow its assistant tool_call). Always preserves the last
 *     `tailTurns` user-anchored turns intact.
 */
import type { ChatMessage } from "@unionstreet/ai-codex";

// ----- types -----

export interface CompactionSettings {
  enabled: boolean;
  /** How many tokens to leave free for the next response (and tool budget). */
  reserveTokens: number;
  /**
   * Minimum tokens of recent history to always keep, regardless of tail
   * turns. Computed as `clamp(contextWindow * 0.25, [2k, 8k])` when set
   * to "auto".
   */
  preserveRecentTokens: number | "auto";
  /** Always keep at least this many user-anchored turns intact. */
  tailTurns: number;
  /** Truncate tool output to this many chars before passing to summarizer. */
  truncateToolOutput: number;
  /** Tool names that are never compacted (always preserved). */
  protectedTools: string[];
}

export const DEFAULT_COMPACTION: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_000,
  preserveRecentTokens: "auto",
  tailTurns: 2,
  truncateToolOutput: 2_000,
  protectedTools: [],
};

export const PRESERVE_MIN = 2_000;
export const PRESERVE_MAX = 8_000;

// ----- token estimation -----

/** chars/4 heuristic — overestimates tokens, conservative for cuts. */
export function estimateTokens(msg: ChatMessage): number {
  let chars = 0;
  if (msg.role === "user" || msg.role === "system") {
    chars = msg.content.length;
  } else if (msg.role === "assistant") {
    if (msg.content) chars += msg.content.length;
    for (const c of msg.tool_calls ?? []) {
      chars += c.name.length + (c.arguments?.length ?? 0);
    }
  } else if (msg.role === "tool") {
    chars = msg.content.length;
  }
  return Math.ceil(chars / 4);
}

export function estimateMessagesTokens(msgs: ChatMessage[]): number {
  let total = 0;
  for (const m of msgs) total += estimateTokens(m);
  return total;
}

export function resolvePreserveBudget(
  settings: CompactionSettings,
  contextWindow: number,
): number {
  if (settings.preserveRecentTokens !== "auto") return settings.preserveRecentTokens;
  return Math.max(PRESERVE_MIN, Math.min(PRESERVE_MAX, Math.floor(contextWindow * 0.25)));
}

// ----- trigger -----

export interface ShouldCompactInput {
  /** Last reported usage from the model. */
  usageTokens: number;
  contextWindow: number;
  settings: CompactionSettings;
}

export function shouldCompact(input: ShouldCompactInput): boolean {
  if (!input.settings.enabled) return false;
  const threshold = input.contextWindow - input.settings.reserveTokens;
  return input.usageTokens >= threshold;
}

// ----- cut point detection -----

export interface CutPointResult {
  /** Index of first kept message (in the full messages array). */
  cutIndex: number;
  /** True if the cut required splitting a single turn (no clean boundary). */
  splitMidTurn: boolean;
}

/**
 * Walk back from newest, accumulate token estimates, stop at preserve budget.
 *
 * Invariants:
 *   - Never cut between an assistant `tool_call` and its matching `tool` result.
 *   - Always keep at least `tailTurns` user-anchored turns intact.
 *   - System messages at the head are kept (the prompt + the anchor).
 *   - Returns `cutIndex` = first kept index. Everything before is dropped.
 */
export function findCutPoint(
  messages: ChatMessage[],
  preserveTokens: number,
  tailTurns: number,
): CutPointResult {
  // Anchor head: keep all leading system messages (prompt + previous anchor).
  let headEnd = 0;
  while (headEnd < messages.length && messages[headEnd]!.role === "system") {
    headEnd++;
  }

  if (headEnd === messages.length) {
    return { cutIndex: messages.length, splitMidTurn: false };
  }

  // Find the last `tailTurns` user-anchored turn boundaries (working back).
  // A "turn" starts at a user message. Tool messages are part of their
  // preceding assistant turn.
  const userIndices: number[] = [];
  for (let i = messages.length - 1; i >= headEnd; i--) {
    if (messages[i]!.role === "user") userIndices.push(i);
  }
  // user messages collected newest-first; pick the boundary tailTurns back.
  const tailTurnStart = userIndices[Math.min(tailTurns, userIndices.length) - 1];
  const protectedFrom =
    tailTurnStart != null ? tailTurnStart : (userIndices[userIndices.length - 1] ?? messages.length);

  // From `protectedFrom`, walk backwards adding tokens until budget exhausted
  // or we reach the head. Each user/assistant message is a valid cut point;
  // tool messages are not (they must stay glued to their tool_call assistant).
  let acc = 0;
  let cutIndex = protectedFrom;
  for (let i = protectedFrom - 1; i >= headEnd; i--) {
    const m = messages[i]!;
    acc += estimateTokens(m);
    if (acc >= preserveTokens) {
      // find the closest valid cut at-or-after this index
      const candidate = nextValidCut(messages, i);
      cutIndex = candidate < protectedFrom ? protectedFrom : candidate;
      break;
    }
    // walked all the way back — cut at headEnd (drop nothing more).
    cutIndex = i;
  }

  // Detect if this cut splits a turn (cut point is not user/system).
  const splitMidTurn =
    cutIndex < messages.length &&
    messages[cutIndex]!.role !== "user" &&
    messages[cutIndex]!.role !== "system";

  return { cutIndex, splitMidTurn };
}

function nextValidCut(messages: ChatMessage[], from: number): number {
  for (let i = from; i < messages.length; i++) {
    const r = messages[i]!.role;
    if (r === "user" || r === "assistant") return i;
  }
  return messages.length;
}

// ----- helpers exposed for the orchestrator -----

export function findExistingAnchor(messages: ChatMessage[]): {
  index: number;
  content: string;
} | null {
  // The anchor is a system message tagged with the marker comment line.
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "system" && m.content.startsWith(ANCHOR_MARKER)) {
      return { index: i, content: m.content };
    }
  }
  return null;
}

/** First line of any anchor. Used to detect re-compactions and to update existing anchors. */
export const ANCHOR_MARKER = "# COMPACTION ANCHOR";
