import { promises as fs } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import type { ChatMessage, TokenUsage, ToolCall } from "@unionstreet/ai-codex";
import { createLashTrace } from "./lash-context.ts";
import { readModelChain, isRetryableError, type ModelTarget } from "./fallback.ts";
import { profileExists } from "./profile.ts";
import { profilePaths } from "./paths.ts";
import { STARTER_TOOLS, toolByName, toolDefinitions, type UsToolContext } from "./tools/index.ts";
import { streamModel } from "./model-client.ts";
import { writeEvent } from "./events.ts";
import { writeUsageRecord } from "./usage.ts";
import { resolveMcpToolsForAgent } from "./mcp-client.ts";

interface ProfileConfigYaml {
  model?: { provider?: string; id?: string };
  runtime?: { max_steps?: number };
}

export interface AgentPromptOptions {
  profile: string;
  prompt: string;
  cwd?: string;
  sessionId?: string;
  sessionFile?: string;
  trace?: string;
  maxSteps?: number;
  onText?(text: string): void;
  onToolResult?(name: string, result: string): void;
  onModelFallback?(from: ModelTarget, to: ModelTarget, error: Error): void;
}

export interface AgentPromptResult {
  profile: string;
  sessionId: string;
  sessionFile: string;
  trace: string;
  runId: string;
  provider: string;
  model: string;
  text: string;
  steps: number;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage: TokenUsage;
}

export async function runAgentPrompt(options: AgentPromptOptions): Promise<AgentPromptResult> {
  const profile = options.profile.replace(/^@+/, "").trim();
  if (!profile) throw new Error("profile is required");
  if (!options.prompt.trim()) throw new Error("prompt is required");
  if (!(await profileExists(profile))) throw new Error(`Profile "${profile}" does not exist.`);

  const paths = profilePaths(profile);
  const cfg = await readProfileConfig(paths.config);
  const providerId = cfg.model?.provider ?? "codex";
  const modelId = cfg.model?.id ?? "gpt-5.4";
  const maxSteps = options.maxSteps ?? cfg.runtime?.max_steps ?? 50;
  const systemPrompt = await composeSystemPrompt(profile, modelId, providerId);
  const session = await resolveSession(profile, paths.sessions, options.sessionId, options.sessionFile);
  const trace = options.trace ?? createLashTrace();
  const runId = `${profile}:${session.sessionId}`;
  const chain = await readModelChain(profile);
  const cwd = options.cwd ?? process.cwd();
  const tools = [...STARTER_TOOLS, ...(await resolveMcpToolsForAgent(profile, cwd))];
  const toolDefs = toolDefinitions(tools);
  const toolMap = toolByName(tools);
  const messages: ChatMessage[] = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
  messages.push({ role: "user", content: options.prompt });

  await writeEvent({
    type: "prompt.run.start",
    actor: profile,
    subject: profile,
    sessionId: session.sessionId,
    trace,
    outcome: "info",
    payload: { runId, promptLength: options.prompt.length, modelChain: chain },
  });
  await persist(session.sessionFile, {
    kind: "session_meta",
    provider: chain[0]?.provider ?? providerId,
    model: chain[0]?.id ?? modelId,
    trace,
    runId,
    ts: Date.now(),
  });
  await persist(session.sessionFile, { role: "user", content: options.prompt, trace, runId, ts: Date.now() });

  let activeModel = chain[0] ?? { provider: providerId, id: modelId };
  let text = "";
  let allToolCalls: ToolCall[] = [];
  let totalUsage = emptyUsage();

  try {
    for (let step = 1; step <= maxSteps; step++) {
      const stepResult = await streamOneStep({
        profile,
        sessionId: session.sessionId,
        systemPrompt,
        messages,
        tools: toolDefs,
        chain,
        preferred: activeModel,
        step,
        trace,
        runId,
        onText: options.onText,
        onModelFallback: options.onModelFallback,
      });
      activeModel = stepResult.model;
      text += stepResult.assistantText;
      allToolCalls = [...allToolCalls, ...stepResult.toolCalls];
      totalUsage = addUsage(totalUsage, stepResult.usage);

      messages.push({
        role: "assistant",
        content: stepResult.assistantText || undefined,
        tool_calls: stepResult.toolCalls.length ? stepResult.toolCalls : undefined,
      });
      await persist(session.sessionFile, {
        role: "assistant",
        content: stepResult.assistantText,
        tool_calls: stepResult.toolCalls,
        finish: stepResult.finishReason,
        provider: activeModel.provider,
        model: activeModel.id,
        ...(stepResult.usage ? { usage: stepResult.usage } : {}),
        trace,
        runId,
        step,
        ts: Date.now(),
      });
      if (stepResult.usage) {
        await writeModelUsageEvent({
          profile,
          sessionId: session.sessionId,
          trace,
          runId,
          step,
          provider: activeModel.provider,
          model: activeModel.id,
          usage: stepResult.usage,
        });
      }

      if (!stepResult.toolCalls.length) {
        await writeEvent({
          type: "prompt.run.complete",
          actor: profile,
          subject: profile,
          sessionId: session.sessionId,
          trace,
          outcome: "success",
          payload: { runId, model: activeModel, steps: step },
        });
        return {
          profile,
          sessionId: session.sessionId,
          sessionFile: session.sessionFile,
          trace,
          runId,
          provider: activeModel.provider,
          model: activeModel.id,
          text,
          steps: step,
          toolCalls: allToolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
          usage: totalUsage,
        };
      }

      for (const call of stepResult.toolCalls) {
        await writeEvent({
          type: "prompt.tool.call",
          actor: profile,
          subject: profile,
          sessionId: session.sessionId,
          trace,
          resource: `tool:${call.name}`,
          outcome: "info",
          payload: { runId, step, toolCallId: call.id, name: call.name },
        });
        const result = await executeTool(call, {
          cwd,
          callingPeer: profile,
          trace,
        }, toolMap);
        options.onToolResult?.(call.name, result);
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
        await persist(session.sessionFile, {
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: result,
          trace,
          runId,
          step,
          ts: Date.now(),
        });
      }
    }

    throw new Error(`MAX_STEPS=${maxSteps} reached`);
  } catch (error) {
    await writeEvent({
      type: "prompt.run.fail",
      actor: profile,
      subject: profile,
      sessionId: session.sessionId,
      trace,
      outcome: "failure",
      reason: (error as Error).message,
      payload: { runId, model: activeModel },
    });
    throw error;
  }
}

