import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { EVENTS_PATH } from "./paths.ts";

export type ControlPlaneEventType =
  | "memory.write"
  | "federation.token.mint"
  | "federation.token.verify"
  | "federation.token.reject"
  | "federation.mcp.grant.resolve"
  | "lash.call"
  | "lash.allow"
  | "lash.deny"
  | "lash.error"
  | "mcp.auth.save"
  | "mcp.auth.delete"
  | "secret.grant.resolve"
  | "secret.materialize"
  | "runtime.workspace.ensure"
  | "scheduler.due"
  | "scheduler.run.claim"
  | "scheduler.run.start"
  | "scheduler.run.complete"
  | "scheduler.run.fail"
  | "prompt.run.start"
  | "prompt.model.start"
  | "prompt.model.fallback"
  | "model.usage"
  | "prompt.tool.call"
  | "prompt.run.complete"
  | "prompt.run.fail"
  | "webhook.received"
  | "audit.test";

export interface ControlPlaneEvent {
  id: string;
  ts: number;
  type: ControlPlaneEventType;
  actor?: string;
  subject?: string;
  target?: string;
  resource?: string;
  sessionId?: string;
  trace?: string;
  threadId?: string;
  outcome: "allow" | "deny" | "success" | "failure" | "info";
  severity: "debug" | "info" | "warn" | "error";
  reason?: string;
  payload?: unknown;
}

export interface EventQuery {
  type?: ControlPlaneEventType | ControlPlaneEventType[];
  actor?: string;
  subject?: string;
  target?: string;
  resource?: string;
  trace?: string;
  outcome?: ControlPlaneEvent["outcome"] | ControlPlaneEvent["outcome"][];
  since?: number;
  until?: number;
  limit?: number;
}

export async function writeEvent(
  input: Omit<ControlPlaneEvent, "id" | "ts" | "severity" | "outcome"> &
    Partial<Pick<ControlPlaneEvent, "id" | "ts" | "severity" | "outcome">>,
): Promise<ControlPlaneEvent> {
  const event: ControlPlaneEvent = {
    id: input.id ?? randomUUID(),
    ts: input.ts ?? Date.now(),
    type: input.type,
    ...(input.actor ? { actor: normalizePrincipal(input.actor) } : {}),
    ...(input.subject ? { subject: normalizePrincipal(input.subject) } : {}),
    ...(input.target ? { target: normalizePrincipal(input.target) } : {}),
    ...(input.resource ? { resource: input.resource } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.trace ? { trace: input.trace } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    outcome: input.outcome ?? "info",
    severity: input.severity ?? severityForOutcome(input.outcome ?? "info"),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.payload !== undefined ? { payload: redactPayload(input.payload) } : {}),
  };
  await appendEvent(event);
  return event;
}

export async function queryEvents(query: EventQuery = {}): Promise<ControlPlaneEvent[]> {
  const events = await readEvents();
  const newestFirst = events
    .filter((event) => matchesQuery(event, query))
    .sort((a, b) => b.ts - a.ts);
  return newestFirst.slice(0, query.limit ?? newestFirst.length);
}

export async function tailEvents(limit = 50): Promise<ControlPlaneEvent[]> {
  return queryEvents({ limit });
}

export async function readEvents(): Promise<ControlPlaneEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(EVENTS_PATH, "utf8");
  } catch {
    return [];
  }
  const out: ControlPlaneEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ControlPlaneEvent);
    } catch {
      // Ignore corrupt partial lines. The append-only file remains inspectable.
    }
  }
  return out;
}

async function appendEvent(event: ControlPlaneEvent): Promise<void> {
  await fs.mkdir(dirname(EVENTS_PATH), { recursive: true });
  await fs.appendFile(EVENTS_PATH, JSON.stringify(event) + "\n", { mode: 0o600 });
}

function matchesQuery(event: ControlPlaneEvent, query: EventQuery): boolean {
  if (query.type && !matchesOne(event.type, query.type)) return false;
  if (query.outcome && !matchesOne(event.outcome, query.outcome)) return false;
  if (query.actor && event.actor !== normalizePrincipal(query.actor)) return false;
  if (query.subject && event.subject !== normalizePrincipal(query.subject)) return false;
  if (query.target && event.target !== normalizePrincipal(query.target)) return false;
  if (query.resource && event.resource !== query.resource) return false;
  if (query.trace && event.trace !== query.trace) return false;
  if (query.since && event.ts < query.since) return false;
  if (query.until && event.ts > query.until) return false;
  return true;
}

function matchesOne<T extends string>(value: T, expected: T | T[]): boolean {
  return Array.isArray(expected) ? expected.includes(value) : value === expected;
}

function normalizePrincipal(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("@")) return trimmed.slice(1);
  if (trimmed.startsWith("agent:")) return trimmed.slice("agent:".length);
  return trimmed;
}

function severityForOutcome(outcome: ControlPlaneEvent["outcome"]): ControlPlaneEvent["severity"] {
  if (outcome === "failure") return "error";
  if (outcome === "deny") return "warn";
  return "info";
}

function redactPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPayload);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/(token|secret|api[_-]?key|authorization|password|refresh|access)/i.test(key)) {
      out[key] = "<redacted>";
    } else {
      out[key] = redactPayload(entry);
    }
  }
  return out;
}
