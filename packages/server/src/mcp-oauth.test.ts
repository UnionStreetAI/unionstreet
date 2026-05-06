import { describe, expect, test } from "bun:test";
import { exchangeMcpOAuthCallback, parseCallbackOrCode, startMcpOAuth } from "./mcp-oauth.ts";

function oauthStart() {
	return startMcpOAuth({
		authorizationUrl: "https://mcp.example.com/oauth/authorize?existing=1",
		tokenUrl: "https://mcp.example.com/oauth/token",
		clientId: "client-123",
		clientSecret: "secret-456",
		redirectUri: "urn:ietf:wg:oauth:2.0:oob",
		scope: "repo read:org",
		audience: "https://mcp.example.com",
	});
}

describe("MCP OAuth helpers", () => {
	test("startMcpOAuth_WhenMetadataIncludesScopeAndAudience_BuildsPkceAuthorizationUrl", () => {
		const started = oauthStart();
		const url = new URL(started.url);

		expect(url.origin + url.pathname, "MCP OAuth should preserve the configured authorization endpoint.").toBe("https://mcp.example.com/oauth/authorize");
		expect(url.searchParams.get("existing"), "Existing provider query params should not be discarded.").toBe("1");
		expect(url.searchParams.get("response_type"), "MCP OAuth must request an authorization code.").toBe("code");
		expect(url.searchParams.get("client_id"), "MCP OAuth must include the configured public client id.").toBe("client-123");
		expect(url.searchParams.get("redirect_uri"), "Remote/cloud auth uses the configured redirect URI the user pastes back.").toBe("urn:ietf:wg:oauth:2.0:oob");
		expect(url.searchParams.get("scope"), "Provider scopes should be passed through exactly.").toBe("repo read:org");
		expect(url.searchParams.get("audience"), "Audience should be included for MCP servers that require resource binding.").toBe("https://mcp.example.com");
		expect(url.searchParams.get("code_challenge_method"), "MCP OAuth must use S256 PKCE.").toBe("S256");
		expect(started.verifier.length > 20, "PKCE verifier should be high-entropy and persisted for the callback exchange.").toBe(true);
		expect(started.state.length > 20, "OAuth state should be generated per auth attempt for CSRF protection.").toBe(true);
	});

	test("parseCallbackOrCode_WhenInputIsUrlOrPlainCode_ReturnsOnlyAvailableFields", () => {
		const urlInput = "https://callback.local/done?code=abc123&state=state456";
		const plainInput = "manual-code";
		const emptyInput = "   ";

		const parsedUrl = parseCallbackOrCode(urlInput);
		const parsedPlain = parseCallbackOrCode(plainInput);
		const parsedEmpty = parseCallbackOrCode(emptyInput);

		expect(parsedUrl, "Pasted callback URLs should extract both code and state.").toEqual({ code: "abc123", state: "state456" });
		expect(parsedPlain, "Plain pasted codes should be accepted for remote/cloud device auth flows.").toEqual({ code: "manual-code" });
		expect(parsedEmpty, "Blank callback input should not fabricate a code.").toEqual({});
	});

	test("exchangeMcpOAuthCallback_WhenCallbackIsValid_SendsPkceVerifierAndNormalizesToken", async () => {
		const started = oauthStart();
		let requestBody = "";
		const fetcher = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			requestBody = String(init?.body ?? "");
			return Response.json({
				access_token: "mcp-access",
				refresh_token: "mcp-refresh",
				expires_in: "60",
				scope: "repo",
				token_type: "Bearer",
			});
		}) as unknown as typeof fetch;

		const token = await exchangeMcpOAuthCallback(started, `https://callback.local/done?code=abc&state=${started.state}`, fetcher);

		expect(requestBody, "MCP OAuth exchange must include the pasted authorization code.").toContain("code=abc");
		expect(requestBody, "MCP OAuth exchange must include the PKCE verifier created at auth start.").toContain(`code_verifier=${started.verifier}`);
		expect(requestBody, "Confidential MCP providers should receive the configured client secret.").toContain("client_secret=secret-456");
		expect(token.accessToken, "Provider access_token should be normalized to accessToken.").toBe("mcp-access");
		expect(token.refreshToken, "Provider refresh_token should be preserved when present.").toBe("mcp-refresh");
		expect(token.scope, "Provider scope should be preserved for status/doctor output.").toBe("repo");
		expect(token.tokenType, "Provider token_type should be preserved for auth materialization.").toBe("Bearer");
		expect(token.expiresAt && token.expiresAt > Date.now(), "expires_in should be converted to an absolute expiry.").toBe(true);
	});

	test("exchangeMcpOAuthCallback_WhenStateMismatches_RejectsBeforeCallingTokenEndpoint", async () => {
		const started = oauthStart();
		let called = false;
		const fetcher = (async () => {
			called = true;
			return Response.json({});
		}) as unknown as typeof fetch;

		const promise = exchangeMcpOAuthCallback(started, "https://callback.local/done?code=abc&state=wrong", fetcher);

		await expect(promise, "State mismatch should fail locally before leaking the auth code to a token endpoint.").rejects.toThrow("state mismatch");
		expect(called, "Token endpoint must not be called when callback state does not match.").toBe(false);
	});

	test("exchangeMcpOAuthCallback_WhenProviderReturnsError_ReportsActionableStatusAndDetail", async () => {
		const started = oauthStart();
		const fetcher = (async () =>
			Response.json({ error: "invalid_grant", error_description: "code expired" }, { status: 400 })) as unknown as typeof fetch;

		const promise = exchangeMcpOAuthCallback(started, `code-only#ignored`, fetcher);

		await expect(
			promise,
			"Token exchange errors should include provider status and error description for CLI troubleshooting.",
		).rejects.toThrow("MCP OAuth token exchange failed (400): code expired");
	});
});
