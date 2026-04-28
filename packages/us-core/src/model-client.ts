/**
 * Provider-aware chat streaming.
 *
 * v1 only had `streamCodex`, so every selected model was sent to the
 * ChatGPT Codex endpoint. This layer keeps the small Codex client but
 * routes Claude models to Anthropic's Messages API.
 */
import {
  streamCodex,
  type ChatMessage,
  type CodexEvent,
  type ToolCall,
  type ToolDefinition,
  type TokenUsage,
} from "@unionstreet/ai-codex";
import {
  resolveAuthProfiles,
  type ApiKeyCred,
  type OAuthCred,
  type ProviderCred,
} from "./auth-profiles.ts";
import { sanitizeOpenAICompatBaseUrl } from "./base-url.ts";

export type ModelProvider = string;

export interface StreamModelOptions {
  profile: string;
  provider: ModelProvider;
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  sessionId?: string;
  textVerbosity?: "low" | "medium" | "high";
  signal?: AbortSignal;
}

export async function* streamModel(opts: StreamModelOptions): AsyncGenerator<CodexEvent> {
  if (process.env.US_STREAM_MODEL_STUB === "1") {
    yield* streamModelStub(opts);
    return;
  }

  const provider = normalizeProvider(opts.provider);
  if (provider === "codex") {
    const cred = await requireCred(opts.profile, "codex", "oauth");
    yield* streamCodex({
      token: cred.access,
      model: opts.model,
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools,
      sessionId: opts.sessionId,
      textVerbosity: opts.textVerbosity,
      signal: opts.signal,
    });
    return;
  }

  if (provider === "anthropic") {
    const cred = await requireAnthropicCred(opts.profile, opts.provider);
    yield* streamAnthropic({
      ...opts,
      cred,
    });
    return;
  }

  const openAICompatCred = await resolveOpenAICompatCred(opts.profile, opts.provider);
  if (openAICompatCred) {
    yield* streamOpenAICompat({
      ...opts,
      cred: openAICompatCred.cred,
      baseUrl: openAICompatCred.baseUrl,
    });
    return;
  }

  yield {
    type: "error",
    error: `provider "${opts.provider}" is configured, but no stream client is wired for it yet`,
  };
}

async function* streamModelStub(opts: StreamModelOptions): AsyncGenerator<CodexEvent> {
  const failProviders = new Set((process.env.US_STREAM_MODEL_STUB_FAIL_PROVIDER ?? "").split(",").map((p) => p.trim()).filter(Boolean));
  if (failProviders.has(opts.provider) || failProviders.has(`${opts.provider}/${opts.model}`)) {
    yield { type: "error", error: `stub retryable 503 from ${opts.provider}/${opts.model}` };
    return;
  }

  const lastUser = [...opts.messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const hasToolResult = opts.messages.some((message) => message.role === "tool");
  if (/use\s+ls\s+tool/i.test(lastUser) && !hasToolResult) {
    yield {
      type: "tool-call",
      call: {
        id: "stub_tool_ls",
        name: "ls",
        arguments: JSON.stringify({ path: "." }),
      },
    };
    yield { type: "finish", reason: "tool_calls", usage: stubUsage() };
    return;
  }

  const text = hasToolResult
    ? `stub response from ${opts.provider}/${opts.model} after tool result`
    : `stub response from ${opts.provider}/${opts.model}: ${lastUser}`;
  for (const chunk of text.match(/.{1,24}/g) ?? [text]) {
    yield { type: "text-delta", text: chunk };
  }
  yield { type: "finish", reason: "stop", usage: stubUsage() };
}

function stubUsage(): TokenUsage {
  return { input: 1, output: 1, reasoning: 0, cache_read: 0, cache_write: 0, total: 2 };
}

export function normalizeProvider(provider: string | undefined): "codex" | "anthropic" | string {
  switch (provider) {
    case undefined:
    case "":
    case "codex":
    case "openai-codex":
      return "codex";
    case "claude":
    case "anthropic":
    case "anthropic-oauth":
      return "anthropic";
    default:
      return provider;
  }
}

async function requireCred(
  profile: string,
  key: string,
  kind?: ProviderCred["kind"],
): Promise<ProviderCred & { kind: "oauth" }> {
  const auth = await resolveAuthProfiles(profile);
  const cred = auth.merged.providers[key];
  if (!cred) throw new Error(`no auth credential for provider "${key}"`);
  if (kind && cred.kind !== kind) throw new Error(`provider "${key}" uses ${cred.kind}; expected ${kind}`);
  if (cred.kind === "oauth" && cred.expires < Date.now()) {
    throw new Error(`provider "${key}" token is expired; re-run auth`);
  }
  return cred as ProviderCred & { kind: "oauth" };
}

async function requireAnthropicCred(profile: string, configuredProvider: string): Promise<ProviderCred> {
  const auth = await resolveAuthProfiles(profile);
  const keys =
    configuredProvider === "anthropic"
      ? ["anthropic", "claude"]
      : ["claude", "anthropic"];
  for (const key of keys) {
    const cred = auth.merged.providers[key];
    if (!cred) continue;
    if (cred.kind === "oauth" && cred.expires < Date.now()) {
      throw new Error(`provider "${key}" token is expired; re-run auth`);
    }
    return cred;
  }
  throw new Error(`no Claude/Anthropic auth found; run \`us-dev auth claude\` or add an Anthropic API key`);
}

interface StreamAnthropicOptions extends StreamModelOptions {
  cred: ProviderCred;
}

interface OpenAICompatResolved {
  cred: ApiKeyCred;
  baseUrl: string;
}

const OPENAI_COMPAT_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  together: "https://api.together.xyz/v1",
  cerebras: "https://api.cerebras.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  perplexity: "https://api.perplexity.ai",
  xai: "https://api.x.ai/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  "opencode-zen": "https://api.opencode.ai/v1",
  "vercel-ai-gateway": "https://gateway.ai.vercel.ai/v1",
};

