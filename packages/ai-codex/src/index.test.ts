import { describe, expect, test } from "bun:test";
import { defaultCodexModel, extractAccountId, findCodexModel, listCodexModels, listOpenAIModels, streamCodex } from "./index.ts";

describe("Codex Responses transport", () => {
  test("extractAccountId_WhenTokenHasChatGptAccountClaim_ReturnsAccountId", () => {
    const token = jwtWithPayload({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } });

    const accountId = extractAccountId(token);

    expect(accountId, "Codex requests must derive chatgpt-account-id from the OAuth JWT claim.").toBe("acct_123");
  });

  test("extractAccountId_WhenTokenIsMalformed_ThrowsActionableError", () => {
    const token = "not-a-jwt";

    const act = () => extractAccountId(token);

    expect(act, "Malformed tokens should fail before making a network request.").toThrow("token is not a JWT");
  });

  test("streamCodex_WhenResponsesApiStreamsTextToolAndUsage_EmitsNormalizedEventsAndSendsExpectedRequest", async () => {
    const token = jwtWithPayload({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_stream" } });
    const calls: Array<{ url: string; headers: Headers; body: any }> = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: init?.headers as Headers,
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return sseResponse([
        { type: "response.output_text.delta", delta: "hello " },
        {
          type: "response.output_item.done",
          item: { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{\"q\":\"docs\"}" },
        },
        {
          type: "response.completed",
          response: {
            status: "completed",
            usage: {
              input_tokens: 100,
              output_tokens: 40,
              total_tokens: 140,
              input_tokens_details: { cached_tokens: 20, cache_creation_input_tokens: 5 },
              output_tokens_details: { reasoning_tokens: 7 },
            },
          },
        },
        "[DONE]",
      ]);
    };

    const events = await collect(streamCodex({
      token,
      model: "gpt-5.4",
      system: "system wins",
      messages: [
        { role: "system", content: "ignored because explicit system was supplied" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "prior", tool_calls: [{ id: "old-call", name: "old", arguments: "{}" }] },
        { role: "tool", tool_call_id: "old-call", content: "old result" },
      ],
      tools: [{ type: "function", name: "lookup", description: "Search", parameters: { type: "object" }, strict: true }],
      sessionId: "session-1",
      baseUrl: "https://chatgpt.example.test/backend-api",
      fetch: fetcher as typeof fetch,
    }));

    expect(calls[0]?.url, "The Codex client should append /codex/responses to backend roots.").toBe("https://chatgpt.example.test/backend-api/codex/responses");
    expect(calls[0]?.headers.get("authorization"), "Codex requests must use OAuth bearer auth.").toBe(`Bearer ${token}`);
    expect(calls[0]?.headers.get("chatgpt-account-id"), "Codex requests must include the derived ChatGPT account id.").toBe("acct_stream");
    expect(calls[0]?.headers.get("session_id"), "Session id should be forwarded for cache affinity.").toBe("session-1");
    expect(calls[0]?.body.instructions, "Explicit system prompt should win over system messages.").toBe("system wins");
    expect(calls[0]?.body.input, "Messages should be converted to Responses input items without leaking system messages into input.").toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "prior" }] },
      { type: "function_call", call_id: "old-call", name: "old", arguments: "{}" },
      { type: "function_call_output", call_id: "old-call", output: "old result" },
    ]);
    expect(events, "Responses streaming should normalize text deltas, completed tool calls, and cache-aware token buckets.").toEqual([
      { type: "text-delta", text: "hello " },
      { type: "tool-call", call: { id: "call-1", name: "lookup", arguments: "{\"q\":\"docs\"}" } },
      {
        type: "finish",
        reason: "stop",
        usage: { input: 75, output: 33, reasoning: 7, cache_read: 20, cache_write: 5, total: 140 },
        raw: {
          status: "completed",
          usage: {
            input_tokens: 100,
            output_tokens: 40,
            total_tokens: 140,
            input_tokens_details: { cached_tokens: 20, cache_creation_input_tokens: 5 },
            output_tokens_details: { reasoning_tokens: 7 },
          },
        },
      },
    ]);
  });

  test("streamCodex_WhenHttpFails_EmitsTruncatedHttpError", async () => {
    const token = jwtWithPayload({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_error" } });
    const fetcher = async () => new Response("x".repeat(600), { status: 500 });

    const events = await collect(streamCodex({
      token,
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hi" }],
      fetch: fetcher as typeof fetch,
    }));

    expect(events, "HTTP failures should surface as a single self-validating error event.").toHaveLength(1);
    expect(events[0]?.type, "HTTP failures should not masquerade as model completions.").toBe("error");
    expect(events[0]?.type === "error" ? events[0].error : "", "HTTP error bodies should be truncated to keep logs readable.").toContain("http 500:");
  });
});

