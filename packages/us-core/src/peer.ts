/**
 * Server-side peer turn runner used by the Lash MCP adapter.
 *
 * Run a single-shot conversation with another profile, returning their
 * response as text. The target peer:
 *   - loads their own SOUL.md, IDENTITY.md, etc.
 *   - resolves auth via the shared/profile-overridden auth-profiles.json
 *   - runs ONE turn (no tools, no follow-ups) with an attribution header
 *   - returns the streamed text
 *
 * The user-facing `delegate`/`report` tools call peers through MCP now;
 * this function is the target-side model invocation behind that MCP tool.
 */
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import yaml from "js-yaml";
import { type ChatMessage, type TokenUsage } from "@unionstreet/ai-codex";
import type { LashEnvelope, LashThread } from "@lashprotocol/lash";
import { profilePaths } from "./paths.ts";
import { profileExists } from "./profile.ts";
import { readAgentPack } from "./agent-pack.ts";
import { streamModel } from "./model-client.ts";
import { canDelegateTo, resolveDelegationTargets } from "./federation.ts";
import { nextLashContext, lashTextResult, type LashChainHop } from "./lash-context.ts";
import { writeMemoryEvent, type MemoryEventKind } from "./memory.ts";
import { writeEvent } from "./events.ts";
import { writeUsageRecord } from "./usage.ts";

export interface PeerCallOptions {
  /** The profile making the call (used in the attribution header). */
  callingPeer: string;
  /** The profile being called. Plain name, no `@`. */
  targetPeer: string;
  /** Message to send. */
  message: string;
  /** Deprecated: auth now resolves from the target profile's provider. */
  token?: string;
  trace?: string;
  thread?: LashThread;
  chain?: LashChainHop[];
  wakeKind?: "delegate" | "report";
  signal?: AbortSignal;
  /** Verbosity hint for the response — defaults to "low" since the caller is reading it as a tool result. */
  textVerbosity?: "low" | "medium" | "high";
}

export interface PeerCallResult {
  ok: boolean;
  response?: string;
  envelope?: LashEnvelope;
  trace?: string;
  thread?: LashThread;
  chain?: LashChainHop[];
  delegation?: { relation?: string; depth?: number };
  modelId?: string;
  usage?: TokenUsage;
  error?: string;
}

const PEER_BASE_PROMPT = (target: string, caller: string, others: string[], lash: { trace: string; thread: LashThread; chain: LashChainHop[] }) =>
  `# You are running inside the Union Street ("us") agent harness.

## Identity
- Your profile name is **@${target}**.
- You are a sovereign peer being **delegated to** by **@${caller}**.
- Other peers in this instance: ${
    others.length ? others.map((n) => `\`@${n}\``).join(", ") : "(none besides yourself)"
  }.

## Mode: peer-delegation (one-shot)
You are answering a single message from another peer. There is no
multi-turn conversation here — give the best single answer you can. No
tools are available in this mode (yet); reason from your own knowledge
and your bootstrap files.

## Lash command context
- trace: \`${lash.trace}\`
- thread: \`${lash.thread.id}\` turn ${lash.thread.turn}
- command chain: ${lash.chain.map((hop) => `@${hop.from} -> @${hop.to}`).join(" -> ")}

Preserve the chain of command: answer the delegated task, and make any
uncertainty explicit so truth can flow back up the chain.

## Conventions
- Be concise. The caller will paste your response back into their own
  context, so brevity helps them not blow their own token budget.
- Speak from YOUR identity, not theirs. Your SOUL.md and IDENTITY.md
  are below.`;

