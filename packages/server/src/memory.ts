/**
 * MemoryStore — durable storage for compaction anchors and (eventually)
 * peer-to-peer derived facts.
 *
 * Two implementations:
 *   - FileMemoryStore — JSONL appended to <profile>/memory/anchors.jsonl
 *   - HonchoMemoryStore — TODO: writes to a local honcho server
 *
 * Both implement the same interface. The chat loop is unaware of which
 * is in use. When honcho stands up (uv venv, postgres+pgvector, server
 * subprocess managed by server), `chat.tsx` swaps the implementation
 * by reading config and constructing the appropriate store.
 */
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { profilePaths } from "./paths.ts";
import { readGlobalConfig } from "./global-config.ts";
import { readAgentPack } from "./agent-pack.ts";
import { resolveAgentRuntime } from "./cloud-runtime.ts";
import { writeEvent } from "./events.ts";

export interface AnchorRecord {
  /** Stable id (uuid). */
  id: string;
  /** Profile that produced the anchor. */
  peer: string;
  /** Chat session id this anchor was generated in. */
  sessionId: string;
  /** Optional cross-peer correlation id (lash trace). */
  trace?: string;
  /** Model that generated the summary. */
  model: string;
  /** Markdown body (opencode-style structured anchor). */
  summary: string;
  /** Whether this anchor *updated* a previous one (vs fresh). */
  isUpdate: boolean;
  /** ID of the parent anchor we updated, if isUpdate. */
  previousAnchorId?: string;
  /** Tokens before/after compaction, for telemetry. */
  tokensBefore: number;
  tokensAfter: number;
  /** How many messages were summarized. */
  droppedCount: number;
  /** Epoch ms. */
  ts: number;
}

export interface MemoryStore {
  /** Append a new anchor for a peer. */
  writeAnchor(record: AnchorRecord): Promise<void>;
  /** Read the most recent N anchors for a peer (newest first). */
  recentAnchors(peer: string, limit?: number): Promise<AnchorRecord[]>;
  /** Read the latest anchor for a peer (or undefined). */
  latestAnchor(peer: string): Promise<AnchorRecord | undefined>;
  /** Free resources. */
  close(): Promise<void>;
}

export type MemoryEventKind =
  | "session.meta"
  | "session.message"
  | "lash.wake"
  | "memory.anchor"
  | "tool.result"
  | "audit.event";

export interface MemoryEvent {
  id: string;
  kind: MemoryEventKind;
  peer: string;
  sessionId?: string;
  trace?: string;
  thread?: unknown;
  role?: string;
  ts: number;
  payload: unknown;
}

export interface MemoryEventQuery {
  peer?: string;
  kind?: MemoryEventKind | MemoryEventKind[];
  trace?: string;
  sessionId?: string;
  since?: number;
  until?: number;
  limit?: number;
}

export interface MemorySyncConfig {
  enabled: boolean;
  url?: string;
  provider: "honcho" | "http" | "local";
  workspaceId: string;
  apiKeyEnv?: string;
  strict: boolean;
  timeoutMs: number;
}

// ---------- FileMemoryStore ----------

export class FileMemoryStore implements MemoryStore {
  /** JSONL one record per line. Path is per-peer. */
  private pathFor(peer: string): string {
    return join(profilePaths(peer).memoryDir, "anchors.jsonl");
  }

  async writeAnchor(record: AnchorRecord): Promise<void> {
    await writeAnchorLocal(record);
    await writeMemoryEvent({
      kind: "memory.anchor",
      peer: record.peer,
      sessionId: record.sessionId,
      trace: record.trace,
      ts: record.ts,
      payload: record,
    });
  }

  async recentAnchors(peer: string, limit = 10): Promise<AnchorRecord[]> {
    const path = this.pathFor(peer);
    let raw: string;
    try {
      raw = await fs.readFile(path, "utf8");
    } catch {
      return [];
    }
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const records: AnchorRecord[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as AnchorRecord);
      } catch {
        // skip corrupt lines
      }
    }
    records.sort((a, b) => b.ts - a.ts);
    return records.slice(0, limit);
  }

  async latestAnchor(peer: string): Promise<AnchorRecord | undefined> {
    const recent = await this.recentAnchors(peer, 1);
    return recent[0];
  }

  async close(): Promise<void> {
    // nothing to do
  }
}

export async function readMemoryEvents(peer: string, query: Omit<MemoryEventQuery, "peer"> = {}): Promise<MemoryEvent[]> {
  const path = join(profilePaths(peer).memoryDir, "events.jsonl");
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: MemoryEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as MemoryEvent;
      if (matchesMemoryQuery(event, { ...query, peer })) out.push(event);
    } catch {
      // Keep the append log readable even if a partial line appears.
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, query.limit ?? out.length);
}

