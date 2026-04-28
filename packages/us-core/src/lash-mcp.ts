import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  callToolResult,
  lashError,
  lashTool,
  threadSchema,
  type LashEnvelope,
  type LashThread,
} from "@lashprotocol/lash";
import {
  canDelegateTo,
  federatedAgentMcpAudience,
  mintFederatedAgentToken,
  resolveAgentPrincipal,
  verifyFederatedAgentToken,
  type FederatedClaims,
} from "./federation.ts";
import { peerCall } from "./peer.ts";
import {
  createLashThread,
  createLashTrace,
  lashEnvelopeValue,
  parseLashEnvelope,
  parseLashThread,
} from "./lash-context.ts";
import { writeEvent } from "./events.ts";

export type LashPeerMethod = "delegate" | "report";

export interface LashPeerCallArgs {
  from: string;
  callerToken?: string;
  caller_token?: string;
  message?: string;
  prompt?: string;
  payload?: unknown;
  envelope?: LashEnvelope;
  trace?: string;
  thread?: LashThread;
}

export async function callLashPeerTool(opts: {
  targetPeer: string;
  method: LashPeerMethod;
  arguments: LashPeerCallArgs;
}): Promise<CallToolResult> {
  const client = new Client({ name: "union-street-lash-client", version: "0.0.0" });
  const server = createLashPeerServer(opts.targetPeer);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const callerToken = opts.arguments.callerToken ?? opts.arguments.caller_token ?? await mintPeerCallerToken(opts.arguments.from, opts.targetPeer);
  await writeEvent({
    type: "lash.call",
    actor: opts.arguments.from,
    subject: opts.arguments.from,
    target: opts.targetPeer,
    trace: opts.arguments.trace,
    threadId: opts.arguments.thread?.id,
    outcome: "info",
    payload: { method: opts.method },
  });
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: {
        token: callerToken,
        clientId: `agent:${opts.arguments.from}`,
        scopes: ["agent"],
        extra: { profile: opts.arguments.from },
      },
    });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool(
      {
        name: opts.method,
        arguments: opts.arguments as unknown as Record<string, unknown>,
      },
      CallToolResultSchema,
    );
    return result as CallToolResult;
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

export async function startLashPeerStdioServer(profile: string): Promise<void> {
  const server = createLashPeerServer(profile);
  await server.connect(new StdioServerTransport());
}

export function createLashPeerServer(profile: string): Server {
  const server = new Server(
    { name: `union-street-agent-${profile}`, version: "0.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Union Street Lash-over-MCP peer. Use tools/call delegate for work flowing down and report for truth flowing up.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [toolMetadata("delegate", profile), toolMetadata("report", profile)],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const method = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (method !== "delegate" && method !== "report") {
      return wrapLashError(profile, args, -32601, `unknown Lash tool "${method}"`);
    }
    return handlePeerTool(profile, method, args, extra.authInfo?.token);
  });

  return server;
}

async function handlePeerTool(
  targetPeer: string,
  method: LashPeerMethod,
  rawArgs: Record<string, unknown>,
  transportToken?: string,
): Promise<CallToolResult> {
  const from = readString(rawArgs.from);
  if (!from) return wrapLashError(targetPeer, rawArgs, -32602, "`from` is required");

  const input = normalizeMcpInput(rawArgs, method);
  if (!input.ok) return wrapLashError(targetPeer, rawArgs, -32602, input.error);

  const auth = await verifyCallerIdentity(from, targetPeer, rawArgs, transportToken);
  if (!auth.ok) {
    await writeEvent({
      type: "lash.deny",
      actor: from,
      subject: from,
      target: targetPeer,
      trace: input.trace,
      threadId: input.thread.id,
      outcome: "deny",
      reason: auth.error,
      payload: { method, phase: "auth" },
    });
    return wrapLashError(targetPeer, rawArgs, 401, auth.error, input.trace, input.thread);
  }

  const decision = await canDelegateTo(from, targetPeer);
  if (!decision.allowed) {
    await writeEvent({
      type: "lash.deny",
      actor: from,
      subject: from,
      target: targetPeer,
      trace: input.trace,
      threadId: input.thread.id,
      outcome: "deny",
      reason: decision.reason,
      payload: { method, relation: decision.relation },
    });
    return wrapLashError(targetPeer, rawArgs, 403, decision.reason, input.trace, input.thread);
  }
  if (method === "report" && decision.relation !== "manager") {
    await writeEvent({
      type: "lash.deny",
      actor: from,
      subject: from,
      target: targetPeer,
      trace: input.trace,
      threadId: input.thread.id,
      outcome: "deny",
      reason: `@${from} can only report to its direct manager`,
      payload: { method, relation: decision.relation },
    });
    return wrapLashError(
      targetPeer,
      rawArgs,
      403,
      `@${from} can only report to its direct manager; @${targetPeer} is ${decision.relation ?? "not in its reporting line"}`,
      input.trace,
      input.thread,
    );
  }

  const message =
    method === "report"
      ? `Report from @${from}:\n\n${input.prompt}`
      : input.prompt;
  const result = await peerCall({
    callingPeer: from,
    targetPeer,
    message,
    trace: input.trace,
    thread: input.thread,
    wakeKind: method,
    textVerbosity: "low",
  });

  if (!result.ok || !result.envelope) {
    await writeEvent({
      type: "lash.error",
      actor: from,
      subject: from,
      target: targetPeer,
      trace: input.trace,
      threadId: input.thread.id,
      outcome: "failure",
      reason: result.error ?? "peer call failed",
      payload: { method },
    });
    return wrapLashError(
      targetPeer,
      rawArgs,
      500,
      result.error ?? "peer call failed",
      input.trace,
      input.thread,
    );
  }
  await writeEvent({
    type: "lash.allow",
    actor: from,
    subject: from,
    target: targetPeer,
    trace: input.trace,
    threadId: input.thread.id,
    outcome: "allow",
    payload: { method, relation: decision.relation },
  });
  return callToolResult(result.envelope) as CallToolResult;
}

