import { describe, expect, test } from "bun:test";
import { sanitizeOpenAICompatBaseUrl } from "./base-url.ts";

describe("sanitizeOpenAICompatBaseUrl", () => {
  test("sanitizeOpenAICompatBaseUrl_WhenHostHasNoScheme_ReturnsHttpsRoot", () => {
    const rawProviderUrl = "gemma.thurgood.cloud";

    const sanitizedUrl = sanitizeOpenAICompatBaseUrl(rawProviderUrl);

    expect(
      sanitizedUrl,
      "A pasted OpenAI-compatible host without a scheme must still become a callable HTTPS base URL.",
    ).toBe("https://gemma.thurgood.cloud");
  });

  test("sanitizeOpenAICompatBaseUrl_WhenUrlPointsAtDiscoveryEndpoint_ReturnsStableV1Root", () => {
    const providerModelDiscoveryUrl = "https://gemma.thurgood.cloud/v1/models?x=1";
    const providerChatCompletionUrl = "https://api.example.com/v1/chat/completions";

    const discoveryRoot = sanitizeOpenAICompatBaseUrl(providerModelDiscoveryUrl);
    const chatRoot = sanitizeOpenAICompatBaseUrl(providerChatCompletionUrl);

    expect(
      discoveryRoot,
      "Model discovery URLs must be normalized to the provider root so later /models calls do not double-append paths or query strings.",
    ).toBe("https://gemma.thurgood.cloud/v1");
    expect(
      chatRoot,
      "Chat completion URLs must be normalized to the /v1 root so response/client code can choose the endpoint intentionally.",
    ).toBe("https://api.example.com/v1");
  });
});
