/**
 * Slash command registry.
 *
 * Lookup is keyed by the literal name the user types (e.g. "/model" → "model").
 * Each command's `run` is called with a SlashContext that exposes the App
 * state mutators it might want to touch — picking a model, clearing
 * transcript, opening an overlay, exiting.
 *
 * Skills (the `$` syntax) are a separate dispatch and do not collide.
 */
import { CODEX_MODELS, findCodexModel } from "@unionstreet/ai-codex";

export type OverlayState =
  | { kind: "model-picker" }
  | { kind: "add-provider" }
  | { kind: "create-profile"; initialName?: string }
  | { kind: "aside"; initialPrompt?: string }
  | { kind: "session-picker" }
  | { kind: "fallback-editor" }
  | { kind: "mcp" };

export interface SlashContext {
  arg?: string;
  state: {
    modelId: string;
    setModelId(id: string): void;
    clearTranscript(): void;
    newSession(): Promise<void>;
    exit(code: number): void;
    setOverlay(o: OverlayState | null): void;
    pushSystemNote(text: string): void;
    compact(): Promise<void>;
    showCost(): Promise<void>;
  };
}

export interface SlashCommand {
  name: string;
  summary: string;
  /** Optional arg name surfaced in `/help`. */
  arg?: string;
  /**
   * Safe to invoke while the main agent is mid-turn (thinking or running
   * tools)? Defaults to false — only set true for commands that don't
   * touch the running message stack or the active model.
   *   safe: /aside, /help, /exit
   * unsafe: /compact, /clear, /new, /model, @<peer>, $<skill>
   */
  allowDuringWork?: boolean;
  run(ctx: SlashContext): void | Promise<void>;
}

const help: SlashCommand = {
  name: "help",
  summary: "list slash commands",
  allowDuringWork: true,
  run(ctx) {
    const lines = [
      ...Object.values(REGISTRY).map((c) => {
        const usage = c.arg ? `/${c.name} <${c.arg}>` : `/${c.name}`;
        return `${usage.padEnd(18)}${c.summary}`;
      }),
    ];
    ctx.state.pushSystemNote(lines.join("\n"));
  },
};

const clear: SlashCommand = {
  name: "clear",
  summary: "forget conversation history (session file kept)",
  run(ctx) {
    ctx.state.clearTranscript();
  },
};

const newSession: SlashCommand = {
  name: "new",
  summary: "start a fresh session",
  async run(ctx) {
    await ctx.state.newSession();
  },
};

const exit: SlashCommand = {
  name: "exit",
  summary: "end the session",
  allowDuringWork: true,
  run(ctx) {
    ctx.state.exit(0);
  },
};

const model: SlashCommand = {
  name: "model",
  summary: "switch active model — opens picker if no arg",
  arg: "id",
  run(ctx) {
    if (ctx.arg) {
      const found = findCodexModel(ctx.arg);
      if (!found) {
        const known = CODEX_MODELS.map((m) => m.id).join(", ");
        ctx.state.pushSystemNote(`unknown model "${ctx.arg}". known: ${known}`);
        return;
      }
      ctx.state.setModelId(found.id);
      ctx.state.pushSystemNote(`model → ${found.id}`);
      return;
    }
    ctx.state.setOverlay({ kind: "model-picker" });
  },
};

const compact: SlashCommand = {
  name: "compact",
  summary: "summarize history into a memory anchor (manual trigger)",
  async run(ctx) {
    await ctx.state.compact();
  },
};

const cost: SlashCommand = {
  name: "cost",
  summary: "show token usage and spend for this session",
  allowDuringWork: true,
  async run(ctx) {
    await ctx.state.showCost();
  },
};

const resume: SlashCommand = {
  name: "resume",
  summary: "pick an older session to resume — replaces current chat",
  async run(ctx) {
    ctx.state.setOverlay({ kind: "session-picker" });
  },
};

const fallback: SlashCommand = {
  name: "fallback",
  summary: "edit the model fallback chain (auto-retry on auth/rate/5xx errors)",
  async run(ctx) {
    ctx.state.setOverlay({ kind: "fallback-editor" });
  },
};

const mcp: SlashCommand = {
  name: "mcp",
  summary: "show MCP server status",
  allowDuringWork: true,
  run(ctx) {
    ctx.state.setOverlay({ kind: "mcp" });
  },
};

const aside: SlashCommand = {
  name: "aside",
  summary: "open an ephemeral fork — esc to dismiss; main thread keeps running",
  arg: "question",
  allowDuringWork: true,
  async run(ctx) {
    ctx.state.setOverlay({ kind: "aside", initialPrompt: ctx.arg });
  },
};

export const REGISTRY: Record<string, SlashCommand> = Object.fromEntries(
  [help, clear, newSession, exit, model, fallback, compact, cost, resume, mcp, aside].map((c) => [c.name, c]),
);

export interface ParsedSlash {
  name: string;
  arg?: string;
}

/** Returns the parsed command, or null if `text` isn't a recognized slash. */
export function parseSlash(text: string): ParsedSlash | null {
  if (!text.startsWith("/")) return null;
  const stripped = text.slice(1).trimStart();
  const m = stripped.match(/^([A-Za-z][\w-]*)(?:\s+(.+))?$/);
  if (!m) return null;
  return { name: m[1]!, arg: m[2]?.trim() || undefined };
}