export async function queryMemoryEvents(query: MemoryEventQuery = {}): Promise<MemoryEvent[]> {
  const peers = query.peer ? [query.peer] : await listMemoryPeers();
  const { peer: _peer, ...rest } = query;
  const batches = await Promise.all(peers.map((peer) => readMemoryEvents(peer, rest)));
  const out = batches.flat().filter((event) => matchesMemoryQuery(event, query));
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, query.limit ?? out.length);
}

async function listMemoryPeers(): Promise<string[]> {
  const { listProfiles } = await import("./profile.ts");
  return listProfiles();
}

function matchesMemoryQuery(event: MemoryEvent, query: MemoryEventQuery): boolean {
  if (query.peer && event.peer !== query.peer) return false;
  if (query.kind && !matchesOne(event.kind, query.kind)) return false;
  if (query.trace && event.trace !== query.trace) return false;
  if (query.sessionId && event.sessionId !== query.sessionId) return false;
  if (query.since && event.ts < query.since) return false;
  if (query.until && event.ts > query.until) return false;
  return true;
}

function matchesOne<T extends string>(value: T, expected: T | T[]): boolean {
  return Array.isArray(expected) ? expected.includes(value) : value === expected;
}

async function writeAnchorLocal(record: AnchorRecord): Promise<void> {
  const path = join(profilePaths(record.peer).memoryDir, "anchors.jsonl");
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.appendFile(path, JSON.stringify(record) + "\n");
}

// ---------- Event sink ----------

/**
 * Write-ahead memory/audit event sink.
 *
 * Local JSONL is always written. If memory sync is enabled, the same event is
 * posted to the configured URL. Failed remote writes are appended to an outbox
 * so we can replay once the runtime owns a durable daemon.
 */
export async function writeMemoryEvent(input: Omit<MemoryEvent, "id" | "ts"> & { id?: string; ts?: number }): Promise<void> {
  const event: MemoryEvent = {
    id: input.id ?? randomUUID(),
    kind: input.kind,
    peer: input.peer,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.trace ? { trace: input.trace } : {}),
    ...(input.thread !== undefined ? { thread: input.thread } : {}),
    ...(input.role ? { role: input.role } : {}),
    ts: input.ts ?? Date.now(),
    payload: input.payload,
  };

  await appendLocalMemoryEvent(event);
  await writeEvent({
    type: "memory.write",
    actor: event.peer,
    subject: event.peer,
    sessionId: event.sessionId,
    trace: event.trace,
    threadId: readThreadId(event.thread),
    outcome: "success",
    payload: {
      kind: event.kind,
      role: event.role,
      memoryEventId: event.id,
    },
  });
  const cfg = await resolveMemorySyncConfig(event.peer);
  if (!cfg.enabled || !cfg.url) return;

  try {
    await postMemoryEvent(cfg, event);
  } catch (error) {
    await appendMemoryOutbox(event, cfg, (error as Error).message);
    if (cfg.strict) throw error;
  }
}

function readThreadId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const thread = value as { id?: unknown };
  return typeof thread.id === "string" ? thread.id : undefined;
}

export async function resolveMemorySyncConfig(peer?: string): Promise<MemorySyncConfig> {
  const cfg = await readGlobalConfig();
  const memory = isRecord(cfg.memory) ? cfg.memory : {};
  const rawSync = isRecord(memory.sync) ? memory.sync : isRecord(memory.sink) ? memory.sink : {};
  const pack = peer ? await readOptionalPack(peer) : undefined;

  if (pack?.memory.provider === "none") {
    return {
      enabled: false,
      provider: "local",
      workspaceId: "local",
      strict: false,
      timeoutMs: 1_500,
    };
  }

  const runtime = peer ? await resolveOptionalRuntime(peer) : undefined;
  const honcho = runtime?.head.honcho;
  const enabled = readEnvBool(process.env.US_MEMORY_SYNC) ?? (typeof rawSync.enabled === "boolean" ? rawSync.enabled : true);
  const provider = readProvider(rawSync.provider) ?? (pack?.memory.provider === "honcho" ? "honcho" : "http");
  const workspaceId = readString(rawSync.workspaceId) ?? pack?.memory.peerProfile ?? honcho?.workspaceId ?? "local";
  const baseUrl = readString(process.env.US_MEMORY_SYNC_BASE_URL) ?? readString(rawSync.baseUrl) ?? honcho?.baseUrl;
  const url =
    readString(process.env.US_MEMORY_SYNC_URL) ??
    readString(rawSync.url) ??
    readString(rawSync.endpoint) ??
    (baseUrl ? `${baseUrl.replace(/\/+$/, "")}/v1/workspaces/${encodeURIComponent(workspaceId)}/events` : undefined);

  return {
    enabled,
    provider,
    ...(url ? { url } : {}),
    workspaceId,
    ...(readString(rawSync.apiKeyEnv) ?? honcho?.apiKeyEnv ? { apiKeyEnv: readString(rawSync.apiKeyEnv) ?? honcho?.apiKeyEnv } : {}),
    strict: rawSync.strict === true,
    timeoutMs: readPositiveInt(rawSync.timeoutMs) ?? 1_500,
  };
}