export async function peerCall(opts: PeerCallOptions): Promise<PeerCallResult> {
  if (opts.targetPeer === opts.callingPeer) {
    return { ok: false, error: "cannot delegate to yourself" };
  }
  const decision = await canDelegateTo(opts.callingPeer, opts.targetPeer);
  if (!decision.allowed) {
    return { ok: false, error: decision.reason };
  }
  if (!(await profileExists(opts.targetPeer))) {
    return { ok: false, error: `peer "@${opts.targetPeer}" does not exist` };
  }

  const lash = nextLashContext({
    caller: opts.callingPeer,
    target: opts.targetPeer,
    trace: opts.trace,
    thread: opts.thread,
    chain: opts.chain,
  });

  const targetPaths = profilePaths(opts.targetPeer);

  const { provider, modelId } = await resolvePeerModel(opts.targetPeer, targetPaths.config);
  const wakeSession = await ensureWakeSession({
    targetPeer: opts.targetPeer,
    callingPeer: opts.callingPeer,
    provider,
    modelId,
    message: opts.message,
    trace: lash.trace,
    thread: lash.thread,
    chain: lash.chain,
    wakeKind: opts.wakeKind ?? "delegate",
  });

  // Build the target's system prompt.
  const targetVisiblePeers = await resolveDelegationTargets(opts.targetPeer);
  const others = targetVisiblePeers.map((target) => target.profile);
  const bootstrap = await readBootstrap(targetPaths);
  const systemPrompt = [
    PEER_BASE_PROMPT(opts.targetPeer, opts.callingPeer, others, lash),
    ...bootstrap,
  ].join("\n\n");

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...wakeSession.history,
    {
      role: "user",
      content: `Lash trace: ${lash.trace}
Lash thread: ${lash.thread.id} turn ${lash.thread.turn}
Caller: @${opts.callingPeer} (verified at MCP boundary)

Message from @${opts.callingPeer}:

${opts.message}`,
    },
  ];

  let response = "";
  let usage: TokenUsage | undefined;
  if (process.env.US_PEER_CALL_STUB === "1") {
    response = [
      `[stub] @${opts.targetPeer} woke via ${opts.wakeKind ?? "delegate"} from @${opts.callingPeer}.`,
      `model=${provider}/${modelId}`,
      `trace=${lash.trace}`,
      `thread=${lash.thread.id}#${lash.thread.turn}`,
      `message=${opts.message}`,
    ].join("\n");
    usage = { input: 1, output: 1, reasoning: 0, cache_read: 0, cache_write: 0, total: 2 };
  } else {
    try {
      for await (const ev of streamModel({
        profile: opts.targetPeer,
        provider,
        model: modelId,
        system: systemPrompt,
        messages,
        textVerbosity: opts.textVerbosity ?? "low",
        sessionId: wakeSession.sessionId,
        signal: opts.signal,
      })) {
        if (ev.type === "text-delta") response += ev.text;
        else if (ev.type === "finish") usage = ev.usage ?? usage;
        else if (ev.type === "error") {
          return { ok: false, error: ev.error };
        }
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  const trimmed = response.trim();
  const text = trimmed.length ? trimmed : "(empty response)";
  const envelope = lashTextResult(text, {
    from: opts.targetPeer,
    trace: lash.trace,
    thread: lash.thread,
  });
  await appendSessionJsonl(opts.targetPeer, wakeSession.sessionId, wakeSession.sessionFile, {
    role: "assistant",
    content: text,
    provider,
    model: modelId,
    ...(usage ? { usage } : {}),
    trace: lash.trace,
    thread: lash.thread,
    ts: Date.now(),
  });
  if (usage) {
    await writeEvent({
      type: "model.usage",
      actor: opts.targetPeer,
      subject: opts.targetPeer,
      target: opts.callingPeer,
      sessionId: wakeSession.sessionId,
      trace: lash.trace,
      threadId: lash.thread.id,
      resource: `model:${provider}/${modelId}`,
      outcome: "success",
      payload: {
        wake: opts.wakeKind ?? "delegate",
        from: opts.callingPeer,
        provider,
        model: modelId,
        usage,
      },
    });
    await writeUsageRecord({
      actor: opts.targetPeer,
      provider,
      model: modelId,
      sessionId: wakeSession.sessionId,
      trace: lash.trace,
      threadId: lash.thread.id,
      kind: "lash",
      usage,
      metadata: {
        wake: opts.wakeKind ?? "delegate",
        from: opts.callingPeer,
      },
    });
  }
  return {
    ok: true,
    response: text,
    envelope,
    trace: lash.trace,
    thread: lash.thread,
    chain: lash.chain,
    delegation: { relation: decision.relation, depth: decision.depth },
    modelId,
    ...(usage ? { usage } : {}),
  };
}

async function ensureWakeSession(input: {
  targetPeer: string;
  callingPeer: string;
  provider: string;
  modelId: string;
  message: string;
  trace: string;
  thread: LashThread;
  chain: LashChainHop[];
  wakeKind: "delegate" | "report";
}): Promise<{ sessionId: string; sessionFile: string; history: ChatMessage[] }> {
  const paths = profilePaths(input.targetPeer);
  await fs.mkdir(paths.sessions, { recursive: true });
  const sessionId = `lash-${safeId(input.thread.id)}-${hashId(input.trace)}`;
  const sessionFile = join(paths.sessions, `${sessionId}.jsonl`);
  const history = await readWakeHistory(sessionFile);
  await appendSessionJsonl(input.targetPeer, sessionId, sessionFile, {
    kind: "session_meta",
    provider: input.provider,
    model: input.modelId,
    ts: Date.now(),
  });
  await appendSessionJsonl(input.targetPeer, sessionId, sessionFile, {
    kind: "lash_wake",
    wake: input.wakeKind,
    trace: input.trace,
    thread: input.thread,
    from: input.callingPeer,
    to: input.targetPeer,
    chain: input.chain,
    ts: Date.now(),
  });
  await appendSessionJsonl(input.targetPeer, sessionId, sessionFile, {
    role: "user",
    content: input.message,
    trace: input.trace,
    thread: input.thread,
    ts: Date.now(),
  });
  return { sessionId, sessionFile, history };
}

async function readWakeHistory(path: string): Promise<ChatMessage[]> {
  let raw = "";
  try {
    raw = await fs.readFile(path, "utf8");
  } catch {
    return [];
  }
  const messages: ChatMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line) as { role?: string; content?: unknown };
      if ((item.role === "user" || item.role === "assistant") && typeof item.content === "string" && item.content.trim()) {
        messages.push({ role: item.role, content: item.content });
      }
    } catch {
      // Ignore corrupt historical rows; they should not block a wake.
    }
  }
  return messages.slice(-20);
}

