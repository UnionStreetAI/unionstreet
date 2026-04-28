import { describe, expect, test } from "bun:test";
import { refreshGitHubCopilotToken } from "./oauth/github-copilot.ts";
import { refreshOpenAICodexToken } from "./oauth/openai-codex.ts";

function jwtWithPayload(payload: Record<string, unknown>): string {
	const encoded = btoa(JSON.stringify(payload));
	return `header.${encoded}.signature`;
}

function jsonFetch(body: unknown, init?: ResponseInit): typeof fetch {
	return (async () => Response.json(body, init)) as unknown as typeof fetch;
}

describe("OAuth provider refresh flows", () => {
	test("refreshOpenAICodexToken_WhenTokenEndpointReturnsAccountClaim_RefreshesCredentialAndPreservesAccountId", async () => {
		const access = jwtWithPayload({
			"https://api.openai.com/auth": { chatgpt_account_id: "acct-enterprise-1" },
		});
		let requestBody = "";
		const fetcher = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			requestBody = String(init?.body ?? "");
			return Response.json({ access_token: access, refresh_token: "new-refresh", expires_in: 900 });
		}) as unknown as typeof fetch;

		const credentials = await refreshOpenAICodexToken("old-refresh", fetcher);

		expect(
			requestBody,
			"OpenAI Codex refresh must exchange the stored refresh token using the OAuth refresh_token grant.",
		).toContain("grant_type=refresh_token");
		expect(requestBody, "OpenAI Codex refresh must send the persisted refresh token to the token endpoint.").toContain("refresh_token=old-refresh");
		expect(credentials.access, "The refreshed OAuth credential should expose the new provider access token.").toBe(access);
		expect(credentials.refresh, "The refreshed OAuth credential should replace the stale refresh token.").toBe("new-refresh");
		expect(credentials.accountId, "The account id claim is required for Codex Responses API routing.").toBe("acct-enterprise-1");
		expect(credentials.expires > Date.now(), "Refresh should convert provider expires_in into a future absolute expiry.").toBe(true);
	});

	test("refreshOpenAICodexToken_WhenAccessTokenHasNoAccountClaim_FailsHard", async () => {
		const fetcher = jsonFetch({
			access_token: jwtWithPayload({ sub: "user-without-account" }),
			refresh_token: "new-refresh",
			expires_in: 900,
		});

		const promise = refreshOpenAICodexToken("old-refresh", fetcher);

		await expect(
			promise,
			"Codex refresh without the ChatGPT account claim should fail instead of silently creating an unusable credential.",
		).rejects.toThrow("Failed to extract accountId");
	});

	test("refreshGitHubCopilotToken_WhenEnterpriseDomainIsProvided_UsesEnterpriseTokenEndpointAndSafetyMargin", async () => {
		const expiresAtSeconds = 2_000_000_000;
		let requestedUrl = "";
		let authorization = "";
		const fetcher = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			requestedUrl = String(url);
			authorization = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
			return Response.json({ token: "tid=1;proxy-ep=proxy.enterprise.githubcopilot.com;", expires_at: expiresAtSeconds });
		}) as unknown as typeof fetch;

		const credentials = await refreshGitHubCopilotToken("gh-user-token", "github.example.com", fetcher);

		expect(
			requestedUrl,
			"GitHub Enterprise Copilot refresh must use the enterprise API host instead of github.com.",
		).toBe("https://api.github.example.com/copilot_internal/v2/token");
		expect(authorization, "Copilot token refresh must authenticate with the GitHub access token as a bearer token.").toBe("Bearer gh-user-token");
		expect(credentials.access, "The Copilot API token must be exposed as the provider access token.").toContain("proxy.enterprise");
		expect(credentials.refresh, "The original GitHub token remains the refresh material for future Copilot token renewal.").toBe("gh-user-token");
		expect(credentials.expires, "Copilot tokens should subtract the five-minute safety window before expiry.").toBe(expiresAtSeconds * 1000 - 5 * 60 * 1000);
		expect((credentials as { enterpriseUrl?: string }).enterpriseUrl, "Enterprise domain should be persisted for later refreshes.").toBe("github.example.com");
	});

	test("refreshGitHubCopilotToken_WhenTokenResponseIsMalformed_FailsBeforePersistingCredential", async () => {
		const fetcher = jsonFetch({ token: "copilot-token-without-expiry" });

		const promise = refreshGitHubCopilotToken("gh-user-token", undefined, fetcher);

		await expect(
			promise,
			"Malformed Copilot token responses should not be converted into credentials with undefined expiry.",
		).rejects.toThrow("Invalid Copilot token response fields");
	});
});