describe("model discovery", () => {
  test("defaultCodexModel_WhenRecommendedModelExists_ReturnsRecommendedModel", () => {
    const model = defaultCodexModel();

    expect(model, "The default model should be the one explicitly marked recommended for stable pickers.").toBe("gpt-5.4");
    expect(findCodexModel(model)?.recommended, "The returned default must correspond to a known model entry.").toBe(true);
  });

  test("listCodexModels_WhenBackendReturnsMixedVisibility_SortsAndFiltersListModels", async () => {
    const token = jwtWithPayload({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_models" } });
    const requestedUrls: string[] = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrls.push(String(url));
      expect((init?.headers as Record<string, string>).authorization, "Codex model discovery must use the bearer token.").toBe(`Bearer ${token}`);
      return Response.json({
        models: [
          { slug: "hidden", display_name: "Hidden", visibility: "internal", priority: 0 },
          { slug: "second", display_name: "Second", description: "two", visibility: "list", priority: 20 },
          { slug: "first", display_name: "First", context_window: 128000, visibility: "list", priority: 10 },
        ],
      });
    };

    const models = await listCodexModels({ token, baseUrl: "https://chatgpt.example.test/backend-api/", clientVersion: "1.2.3", fetch: fetcher as typeof fetch });

    expect(requestedUrls, "Model discovery should hit the Codex models endpoint with encoded client version.").toEqual([
      "https://chatgpt.example.test/backend-api/codex/models?client_version=1.2.3",
    ]);
    expect(models.map((model) => model.id), "Only list-visible models should be returned in backend priority order.").toEqual(["first", "second"]);
    expect(models[0]?.context_window, "Rich model metadata should survive projection for model pickers.").toBe(128000);
  });

  test("listOpenAIModels_WhenRootModels404s_RetriesV1Models", async () => {
    const requestedUrls: string[] = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrls.push(String(url));
      expect((init?.headers as Record<string, string>).authorization, "OpenAI-compatible discovery must use bearer API-key auth.").toBe("Bearer sk-test");
      if (requestedUrls.length === 1) return new Response("not found", { status: 404 });
      return Response.json({ data: [{ id: "gemma", owned_by: "local", context_length: 32000 }] });
    };

    const models = await listOpenAIModels({ baseUrl: "https://llm.example.test", apiKey: "sk-test", fetch: fetcher as typeof fetch });

    expect(requestedUrls, "OpenAI-compatible discovery should retry /v1/models when the saved root omits /v1.").toEqual([
      "https://llm.example.test/models",
      "https://llm.example.test/v1/models",
    ]);
    expect(models, "OpenAI-compatible models should be projected into the same display shape as Codex models.").toEqual([
      { id: "gemma", description: "local", display_name: "gemma", context_window: 32000, recommended: false },
    ]);
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

function sseResponse(events: Array<Record<string, unknown> | string>): Response {
  const text = events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
  return new Response(new TextEncoder().encode(text), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function jwtWithPayload(payload: Record<string, unknown>): string {
  return [
    base64Url(JSON.stringify({ alg: "none", typ: "JWT" })),
    base64Url(JSON.stringify(payload)),
    "sig",
  ].join(".");
}

function base64Url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
