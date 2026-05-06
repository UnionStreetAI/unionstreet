/**
 * Curated provider catalog for the `Add Provider` dialog.
 *
 * **Scope:** American / European / Canadian / Israeli providers only.
 * We intentionally omit Chinese-controlled providers (DeepSeek, Qwen,
 * Moonshot/Kimi, Zhipu/GLM, Baidu/Ernie, 01.AI, etc.) per project policy.
 *
 * Two auth shapes:
 *   - "oauth" — handled by `us-dev auth <id>` from the CLI (browser
 *     callback flow). The TUI's Add Provider dialog points users at the
 *     CLI command for these; we don't run the OAuth flow inside the TUI
 *     in this build.
 *   - "api_key" — handled inline in the TUI (paste key → write to
 *     auth-profiles.json).
 *
 * Adding a provider here doesn't yet make its models callable — that's
 * the model-client wiring which lands provider-by-provider. This catalog
 * is the discovery + persistence surface.
 */

export type ProviderRegion = "us" | "eu" | "ca" | "il";

export type ProviderAuthMethod = "oauth" | "api_key";

export interface ProviderInfo {
  /** Stable id used in auth-profiles.json (matches us-auth oauth ids where applicable). */
  id: string;
  /** Human label shown in the picker. */
  name: string;
  /** "popular" pins to the top of the list; "other" sorts alphabetically. */
  category: "popular" | "other";
  region: ProviderRegion;
  /** What auth shapes the provider supports, in preference order. */
  authMethods: ProviderAuthMethod[];
  /** Hint text shown next to the API-key input field. */
  apiKeyHint?: string;
  /** CLI subcommand for OAuth flow (e.g., `codex` → `us-dev auth codex`). */
  oauthSubcommand?: string;
  /** One-line description for the picker. */
  description: string;
  /** Optional URL where users can find/create their API key. */
  apiKeyUrl?: string;
  /** Internal note when `oauth` is the recommended path. */
  oauthNote?: string;
  /**
   * If true, the provider requires the user to supply a base URL alongside
   * their API key (e.g., a custom OpenAI-compatible endpoint, a Cloudflare
   * AI Gateway URL, or a self-hosted vLLM/LM Studio/Ollama deployment).
   * The dialog renders a second input when this is set.
   */
  needsBaseUrl?: boolean;
  /** Placeholder hint shown for the base URL field when needsBaseUrl. */
  baseUrlHint?: string;
}