interface StreamStepInput {
  profile: string;
  sessionId: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  tools: ReturnType<typeof toolDefinitions>;
  chain: ModelTarget[];
  preferred: ModelTarget;
  step: number;
  trace: string;
  runId: string;
  onText?(text: string): void;
  onModelFallback?(from: ModelTarget, to: ModelTarget, error: Error): void;
}

interface StreamStepResult {
  model: ModelTarget;
  assistantText: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  usage?: TokenUsage;
}

async function streamOneStep(input: StreamStepInput): Promise<StreamStepResult> {
  const ordered = orderChain(input.chain, input.preferred);
  let lastError: unknown;

  for (let index = 0; index < ordered.length; index++) {
    const model = ordered[index]!;
    await writeEvent({
      type: "prompt.model.start",
      actor: input.profile,
      subject: input.profile,
      sessionId: input.sessionId,
      trace: input.trace,
      outcome: "info",
      payload: { runId: input.runId, step: input.step, model, attempt: index + 1 },
    });

    try {
      return await collectModelStream(input, model);
    } catch (error) {
      lastError = error;
      const retryable = isRetryableError(error);
      const hasNext = index < ordered.length - 1;
      if (!retryable || !hasNext) throw error;
      const next = ordered[index + 1]!;
      await writeEvent({
        type: "prompt.model.fallback",
        actor: input.profile,
        subject: input.profile,
        sessionId: input.sessionId,
        trace: input.trace,
        outcome: "info",
        reason: (error as Error).message,
        payload: { runId: input.runId, step: input.step, from: model, to: next },
      });
      input.onModelFallback?.(model, next, error as Error);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "model stream failed"));
}

async function collectModelStream(input: StreamStepInput, model: ModelTarget): Promise<StreamStepResult> {
  let assistantText = "";
  const toolCalls: ToolCall[] = [];
  let finishReason: string | undefined;
  let usage: TokenUsage | undefined;

  for await (const ev of streamModel({
    profile: input.profile,
    provider: model.provider,
    model: model.id,
    system: input.systemPrompt,
    messages: input.messages,
    tools: input.tools,
    sessionId: input.sessionId,
  })) {
    if (ev.type === "text-delta") {
      assistantText += ev.text;
      input.onText?.(ev.text);
    } else if (ev.type === "tool-call") {
      toolCalls.push(ev.call);
    } else if (ev.type === "finish") {
      finishReason = ev.reason;
      usage = ev.usage ?? usage;
    } else if (ev.type === "error") {
      throw new Error(ev.error);
    }
  }

  return { model, assistantText, toolCalls, finishReason, usage };
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total: 0 };
}

