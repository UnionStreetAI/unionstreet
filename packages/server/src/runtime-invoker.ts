import type { LashThread } from "@lashprotocol/lash";
import { dockerRuntimeControlUrl, ensureAgentDockerRuntime } from "./docker-runtime.ts";
import { writeEvent } from "./events.ts";
import type { LashChainHop } from "./lash-context.ts";
import type { PeerCallResult } from "./peer.ts";
import { resolveAgentRuntime } from "./cloud-runtime.ts";

export type RuntimeInvocation =
  | {
    kind: "peer_wake";
    targetPeer: string;
    callingPeer: string;
    message: string;
    trace: string;
    thread: LashThread;
    chain: LashChainHop[];
    wakeKind: "delegate" | "report";
    textVerbosity?: "low" | "medium" | "high";
    signal?: AbortSignal;
  };

export type RuntimeInvocationResult =
  | { routed: false }
  | { routed: true; result: PeerCallResult };

export async function invokeAgentRuntime(invocation: RuntimeInvocation): Promise<RuntimeInvocationResult> {
  const runtime = await resolveAgentRuntime(invocation.targetPeer);
  if (runtime.workspace.provider === "local") return { routed: false };
  if (process.env.US_PROFILE === invocation.targetPeer || process.env.US_RUNTIME_PROFILE === invocation.targetPeer) return { routed: false };

  await writeEvent({
    type: "runtime.workspace.ensure",
    actor: invocation.targetPeer,
    subject: invocation.targetPeer,
    target: invocation.callingPeer,
    trace: invocation.trace,
    threadId: invocation.thread.id,
    resource: runtime.workspacePath,
    outcome: "success",
    severity: "info",
    payload: {
      action: invocation.kind,
      wake: invocation.wakeKind,
      provider: runtime.workspace.provider,
      pluginId: runtime.pluginId,
      routed: true,
    },
  });

  if (runtime.workspace.provider === "docker") {
    return { routed: true, result: await invokeDockerPeerWake(invocation) };
  }

  return {
    routed: true,
    result: {
      ok: false,
      error: `runtime provider "${runtime.workspace.provider}" is selected for @${invocation.targetPeer}, but runtime invocation is not implemented for ${runtime.pluginId} yet`,
      trace: invocation.trace,
      thread: invocation.thread,
      chain: invocation.chain,
    },
  };
}

async function invokeDockerPeerWake(invocation: Extract<RuntimeInvocation, { kind: "peer_wake" }>): Promise<PeerCallResult> {
  if (process.env.US_PEER_RUNTIME_STUB === "1") {
    return {
      ok: true,
      response: `[stub] @${invocation.targetPeer} routed via docker runtime from @${invocation.callingPeer}.`,
      trace: invocation.trace,
      thread: invocation.thread,
      chain: invocation.chain,
    };
  }

  const runtime = await resolveAgentRuntime(invocation.targetPeer);
  const ensured = await ensureAgentDockerRuntime(runtime);
  const baseUrl = dockerRuntimeControlUrl(ensured.status);
  if (!baseUrl) {
    return {
      ok: false,
      error: `docker runtime for @${invocation.targetPeer} started but did not expose a control URL on 8787/tcp`,
      trace: invocation.trace,
      thread: invocation.thread,
      chain: invocation.chain,
    };
  }

  const response = await fetch(`${baseUrl}/api/peers/${encodeURIComponent(invocation.targetPeer)}/wake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      caller: invocation.callingPeer,
      message: invocation.message,
      trace: invocation.trace,
      thread: invocation.thread,
      chain: invocation.chain,
      wakeKind: invocation.wakeKind,
      textVerbosity: invocation.textVerbosity,
    }),
    signal: invocation.signal,
  });
  const body = await response.json().catch(() => undefined) as { result?: PeerCallResult; error?: string; message?: string } | undefined;
  if (!response.ok || !body?.result) {
    return {
      ok: false,
      error: body?.message ?? body?.error ?? `docker peer wake failed with HTTP ${response.status}`,
      trace: invocation.trace,
      thread: invocation.thread,
      chain: invocation.chain,
    };
  }
  return body.result;
}
