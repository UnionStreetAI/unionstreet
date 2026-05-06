/**
 * Context engine contract.
 *
 * Hermes' useful abstraction is that context management is not "the
 * compressor"; it is a selected engine with lifecycle, usage tracking,
 * status, optional tools, and a compression decision. Union Street keeps
 * that shape so an LCM/DAG engine can replace the default compressor
 * without changing chat, runtime, or gateway code.
 */
import type { ChatMessage, TokenUsage, ToolDefinition } from "@unionstreet/ai-codex";
import {
  compactSession,
  type CompactInput,
  type CompactResult,
} from "./compactor.ts";
import {
  DEFAULT_COMPACTION,
  estimateMessagesTokens,
  type CompactionSettings,
} from "./compaction.ts";

export interface ContextEngineConfig {
  engine: "compressor";
  compressor: CompressorEngineConfig;
}

export interface CompressorEngineConfig {
  enabled: boolean;
  /** Agent loop compression threshold as fraction of model context. Hermes defaults to 0.50. */
  threshold: number;
  /** Pre-agent hygiene threshold as fraction of model context. Hermes uses 0.85. */
  gatewayHygieneThreshold: number;
  /** How much of the compression threshold to preserve as recent tail budget. */
  targetRatio: number;
  /** Minimum recent user turns to preserve. */
  protectLastTurns: number;
  /** Maximum old tool output bytes sent to the summarizer. */
  truncateToolOutput: number;
  protectedTools: string[];
}

export const DEFAULT_CONTEXT_ENGINE_CONFIG: ContextEngineConfig = {
  engine: "compressor",
  compressor: {
    enabled: true,
    threshold: 0.5,
    gatewayHygieneThreshold: 0.85,
    targetRatio: 0.2,
    protectLastTurns: 2,
    truncateToolOutput: DEFAULT_COMPACTION.truncateToolOutput,
    protectedTools: [],
  },
};

export interface ContextEngineStatus {
  name: string;
  sessionId?: string;
  contextWindow: number;
  thresholdTokens: number;
  gatewayHygieneTokens: number;
  lastPromptTokens: number;
  lastCompletionTokens: number;
  lastTotalTokens: number;
  compressionCount: number;
  pressure: number;
}

export interface ContextEngine {
  readonly name: string;
  onSessionStart(sessionId: string): void;
  onSessionReset(sessionId?: string): void;
  updateModel(model: string, contextWindow: number): void;
  updateFromUsage(usage: TokenUsage): void;
  shouldCompress(promptTokens?: number): boolean;
  shouldGatewayHygiene(messages: ChatMessage[], promptTokens?: number): boolean;
  compress(input: Omit<CompactInput, "settings" | "contextWindow">): Promise<CompactResult>;
  getStatus(): ContextEngineStatus;
  getToolSchemas(): ToolDefinition[];
  handleToolCall(name: string, args: Record<string, unknown>): Promise<string>;
}

export function createContextEngine(config: ContextEngineConfig = DEFAULT_CONTEXT_ENGINE_CONFIG): ContextEngine {
  switch (config.engine) {
    case "compressor":
      return new CompressorContextEngine(config.compressor);
  }
}

export class CompressorContextEngine implements ContextEngine {
  readonly name = "compressor";
  private sessionId: string | undefined;
  private model = "";
  private contextWindow = 0;
  private lastPromptTokens = 0;
  private lastCompletionTokens = 0;
  private lastTotalTokens = 0;
  private compressionCount = 0;

  constructor(private readonly config: CompressorEngineConfig = DEFAULT_CONTEXT_ENGINE_CONFIG.compressor) {}

  onSessionStart(sessionId: string): void {
    this.sessionId = sessionId;
    this.resetCounters();
  }

  onSessionReset(sessionId?: string): void {
    this.sessionId = sessionId;
    this.resetCounters();
  }

  updateModel(model: string, contextWindow: number): void {
    this.model = model;
    this.contextWindow = Math.max(0, Math.floor(contextWindow));
  }

  updateFromUsage(usage: TokenUsage): void {
    this.lastPromptTokens = usage.input + (usage.cache_read ?? 0) + (usage.cache_write ?? 0);
    this.lastCompletionTokens = usage.output + (usage.reasoning ?? 0);
    this.lastTotalTokens = usage.total;
  }

  shouldCompress(promptTokens = this.lastTotalTokens): boolean {
    if (!this.config.enabled) return false;
    if (promptTokens <= 0 || this.contextWindow <= 0) return false;
    return promptTokens >= this.thresholdTokens();
  }

  shouldGatewayHygiene(messages: ChatMessage[], promptTokens = this.lastTotalTokens): boolean {
    if (!this.config.enabled || messages.length < 4 || this.contextWindow <= 0) return false;
    const estimated = promptTokens > 0 ? promptTokens : estimateMessagesTokens(messages);
    return estimated >= this.gatewayHygieneTokens();
  }

  async compress(input: Omit<CompactInput, "settings" | "contextWindow">): Promise<CompactResult> {
    const result = await compactSession({
      ...input,
      contextWindow: this.contextWindow,
      settings: this.compactionSettings(),
    });
    this.compressionCount += 1;
    this.lastTotalTokens = result.tokensAfter;
    return result;
  }

  getStatus(): ContextEngineStatus {
    return {
      name: this.name,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      contextWindow: this.contextWindow,
      thresholdTokens: this.thresholdTokens(),
      gatewayHygieneTokens: this.gatewayHygieneTokens(),
      lastPromptTokens: this.lastPromptTokens,
      lastCompletionTokens: this.lastCompletionTokens,
      lastTotalTokens: this.lastTotalTokens,
      compressionCount: this.compressionCount,
      pressure: this.contextWindow > 0 ? this.lastTotalTokens / this.contextWindow : 0,
    };
  }

  getToolSchemas(): ToolDefinition[] {
    return [];
  }

  async handleToolCall(name: string): Promise<string> {
    return JSON.stringify({ error: `context engine "${this.name}" has no tool "${name}"` });
  }

  private compactionSettings(): CompactionSettings {
    return {
      enabled: this.config.enabled,
      reserveTokens: Math.max(1, this.contextWindow - this.thresholdTokens()),
      preserveRecentTokens: Math.max(1, Math.floor(this.thresholdTokens() * this.config.targetRatio)),
      tailTurns: this.config.protectLastTurns,
      truncateToolOutput: this.config.truncateToolOutput,
      protectedTools: this.config.protectedTools,
    };
  }

  private thresholdTokens(): number {
    return Math.floor(this.contextWindow * clamp01(this.config.threshold));
  }

  private gatewayHygieneTokens(): number {
    return Math.floor(this.contextWindow * clamp01(this.config.gatewayHygieneThreshold));
  }

  private resetCounters(): void {
    this.lastPromptTokens = 0;
    this.lastCompletionTokens = 0;
    this.lastTotalTokens = 0;
    this.compressionCount = 0;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
