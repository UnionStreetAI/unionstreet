import { describe, expect, test } from "bun:test";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth/oauth-page.ts";
import { generatePKCE } from "./oauth/pkce.ts";
import {
  getGitHubCopilotBaseUrl,
  getOAuthApiKey,
  getOAuthProvider,
  getOAuthProviderInfoList,
  getOAuthProviders,
  normalizeDomain,
  refreshOAuthToken,
  registerOAuthProvider,
  resetOAuthProviders,
  unregisterOAuthProvider,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type OAuthProviderInterface,
} from "./oauth/index.ts";

describe("OAuth provider registry", () => {
  test("getOAuthProviders_WhenRegistryIsReset_ReturnsBuiltInProviders", () => {
    resetOAuthProviders();

    const providers = getOAuthProviders().map((provider) => provider.id).sort();
    const info = getOAuthProviderInfoList().map((provider) => provider.id).sort();

    expect(
      providers,
      "The registry should expose every built-in provider needed by CLI auth status and provider pickers.",
    ).toEqual(["anthropic", "github-copilot", "google-antigravity", "google-gemini-cli", "openai-codex"]);
    expect(info, "Deprecated provider info should remain consistent with the main registry while older CLI code exists.").toEqual(providers);
  });

  test("registerOAuthProvider_WhenCustomProviderIsRegistered_RefreshesExpiredCredentialsThroughProvider", async () => {
    resetOAuthProviders();
    const provider: OAuthProviderInterface = {
      id: "test-provider",
      name: "Test Provider",
      async login(_callbacks: OAuthLoginCallbacks) {
        return { access: "login-access", refresh: "login-refresh", expires: Date.now() + 60_000 };
      },
      async refreshToken(credentials: OAuthCredentials) {
        return { ...credentials, access: "fresh-access", refresh: "fresh-refresh", expires: Date.now() + 60_000 };
      },
      getApiKey(credentials: OAuthCredentials) {
        return `Bearer ${credentials.access}`;
      },
    };
    registerOAuthProvider(provider);
    const expired = { access: "old-access", refresh: "old-refresh", expires: Date.now() - 1 };

    const result = await getOAuthApiKey("test-provider", { "test-provider": expired });

    expect(result?.newCredentials.access, "Expired credentials should be refreshed before returning an API key.").toBe("fresh-access");
    expect(result?.apiKey, "The returned API key should be derived from the refreshed credential, not the expired one.").toBe("Bearer fresh-access");
  });

  test("unregisterOAuthProvider_WhenCustomProviderIsRemoved_MakesProviderUnknown", async () => {
    resetOAuthProviders();
    registerOAuthProvider({
      id: "temporary-provider",
      name: "Temporary",
      async login() {
        return { access: "a", refresh: "r", expires: Date.now() + 1 };
      },
      async refreshToken(credentials) {
        return credentials;
      },
      getApiKey(credentials) {
        return credentials.access;
      },
    });

    unregisterOAuthProvider("temporary-provider");
    const provider = getOAuthProvider("temporary-provider");
    const act = () => refreshOAuthToken("temporary-provider", { access: "a", refresh: "r", expires: Date.now() + 1 });

    expect(provider, "Custom providers should be removed completely when unregistered.").toBeUndefined();
    await expect(act(), "Refreshing an unknown provider should fail loudly instead of returning stale credentials.").rejects.toThrow("Unknown OAuth provider");
  });

  test("unregisterOAuthProvider_WhenBuiltInProviderIsUnregistered_RestoresBuiltInImplementation", () => {
    resetOAuthProviders();
    const original = getOAuthProvider("openai-codex");
    registerOAuthProvider({
      id: "openai-codex",
      name: "Shadow Provider",
      async login() {
        return { access: "shadow", refresh: "shadow", expires: Date.now() + 1 };
      },
      async refreshToken(credentials) {
        return credentials;
      },
      getApiKey(credentials) {
        return credentials.access;
      },
    });

    unregisterOAuthProvider("openai-codex");
    const restored = getOAuthProvider("openai-codex");

    expect(restored, "Unregistering a built-in id should restore the bundled provider rather than leaving a hole.").toBe(original);
    expect(restored?.name, "The restored provider should not retain custom provider metadata.").not.toBe("Shadow Provider");
  });
});

describe("OAuth helpers", () => {
  test("generatePKCE_WhenCalled_ReturnsVerifierAndChallengeThatAreBase64UrlSafe", async () => {
    const first = await generatePKCE();
    const second = await generatePKCE();

    expect(first.verifier, "PKCE verifier should be URL-safe base64 without padding.").toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.challenge, "PKCE challenge should be URL-safe base64 without padding.").toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.challenge, "PKCE challenge must be SHA-256 based and therefore not equal to the verifier.").not.toBe(first.verifier);
    expect(first.verifier, "Two PKCE verifiers should not repeat because OAuth state relies on entropy.").not.toBe(second.verifier);
  });

  test("oauthPage_WhenMessageContainsHtml_EscapesUserControlledText", () => {
    const html = oauthErrorHtml("<script>alert(1)</script>", "\"details\" & token");
    const success = oauthSuccessHtml("Done <ok>");

    expect(html, "OAuth error pages must escape HTML in messages to avoid browser-executed callback text.").toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html, "OAuth error page details must escape quotes and ampersands.").toContain("&quot;details&quot; &amp; token");
    expect(html, "Raw script tags should never survive into OAuth callback HTML.").not.toContain("<script>alert(1)</script>");
    expect(success, "Success pages should use the same escaping path as errors.").toContain("Done &lt;ok&gt;");
  });

  test("normalizeDomain_WhenGivenUrlOrHost_ReturnsHostnameOnly", () => {
    const domains = [
      normalizeDomain("github.example.com"),
      normalizeDomain("https://github.example.com/login?x=1"),
      normalizeDomain("   "),
      normalizeDomain("not a domain ###"),
    ];

    expect(domains, "Enterprise GitHub domains should normalize to hostnames and reject unusable input.").toEqual([
      "github.example.com",
      "github.example.com",
      null,
      null,
    ]);
  });

  test("getGitHubCopilotBaseUrl_WhenTokenContainsProxyEndpoint_UsesTokenEndpointOverEnterpriseFallback", () => {
    const fromToken = getGitHubCopilotBaseUrl("tid=1;proxy-ep=proxy.business.githubcopilot.com;exp=2", "enterprise.example.com");
    const fromEnterprise = getGitHubCopilotBaseUrl(undefined, "enterprise.example.com");
    const defaultUrl = getGitHubCopilotBaseUrl();

    expect(fromToken, "Copilot API base should prefer proxy endpoint embedded in the Copilot token.").toBe("https://api.business.githubcopilot.com");
    expect(fromEnterprise, "Enterprise domains should produce the enterprise Copilot API host when no proxy endpoint exists.").toBe("https://copilot-api.enterprise.example.com");
    expect(defaultUrl, "Public Copilot should keep the individual API endpoint.").toBe("https://api.individual.githubcopilot.com");
  });
});
