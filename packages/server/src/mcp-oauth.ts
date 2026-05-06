import { createHash, randomBytes, randomUUID } from "node:crypto";

export interface McpOAuthMetadata {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scope?: string;
  audience?: string;
}

export interface McpOAuthStart {
  url: string;
  state: string;
  verifier: string;
  metadata: McpOAuthMetadata;
}

export interface McpOAuthTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
  raw: Record<string, unknown>;
}

export function startMcpOAuth(metadata: McpOAuthMetadata): McpOAuthStart {
  const state = randomUUID();
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const url = new URL(metadata.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", metadata.clientId);
  url.searchParams.set("redirect_uri", metadata.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (metadata.scope) url.searchParams.set("scope", metadata.scope);
  if (metadata.audience) url.searchParams.set("audience", metadata.audience);
  return { url: url.toString(), state, verifier, metadata };
}

export async function exchangeMcpOAuthCallback(
  started: McpOAuthStart,
  callbackOrCode: string,
  fetcher: typeof fetch = fetch,
): Promise<McpOAuthTokenResponse> {
  const { code, state } = parseCallbackOrCode(callbackOrCode);
  if (!code) throw new Error("OAuth callback did not include an authorization code.");
  if (state && state !== started.state) throw new Error("OAuth callback state mismatch.");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: started.metadata.redirectUri,
    client_id: started.metadata.clientId,
    code_verifier: started.verifier,
  });
  if (started.metadata.clientSecret) body.set("client_secret", started.metadata.clientSecret);

  const response = await fetcher(started.metadata.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const raw = await response.json().catch(async () => ({ error: await response.text() })) as Record<string, unknown>;
  if (!response.ok) {
    const detail = typeof raw.error_description === "string" ? raw.error_description : JSON.stringify(raw);
    throw new Error(`MCP OAuth token exchange failed (${response.status}): ${detail}`);
  }

  const access = readString(raw.access_token);
  if (!access) throw new Error("MCP OAuth token response did not include access_token.");
  const expiresIn = readNumber(raw.expires_in);
  return {
    accessToken: access,
    ...(readString(raw.refresh_token) ? { refreshToken: readString(raw.refresh_token) } : {}),
    ...(expiresIn ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
    ...(readString(raw.scope) ? { scope: readString(raw.scope) } : {}),
    ...(readString(raw.token_type) ? { tokenType: readString(raw.token_type) } : {}),
    raw,
  };
}

export function parseCallbackOrCode(value: string): { code?: string; state?: string } {
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    const url = new URL(trimmed);
    return {
      ...(url.searchParams.get("code") ? { code: url.searchParams.get("code")! } : {}),
      ...(url.searchParams.get("state") ? { state: url.searchParams.get("state")! } : {}),
    };
  } catch {
    return { code: trimmed };
  }
}

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
