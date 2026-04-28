export * from "./models.ts";

/**
 * @unionstreet/ai-codex
 *
 * Minimal Codex (ChatGPT Plus/Pro/Team) Responses API client.
 *
 * Wire details cribbed from pi-mono's openai-codex-responses provider.
 * Just text-streaming + tool-calls. No reasoning summaries, no service tiers,
 * no retry-on-429 (yet). Keep this small and hackable.
 *
 *   POST https://chatgpt.com/backend-api/codex/responses
 *   Authorization: Bearer <oauth_access_token>
 *   chatgpt-account-id: <jwt.https://api.openai.com/auth.chatgpt_account_id>
 *   OpenAI-Beta: responses=experimental
 *   accept: text/event-stream
 */

const DEFAULT_BASE = "https://chatgpt.com/backend-api";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const ORIGINATOR = "us-dev";

// ----- public types -----

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  /** JSON Schema for the input. */
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string per Responses API
}

export interface TokenUsage {
  /** Billable non-cached input tokens. */
  input: number;
  /** Billable non-reasoning output tokens. */
  output: number;
  /** Output tokens spent on hidden reasoning. */
  reasoning?: number;
  /** Cached input tokens (already in the prefix cache). */
  cache_read?: number;
  /** Input tokens written into the provider cache. */
  cache_write?: number;
  /** Provider total, or input + output + reasoning + cache read/write. */
  total: number;
}

export type CodexEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; call: ToolCall }
  | {
      type: "finish";
      reason: "stop" | "tool_calls" | "incomplete" | "error";
      usage?: TokenUsage;
      raw?: unknown;
    }
  | { type: "error"; error: string };

export interface StreamCodexOptions {
  /** OAuth access token from us-auth. */
  token: string;
  /** Model id, e.g. "gpt-5", "gpt-5-codex". */
  model: string;
  /** System / instructions. */
  system?: string;
  /** Conversation so far. We convert to Responses input format internally. */
  messages: ChatMessage[];
  /** Tools to expose to the model. */
  tools?: ToolDefinition[];
  /** "low" | "medium" | "high" — default "medium". */
  textVerbosity?: "low" | "medium" | "high";
  /** Used for prompt cache + request id. */
  sessionId?: string;
  /** AbortSignal. */
  signal?: AbortSignal;
  /** Override base URL (testing). */
  baseUrl?: string;
  /** Override fetch (testing / embedded runtimes). */
  fetch?: typeof fetch;
}

// ----- entry point -----

export async function* streamCodex(opts: StreamCodexOptions): AsyncGenerator<CodexEvent> {
  const accountId = extractAccountId(opts.token);
  const url = resolveCodexUrl(opts.baseUrl);
  const body = buildRequestBody(opts);
  const headers = buildHeaders(opts.token, accountId, opts.sessionId);

  let response: Response;
  try {
    response = await (opts.fetch ?? fetch)(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    yield { type: "error", error: `network: ${(e as Error).message}` };
    return;
  }

  if (!response.ok || !response.body) {
    const text = await safeText(response);
    yield {
      type: "error",
      error: `http ${response.status}: ${truncate(text, 500)}`,
    };
    return;
  }

  for await (const event of parseSSE(response.body)) {
    const mapped = mapResponsesEvent(event);
    if (mapped) yield mapped;
  }
}

// ----- request shape -----

function buildRequestBody(opts: StreamCodexOptions): Record<string, unknown> {
  const input: unknown[] = [];

  for (const m of opts.messages) {
    if (m.role === "system") continue; // hoisted to instructions
    if (m.role === "user") {
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: m.content }],
      });
    } else if (m.role === "assistant") {
      if (m.content) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: m.content }],
        });
      }
      for (const c of m.tool_calls ?? []) {
        input.push({
          type: "function_call",
          call_id: c.id,
          name: c.name,
          arguments: c.arguments,
        });
      }
    } else if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id,
        output: m.content,
      });
    }
  }

  const sysFromMessages = opts.messages.find((m) => m.role === "system");
  const body: Record<string, unknown> = {
    model: opts.model,
    store: false,
    stream: true,
    instructions:
      opts.system ??
      (sysFromMessages?.role === "system" ? sysFromMessages.content : undefined) ??
      "You are a helpful assistant.",
    input,
    text: { verbosity: opts.textVerbosity ?? "medium" },
    include: ["reasoning.encrypted_content"],
  };

  if (opts.sessionId) body.prompt_cache_key = opts.sessionId;

  if (opts.tools && opts.tools.length) {
    body.tools = opts.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: t.strict ?? false,
    }));
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }

  return body;
}

// ----- headers -----