async function resolveOpenAICompatCred(
  profile: string,
  provider: string,
): Promise<OpenAICompatResolved | undefined> {
  const auth = await resolveAuthProfiles(profile);
  const cred = auth.merged.providers[provider];
  if (!cred || cred.kind !== "api_key") return undefined;
  const baseKey = providerBaseKey(provider);
  const baseUrl = sanitizeOpenAICompatBaseUrl(cred.base_url ?? OPENAI_COMPAT_BASE[baseKey] ?? "");
  if (!baseUrl) return undefined;
  return { cred, baseUrl };
}

function providerBaseKey(provider: string): string {
  return provider.startsWith("custom-openai-compat:") ? "custom-openai-compat" : provider;
}

interface StreamOpenAICompatOptions extends StreamModelOptions {
  cred: ApiKeyCred;
  baseUrl: string;
}

async function* streamOpenAICompat(opts: StreamOpenAICompatOptions): AsyncGenerator<CodexEvent> {
  const body = buildOpenAICompatBody(opts);
  let response: Response | undefined;
  let url = "";
  try {
    for (const candidate of openAICompatChatUrls(opts.baseUrl)) {
      url = candidate;
      response = await fetch(candidate, {
        method: "POST",
        headers: openAICompatHeaders(opts),
        body: JSON.stringify(body),
        signal: opts.signal,
      });
      if (response.ok || response.status !== 404) break;
    }
  } catch (e) {
    yield { type: "error", error: `network: ${(e as Error).message}` };
    return;
  }

  if (!response || !response.ok || !response.body) {
    const text = response ? await safeText(response) : "";
    yield {
      type: "error",
      error: response
        ? `http ${response.status}: ${truncate(text, 500)}`
        : "no OpenAI-compatible request attempted",
    };
    return;
  }

  const tools = new Map<number, ToolCall & { index: number }>();
  let finishReason: "stop" | "tool_calls" | "incomplete" | "error" = "stop";
  let usage: TokenUsage | undefined;

  for await (const raw of parseSSE(response.body)) {
    if (raw.data === "[DONE]") continue;
    let event: Record<string, any>;
    try {
      event = JSON.parse(raw.data) as Record<string, any>;
    } catch {
      continue;
    }

    usage = openAIUsage(event.usage) ?? usage;
    const choice = event.choices?.[0];
    const delta = choice?.delta;
    if (typeof delta?.content === "string" && delta.content.length) {
      yield { type: "text-delta", text: delta.content };
    }

    for (const tc of delta?.tool_calls ?? []) {
      const index = Number(tc.index ?? 0);
      const existing =
        tools.get(index) ??
        {
          index,
          id: String(tc.id ?? ""),
          name: "",
          arguments: "",
        };
      if (tc.id) existing.id = String(tc.id);
      if (tc.function?.name) existing.name = String(tc.function.name);
      if (tc.function?.arguments) existing.arguments += String(tc.function.arguments);
      tools.set(index, existing);
    }

    const rawFinish = String(choice?.finish_reason ?? "");
    if (rawFinish === "tool_calls") finishReason = "tool_calls";
    else if (rawFinish === "length") finishReason = "incomplete";
    else if (rawFinish) finishReason = "stop";
  }

  for (const call of [...tools.values()].sort((a, b) => a.index - b.index)) {
    yield {
      type: "tool-call",
      call: {
        id: call.id,
        name: call.name,
        arguments: call.arguments || "{}",
      },
    };
  }

  yield {
    type: "finish",
    reason: tools.size > 0 ? "tool_calls" : finishReason,
    usage,
  };
}

