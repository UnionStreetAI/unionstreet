/**
 * Session JSONL helpers for `/resume`.
 *
 * Each chat writes turns to `<profile>/sessions/<sessionId>.jsonl`, one
 * record per line. Resuming a session reads the file, reconstructs the
 * agent's `ChatMessage[]` (so the model has full context) AND a UI
 * `Turn[]` (so the user sees the history) — and then new turns continue
 * appending to the same file.
 *
 * Persisted record shapes (current schema):
 *   { role: "user", content, ts }
 *   { role: "assistant", content, tool_calls, finish, provider?, model?, ts }
 *   { role: "tool", tool_call_id, name, content, ts }
 *   { kind: "session_meta", provider, model, ts }
 *   { kind: "compaction", anchor_id, summary?, dropped_count, tokens_before, tokens_after, ts }
 *
 * The compaction entry MAY be older-format without an inline `summary`
 * (we added that field in the same change that introduced this loader).
 * In that case we substitute a placeholder; the agent still sees a clear
 * marker that history was compacted at that point.
 */
import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import type { ChatMessage } from "@unionstreet/ai-codex";
import { profilePaths } from "./paths.ts";
import { ANCHOR_MARKER } from "./compaction.ts";

// ----- listing -----

export interface SessionInfo {
  /** sessionId — the basename without extension. */
  id: string;
  /** Absolute path to the JSONL. */
  file: string;
  /** Most recent line ts; falls back to file mtime if no parseable ts. */
  ts: number;
  /** Number of message-shaped lines. */
  turnCount: number;
  /** Preview of the first user message in the session (or "" if none). */
  firstUserPreview: string;
  /** Preview of the most recent user message. */
  lastUserPreview: string;
  /** File size in bytes. */
  size: number;
}

const PREVIEW_MAX = 80;
const SESSIONS_TO_INSPECT = 50; // cap to avoid pathological dirs