async function appendJsonl(path: string, entry: unknown): Promise<void> {
  await fs.appendFile(path, JSON.stringify(entry) + "\n");
}

async function appendSessionJsonl(
  peer: string,
  sessionId: string,
  path: string,
  entry: Record<string, unknown>,
): Promise<void> {
  await appendJsonl(path, entry);
  await writeMemoryEvent({
    kind: eventKindForSessionEntry(entry),
    peer,
    sessionId,
    trace: typeof entry.trace === "string" ? entry.trace : undefined,
    thread: entry.thread,
    role: typeof entry.role === "string" ? entry.role : undefined,
    ts: typeof entry.ts === "number" ? entry.ts : Date.now(),
    payload: entry,
  });
}

function eventKindForSessionEntry(entry: Record<string, unknown>): MemoryEventKind {
  if (entry.kind === "lash_wake") return "lash.wake";
  if (entry.kind === "session_meta") return "session.meta";
  if (entry.role === "tool") return "tool.result";
  if (entry.role) return "session.message";
  return "audit.event";
}

async function resolvePeerModel(profile: string, configPath: string): Promise<{ provider: string; modelId: string }> {
  try {
    const pack = await readAgentPack(profile);
    return {
      provider: pack.model.primary.provider,
      modelId: pack.model.primary.id,
    };
  } catch {
    // Fall back to legacy config.yaml for pre-pack profiles.
  }

  let cfg: { model?: { id?: string; provider?: string } } = {};
  try {
    const raw = await fs.readFile(configPath, "utf8");
    cfg = (yaml.load(raw) as typeof cfg) ?? {};
  } catch {
    /* missing config — use defaults */
  }
  return {
    provider: cfg.model?.provider ?? "codex",
    modelId: cfg.model?.id ?? "gpt-5.4",
  };
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "thread";
}

function hashId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

async function readBootstrap(paths: ReturnType<typeof profilePaths>): Promise<string[]> {
  const sections: string[] = [];
  for (const [label, path] of [
    ["IDENTITY", paths.identity],
    ["SOUL", paths.soul],
    ["AGENTS", paths.agents],
    ["TOOLS", paths.tools],
    ["MEMORY", paths.memory],
  ] as const) {
    try {
      const raw = (await fs.readFile(path, "utf8")).trim();
      if (raw) sections.push(`<${label}>\n${raw}\n</${label}>`);
    } catch {
      /* skip */
    }
  }
  return sections;
}