function openAICompatChatUrls(baseUrl: string): string[] {
  const base = baseUrl.replace(/\/+$/, "");
  const urls = [`${base}/chat/completions`];
  if (!base.endsWith("/v1")) urls.push(`${base}/v1/chat/completions`);
  return urls;
}

function openAICompatHeaders(opts: StreamOpenAICompatOptions): Headers {
  const h = new Headers();
  h.set("authorization", `Bearer ${opts.cred.api_key}`);
  h.set("accept", "text/event-stream");
  h.set("content-type", "application/json");
  if (opts.provider === "openrouter") {
    h.set("HTTP-Referer", "https://unionstreet.ai");
    h.set("X-Title", "Union Street");
  }
  return h;
}

function buildOpenAICompatBody(opts: StreamOpenAICompatOptions): Record<string, unknown> {
  return {
    model: opts.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: convertOpenAICompatMessages(opts.messages, opts.system),
    ...(opts.tools?.length ? { tools: convertOpenAICompatTools(opts.tools), tool_choice: "auto" } : {}),
  };
}

function convertOpenAICompatMessages(
  messages: ChatMessage[],
  system?: string,
): unknown[] {
  const out: unknown[] = [];
  const systemText = system ?? messages.find((m) => m.role === "system")?.content;
  if (systemText) out.push({ role: "system", content: systemText });

  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content ?? null,
        ...(m.tool_calls?.length ? { tool_calls: m.tool_calls.map(openAIToolCall) } : {}),
      });
    } else if (m.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: m.tool_call_id,
        content: m.content,
      });
    }
  }
  return out;
}

function openAIToolCall(call: ToolCall): unknown {
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: call.arguments,
    },
  };
}

function convertOpenAICompatTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

function openAIUsage(raw: any): TokenUsage | undefined {
  if (!raw) return undefined;
  const rawInput = finiteUsage(raw.prompt_tokens ?? raw.input_tokens);
  const rawOutput = finiteUsage(raw.completion_tokens ?? raw.output_tokens);
  const cacheRead = finiteUsage(raw.prompt_tokens_details?.cached_tokens ?? raw.input_tokens_details?.cached_tokens);
  const cacheWrite = finiteUsage(
    raw.prompt_tokens_details?.cache_creation_input_tokens
      ?? raw.input_tokens_details?.cache_creation_input_tokens
      ?? raw.prompt_tokens_details?.cache_write_tokens
      ?? raw.input_tokens_details?.cache_write_tokens,
  );
  const reasoning = finiteUsage(
    raw.completion_tokens_details?.reasoning_tokens
      ?? raw.output_tokens_details?.reasoning_tokens,
  );
  const input = Math.max(0, rawInput - cacheRead - cacheWrite);
  const output = Math.max(0, rawOutput - reasoning);
  return {
    input,
    output,
    reasoning,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    total: finiteUsage(raw.total_tokens) || input + output + reasoning + cacheRead + cacheWrite,
  };
}

async function* streamAnthropic(opts: StreamAnthropicOptions): AsyncGenerator<CodexEvent> {
  const url = `${anthropicBaseUrl(opts.cred).replace(/\/+$/, "")}/v1/messages`;
  const body = buildAnthropicBody(opts);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: anthropicHeaders(opts.cred),
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

  let currentTool:
    | {
        id: string;
        name: string;
        json: string;
      }
    | undefined;
  let finishReason: "stop" | "tool_calls" | "incomplete" | "error" = "stop";
  let usage: TokenUsage | undefined;

  for await (const raw of parseSSE(response.body)) {
    if (raw.data === "[DONE]") continue;
    let event: Record<string, any>;
    try {
      event = JSON.parse(raw.data) as Record<string, any>;
    } catch {
      continue;
    }

    if (event.type === "message_start") {
      usage = anthropicUsage(event.message?.usage);
      continue;
    }

    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (block?.type === "tool_use") {
        currentTool = {
          id: String(block.id ?? ""),
          name: String(block.name ?? ""),
          json: block.input ? JSON.stringify(block.input) : "",
        };
      }
      continue;
    }

    if (event.type === "content_block_delta") {
      const delta = event.delta;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        yield { type: "text-delta", text: delta.text };
      } else if (delta?.type === "input_json_delta" && currentTool) {
        currentTool.json += String(delta.partial_json ?? "");
      }
      continue;
    }

    if (event.type === "content_block_stop" && currentTool) {
      yield {
        type: "tool-call",
        call: {
          id: currentTool.id,
          name: currentTool.name,
          arguments: currentTool.json || "{}",
        },
      };
      currentTool = undefined;
      continue;
    }

    if (event.type === "message_delta") {
      usage = mergeAnthropicUsage(usage, event.usage);
      const stopReason = String(event.delta?.stop_reason ?? "");
      if (stopReason === "tool_use") finishReason = "tool_calls";
      else if (stopReason === "max_tokens") finishReason = "incomplete";
      else if (stopReason) finishReason = "stop";
      continue;
    }

    if (event.type === "error") {
      yield { type: "error", error: JSON.stringify(event.error ?? event) };
      return;
    }
  }

  yield {
    type: "finish",
    reason: finishReason,
    usage,
  };
}

