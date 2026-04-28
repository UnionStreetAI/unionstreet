/**
 * Known model ids exposed via the ChatGPT (Codex) Responses backend.
 * These are the IDs accepted when authenticated with a ChatGPT Plus / Pro /
 * Team / Enterprise subscription (NOT the api.openai.com api-key path).
 *
 * Source of truth — at the moment — is pi-mono's models.generated.ts;
 * we'll regenerate from /v1/models once we have a fetch helper.
 *
 * The order here is the order shown in `/model` pickers — newest first.
 */

export interface CodexModel {
  id: string;
  /** One-line human description shown in pickers. */
  description: string;
  /** Marker for our recommended default. */
  recommended?: boolean;
}

/** Stable provider identity used by pickers to group models. */
export const CODEX_PROVIDER = {
  id: "openai-codex",
  label: "OPENAI · CHATGPT",
  authMethod: "oauth (chatgpt subscription)",
} as const;

export const CODEX_MODELS: ReadonlyArray<CodexModel> = [
  { id: "gpt-5.5", description: "frontier — latest" },
  { id: "gpt-5.4", description: "default", recommended: true },
  { id: "gpt-5.4-mini", description: "faster, cheaper" },
  { id: "gpt-5.3-codex", description: "codex specialty" },
  { id: "gpt-5.3-codex-spark", description: "codex spark" },
  { id: "gpt-5.2-codex", description: "codex 5.2" },
  { id: "gpt-5.2", description: "5.2" },
  { id: "gpt-5.1-codex-max", description: "5.1 codex max" },
  { id: "gpt-5.1-codex-mini", description: "5.1 codex mini" },
  { id: "gpt-5.1", description: "5.1" },
];

export function defaultCodexModel(): string {
  return CODEX_MODELS.find((m) => m.recommended)?.id ?? CODEX_MODELS[0]!.id;
}

export function findCodexModel(id: string): CodexModel | undefined {
  return CODEX_MODELS.find((m) => m.id === id);
}

// ---------- live model listing from the ChatGPT (Codex) backend ----------

const CODEX_MODELS_PATH = "/codex/models";
const DEFAULT_CODEX_BASE = "https://chatgpt.com/backend-api";

interface RawCodexModel {
  slug: string;
  display_name?: string;
  description?: string;
  context_window?: number;
  priority?: number;
  visibility?: string;
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
}

export interface LiveCodexModel extends CodexModel {
  display_name: string;
  context_window?: number;
  priority?: number;
  default_reasoning_level?: string;
  reasoning_levels?: Array<{ effort: string; description: string }>;
}

/**
 * Fetch the list of Codex models the authenticated ChatGPT account can use.
 *
 * Hits `/codex/models?client_version=…`. The endpoint returns rich
 * metadata; we project to {@link LiveCodexModel}. Models with
 * `visibility !== "list"` are filtered out.
 */
export async function listCodexModels(opts: {
  token: string;
  accountId?: string;
  baseUrl?: string;
  clientVersion?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}): Promise<LiveCodexModel[]> {
  const accountId = opts.accountId ?? extractAccountIdFromToken(opts.token);
  const base = (opts.baseUrl ?? DEFAULT_CODEX_BASE).replace(/\/+$/, "");
  const url = `${base}${CODEX_MODELS_PATH}?client_version=${encodeURIComponent(opts.clientVersion ?? "0.0.0")}`;

  const r = await (opts.fetch ?? fetch)(url, {
    headers: {
      authorization: `Bearer ${opts.token}`,
      "chatgpt-account-id": accountId,
      "openai-beta": "responses=experimental",
      accept: "application/json",
      "user-agent": "us-dev/0.0.0",
      originator: "us-dev",
    },
    signal: opts.signal,
  });
  if (!r.ok) {
    throw new Error(`codex /models: HTTP ${r.status}`);
  }
  const body = (await r.json()) as { models?: RawCodexModel[] };
  const raws = body.models ?? [];
  return raws
    .filter((m) => m.visibility === "list")
    .sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9))
    .map<LiveCodexModel>((m) => ({
      id: m.slug,
      description: m.description ?? m.display_name ?? "",
      display_name: m.display_name ?? m.slug,
      context_window: m.context_window,
      priority: m.priority,
      default_reasoning_level: m.default_reasoning_level,
      reasoning_levels: m.supported_reasoning_levels?.map((r) => ({
        effort: r.effort,
        description: r.description ?? "",
      })),
      recommended: false,
    }));
}

// ---------- generic OpenAI-compatible /v1/models ----------

/**
 * Anything that speaks OpenAI's `/v1/models` (most major providers and
 * gateways: OpenAI, OpenRouter, Groq, Fireworks, Together, Cerebras,
 * Perplexity, Mistral, Cloudflare AI Gateway, Vercel AI Gateway, vLLM,
 * LM Studio, Ollama with their compat layer, custom proxies, etc.).
 *
 * The standard response is `{ data: [{ id, owned_by, ... }] }`.
 * We project to LiveCodexModel for uniform consumption by the picker.
 */
export async function listOpenAIModels(opts: {
  /** Trailing /v1 (or wherever the API root is) included. We append `/models`. */
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}): Promise<LiveCodexModel[]> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const urls = [`${base}/models`];
  if (!base.endsWith("/v1")) urls.push(`${base}/v1/models`);

  let r: Response | undefined;
  let url = urls[0]!;
  for (const candidate of urls) {
    url = candidate;
    r = await (opts.fetch ?? fetch)(candidate, {
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        accept: "application/json",
      },
      signal: opts.signal,
    });
    if (r.ok || r.status !== 404) break;
  }
  if (!r) {
    throw new Error(`openai-compat /models: no request attempted`);
  }
  if (!r.ok) {
    throw new Error(`openai-compat /models: HTTP ${r.status} at ${url}`);
  }
  const body = (await r.json()) as {
    data?: Array<{
      id?: string;
      name?: string;
      owned_by?: string;
      object?: string;
      description?: string;
      context_length?: number;
    }>;
  };
  const raws = body.data ?? [];
  return raws
    .filter((m): m is { id: string } & typeof m => typeof m.id === "string")
    .map<LiveCodexModel>((m) => ({
      id: m.id,
      description: m.description ?? m.owned_by ?? "",
      display_name: m.name ?? m.id,
      context_window: m.context_length,
      recommended: false,
    }));
}

function extractAccountIdFromToken(token: string): string {
  // Re-use the JWT helper from the main client. We avoid a circular import
  // by inlining a minimal version here.
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("token is not a JWT");
  const pad = (parts[1]!.length % 4) === 0 ? "" : "=".repeat(4 - (parts[1]!.length % 4));
  const payload = JSON.parse(atob((parts[1]! + pad).replace(/-/g, "+").replace(/_/g, "/")));
  const claim = payload?.["https://api.openai.com/auth"];
  const id = claim?.chatgpt_account_id;
  if (!id) throw new Error("no chatgpt_account_id claim");
  return id;
}