async function appendLocalMemoryEvent(event: MemoryEvent): Promise<void> {
  const path = join(profilePaths(event.peer).memoryDir, "events.jsonl");
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.appendFile(path, JSON.stringify(event) + "\n");
}

async function appendMemoryOutbox(event: MemoryEvent, cfg: MemorySyncConfig, error: string): Promise<void> {
  const path = join(profilePaths(event.peer).memoryDir, "sync-outbox.jsonl");
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.appendFile(path, JSON.stringify({ event, sink: redactedSink(cfg), error, ts: Date.now() }) + "\n");
}

async function postMemoryEvent(cfg: MemorySyncConfig, event: MemoryEvent): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "union-street/0.0.0",
    };
    const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const response = await fetch(cfg.url!, {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider: cfg.provider,
        workspaceId: cfg.workspaceId,
        event,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`memory sink HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function redactedSink(cfg: MemorySyncConfig): Record<string, unknown> {
  return {
    enabled: cfg.enabled,
    provider: cfg.provider,
    url: cfg.url,
    workspaceId: cfg.workspaceId,
    apiKeyEnv: cfg.apiKeyEnv,
    strict: cfg.strict,
    timeoutMs: cfg.timeoutMs,
  };
}

async function readOptionalPack(peer: string) {
  try {
    return await readAgentPack(peer);
  } catch {
    return undefined;
  }
}

async function resolveOptionalRuntime(peer: string) {
  try {
    return await resolveAgentRuntime(peer);
  } catch {
    return undefined;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readProvider(value: unknown): MemorySyncConfig["provider"] | undefined {
  return value === "honcho" || value === "http" || value === "local" ? value : undefined;
}

function readEnvBool(value: string | undefined): boolean | undefined {
  if (value == null || value.trim() === "") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["0", "false", "off", "no", "disabled"].includes(normalized)) return false;
  if (["1", "true", "on", "yes", "enabled"].includes(normalized)) return true;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ---------- HonchoMemoryStore ----------

/**
 * Pipes anchors into a local honcho server as `peer.sessions.<id>.messages`
 * with category "anchor", AND optionally promotes them to peer-level
 * representations for cross-session retrieval.
 *
 * Compatibility wrapper around the default HTTP sink. The runtime can replace
 * this with a native SDK client later without changing callers.
 */
export class HonchoMemoryStore implements MemoryStore {
  private file = new FileMemoryStore();
  private opts: { baseUrl: string; workspaceId: string; apiKey?: string };

  constructor(opts: { baseUrl: string; workspaceId: string; apiKey?: string }) {
    this.opts = opts;
  }

  async writeAnchor(record: AnchorRecord): Promise<void> {
    await writeAnchorLocal(record);
    const event: MemoryEvent = {
      id: randomUUID(),
      kind: "memory.anchor",
      peer: record.peer,
      sessionId: record.sessionId,
      ...(record.trace ? { trace: record.trace } : {}),
      ts: record.ts,
      payload: record,
    };
    await appendLocalMemoryEvent(event);
    await postMemoryEvent({
      enabled: true,
      provider: "honcho",
      url: `${this.opts.baseUrl.replace(/\/+$/, "")}/v1/workspaces/${encodeURIComponent(this.opts.workspaceId)}/events`,
      workspaceId: this.opts.workspaceId,
      strict: false,
      timeoutMs: 1_500,
    }, event).catch(async (error) => {
      await appendMemoryOutbox(event, {
        enabled: true,
        provider: "honcho",
        url: this.opts.baseUrl,
        workspaceId: this.opts.workspaceId,
        strict: false,
        timeoutMs: 1_500,
      }, (error as Error).message);
    });
  }

  async recentAnchors(peer: string, limit?: number): Promise<AnchorRecord[]> {
    return this.file.recentAnchors(peer, limit);
  }

  async latestAnchor(peer: string): Promise<AnchorRecord | undefined> {
    return this.file.latestAnchor(peer);
  }

  async close(): Promise<void> {
    // future: close honcho client
  }
}