function buildHeaders(token: string, accountId: string, sessionId?: string): Headers {
  const h = new Headers();
  h.set("authorization", `Bearer ${token}`);
  h.set("chatgpt-account-id", accountId);
  h.set("originator", ORIGINATOR);
  h.set("user-agent", `${ORIGINATOR}/0.0.0 (${process.platform} ${process.arch})`);
  h.set("openai-beta", "responses=experimental");
  h.set("accept", "text/event-stream");
  h.set("content-type", "application/json");
  if (sessionId) {
    h.set("session_id", sessionId);
    h.set("x-client-request-id", sessionId);
  }
  return h;
}

// ----- url -----

function resolveCodexUrl(base?: string): string {
  const raw = (base ?? DEFAULT_BASE).replace(/\/+$/, "");
  if (raw.endsWith("/codex/responses")) return raw;
  if (raw.endsWith("/codex")) return `${raw}/responses`;
  return `${raw}/codex/responses`;
}

// ----- jwt account-id -----

export function extractAccountId(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("token is not a JWT — cannot extract chatgpt-account-id");
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(b64urlDecode(parts[1]!)) as Record<string, unknown>;
  } catch {
    throw new Error("token JWT payload is not valid JSON");
  }
  const auth = payload[JWT_AUTH_CLAIM] as { chatgpt_account_id?: string } | undefined;
  if (!auth?.chatgpt_account_id) {
    throw new Error(`token missing claim "${JWT_AUTH_CLAIM}.chatgpt_account_id"`);
  }
  return auth.chatgpt_account_id;
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64);
}

// ----- SSE parsing -----

interface RawSSE {
  event?: string;
  data: string;
}

async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<RawSSE> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseSSEChunk(chunk);
        if (ev) yield ev;
      }
    }
    if (buf.trim()) {
      const ev = parseSSEChunk(buf);
      if (ev) yield ev;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSSEChunk(chunk: string): RawSSE | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of chunk.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (!dataLines.length) return null;
  return { event, data: dataLines.join("\n") };
}

// ----- map Responses API events to our CodexEvent -----

function mapResponsesEvent(raw: RawSSE): CodexEvent | null {
  if (raw.data === "[DONE]") return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.data) as Record<string, unknown>;
  } catch {
    return null;
  }

  const type = (parsed.type as string) ?? raw.event ?? "";

  // text deltas
  if (type === "response.output_text.delta") {
    const delta = parsed.delta as string | undefined;
    if (typeof delta === "string" && delta.length) return { type: "text-delta", text: delta };
    return null;
  }

  // function/tool call assembly — simplified: only emit on completion
  if (type === "response.output_item.done") {
    const item = parsed.item as
      | { type?: string; id?: string; name?: string; arguments?: string; call_id?: string }
      | undefined;
    if (item?.type === "function_call" && item.name && typeof item.arguments === "string") {
      return {
        type: "tool-call",
        call: {
          id: item.call_id ?? item.id ?? "",
          name: item.name,
          arguments: item.arguments,
        },
      };
    }
    return null;
  }

  if (type === "response.completed" || type === "response.done") {
    const r =
      (parsed.response as {
        status?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
          input_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number };
          output_tokens_details?: { reasoning_tokens?: number };
        };
      }) ?? {};
    const status = (r.status ?? "completed") as string;
    const usage = normalizeResponsesUsage(r.usage);
    return {
      type: "finish",
      reason:
        status === "incomplete"
          ? "incomplete"
          : status === "failed" || status === "cancelled"
          ? "error"
          : "stop",
      usage,
      raw: parsed.response,
    };
  }

  if (type === "response.failed" || type === "error") {
    return { type: "error", error: JSON.stringify(parsed) };
  }

  return null;
}

function normalizeResponsesUsage(
  usage:
    | {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        input_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number };
        output_tokens_details?: { reasoning_tokens?: number };
      }
    | undefined,
): TokenUsage | undefined {
  if (!usage) return undefined;
  const rawInput = finiteUsage(usage.input_tokens);
  const rawOutput = finiteUsage(usage.output_tokens);
  const cacheRead = finiteUsage(usage.input_tokens_details?.cached_tokens);
  const cacheWrite = finiteUsage(usage.input_tokens_details?.cache_creation_input_tokens);
  const reasoning = finiteUsage(usage.output_tokens_details?.reasoning_tokens);
  const input = Math.max(0, rawInput - cacheRead - cacheWrite);
  const output = Math.max(0, rawOutput - reasoning);
  return {
    input,
    output,
    reasoning,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    total: finiteUsage(usage.total_tokens) || input + output + reasoning + cacheRead + cacheWrite,
  };
}

function finiteUsage(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

// ----- helpers -----

async function safeText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "";
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
