import {
  CODEX_MODELS,
  CODEX_PROVIDER,
  listCodexModels,
  listOpenAIModels,
  type LiveCodexModel,
} from "@unionstreet/ai-codex";
import { resolveAuthProfiles, type ApiKeyCred, type AuthProfilesFile, type OAuthCred } from "./auth-profiles.ts";
import { findProvider } from "./providers.ts";
import { getModelsForAuthKey, getProviderLabel, type RegistryModel } from "./models-dev.ts";
import { sanitizeOpenAICompatBaseUrl } from "./base-url.ts";

const OPENAI_COMPAT_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  together: "https://api.together.xyz/v1",
  cerebras: "https://api.cerebras.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  perplexity: "https://api.perplexity.ai",
  xai: "https://api.x.ai/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  "opencode-zen": "https://api.opencode.ai/v1",
  "vercel-ai-gateway": "https://gateway.ai.vercel.ai/v1",
};

const PROVIDER_LABEL_HINTS: Record<string, string> = {
  codex: "OPENAI · CHATGPT",
  claude: "ANTHROPIC · CLAUDE PRO",
};

export interface DiscoveredModel {
  id: string;
  description: string;
  display_name?: string;
  context_window?: number;
}

export interface DiscoveredModelGroup {
  id: string;
  label: string;
  authMethod: string;
  models: DiscoveredModel[];
  baseUrl?: string;
  state: "live" | "fallback" | "error";
}

export interface ModelDiscoveryOptions {
  profile?: string;
  fetch?: typeof fetch;
}

export async function discoverModelGroups(options: ModelDiscoveryOptions = {}): Promise<DiscoveredModelGroup[]> {
  let auth: AuthProfilesFile;
  try {
    auth = (await resolveAuthProfiles(options.profile)).merged;
  } catch {
    return [];
  }

  const groups: DiscoveredModelGroup[] = [];
  const codexCred = auth.providers.codex;
  if (codexCred?.kind === "oauth") {
    groups.push(await discoverCodexGroup(codexCred, options.fetch));
  }

  const entries = Object.entries(auth.providers)
    .filter(([key]) => key !== "codex")
    .sort(([a], [b]) => providerSortKey(a).localeCompare(providerSortKey(b)));

  const discovered = await Promise.all(entries.map(([key, cred]) => discoverProviderGroup(key, cred, options.fetch)));
  return groups.concat(discovered.filter((group): group is DiscoveredModelGroup => Boolean(group)));
}

async function discoverCodexGroup(cred: OAuthCred, fetcher?: typeof fetch): Promise<DiscoveredModelGroup> {
  try {
    const live = await listCodexModels({ token: cred.access, fetch: fetcher });
    if (live.length > 0) {
      return {
        id: CODEX_PROVIDER.id,
        label: CODEX_PROVIDER.label,
        authMethod: CODEX_PROVIDER.authMethod,
        models: live.map(fromLiveModel),
        state: "live",
      };
    }
  } catch {
    // Fall through to the bundled offline Codex list.
  }
  return {
    id: CODEX_PROVIDER.id,
    label: CODEX_PROVIDER.label,
    authMethod: CODEX_PROVIDER.authMethod,
    models: CODEX_MODELS.map((model) => ({ id: model.id, description: model.description })),
    state: "error",
  };
}

async function discoverProviderGroup(
  key: string,
  cred: AuthProfilesFile["providers"][string],
  fetcher?: typeof fetch,
): Promise<DiscoveredModelGroup | undefined> {
  const baseKey = providerBaseKey(key);
  const info = findProvider(baseKey);
  const authMethod = cred.kind === "oauth" ? "oauth" : "api key";
  const baseUrl =
    cred.kind === "api_key"
      ? sanitizeOpenAICompatBaseUrl((cred as ApiKeyCred).base_url ?? OPENAI_COMPAT_BASE[baseKey] ?? "")
      : undefined;
  const fallbackLabel = providerLabelForAuthKey(key, baseUrl, info?.name, undefined);
  const [registryModels, registryLabel] = await Promise.all([
    getModelsForAuthKey(key).catch((): RegistryModel[] => []),
    getProviderLabel(key).catch((): string | undefined => undefined),
  ]);
  const label = providerLabelForAuthKey(key, baseUrl, info?.name, registryLabel) ?? fallbackLabel;
  const baselineModels: DiscoveredModel[] = registryModels.map((model) => ({
    id: model.id,
    description: model.name ?? "",
    display_name: model.name,
    context_window: model.limit?.context,
  }));

  if (cred.kind === "api_key" && baseUrl) {
    try {
      const live = await listOpenAIModels({ baseUrl, apiKey: (cred as ApiKeyCred).api_key, fetch: fetcher });
      if (live.length > 0) {
        return { id: key, label, authMethod, baseUrl, models: live.map(fromLiveModel), state: "live" };
      }
    } catch {
      return {
        id: key,
        label,
        authMethod,
        ...(baseUrl ? { baseUrl } : {}),
        models: baselineModels,
        state: baselineModels.length ? "fallback" : "error",
      };
    }
  }

  if (!baselineModels.length && cred.kind !== "oauth") return undefined;
  return {
    id: key,
    label,
    authMethod,
    ...(baseUrl ? { baseUrl } : {}),
    models: baselineModels,
    state: baselineModels.length ? "fallback" : "error",
  };
}

function fromLiveModel(model: LiveCodexModel): DiscoveredModel {
  return {
    id: model.id,
    description: model.description,
    display_name: model.display_name,
    context_window: model.context_window,
  };
}

function providerSortKey(key: string): string {
  const baseKey = providerBaseKey(key);
  if (baseKey === "codex" || baseKey === "openai" || baseKey === "openai-codex") return `0:${key}`;
  if (baseKey === "claude" || baseKey === "anthropic" || baseKey === "anthropic-oauth") return `1:${key}`;
  return `2:${key}`;
}

function providerBaseKey(key: string): string {
  return key.startsWith("custom-openai-compat:") ? "custom-openai-compat" : key;
}

function providerLabelForAuthKey(
  key: string,
  baseUrl: string | undefined,
  catalogName: string | undefined,
  registryName: string | undefined,
): string {
  const baseKey = providerBaseKey(key);
  if (PROVIDER_LABEL_HINTS[baseKey]) return PROVIDER_LABEL_HINTS[baseKey];
  if (baseKey === "custom-openai-compat" && baseUrl) return titleWords(providerNameFromUrl(baseUrl));
  if (registryName) return registryName;
  if (catalogName) return catalogName;
  return titleWords(baseKey.replace(/[-_]+/g, " "));
}

function providerNameFromUrl(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname.replace(/^api\./, "");
    const parts = host.split(".").filter((part) => part && part !== "cloud" && part !== "ai" && part !== "com");
    return parts.reverse().join(" ");
  } catch {
    return "Custom";
  }
}

function titleWords(raw: string): string {
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.length <= 2 && /^[a-z]+$/i.test(word) ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1)))
    .join(" ");
}
