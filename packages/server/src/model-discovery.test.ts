import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const usHome = await mkdtemp(join(tmpdir(), "union-street-model-discovery-test-"));
process.env.US_HOME = usHome;

const {
  GLOBAL_AUTH_PROFILES_PATH,
  discoverModelGroups,
  updateAuthProfiles,
} = await import("./index.ts");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await rm(usHome, { recursive: true, force: true });
});

describe("model discovery", () => {
  test("discoverModelGroups_WhenProfileHasAuthedProviders_ReturnsTuiOrderedSearchableGroupsFromLiveAndRegistrySources", async () => {
    await updateAuthProfiles(GLOBAL_AUTH_PROFILES_PATH, (current) => ({
      ...current,
      providers: {
        codex: {
          kind: "oauth",
          provider: "openai-codex",
          access: fakeChatGptToken("acct-test"),
          refresh: "codex-refresh-token",
          expires: Date.now() + 60_000,
        },
        claude: {
          kind: "oauth",
          provider: "anthropic",
          access: "claude-access-token",
          refresh: "claude-refresh-token",
          expires: Date.now() + 60_000,
        },
        "custom-openai-compat:gemma-thurgood-cloud": {
          kind: "api_key",
          api_key: "sk-test",
          base_url: "https://gemma.thurgood.cloud/v1/chat/completions",
        },
      },
    }));
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (url) => {
      requestedUrls.push(String(url));
      if (String(url).includes("models.dev/api.json")) {
        return Response.json({
          anthropic: {
            id: "anthropic",
            name: "Anthropic",
            models: {
              "claude-opus-4-7": { id: "claude-opus-4-7", name: "Claude Opus 4.7", limit: { context: 200_000 } },
            },
          },
        });
      }
      if (String(url).includes("/codex/models")) {
        return Response.json({
          models: [
            { slug: "gpt-hidden", visibility: "hidden", priority: 0 },
            { slug: "gpt-5.4", display_name: "GPT 5.4", description: "default", visibility: "list", priority: 1, context_window: 400_000 },
          ],
        });
      }
      if (String(url) === "https://gemma.thurgood.cloud/v1/models") {
        return Response.json({
          data: [
            { id: "google/gemma-4-31B-it", name: "Gemma 4 31B IT", owned_by: "thurgood", context_length: 128_000 },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const groups = await discoverModelGroups({ profile: "coo" });

    expect(
      groups.map((group) => group.id),
      "Model discovery must use the same provider ordering as the TUI: Codex/OpenAI first, Anthropic second, then custom providers.",
    ).toEqual(["openai-codex", "claude", "custom-openai-compat:gemma-thurgood-cloud"]);
    expect(
      groups[0]?.models.map((model) => model.id),
      "Codex discovery must use the live authenticated /codex/models response and filter hidden models.",
    ).toEqual(["gpt-5.4"]);
    expect(
      groups[1]?.models.map((model) => model.id),
      "OAuth providers without a native live enumerator must still use models.dev registry data so the picker is not empty.",
    ).toEqual(["claude-opus-4-7"]);
    expect(
      groups[2],
      "Custom OpenAI-compatible providers must be labeled from their sanitized base URL and populated from their live /models endpoint.",
    ).toMatchObject({
      label: "Thurgood Gemma",
      state: "live",
      models: [{ id: "google/gemma-4-31B-it", display_name: "Gemma 4 31B IT", context_window: 128_000 }],
    });
    expect(
      requestedUrls,
      "Discovery must sanitize pasted chat-completions URLs before appending /models.",
    ).toContain("https://gemma.thurgood.cloud/v1/models");
  });

  test("discoverModelGroups_WhenCustomProviderModelsEndpointFails_ReturnsHardErrorGroupWithoutLeakingSecrets", async () => {
    await updateAuthProfiles(GLOBAL_AUTH_PROFILES_PATH, (current) => ({
      ...current,
      providers: {
        "custom-openai-compat:offline": {
          kind: "api_key",
          api_key: "sk-super-secret",
          base_url: "https://offline.example.test/v1",
        },
      },
    }));
    globalThis.fetch = (async (url) => {
      if (String(url).includes("models.dev/api.json")) return Response.json({});
      return new Response("upstream down", { status: 503 });
    }) as typeof fetch;

    const groups = await discoverModelGroups({ profile: "coo" });

    expect(groups, "An authed but unreachable custom provider should still appear so operators can see what is configured.").toHaveLength(1);
    expect(groups[0]?.state, "The picker must distinguish failed discovery from an empty successful model list.").toBe("error");
    expect(
      JSON.stringify(groups),
      "Model discovery responses must never include provider API keys or OAuth tokens.",
    ).not.toContain("sk-super-secret");
  });
});

function fakeChatGptToken(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}