export const PROVIDERS: ReadonlyArray<ProviderInfo> = [
  // ───── popular: have OAuth, recommended path ─────
  {
    id: "openai-codex",
    name: "OpenAI (ChatGPT subscription)",
    category: "popular",
    region: "us",
    authMethods: ["oauth"],
    oauthSubcommand: "codex",
    description: "Plus / Pro / Team / Enterprise · OAuth via ChatGPT.com",
    oauthNote: "Run `us-dev auth codex` to authenticate.",
  },
  {
    id: "anthropic-oauth",
    name: "Anthropic (Claude Pro/Max)",
    category: "popular",
    region: "us",
    authMethods: ["oauth"],
    oauthSubcommand: "claude",
    description: "Pro / Max subscription · OAuth via claude.ai",
    oauthNote: "Run `us-dev auth claude` to authenticate.",
  },

  // ───── popular: aggregator gateways ─────
  {
    id: "opencode-zen",
    name: "OpenCode Zen",
    category: "popular",
    region: "us",
    authMethods: ["api_key"],
    apiKeyHint: "ock_…",
    apiKeyUrl: "https://opencode.ai/zen",
    description: "Managed inference from the OpenCode team — multi-vendor",
  },
  {
    id: "vercel-ai-gateway",
    name: "Vercel AI Gateway",
    category: "popular",
    region: "us",
    authMethods: ["api_key"],
    apiKeyHint: "vck_…",
    apiKeyUrl: "https://vercel.com/dashboard/ai-gateway",
    description: "Unified gateway with routing, failover, and observability",
  },
  {
    id: "cloudflare-ai-gateway",
    name: "Cloudflare AI Gateway",
    category: "popular",
    region: "us",
    authMethods: ["api_key"],
    needsBaseUrl: true,
    baseUrlHint: "https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openai",
    apiKeyHint: "CF API token",
    apiKeyUrl: "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway",
    description:
      "Caching · rate limits · analytics across many providers — one URL",
  },

  // ───── popular: API key ─────
  {
    id: "openai",
    name: "OpenAI (API key)",
    category: "popular",
    region: "us",
    authMethods: ["api_key"],
    apiKeyHint: "sk-…",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    description: "Direct API access — pay-per-token",
  },
  {
    id: "anthropic",
    name: "Anthropic (API key)",
    category: "popular",
    region: "us",
    authMethods: ["api_key"],
    apiKeyHint: "sk-ant-…",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    description: "Direct API access — pay-per-token",
  },
  {
    id: "google",
    name: "Google Gemini",
    category: "popular",
    region: "us",
    authMethods: ["api_key"],
    apiKeyHint: "AIza…",
    apiKeyUrl: "https://aistudio.google.com/app/apikey",
    description: "Google AI Studio — Gemini family",
  },

  // ───── escape hatch: bring your own endpoint ─────
  {
    id: "custom-openai-compat",
    name: "Custom (OpenAI-compatible)",
    category: "popular",
    region: "us",
    authMethods: ["api_key"],
    needsBaseUrl: true,
    baseUrlHint: "https://my-host/v1",
    apiKeyHint: "your endpoint's key (or `dummy` if none)",
    description:
      "Any OpenAI-compatible endpoint — vLLM, LM Studio, Ollama, custom proxy",
  },

  // ───── other Western providers (alphabetical) ─────
  {
    id: "ai21",
    name: "AI21 Labs",
    category: "other",
    region: "il",
    authMethods: ["api_key"],
    apiKeyHint: "…",
    apiKeyUrl: "https://studio.ai21.com/account/api-key",
    description: "Jamba family — Israeli lab",
  },
  {
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    category: "other",
    region: "us",
    authMethods: ["api_key"],
    apiKeyHint: "AWS access key (via env)",
    description: "Multi-vendor through AWS — Anthropic/Meta/etc.",
  },
  {
    id: "azure-openai",
    name: "Azure OpenAI",
    category: "other",
    region: "us",
    authMethods: ["api_key"],
    apiKeyHint: "…",
    description: "Microsoft-hosted OpenAI deployment",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    category: "other",
    region: "us",
    authMethods: ["api_key"],
    apiKeyHint: "csk-…",
    apiKeyUrl: "https://cloud.cerebras.ai/platform/keys",
    description: "Wafer-scale inference — fastest",
  },
  {
    id: "cohere",
    name: "Cohere",
    category: "other",
    region: "ca",
    authMethods: ["api_key"],
    apiKeyHint: "…",
    apiKeyUrl: "https://dashboard.cohere.com/api-keys",
    description: "Command R+ family — Canadian",
  },
  {
    id: "deepinfra",
    name: "DeepInfra",
    category: "other",
    region: "us",
    authMethods: ["api_key"],
    apiKeyHint: "…",
    apiKeyUrl: "https://deepinfra.com/dash/api_keys",
    description: "Open-weight model hosting",
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    category: "other",
    region: "us",
    authMethods: ["api_key"],
    apiKeyHint: "fw_…",
    apiKeyUrl: "https://fireworks.ai/api-keys",
    description: "Fast open-model inference",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    category: "other",
    region: "us",
    authMethods: ["oauth"],
    oauthSubcommand: "github-copilot",
    description: "Copilot subscription · OAuth via GitHub",
    oauthNote: "GitHub Copilot OAuth — wiring in a future build.",
  },
  {
    id: "groq",
    name: "Groq",
    category: "other",
    region: "us",
    authMethods: ["api_key"],
    apiKeyHint: "gsk_…",
    apiKeyUrl: "https://console.groq.com/keys",
    description: "LPU-accelerated inference — very fast",
  },
  {
    id: "mistral",
    name: "Mistral",
    category: "other",
    region: "eu",
    authMethods: ["api_key"],
    apiKeyHint: "…",
    apiKeyUrl: "https://console.mistral.ai/api-keys/",
    description: "French frontier lab — Mistral family",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    category: "other",
    region: "us",
    authMethods: ["api_key"],
    apiKeyHint: "sk-or-v1-…",
    apiKeyUrl: "https://openrouter.ai/keys",
    description: "Aggregator — many models behind one API",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    category: "other",
    region: "us",
    authMethods: ["api_key"],
    apiKeyHint: "pplx-…",
    apiKeyUrl: "https://www.perplexity.ai/settings/api",
    description: "Sonar models with built-in web search",
  },
  {
    id: "together",
    name: "Together AI",
    category: "other",
    region: "us",
    authMethods: ["api_key"],
    apiKeyHint: "…",
    apiKeyUrl: "https://api.together.ai/settings/api-keys",
    description: "Open-weight model hosting",
  },
  {
    id: "vertex",
    name: "Google Vertex AI",
    category: "other",
    region: "us",
    authMethods: ["api_key"],
    apiKeyHint: "service-account JSON path",
    description: "Enterprise GCP-hosted Gemini",
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    category: "other",
    region: "us",
    authMethods: ["api_key"],
    apiKeyHint: "xai-…",
    apiKeyUrl: "https://console.x.ai/",
    description: "Grok family",
  },
];

export function findProvider(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
