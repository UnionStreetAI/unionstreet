import { randomUUID } from "node:crypto";
import type { LashEnvelope, LashThread } from "@lashprotocol/lash";
import { result as lashResult, validateSchema, lashOutputSchema, validateThread } from "@lashprotocol/lash";

export interface LashChainHop {
  from: string;
  to: string;
  at: string;
}

export interface LashCallContext {
  trace: string;
  thread: LashThread;
  chain: LashChainHop[];
}

export function createLashTrace(): string {
  return `trace_${randomUUID()}`;
}

export function createLashThread(targetPeer: string, trace = createLashTrace()): LashThread {
  return {
    id: `${targetPeer}/${trace}`,
    resume: "resume_or_create",
    summary: `Delegation thread for @${targetPeer}`,
    turn: 0,
  };
}

export function nextLashContext(input: {
  caller: string;
  target: string;
  trace?: string;
  thread?: LashThread;
  chain?: LashChainHop[];
}): LashCallContext {
  const trace = input.trace ?? createLashTrace();
  const baseThread = input.thread ?? createLashThread(input.target, trace);
  return {
    trace,
    thread: {
      ...baseThread,
      turn: baseThread.turn + 1,
    },
    chain: [
      ...(input.chain ?? []),
      {
        from: input.caller,
        to: input.target,
        at: new Date().toISOString(),
      },
    ],
  };
}

export function lashTextResult(value: string, options: { from: string; trace: string; thread: LashThread }): LashEnvelope {
  return lashResult(value, options);
}

export function parseLashEnvelope(value: unknown): LashEnvelope | undefined {
  if (!value || typeof value !== "object") return undefined;
  try {
    validateSchema(lashOutputSchema(), value, "structuredContent");
    return value as LashEnvelope;
  } catch {
    return undefined;
  }
}

export function parseLashThread(value: unknown): LashThread | undefined {
  try {
    validateThread(value);
    return value as LashThread;
  } catch {
    return undefined;
  }
}

export function lashEnvelopeValue(envelope: LashEnvelope): unknown {
  switch (envelope.kind) {
    case "result":
    case "stream":
      return envelope.value;
    case "continuation":
      return envelope.continuation;
    case "error":
      return envelope.error;
  }
}
