import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const usHome = await mkdtemp(join(tmpdir(), "union-street-model-client-test-"));
process.env.US_HOME = usHome;

const {
  GLOBAL_AUTH_PROFILES_PATH,
  normalizeProvider,
  streamModel,
  updateAuthProfiles,
} = await import("./index.ts");

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.US_STREAM_MODEL_STUB = "0";
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
});

describe("model client", () => {
  test("normalizeProvider_WhenAliasesAreProvided_ReturnsCanonicalProviderRoutes", () => {
    const aliases = [
      normalizeProvider(undefined),
      normalizeProvider(""),
      normalizeProvider("openai-codex"),
      normalizeProvider("claude"),
      normalizeProvider("anthropic-oauth"),
      normalizeProvider("custom-openai-compat:local"),
    ];

    expect(
      aliases,
      "Provider normalization must keep legacy Codex/Claude aliases working while preserving custom OpenAI-compatible provider ids.",
    ).toEqual(["codex", "codex", "codex", "anthropic", "anthropic", "custom-openai-compat:local"]);
  });

  test("streamModel_WhenOpenAICompatStreamReturnsUsage_NormalizesToolCallsAndTokenBuckets", async () => {
    await updateAuthProfiles(GLOBAL_AUTH_PROFILES_PATH, (current) => ({
      ...current,
      providers: {
        ...current.providers,
        "custom-openai-compat:test": {
          kind: "api_key",
          api_key: "test-key",
          base_url: "https://llm.example.com/api",
        },
      },
    }));
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (url, init) => {
      requestedUrls.push(String(url));
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      expect(body.model, "OpenAI-compatible requests must pass through the selected model id without rewriting it.").toBe("test-model");
      expect(body.stream_options, "OpenAI-compatible streams must request final usage frames for accounting.").toEqual({ include_usage: true });
      return sseResponse([
        {
          choices: [{ delta: { content: "hello " } }],
        },
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call-1",
                function: { name: "lookup", arguments: "{\"q\"" },
              }],
            },
          }],
        },
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: ":\"docs\"}" },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 40,
            total_tokens: 140,
            prompt_tokens_details: { cached_tokens: 25, cache_creation_input_tokens: 5 },
            completion_tokens_details: { reasoning_tokens: 7 },
          },
        },
        "[DONE]",
      ]);
    }) as typeof fetch;

    const events = await collect(streamModel({
      profile: "coo",
      provider: "custom-openai-compat:test",
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
    }));

    expect(requestedUrls, "A sanitized custom base URL should be used as the OpenAI-compatible chat completions root.").toEqual(["https://llm.example.com/api/chat/completions"]);
    expect(
      events,
      "OpenAI-compatible streaming should emit text, assembled tool calls, and a final usage payload normalized like opencode.",
    ).toEqual([
      { type: "text-delta", text: "hello " },
      { type: "tool-call", call: { id: "call-1", name: "lookup", arguments: "{\"q\":\"docs\"}" } },
      {
        type: "finish",
        reason: "tool_calls",
        usage: { input: 70, output: 33, reasoning: 7, cache_read: 25, cache_write: 5, total: 140 },
      },
    ]);
  });

  test("streamModel_WhenOpenAICompatRoot404s_RetriesV1ChatCompletions", async () => {
    await updateAuthProfiles(GLOBAL_AUTH_PROFILES_PATH, (current) => ({
      ...current,
      providers: {
        ...current.providers,
        "custom-openai-compat:retry": {
          kind: "api_key",
          api_key: "test-key",
          base_url: "https://retry.example.com",
        },
      },
    }));
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (url) => {
      requestedUrls.push(String(url));
      if (requestedUrls.length === 1) return new Response("not found", { status: 404 });
      return sseResponse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }, "[DONE]"]);
    }) as typeof fetch;

    const events = await collect(streamModel({
      profile: "coo",
      provider: "custom-openai-compat:retry",
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
    }));

    expect(
      requestedUrls,
      "Providers that expose only /v1/chat/completions should still work when the user saved the host root.",
    ).toEqual([
      "https://retry.example.com/chat/completions",
      "https://retry.example.com/v1/chat/completions",
    ]);
    expect(events.at(-1), "A successful retry should still finish normally rather than surfacing the initial 404.").toEqual({
      type: "finish",
      reason: "stop",
      usage: undefined,
    });
  });

  test("streamModel_WhenAnthropicStreamReturnsUsage_NormalizesCacheCreationAndToolUse", async () => {
    await updateAuthProfiles(GLOBAL_AUTH_PROFILES_PATH, (current) => ({
      ...current,
      providers: {
        ...current.providers,
        anthropic: {
          kind: "api_key",
          api_key: "anthropic-key",
          base_url: "https://anthropic.example.com",
        },
      },
    }));
    globalThis.fetch = (async (url, init) => {
      expect(String(url), "Anthropic provider should use the configured API base URL and /v1/messages endpoint.").toBe("https://anthropic.example.com/v1/messages");
      const headers = init?.headers as Headers;
      expect(headers.get("x-api-key"), "Anthropic API-key auth must be sent in x-api-key, not Bearer auth.").toBe("anthropic-key");
      return sseResponse([
        {
          type: "message_start",
          message: { usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 } },
        },
        {
          type: "content_block_start",
          content_block: { type: "tool_use", id: "toolu-1", name: "search", input: { q: "x" } },
        },
        {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: "{\"extra\":true}" },
        },
        { type: "content_block_stop" },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 25 },
        },
      ]);
    }) as typeof fetch;

    const events = await collect(streamModel({
      profile: "coo",
      provider: "anthropic",
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
    }));

    expect(events, "Anthropic streaming should emit tool use and merged cache-aware usage.").toEqual([
      { type: "tool-call", call: { id: "toolu-1", name: "search", arguments: "{\"q\":\"x\"}{\"extra\":true}" } },
      {
        type: "finish",
        reason: "tool_calls",
        usage: { input: 50, output: 25, reasoning: 0, cache_read: 40, cache_write: 10, total: 125 },
      },
    ]);
  });

  test("streamModel_WhenProviderHasNoCredential_EmitsConfiguredButUnwiredError", async () => {
    const events = await collect(streamModel({
      profile: "coo",
      provider: "custom-openai-compat:missing",
      model: "missing-model",
      messages: [{ role: "user", content: "hi" }],
    }));

    expect(
      events,
      "Unknown providers must fail explicitly instead of falling back to Codex or silently using another credential.",
    ).toEqual([{
      type: "error",
      error: 'provider "custom-openai-compat:missing" is configured, but no stream client is wired for it yet',
    }]);
  });

  test("streamModel_WhenOpenAICompatProviderReturnsRateLimit_EmitsTruncatedHttpError", async () => {
    await updateAuthProfiles(GLOBAL_AUTH_PROFILES_PATH, (current) => ({
      ...current,
      providers: {
        ...current.providers,
        "custom-openai-compat:rate-limit": {
          kind: "api_key",
          api_key: "rate-limit-key",
          base_url: "https://rate-limit.example.com/v1",
        },
      },
    }));
    globalThis.fetch = (async () => new Response("x".repeat(900), { status: 429 })) as unknown as typeof fetch;

    const events = await collect(streamModel({
      profile: "coo",
      provider: "custom-openai-compat:rate-limit",
      model: "rate-limited-model",
      messages: [{ role: "user", content: "hi" }],
    }));

    expect(events[0]?.type, "Provider 429s must surface as model error events, not thrown process errors.").toBe("error");
    expect(
      (events[0] as { error?: string }).error,
      "HTTP provider errors should be truncated so logs do not balloon or echo entire upstream bodies.",
    ).toBe(`http 429: ${"x".repeat(500)}...`);
  });

  test("streamModel_WhenOpenAICompatFetchThrows_EmitsNetworkError", async () => {
    await updateAuthProfiles(GLOBAL_AUTH_PROFILES_PATH, (current) => ({
      ...current,
      providers: {
        ...current.providers,
        "custom-openai-compat:network": {
          kind: "api_key",
          api_key: "network-key",
          base_url: "https://network.example.com/v1",
        },
      },
    }));
    globalThis.fetch = (async () => {
      throw new Error("socket closed");
    }) as unknown as typeof fetch;

    const events = await collect(streamModel({
      profile: "coo",
      provider: "custom-openai-compat:network",
      model: "network-model",
      messages: [{ role: "user", content: "hi" }],
    }));

    expect(
      events,
      "Network failures must be self-validating model error events so fallback logic can decide whether to retry another model.",
    ).toEqual([{ type: "error", error: "network: socket closed" }]);
  });

  test("streamModel_WhenAnthropicOAuthCredentialIsExpired_RejectsBeforeFetch", async () => {
    await updateAuthProfiles(GLOBAL_AUTH_PROFILES_PATH, (current) => ({
      ...current,
      providers: {
        ...current.providers,
        anthropic: {
          kind: "oauth",
          provider: "anthropic",
          access: "expired-access",
          refresh: "expired-refresh",
          expires: Date.now() - 1_000,
        },
      },
    }));
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;

    await expect(
      collect(streamModel({
        profile: "coo",
        provider: "anthropic",
        model: "claude-expired",
        messages: [{ role: "user", content: "hi" }],
      })),
      "Expired OAuth credentials should fail before making a provider request.",
    ).rejects.toThrow("token is expired");
    expect(fetchCalled, "Expired OAuth credentials must not be sent over the network.").toBe(false);
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function sseResponse(events: Array<Record<string, unknown> | string>): Response {
  const text = events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
  return new Response(new TextEncoder().encode(text), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