export async function listSessions(profile: string): Promise<SessionInfo[]> {
  const dir = profilePaths(profile).sessions;
  let entries: string[];
  try {
    entries = (await fs.readdir(dir)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  // Stat first so we can sort by mtime cheaply, then inspect contents.
  const stats = await Promise.all(
    entries.map(async (n) => {
      const full = join(dir, n);
      try {
        const st = await fs.stat(full);
        return { name: n, full, mtime: st.mtimeMs, size: st.size };
      } catch {
        return null;
      }
    }),
  );
  const ranked = stats
    .filter((x): x is { name: string; full: string; mtime: number; size: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, SESSIONS_TO_INSPECT);

  const infos: SessionInfo[] = [];
  for (const r of ranked) {
    const info = await summarizeFile(r.name, r.full, r.mtime, r.size);
    if (info) infos.push(info);
  }
  return infos;
}

async function summarizeFile(
  name: string,
  full: string,
  mtime: number,
  size: number,
): Promise<SessionInfo | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(full, "utf8");
  } catch {
    return undefined;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  let turnCount = 0;
  let firstUser: string | undefined;
  let lastUser: string | undefined;
  let lastTs: number | undefined;
  for (const line of lines) {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const role = parsed.role as string | undefined;
    const kind = parsed.kind as string | undefined;
    const ts = typeof parsed.ts === "number" ? (parsed.ts as number) : undefined;
    if (ts) lastTs = ts;
    if (role === "user" || role === "assistant" || kind === "compaction") turnCount++;
    if (role === "user") {
      const content = String(parsed.content ?? "");
      if (!firstUser) firstUser = content;
      lastUser = content;
    }
  }
  return {
    id: name.replace(/\.jsonl$/, ""),
    file: full,
    ts: lastTs ?? mtime,
    turnCount,
    firstUserPreview: clip(firstUser ?? "", PREVIEW_MAX),
    lastUserPreview: clip(lastUser ?? firstUser ?? "", PREVIEW_MAX),
    size,
  };
}

function clip(s: string, n: number): string {
  const compact = s.replace(/\s+/g, " ").trim();
  if (compact.length <= n) return compact;
  return compact.slice(0, n - 1) + "…";
}

// ----- replay -----

export interface ReplayResult {
  /** Reconstructed agent messages (including a placeholder system header). */
  messages: ChatMessage[];
  /** UI turns (re-rendered transcript). Same shape as App's `Turn` type. */
  turns: ReplayTurn[];
  /** Last model/provider recorded in the session, if the log carries it. */
  model?: { provider: string; id: string };
}

/**
 * Mirror of App's `Turn` union. Exported here so `chat.tsx`/App can
 * project these directly into App state without re-walking the JSONL.
 */
export type ReplayTurn =
  | { kind: "user"; id: string; text: string; ts: number }
  | {
      kind: "assistant";
      id: string;
      agent: string;
      text: string;
      streaming: false;
      ts: number;
    }
  | { kind: "system"; id: string; text: string; ts: number }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: string;
      result: string | null;
      ts: number;
    }
  | {
      kind: "compaction";
      id: string;
      droppedCount: number;
      tokensBefore: number;
      tokensAfter: number;
      summary: string;
      ts: number;
    };

export async function readSession(profile: string, file: string): Promise<ReplayResult> {
  const raw = await fs.readFile(file, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  const messages: ChatMessage[] = [];
  const turns: ReplayTurn[] = [];
  let model: ReplayResult["model"];

  for (const line of lines) {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const role = parsed.role as string | undefined;
    const kind = parsed.kind as string | undefined;
    const ts = typeof parsed.ts === "number" ? (parsed.ts as number) : Date.now();
    const id = newId();

    const provider = typeof parsed.provider === "string" ? parsed.provider : undefined;
    const modelId = typeof parsed.model === "string" ? parsed.model : undefined;
    if (provider && modelId) model = { provider, id: modelId };

    if (kind === "session_meta") {
      continue;
    }

    if (role === "user") {
      const content = String(parsed.content ?? "");
      messages.push({ role: "user", content });
      turns.push({ kind: "user", id, text: content, ts });
      continue;
    }

    if (role === "assistant") {
      const content = (parsed.content as string | undefined) ?? "";
      const toolCalls = parsed.tool_calls as
        | Array<{ id: string; name: string; arguments: string }>
        | undefined;
      messages.push({
        role: "assistant",
        content: content || undefined,
        tool_calls: toolCalls && toolCalls.length ? toolCalls : undefined,
      });
      turns.push({
        kind: "assistant",
        id,
        agent: profile,
        text: content,
        streaming: false,
        ts,
      });
      continue;
    }

    if (role === "tool") {
      const callId = String(parsed.tool_call_id ?? "");
      const name = String(parsed.name ?? "tool");
      const content = String(parsed.content ?? "");
      messages.push({ role: "tool", tool_call_id: callId, content });
      turns.push({
        kind: "tool",
        id,
        name,
        args: "",
        result: content,
        ts,
      });
      continue;
    }

    if (kind === "compaction") {
      const summary = (parsed.summary as string | undefined) ?? "(summary not persisted in this session — older format)";
      const droppedCount = Number(parsed.dropped_count ?? 0);
      const tokensBefore = Number(parsed.tokens_before ?? 0);
      const tokensAfter = Number(parsed.tokens_after ?? 0);
      // The compaction marker becomes a system message in the agent's
      // context, so the model "remembers" it via the anchor template.
      messages.push({
        role: "system",
        content: `${ANCHOR_MARKER}\n\n${summary}`,
      });
      turns.push({
        kind: "compaction",
        id,
        droppedCount,
        tokensBefore,
        tokensAfter,
        summary,
        ts,
      });
      continue;
    }

    // unknown record — skip silently
  }

  return { messages, turns, model };
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Helper for picker rendering. */
export function sessionAgeLabel(ts: number, now = Date.now()): string {
  const ms = Math.max(0, now - ts);
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

/** Compact id for display when the long timestamp form is too verbose. */
export function shortSessionLabel(id: string): string {
  // ids look like `<profile>-2026-04-27T01-23-45-678Z`; chop the profile
  // prefix and pretty-print the timestamp.
  const m = id.match(/-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return basename(id);
  const [, Y, M, D, h, mn] = m;
  return `${Y}-${M}-${D} ${h}:${mn}`;
}