type CallerIdentityResult =
  | { ok: true; claims: FederatedClaims }
  | { ok: false; error: string };

async function verifyCallerIdentity(
  from: string,
  targetPeer: string,
  rawArgs: Record<string, unknown>,
  transportToken?: string,
): Promise<CallerIdentityResult> {
  const token =
    transportToken ??
    readString(rawArgs.callerToken) ??
    readString(rawArgs.caller_token) ??
    readString(rawArgs.token);
  if (!token) {
    return { ok: false, error: "missing federated caller token" };
  }
  try {
    const claims = await verifyFederatedAgentToken(token, {
      audience: federatedAgentMcpAudience(targetPeer),
    });
    const expected = await resolveAgentPrincipal(from);
    if (claims.us_profile !== from || claims.sub !== expected.subject) {
      return { ok: false, error: `caller token is for @${claims.us_profile}, not @${from}` };
    }
    return { ok: true, claims };
  } catch (e) {
    return { ok: false, error: `invalid federated caller token: ${(e as Error).message}` };
  }
}

async function mintPeerCallerToken(from: string, targetPeer: string): Promise<string> {
  return mintFederatedAgentToken(from, {
    audience: [federatedAgentMcpAudience(targetPeer)],
    ttlSeconds: 60,
  });
}

function toolMetadata(method: LashPeerMethod, profile: string): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    from: { type: "string", description: "Calling peer profile name." },
    caller_token: {
      type: "string",
      description:
        "Signed Union Street federation JWT for stdio clients. Transports with authInfo may omit this.",
    },
    message: { type: "string", description: "Plain natural-language message." },
    prompt: { type: "string", description: "Plain prompt alias for message, matching CLI -p style." },
    payload: { type: "object", description: "Structured JSON payload for this peer." },
    envelope: {
      type: "object",
      description: "Full Lash envelope. Its trace/thread are preserved.",
    },
    thread: threadSchema(),
    trace: { type: "string", description: "Optional Lash trace id." },
  };
  return lashTool({
    name: method,
    description:
      method === "delegate"
        ? `Delegate work to @${profile}. Work flows down through federation permissions.`
        : `Report findings/status to @${profile}. Truth flows up through federation permissions.`,
    properties,
    required: ["from", "thread"],
    trace: createLashTrace(),
  });
}

type NormalizedMcpInput =
  | { ok: true; prompt: string; trace: string; thread: LashThread }
  | { ok: false; error: string };

function normalizeMcpInput(args: Record<string, unknown>, label: LashPeerMethod): NormalizedMcpInput {
  const envelope = parseLashEnvelope(args.envelope);
  const trace = readString(args.trace) ?? envelope?.trace ?? createLashTrace();
  const thread =
    parseLashThread(args.thread) ??
    envelope?.thread ??
    createLashThread(readString(args.from) ?? "unknown", trace);

  if (envelope) {
    return {
      ok: true,
      trace,
      thread,
      prompt: [
        `Structured Lash ${label} from @${envelope.from}.`,
        `kind: ${envelope.kind}`,
        "",
        stringifyPayload(lashEnvelopeValue(envelope)),
      ].join("\n"),
    };
  }

  const prompt = readString(args.message) ?? readString(args.prompt);
  if (prompt) return { ok: true, prompt, trace, thread };

  if (args.payload !== undefined) {
    return {
      ok: true,
      trace,
      thread,
      prompt: [`Structured ${label} payload:`, "", stringifyPayload(args.payload)].join("\n"),
    };
  }

  return { ok: false, error: "provide `message`, `prompt`, `payload`, or `envelope`" };
}

function wrapLashError(
  from: string,
  args: Record<string, unknown>,
  code: number,
  message: string,
  trace = readString(args.trace) ?? createLashTrace(),
  thread = parseLashThread(args.thread) ?? createLashThread(from, trace),
): CallToolResult {
  return callToolResult(lashError(code, message, { from, trace, thread })) as CallToolResult;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringifyPayload(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