function anthropicBaseUrl(cred: ProviderCred): string {
  if (cred.kind === "api_key" && cred.base_url) return cred.base_url;
  return "https://api.anthropic.com";
}

function anthropicHeaders(cred: ProviderCred): Headers {
  const h = new Headers();
  h.set("accept", "text/event-stream");
  h.set("content-type", "application/json");
  h.set("anthropic-version", "2023-06-01");
  h.set("anthropic-dangerous-direct-browser-access", "true");

  if (cred.kind === "oauth") {
    h.set("authorization", `Bearer ${(cred as OAuthCred).access}`);
    h.set("anthropic-beta", "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14");
    h.set("user-agent", "claude-cli/1.0.0");
    h.set("x-app", "cli");
  } else {
    h.set("x-api-key", (cred as ApiKeyCred).api_key);
    h.set("anthropic-beta", "fine-grained-tool-streaming-2025-05-14");
  }
  return h;
}

function buildAnthropicBody(opts: StreamAnthropicOptions): Record<string, unknown> {
  const system = opts.cred.kind === "oauth"
    ? [
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
        ...(opts.system ? [{ type: "text", text: opts.system }] : []),
      ]
    : opts.system
    ? [{ type: "text", text: opts.system }]
    : undefined;

  return {
    model: opts.model,
    max_tokens: 8192,
    stream: true,
    ...(system ? { system } : {}),
    messages: convertAnthropicMessages(opts.messages),
    ...(opts.tools?.length ? { tools: convertAnthropicTools(opts.tools), tool_choice: { type: "auto" } } : {}),
  };
}

function convertAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const out: Array<{ role: "user" | "assistant"; content: unknown[] | string }> = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.push({ role: "user", content: m.content || " " });
      continue;
    }
    if (m.role === "assistant") {
      const content: unknown[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const call of m.tool_calls ?? []) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: parseToolArgs(call.arguments),
        });
      }
      out.push({ role: "assistant", content: content.length ? content : " " });
      continue;
    }
    if (m.role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id,
            content: m.content,
          },
        ],
      });
    }
  }
  return out;
}

function convertAnthropicTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

function parseToolArgs(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function anthropicUsage(raw: any): TokenUsage | undefined {
  if (!raw) return undefined;
  const rawInput = finiteUsage(raw.input_tokens);
  const output = finiteUsage(raw.output_tokens);
  const cacheRead = finiteUsage(raw.cache_read_input_tokens);
  const cacheWrite = finiteUsage(raw.cache_creation_input_tokens)
    + finiteUsage(raw.cache_creation?.ephemeral_5m_input_tokens)
    + finiteUsage(raw.cache_creation?.ephemeral_1h_input_tokens);
  const input = Math.max(0, rawInput - cacheRead - cacheWrite);
  return {
    input,
    output,
    reasoning: 0,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

function mergeAnthropicUsage(prev: TokenUsage | undefined, raw: any): TokenUsage | undefined {
  const next = anthropicUsage(raw);
  if (!next) return prev;
  if (!prev) return next;
  const input = Math.max(prev.input, next.input);
  const output = Math.max(prev.output, next.output);
  const reasoning = Math.max(prev.reasoning ?? 0, next.reasoning ?? 0);
  const cacheRead = Math.max(prev.cache_read ?? 0, next.cache_read ?? 0);
  const cacheWrite = Math.max(prev.cache_write ?? 0, next.cache_write ?? 0);
  return {
    input,
    output,
    reasoning,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite,
  };
}

function finiteUsage(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

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
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (!dataLines.length) return null;
  return { event, data: dataLines.join("\n") };
}

async function safeText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "";
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}...`;
}
