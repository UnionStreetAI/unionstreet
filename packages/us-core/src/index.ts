/**
 * @unionstreet/us-core
 *
 * Composition layer over the Vercel AI SDK's `Agent` class. We do not
 * implement the agent loop — `ai` does. We assemble a configured `Agent`
 * from a profile:
 *
 *   - load profile bootstrap files (SOUL.md, IDENTITY.md, ...)
 *   - assemble a modular system prompt (openclaw-style sections)
 *   - wire context engine into AI SDK's `prepareStep` hook
 *   - register tools: lash peer (delegate, query), channel, storage, memory
 *   - resolve credentials from the profile's auth-profiles.json
 */

export const VERSION = "0.0.0";

export type ProfileName = string;

export interface ProfilePaths {
  root: string;
  soul: string;
  identity: string;
  agents: string;
  user: string;
  tools: string;
  memory: string;
  memoryDir: string;
  sessions: string;
  skills: string;
  agentPack: string;
  authProfiles: string;
  config: string;
  env: string;
  state: string;
}

export interface ProfileConfig {
  name: ProfileName;
  paths: ProfilePaths;
  /** Resolved bootstrap file contents, trimmed per openclaw conventions (12k cap). */
  bootstrap: {
    soul?: string;
    identity?: string;
    agents?: string;
    user?: string;
    tools?: string;
    memory?: string;
  };
  /** Parsed config.yaml. */
  raw: unknown;
}

export type PromptMode = "full" | "minimal" | "none";

export {
  US_HOME,
  PROFILES_DIR,
  REGISTRY_PATH,
  FEDERATION_PATH,
  FEDERATION_KEYS_PATH,
  EVENTS_DIR,
  EVENTS_PATH,
  USAGE_DIR,
  USAGE_PATH,
  SCHEDULER_DIR,
  SCHEDULER_RUNS_PATH,
  GLOBAL_AUTH_PROFILES_PATH,
  profilePaths,
} from "./paths.ts";
export {
  initProfile,
  profileExists,
  listProfiles,
  updateProfileConfig,
  setProfileModel,
} from "./profile.ts";
export type { InitOptions, InitResult } from "./profile.ts";
export {
  AGENT_PACK_FILENAME,
  buildAgentPackFromOrgNode,
  buildDemoAgentPacks,
  normalizeAgentPack,
  readAgentPack,
  writeAgentPack,
} from "./agent-pack.ts";
export type {
  AgentPack,
  AgentPackIdentity,
  AgentPackOidc,
  AgentPackLash,
  AgentPackMemory,
  AgentPackModelTarget,
  AgentPackPulse,
  AgentPackRuntime,
  AgentPackSchedule,
  AgentPackToolkit,
} from "./agent-pack.ts";
export {
  readAuthProfiles,
  updateAuthProfiles,
  resolveAuthProfiles,
  mergeAuthProfiles,
  redactCred,
  redactMcpCred,
  EMPTY_AUTH_PROFILES,
} from "./auth-profiles.ts";
export type {
  AuthProfilesFile,
  ProviderCred,
  OAuthCred,
  ApiKeyCred,
  McpCred,
  McpApiKeyCred,
  McpOAuthCred,
  ProviderAccounting,
  ResolvedAuth,
} from "./auth-profiles.ts";

export {
  GLOBAL_CONFIG_PATH,
  readGlobalConfig,
  writeGlobalConfig,
  setDefaultProfile,
  resolveProfile,
  NoProfileError,
} from "./global-config.ts";
export type { GlobalConfig, ResolvedDefault } from "./global-config.ts";

export {
  STARTER_TOOLS,
  toolDefinitions,
  toolByName,
} from "./tools/index.ts";
export type { UsTool, UsToolContext } from "./tools/index.ts";

export {
  estimateTokens,
  estimateMessagesTokens,
  shouldCompact,
  findCutPoint,
  findExistingAnchor,
  resolvePreserveBudget,
  ANCHOR_MARKER,
  DEFAULT_COMPACTION,
} from "./compaction.ts";
export type {
  CompactionSettings,
  CutPointResult,
  ShouldCompactInput,
} from "./compaction.ts";

export { compactSession } from "./compactor.ts";
export type { CompactInput, CompactResult } from "./compactor.ts";

export {
  CompressorContextEngine,
  DEFAULT_CONTEXT_ENGINE_CONFIG,
  createContextEngine,
} from "./context-engine.ts";
export type {
  CompressorEngineConfig,
  ContextEngine,
  ContextEngineConfig,
  ContextEngineStatus,
} from "./context-engine.ts";

export {
  FileMemoryStore,
  HonchoMemoryStore,
  queryMemoryEvents,
  readMemoryEvents,
  resolveMemorySyncConfig,
  writeMemoryEvent,
} from "./memory.ts";
export type { MemoryStore, AnchorRecord, MemoryEvent, MemoryEventKind, MemoryEventQuery, MemorySyncConfig } from "./memory.ts";

export {
  listSessions,
  readSession,
  sessionAgeLabel,
  shortSessionLabel,
} from "./sessions.ts";
export type { SessionInfo, ReplayResult, ReplayTurn } from "./sessions.ts";

export { peerCall } from "./peer.ts";
export type { PeerCallOptions, PeerCallResult } from "./peer.ts";

export { streamModel, normalizeProvider } from "./model-client.ts";
export type { StreamModelOptions, ModelProvider } from "./model-client.ts";