function addUsage(total: TokenUsage, next: TokenUsage | undefined): TokenUsage {
  if (!next) return total;
  const input = total.input + next.input;
  const output = total.output + next.output;
  const reasoning = (total.reasoning ?? 0) + (next.reasoning ?? 0);
  const cacheRead = (total.cache_read ?? 0) + (next.cache_read ?? 0);
  const cacheWrite = (total.cache_write ?? 0) + (next.cache_write ?? 0);
  return {
    input,
    output,
    reasoning,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    total: total.total + next.total,
  };
}

async function writeModelUsageEvent(input: {
  profile: string;
  sessionId: string;
  trace: string;
  runId: string;
  step: number;
  provider: string;
  model: string;
  usage: TokenUsage;
}): Promise<void> {
  await writeEvent({
    type: "model.usage",
    actor: input.profile,
    subject: input.profile,
    sessionId: input.sessionId,
    trace: input.trace,
    resource: `model:${input.provider}/${input.model}`,
    outcome: "success",
    payload: {
      runId: input.runId,
      step: input.step,
      provider: input.provider,
      model: input.model,
      usage: input.usage,
    },
  });
  await writeUsageRecord({
    actor: input.profile,
    provider: input.provider,
    model: input.model,
    sessionId: input.sessionId,
    trace: input.trace,
    runId: input.runId,
    step: input.step,
    kind: "prompt",
    usage: input.usage,
  });
}

function orderChain(chain: ModelTarget[], preferred: ModelTarget): ModelTarget[] {
  const normalized = chain.length ? chain : [preferred];
  const idx = normalized.findIndex((item) => item.provider === preferred.provider && item.id === preferred.id);
  if (idx <= 0) return normalized;
  return [...normalized.slice(idx), ...normalized.slice(0, idx)];
}

async function executeTool(
  call: ToolCall,
  ctx: UsToolContext,
  toolMap: ReturnType<typeof toolByName>,
): Promise<string> {
  try {
    const tool = toolMap.get(call.name);
    if (!tool) return `error: unknown tool "${call.name}"`;
    const args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    return await tool.execute(args, ctx);
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

async function readProfileConfig(path: string): Promise<ProfileConfigYaml> {
  try {
    return (yaml.load(await fs.readFile(path, "utf8")) ?? {}) as ProfileConfigYaml;
  } catch {
    return {};
  }
}

async function composeSystemPrompt(profileName: string, modelId: string, provider: string): Promise<string> {
  const paths = profilePaths(profileName);
  const sections: string[] = [
    `<UNION_STREET>\nYou are @${profileName}, an agent running inside Union Street. Preserve Lash chain-of-command visibility, use tools only through granted capabilities, and report material results upward.\nModel: ${provider}/${modelId}\n</UNION_STREET>`,
  ];
  for (const [label, path] of [
    ["IDENTITY", paths.identity],
    ["SOUL", paths.soul],
    ["AGENTS", paths.agents],
    ["USER", paths.user],
    ["TOOLS", paths.tools],
    ["MEMORY", paths.memory],
  ] as const) {
    try {
      const raw = (await fs.readFile(path, "utf8")).trim();
      if (raw) sections.push(`<${label}>\n${raw}\n</${label}>`);
    } catch {
      // Optional profile bootstrap file.
    }
  }
  return sections.join("\n\n");
}

async function resolveSession(profile: string, sessionsDir: string, sessionId?: string, sessionFile?: string): Promise<{ sessionId: string; sessionFile: string }> {
  await fs.mkdir(sessionsDir, { recursive: true });
  if (sessionFile) {
    return {
      sessionId: sessionId ?? sessionFile.replace(/^.*\//, "").replace(/\.jsonl$/, ""),
      sessionFile,
    };
  }
  const id = sessionId ?? `${profile}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  return { sessionId: id, sessionFile: join(sessionsDir, `${id}.jsonl`) };
}

async function persist(sessionFile: string, entry: unknown): Promise<void> {
  await fs.appendFile(sessionFile, JSON.stringify(entry) + "\n");
}