export { PROVIDERS, findProvider } from "./providers.ts";
export type { ProviderInfo, ProviderRegion, ProviderAuthMethod } from "./providers.ts";

export { readModelChain, setFallbackChain, isRetryableError } from "./fallback.ts";
export type { ModelTarget } from "./fallback.ts";

export { sanitizeOpenAICompatBaseUrl } from "./base-url.ts";

export {
  ensureFederationConfig,
  readFederationConfig,
  resolveAgentPrincipal,
  resolveMcpGrantsForAgent,
  resolveDelegationTargets,
  canDelegateTo,
  federatedAgentMcpAudience,
  mintFederatedAgentToken,
  verifyFederatedAgentToken,
  readFederationJwks,
  verifyExternalOidcToken,
  buildDemoFederationConfig,
} from "./federation.ts";
export type {
  FederationConfig,
  FederationGrant,
  FederationPrincipal,
  FederationOidcProvider,
  FederatedAgentIdentity,
  FederatedClaims,
  ExternalFederatedIdentity,
  McpGrantDecision,
  FederationOrgNode,
  DelegationDecision,
  DelegationTarget,
  DelegationRelation,
} from "./federation.ts";

export {
  createLashTrace,
  createLashThread,
  nextLashContext,
  lashTextResult,
} from "./lash-context.ts";
export type { LashCallContext, LashChainHop } from "./lash-context.ts";

export {
  callLashPeerTool,
  createLashPeerServer,
  startLashPeerStdioServer,
} from "./lash-mcp.ts";
export type { LashPeerCallArgs, LashPeerMethod } from "./lash-mcp.ts";

export { inspectMcpStatus } from "./mcp-status.ts";
export type { McpStatus, McpServerInfo } from "./mcp-status.ts";
export { resolveMcpToolsForAgent } from "./mcp-client.ts";

export {
  deleteMcpCredential,
  getMcpCredential,
  getMcpCredentialStatus,
  listMcpCredentials,
  normalizeMcpServerName,
  saveMcpApiKeyCredential,
  saveMcpOAuthCredential,
} from "./mcp-auth.ts";
export type {
  McpCredentialStatus,
  SaveMcpApiKeyOptions,
  SaveMcpOAuthOptions,
} from "./mcp-auth.ts";

export {
  exchangeMcpOAuthCallback,
  parseCallbackOrCode,
  startMcpOAuth,
} from "./mcp-oauth.ts";
export type {
  McpOAuthMetadata,
  McpOAuthStart,
  McpOAuthTokenResponse,
} from "./mcp-oauth.ts";

export {
  queryEvents,
  readEvents,
  tailEvents,
  writeEvent,
} from "./events.ts";

export {
  queryUsageRecords,
  readUsageRecords,
  summarizeUsage,
  writeUsageRecord,
} from "./usage.ts";
export type {
  UsageQuery,
  UsageRecord,
  UsageSummary,
} from "./usage.ts";
export type {
  ControlPlaneEvent,
  ControlPlaneEventType,
  EventQuery,
} from "./events.ts";

export {
  claimDueSchedulerJobs,
  dueSchedulerJobs,
  executeSchedulerRun,
  listSchedulerJobs,
  readSchedulerRuns,
} from "./scheduler.ts";
export type {
  DueSchedulerJob,
  SchedulerExecutor,
  SchedulerExecutorResult,
  SchedulerJob,
  SchedulerJobKind,
  SchedulerRun,
  SchedulerRunStatus,
} from "./scheduler.ts";

export {
  runAgentPrompt,
} from "./prompt-runner.ts";
export type {
  AgentPromptOptions,
  AgentPromptResult,
} from "./prompt-runner.ts";

export {
  DEFAULT_RUNTIME,
  ensureAgentWorkspace,
  resolveAgentRuntime,
} from "./cloud-runtime.ts";
export type {
  AgentRuntimeConfig,
  RuntimeComputeConfig,
  ResolvedAgentRuntime,
  RuntimeHeadConfig,
  RuntimeIngressConfig,
  RuntimeProvider,
  RuntimeStorageConfig,
  RuntimeWorkspaceConfig,
  WorkspaceScope,
} from "./cloud-runtime.ts";

export {
  dumpKubernetesManifests,
  renderAgentKubernetesManifests,
  validateKubernetesManifests,
} from "./kubernetes-runtime.ts";
export type {
  KubernetesAgentWorkloadKind,
  KubernetesManifest,
  KubernetesManifestValidation,
  KubernetesRenderedManifest,
  KubernetesRenderOptions,
} from "./kubernetes-runtime.ts";

export {
  dumpSecretRegistry,
  materializeAgentSecrets,
  readSecretRegistry,
  resolveSecretGrantsForAgent,
} from "./secrets.ts";
export type {
  ResolvedSecretGrant,
  SecretAudience,
  SecretEntryConfig,
  SecretMaterialization,
  SecretProviderConfig,
  SecretProviderType,
  SecretRegistry,
} from "./secrets.ts";

export {
  getModelsRegistry,
  getModelsForAuthKey,
  getProviderLabel,
  authKeyToRegistryId,
} from "./models-dev.ts";
export type { Registry, RegistryProvider, RegistryModel } from "./models-dev.ts";

export {
  discoverModelGroups,
} from "./model-discovery.ts";
export type {
  DiscoveredModel,
  DiscoveredModelGroup,
  ModelDiscoveryOptions,
} from "./model-discovery.ts";
