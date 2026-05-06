/**
 * The chat UI for `us chat`.
 *
 * Brand: Union Street AI — "the void and the laser."
 * Pure black canvas, hairline structure, sharp edges, mono tags as
 * section eyebrows, electric-orange laser used as a single accent.
 *
 * Layout (loosely Amp-shaped):
 *
 *   ╔════════════════════════════════════════════════════════════╗
 *   ║                                                            ║
 *   ║                     USAI.                                  ║   ← welcome splash
 *   ║                     THE VOID AND THE LASER                 ║      (only when turns=0)
 *   ║                                                            ║
 *   ║                     [ ALICE ]  GPT-5.4                     ║
 *   ║                     /help    commands                      ║
 *   ║                     /exit    end session                   ║
 *   ║                                                            ║
 *   ║                                                            ║
 *   ║                                              [ALICE · GPT-5.4 · 6 TOOLS]
 *   ║ ┌────────────────────────────────────────────────────────┐ ║
 *   ║ │ > type a message — enter to send                       │ ║
 *   ║ └────────────────────────────────────────────────────────┘ ║
 *   ║  ?  for shortcuts                            ~/cwd/dir     ║
 *   ╚════════════════════════════════════════════════════════════╝
 */
import { useEffect, useRef, useState } from "react";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import {
  STARTER_TOOLS,
  toolDefinitions,
  toolByName,
  setProfileModel,
  initProfile,
  readSession,
  streamModel,
  FileMemoryStore,
  createLashTrace,
  writeUsageRecord,
  queryUsageRecords,
  summarizeUsage,
  createContextEngine,
  DEFAULT_CONTEXT_ENGINE_CONFIG,
  type ContextEngine,
  type MemoryStore,
  type UsToolContext,
  type SessionInfo,
  type UsageSummary,
} from "@unionstreet/server";
import { type ChatMessage, type TokenUsage, type ToolCall } from "@unionstreet/ai-codex";
import type { ChatRuntime } from "./runtime.ts";
import { C, ATTR_BOLD, markdownSyntax } from "./theme.ts";
import { detectEnv, compactPath, type EnvInfo } from "./env.ts";
import { copyText } from "./clipboard.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { AddProviderDialog } from "./AddProviderDialog.tsx";
import { FallbackEditor } from "./FallbackEditor.tsx";
import { SlashMenu, filterSlashCommands } from "./SlashMenu.tsx";
import { ProfileMenu, filterProfiles, CREATE_PROFILE_SENTINEL } from "./ProfileMenu.tsx";
import { CreateProfileOverlay } from "./CreateProfileOverlay.tsx";
import { AsideOverlay } from "./AsideOverlay.tsx";
import { SessionPicker } from "./SessionPicker.tsx";
import { McpOverlay } from "./McpOverlay.tsx";
import { useDelegationTargets } from "./useDelegationTargets.ts";
import { cleanTextareaValue, stripTerminalMousePackets } from "./terminalInput.ts";
import {
  REGISTRY as SLASH_REGISTRY,
  parseSlash,
  type OverlayState,
  type SlashContext,
  type SlashCommand,
} from "./slash.ts";

export type Turn =
  | { kind: "user"; id: string; text: string; ts: number }
  | {
      kind: "assistant";
      id: string;
      /** Profile name at the moment this turn was produced. */
      agent: string;
      text: string;
      streaming: boolean;
      ts: number;
    }
  | {
      kind: "system";
      id: string;
      text: string;
      ts: number;
    }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: string;
      result: string | null;
      ts: number;
    }
  | {
      kind: "compaction";
      id: string;
      droppedCount: number;
      tokensBefore: number;
      tokensAfter: number;
      summary: string;
      ts: number;
    }
  | {
      kind: "cost";
      id: string;
      summary: UsageSummary;
      contextWindow: number;
      ts: number;
    };

export interface AppProps {
  runtime: ChatRuntime;
  /**
   * Build a fresh runtime for a different profile. Used by `@<peer>`
   * switching. The exit handler is shared with the original runtime.
   */
  switchProfile?(name: string): Promise<ChatRuntime>;
  /**
   * Repoint the runtime at an existing session file (for `/resume`).
   * Returns a new runtime with `sessionFile` + `sessionId` + `persist`
   * pointing at the resumed file; the model + auth + profile stay put.
   */
  resumeSession?(current: ChatRuntime, sessionFile: string): Promise<ChatRuntime>;
  /** Create a blank session file for the current profile/model runtime. */
  newSession?(current: ChatRuntime): Promise<ChatRuntime>;
}

const TOOL_COUNT = STARTER_TOOLS.length;

export function App({
  runtime: initialRuntime,
  switchProfile,
  resumeSession,
  newSession,
}: AppProps) {
  const [runtime, setRuntime] = useState<ChatRuntime>(initialRuntime);
  // Mirror runtime in a ref so async closures (runChatLoop, maybeCompact,
  // tool-dispatch) read the LATEST runtime even if their enclosing
  // function reference was captured before the most recent re-render.
  // Otherwise, e.g., switching profile mid-session and immediately sending
  // a message would label the response with the OLD profile because the
  // textarea held a stale `onSubmit` closure.
  const runtimeRef = useRef<ChatRuntime>(runtime);
  runtimeRef.current = runtime;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [status, setStatus] = useState<"idle" | "thinking" | "tool" | "error" | "exiting">(
    "idle",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [composerKey, setComposerKey] = useState(0);
  const [modelId, setModelId] = useState(runtime.modelId);
  const [providerId, setProviderId] = useState(runtime.providerId);
  const [overlay, setOverlay] = useState<OverlayState | null>(null);
  const [composerValue, setComposerValue] = useState("");
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [env, setEnv] = useState<EnvInfo>({ cwd: process.cwd() });
  const [tokenUsage, setTokenUsage] = useState<{ used: number; window: number } | null>(null);
  const tokenUsageRef = useRef<{ used: number; window: number } | null>(null);
  const [compacting, setCompacting] = useState(false);
  const lastAuthWarningRef = useRef<string | null>(null);

  // Memory store: file-backed for now. Swap to HonchoMemoryStore once
  // honcho's wired up in server.
  const memoryRef = useRef<MemoryStore>(new FileMemoryStore());
  const contextEngineRef = useRef<ContextEngine>(createContextEngine(DEFAULT_CONTEXT_ENGINE_CONFIG));
  if (contextEngineRef.current.getStatus().sessionId !== runtime.sessionId) {
    contextEngineRef.current.onSessionStart(runtime.sessionId);
  }
  contextEngineRef.current.updateModel(runtime.modelId, runtime.contextWindow);

  // Keep the ref in sync with state for async compaction reads.
  if (tokenUsageRef.current !== tokenUsage) tokenUsageRef.current = tokenUsage;

  useEffect(() => {
    const warning = runtime.authWarning;
    const key = warning ? `${runtime.profileName}:${runtime.providerId}:${warning}` : null;
    if (!warning || lastAuthWarningRef.current === key) return;
    lastAuthWarningRef.current = key;
    pushSystemNote(`auth warning: ${warning}`);
  }, [runtime.profileName, runtime.providerId, runtime.authWarning]);

  const slashCommands = Object.values(SLASH_REGISTRY);
  const showSlashMenu = composerValue.startsWith("/");
  const slashFiltered = showSlashMenu
    ? filterSlashCommands(slashCommands, composerValue)
    : [];
  const slashSafeIndex =
    slashFiltered.length > 0
      ? Math.min(slashSelectedIndex, slashFiltered.length - 1)
      : 0;

  const { allProfiles, visibleProfiles, addProfile } = useDelegationTargets(runtime.profileName);
  const [peerSelectedIndex, setPeerSelectedIndex] = useState(0);
  const showPeerMenu = composerValue.startsWith("@");
  const peerFiltered = showPeerMenu
    ? filterProfiles(visibleProfiles, composerValue)
    : [];
  const peerSafeIndex =
    peerFiltered.length > 0
      ? Math.min(peerSelectedIndex, peerFiltered.length - 1)
      : 0;
  const showSkillStub = composerValue.startsWith("$");

  const messagesRef = useRef<ChatMessage[]>(
    runtime.systemPrompt
      ? [{ role: "system", content: runtime.systemPrompt }]
      : [],
  );
  const traceRef = useRef(createLashTrace());

  const tools = STARTER_TOOLS;
  const toolDefs = toolDefinitions(tools);
  const toolMap = toolByName(tools);
  // ctx is rebuilt fresh inside the tool dispatch (so callingPeer always
  // reflects the LIVE runtime, not whichever render this closure was
  // captured in).
  const baseCtx: { cwd: string } = { cwd: process.cwd() };

  // Detect ambient environment on mount; refresh after any bash tool call.
  useEffect(() => {
    let cancelled = false;
    detectEnv(baseCtx.cwd).then((info) => {
      if (!cancelled) setEnv(info);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function refreshEnv() {
    detectEnv(baseCtx.cwd).then(setEnv);
  }

  const { width, height } = useTerminalDimensions();
  const renderer = useRenderer();

  useKeyboard((ev) => {
    // Auto-copy already runs on mouse-up. These keyboard paths are for
    // users who select via keyboard (or who want an explicit re-copy).
    // Cmd+C / Cmd+X / Ctrl+C — copy any active selection. Ctrl+C with
    // no selection is the bail-out signal.
    if ((ev.meta && (ev.name === "c" || ev.name === "x")) || (ev.ctrl && ev.name === "c")) {
      if (copySelection()) return;
      if (ev.ctrl && ev.name === "c") {
        setStatus("exiting");
        runtime.exit(130);
        return;
      }
    }
    if (showSlashMenu && slashFiltered.length > 0) {
      if (ev.name === "up") {
        setSlashSelectedIndex((i) =>
          i <= 0 ? slashFiltered.length - 1 : i - 1,
        );
      } else if (ev.name === "down") {
        setSlashSelectedIndex((i) =>
          i >= slashFiltered.length - 1 ? 0 : i + 1,
        );
      } else if (ev.name === "tab") {
        const cmd = slashFiltered[slashSafeIndex];
        if (cmd) pickSlashCommand(cmd);
      }
    }
    if (showPeerMenu && peerFiltered.length > 0) {
      if (ev.name === "up") {
        setPeerSelectedIndex((i) =>
          i <= 0 ? peerFiltered.length - 1 : i - 1,
        );
      } else if (ev.name === "down") {
        setPeerSelectedIndex((i) =>
          i >= peerFiltered.length - 1 ? 0 : i + 1,
        );
      } else if (ev.name === "tab") {
        const name = peerFiltered[peerSafeIndex];
        if (name) void pickProfile(name);
      }
    }
  });

  function pickSlashCommand(cmd: SlashCommand) {
    setComposerValue("");
    setComposerKey((k) => k + 1);
    setSlashSelectedIndex(0);
    void cmd.run({ ...slashCtx, arg: undefined });
  }

  async function pickProfile(name: string) {
    if (name === CREATE_PROFILE_SENTINEL) {
      const initialName = composerValue.replace(/^@+/, "").trim() || undefined;
      setComposerValue("");
      setComposerKey((k) => k + 1);
      setPeerSelectedIndex(0);
      setOverlay({ kind: "create-profile", initialName });
      return;
    }

    setComposerValue("");
    setPeerSelectedIndex(0);

    if (name === runtime.profileName) {
      setComposerKey((k) => k + 1);
      pushSystemNote(`already on @${name}.`);
      return;
    }
    if (!visibleProfiles.includes(name)) {
      setComposerKey((k) => k + 1);
      pushSystemNote(`@${runtime.profileName} cannot switch/delegate to @${name} from this org position.`);
      return;
    }
    if (!switchProfile) {
      setComposerKey((k) => k + 1);
      pushSystemNote("profile switching is not available in this build.");
      return;
    }

    try {
      const next = await switchProfile(name);
      setRuntime(next);
      setModelId(next.modelId);
      setProviderId(next.providerId);
      setTurns([]);
      messagesRef.current = next.systemPrompt
        ? [{ role: "system", content: next.systemPrompt }]
        : [];
      contextEngineRef.current.onSessionStart(next.sessionId);
      contextEngineRef.current.updateModel(next.modelId, next.contextWindow);
      setTokenUsage(null);
      pushSystemNote(`switched to @${name}  ·  ${next.modelId}`);
      // Composer remount must happen AFTER setRuntime, otherwise the
      // textarea binds its onSubmit listener in a render that still has
      // the OLD runtime in closure scope, and the next message gets
      // processed with stale model/state.
      setComposerKey((k) => k + 1);
    } catch (e) {
      setComposerKey((k) => k + 1);
      pushSystemNote(`failed to switch to @${name}: ${(e as Error).message}`);
    }
  }

  async function resumeFromFile(s: SessionInfo) {
    setOverlay(null);
    if (!resumeSession) {
      setComposerKey((k) => k + 1);
      pushSystemNote("resume isn't available in this build.");
      return;
    }
    try {
      const replay = await readSession(runtimeRef.current.profileName, s.file);
      const current = { ...runtimeRef.current, providerId, modelId };
      const nextBase = await resumeSession(current, s.file);
      const next = replay.model
        ? { ...nextBase, providerId: replay.model.provider, modelId: replay.model.id }
        : nextBase;
      setRuntime(next);
      setProviderId(next.providerId);
      setModelId(next.modelId);
      setTurns(replay.turns);
      messagesRef.current = next.systemPrompt
        ? [{ role: "system", content: next.systemPrompt }, ...replay.messages]
        : [...replay.messages];
      contextEngineRef.current.onSessionStart(next.sessionId);
      contextEngineRef.current.updateModel(next.modelId, next.contextWindow);
      setTokenUsage(null);
      pushSystemNote(
        `resumed ${shortLabel(s.id)}  ·  ${next.providerId}/${next.modelId}  ·  ${replay.turns.length} turns replayed`,
      );
      // Remount the composer with fresh closures AFTER setRuntime — same
      // reason as profile switching.
      setComposerKey((k) => k + 1);
    } catch (e) {
      setComposerKey((k) => k + 1);
      pushSystemNote(`failed to resume: ${(e as Error).message}`);
    }
  }

  async function startNewSession() {
    if (!newSession) {
      setComposerKey((k) => k + 1);
      pushSystemNote("new session isn't available in this build.");
      return;
    }
    try {
      const current = { ...runtimeRef.current, providerId, modelId };
      const next = await newSession(current);
      setRuntime(next);
      setTurns([]);
      messagesRef.current = next.systemPrompt
        ? [{ role: "system", content: next.systemPrompt }]
        : [];
      contextEngineRef.current.onSessionReset(next.sessionId);
      contextEngineRef.current.updateModel(next.modelId, next.contextWindow);
      traceRef.current = createLashTrace();
      setTokenUsage(null);
      setErrorMsg(null);
      setStatus("idle");
      setOverlay(null);
      setComposerValue("");
      setSlashSelectedIndex(0);
      setComposerKey((k) => k + 1);
    } catch (e) {
      setComposerKey((k) => k + 1);
      pushSystemNote(`failed to start new session: ${(e as Error).message}`);
    }
  }

  async function showSessionCost() {
    const r = runtimeRef.current;
    try {
      const records = await queryUsageRecords({ sessionId: r.sessionId, limit: 10_000 });
      pushTurn({
        kind: "cost",
        id: cryptoId(),
        summary: summarizeUsage(records),
        contextWindow: r.contextWindow,
        ts: Date.now(),
      });
    } catch (e) {
      pushSystemNote(`failed to read session cost: ${(e as Error).message}`);
    }
  }

  async function createProfileAndSwitch(name: string) {
    setOverlay(null);
    setComposerKey((k) => k + 1);
    try {
      await initProfile(name);
      addProfile(name);
      // Switch into it immediately (same flow as @ pick).
      await pickProfile(name);
    } catch (e) {
      pushSystemNote(`failed to create @${name}: ${(e as Error).message}`);
    }
  }

  function pushSystemNote(text: string) {
    pushTurn({
      kind: "system",
      id: cryptoId(),
      text,
      ts: Date.now(),
    });
  }

  async function maybeCompact(reason: "auto" | "manual"): Promise<boolean> {
    const r = runtimeRef.current;
    const usage = tokenUsageRef.current;
    const usedTokens = usage?.used ?? 0;
    const window = r.contextWindow;
    const engine = contextEngineRef.current;
    engine.updateModel(r.modelId, window);
    const overflow = engine.shouldCompress(usedTokens);
    if (reason === "auto" && !overflow) return false;
    if (reason === "manual" && messagesRef.current.length < 4) {
      pushSystemNote("nothing to compact yet.");
      return false;
    }

    setCompacting(true);
    try {
      const result = await engine.compress({
        messages: messagesRef.current,
        token: r.token,
        summarizerModel: r.summarizerModel,
        peer: r.profileName,
        sessionId: r.sessionId,
        memory: memoryRef.current,
      });
      messagesRef.current = result.messages;
      pushTurn({
        kind: "compaction",
        id: cryptoId(),
        droppedCount: result.droppedCount,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        summary: result.anchor.summary,
        ts: Date.now(),
      });
      await r.persist({
        kind: "compaction",
        anchor_id: result.anchor.id,
        // Inline so /resume can rebuild the anchor without a memory-store
        // round-trip (and survives if the anchors.jsonl rotates).
        summary: result.anchor.summary,
        dropped_count: result.droppedCount,
        tokens_before: result.tokensBefore,
        tokens_after: result.tokensAfter,
        ts: Date.now(),
      });
      // Reset usage estimate to the post-compaction footprint so the meter
      // doesn't immediately re-trigger compaction. Real value lands on the
      // next assistant response's usage payload.
      setTokenUsage({ used: result.tokensAfter, window });
      return true;
    } catch (e) {
      pushSystemNote(`compaction failed: ${(e as Error).message}`);
      return false;
    } finally {
      setCompacting(false);
    }
  }

  function clearTranscript() {
    setTurns([]);
    messagesRef.current = runtime.systemPrompt
      ? [{ role: "system", content: runtime.systemPrompt }]
      : [];
  }

  const slashCtx: SlashContext = {
    state: {
      modelId,
      setModelId,
      clearTranscript,
      newSession: startNewSession,
      exit: (code) => {
        setStatus("exiting");
        runtime.exit(code);
      },
      setOverlay,
      pushSystemNote,
      compact: async () => {
        await maybeCompact("manual");
        setComposerKey((k) => k + 1);
      },
      showCost: async () => {
        await showSessionCost();
        setComposerKey((k) => k + 1);
      },
    },
  };

  async function handleSubmit(value: string) {
    const text = stripTerminalMousePackets(value).trim();
    if (!text) return;
    const isWorking = status === "thinking" || status === "tool";
    const r = runtimeRef.current;

    // While the main agent is mid-turn, only the lightweight slash
    // commands marked `allowDuringWork` are accepted. Everything else
    // would mutate the running message stack — block with a hint.
    if (isWorking) {
      const slash = parseSlash(text);
      const cmd = slash ? SLASH_REGISTRY[slash.name] : undefined;
      if (cmd?.allowDuringWork) {
        setComposerValue("");
        setComposerKey((k) => k + 1);
        await cmd.run({ ...slashCtx, arg: slash?.arg });
        return;
      }
      pushSystemNote(
        "agent is busy. open `/aside <question>` to ask without disrupting, or wait for the current turn to finish.",
      );
      setComposerValue("");
      setComposerKey((k) => k + 1);
      return;
    }

    // `@` peer-switch dispatch.
    if (showPeerMenu) {
      const target = peerFiltered[peerSafeIndex];
      if (!target) {
        pushSystemNote(`no peer matching "${text.slice(1)}".`);
        setComposerValue("");
        setComposerKey((k) => k + 1);
        return;
      }
      await pickProfile(target);
      return;
    }

    // `$skill` stub — recognized but not implemented yet.
    if (showSkillStub) {
      const skillName = text.slice(1).split(/\s+/)[0] ?? "";
      pushSystemNote(
        `skill "$${skillName}": skills aren't wired yet. coming soon — they'll inject prompt sections + tools when invoked.`,
      );
      setComposerValue("");
      setComposerKey((k) => k + 1);
      return;
    }

    // Enter accepts the highlighted slash completion exactly like Tab.
    // Compute from submitted text instead of composerValue so the latest
    // keystroke is honored even if React state is one tick behind.
    const submitSlashFiltered = text.startsWith("/")
      ? filterSlashCommands(slashCommands, text)
      : [];
    if (submitSlashFiltered.length > 0) {
      const cmd = submitSlashFiltered[Math.min(slashSelectedIndex, submitSlashFiltered.length - 1)];
      if (cmd) {
        pickSlashCommand(cmd);
        return;
      }
    }

    const slash = parseSlash(text);
    if (slash) {
      const cmd = SLASH_REGISTRY[slash.name];
      if (cmd) {
        setComposerValue("");
        setComposerKey((k) => k + 1);
        await cmd.run({ ...slashCtx, arg: slash.arg });
        return;
      }
      pushSystemNote(`unknown command "/${slash.name}". try /help.`);
      setComposerValue("");
      setComposerKey((k) => k + 1);
      return;
    }

      const userTurn: Turn = { kind: "user", id: cryptoId(), text, ts: Date.now() };
      pushTurn(userTurn);
      messagesRef.current.push({ role: "user", content: text });
      await r.persist({
        kind: "session_meta",
        provider: providerId,
        model: modelId,
        ts: userTurn.ts,
      });
      await r.persist({ role: "user", content: text, ts: userTurn.ts });

    setComposerValue("");
    setComposerKey((k) => k + 1);
    setStatus("thinking");
    setErrorMsg(null);

    try {
      await runChatLoop();
      // After the agent finishes its turn, check if we need to compact.
      await maybeCompact("auto");
      setStatus("idle");
    } catch (e) {
      setStatus("error");
      setErrorMsg((e as Error).message);
    }
    // Force composer remount so the textarea re-takes focus. opentui
    // doesn't always re-focus when `disabled` flips back from true to
    // false on the same instance.
    setComposerKey((k) => k + 1);
  }

  function pushTurn(t: Turn) {
    setTurns((prev) => [...prev, t]);
  }

  function patchAssistantTurn(
    id: string,
    patch: Partial<Extract<Turn, { kind: "assistant" }>>,
  ) {
    setTurns((prev) =>
      prev.map((t) => (t.kind === "assistant" && t.id === id ? { ...t, ...patch } : t)),
    );
  }

  function patchToolTurn(id: string, patch: Partial<Extract<Turn, { kind: "tool" }>>) {
    setTurns((prev) =>
      prev.map((t) => (t.kind === "tool" && t.id === id ? { ...t, ...patch } : t)),
    );
  }

  async function runChatLoop() {
    let stepCount = 0;
    while (true) {
      stepCount++;
      const r = runtimeRef.current;
      if (stepCount > r.maxSteps) {
        pushTurn({
          kind: "system",
          id: cryptoId(),
          text: `MAX_STEPS=${r.maxSteps} REACHED — STOPPING`,
          ts: Date.now(),
        });
        return;
      }

      const assistantId = cryptoId();
      pushTurn({
        kind: "assistant",
        id: assistantId,
        agent: r.profileName,
        text: "",
        streaming: true,
        ts: Date.now(),
      });

      let assistantText = "";
      const pendingToolCalls: ToolCall[] = [];
      let finishReason: string | undefined;
      let usage: TokenUsage | undefined;

      for await (const ev of streamModel({
        profile: r.profileName,
        provider: providerId,
        model: modelId,
        system: r.systemPrompt,
        messages: messagesRef.current,
        tools: toolDefs,
        sessionId: r.sessionId,
      })) {
        if (ev.type === "text-delta") {
          assistantText += ev.text;
          patchAssistantTurn(assistantId, { text: assistantText });
        } else if (ev.type === "tool-call") {
          pendingToolCalls.push(ev.call);
        } else if (ev.type === "finish") {
          finishReason = ev.reason;
          usage = ev.usage ?? usage;
          if (ev.usage && r.contextWindow) {
            setTokenUsage({ used: ev.usage.total, window: r.contextWindow });
            contextEngineRef.current.updateFromUsage(ev.usage);
          }
        } else if (ev.type === "error") {
          throw new Error(ev.error);
        }
      }

      patchAssistantTurn(assistantId, { streaming: false, text: assistantText });

      messagesRef.current.push({
        role: "assistant",
        content: assistantText || undefined,
        tool_calls: pendingToolCalls.length ? pendingToolCalls : undefined,
      });
      await r.persist({
        role: "assistant",
        content: assistantText,
        tool_calls: pendingToolCalls,
        finish: finishReason,
        provider: providerId,
        model: modelId,
        ...(usage ? { usage } : {}),
        ts: Date.now(),
      });
      if (usage) {
        await writeUsageRecord({
          actor: r.profileName,
          provider: providerId,
          model: modelId,
          sessionId: r.sessionId,
          trace: traceRef.current,
          step: stepCount,
          kind: "chat",
          usage,
        });
      }

      if (!pendingToolCalls.length) return;

      setStatus("tool");
      for (const call of pendingToolCalls) {
        const toolId = cryptoId();
        pushTurn({
          kind: "tool",
          id: toolId,
          name: call.name,
          args: call.arguments,
          result: null,
          ts: Date.now(),
        });

        let result: string;
        try {
          const tool = toolMap.get(call.name);
          if (!tool) {
            result = `error: unknown tool "${call.name}"`;
          } else {
            const args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
            const liveCtx: UsToolContext = {
              ...baseCtx,
              callingPeer: r.profileName,
              trace: traceRef.current,
            };
            result = await tool.execute(args, liveCtx);
          }
        } catch (e) {
          result = `error: ${(e as Error).message}`;
        }

        patchToolTurn(toolId, { result });
        messagesRef.current.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
        await r.persist({
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: result,
          ts: Date.now(),
        });
        // refresh env after any tool that could mutate it (bash/write/edit)
        if (call.name === "bash" || call.name === "write" || call.name === "edit") {
          refreshEnv();
        }
      }
      setStatus("thinking");
    }
  }

  const tagBadge = `${runtime.profileName.toUpperCase()} · ${providerId.toUpperCase()}/${modelId.toUpperCase()} · ${TOOL_COUNT} TOOLS`;

  function copySelection(): boolean {
    const sel = renderer.getSelection();
    const text = sel?.getSelectedText() ?? "";
    if (!text) return false;
    copyText(text);
    renderer.clearSelection();
    return true;
  }

  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      onMouseUp={() => {
        // opencode-style auto-copy: any drag-and-release with a selection
        // commits to the system clipboard.
        copySelection();
      }}
    >
      {turns.length === 0 ? (
        <WelcomeSplash profile={runtime.profileName} modelId={modelId} />
      ) : (
        <Transcript turns={turns} />
      )}
      <TagRow text={tagBadge} disabled={status !== "idle"} />
      {showSlashMenu && (
        <box paddingLeft={1} paddingRight={1}>
          <SlashMenu
            commands={slashFiltered}
            query={composerValue}
            selectedIndex={slashSafeIndex}
            onPick={(cmd) => pickSlashCommand(cmd)}
          />
        </box>
      )}
      {showPeerMenu && !showSlashMenu && (
        <box paddingLeft={1} paddingRight={1}>
          <ProfileMenu
            profiles={peerFiltered}
            current={runtime.profileName}
            query={composerValue}
            selectedIndex={peerSafeIndex}
            onPick={(name) => void pickProfile(name)}
          />
        </box>
      )}
      <Composer
        key={composerKey}
        onSubmit={handleSubmit}
        onValueChange={setComposerValue}
        // Composer stays enabled while the main agent works, so the user
        // can still hit /aside or /help. Plain messages get gated inside
        // handleSubmit. Only an open overlay actually disables the input
        // (since the overlay owns focus).
        disabled={overlay !== null}
      />
      <StatusBar
        status={compacting ? "compacting" : status}
        errorMsg={errorMsg}
        env={env}
        tokenUsage={tokenUsage}
      />
      {overlay?.kind === "create-profile" && (
        <CreateProfileOverlay
          initialName={overlay.initialName}
          existing={allProfiles}
          onCreate={(name) => void createProfileAndSwitch(name)}
          onCancel={() => {
            setOverlay(null);
            setComposerKey((k) => k + 1);
          }}
        />
      )}
      {overlay?.kind === "session-picker" && (
        <SessionPicker
          profile={runtime.profileName}
          currentFile={runtime.sessionFile}
          onSelect={(s) => void resumeFromFile(s)}
          onCancel={() => {
            setOverlay(null);
            setComposerKey((k) => k + 1);
          }}
        />
      )}
      {overlay?.kind === "aside" && (
        <AsideOverlay
          initialPrompt={overlay.initialPrompt}
          agent={runtime.profileName}
          token={runtime.token}
          providerId={providerId}
          modelId={modelId}
          sessionId={runtime.sessionId}
          onClose={() => {
            setOverlay(null);
            setComposerKey((k) => k + 1);
          }}
        />
      )}
      {overlay?.kind === "mcp" && (
        <McpOverlay
          cwd={baseCtx.cwd}
          profile={runtime.profileName}
          onCancel={() => {
            setOverlay(null);
            setComposerKey((k) => k + 1);
          }}
        />
      )}
      {overlay?.kind === "model-picker" && (
        <ModelPicker
          current={modelId}
          profile={runtime.profileName}
          currentProvider={providerId}
          onSelect={(id, provider) => {
            setModelId(id);
            setProviderId(provider);
            setRuntime((r) => ({ ...r, modelId: id, providerId: provider }));
            setOverlay(null);
            setComposerKey((k) => k + 1); // restore composer focus
            void runtimeRef.current.persist({
              kind: "session_meta",
              provider,
              model: id,
              ts: Date.now(),
            });
            pushSystemNote(`model → ${provider}/${id}  (this session)`);
          }}
          onSetDefault={(id, provider) => {
            setModelId(id);
            setProviderId(provider);
            setRuntime((r) => ({ ...r, modelId: id, providerId: provider }));
            setOverlay(null);
            setComposerKey((k) => k + 1); // restore composer focus
            void runtimeRef.current.persist({
              kind: "session_meta",
              provider,
              model: id,
              ts: Date.now(),
            });
            void setProfileModel(runtime.profileName, id, provider)
              .then(() => pushSystemNote(`model → ${provider}/${id}  ·  saved as default for "${runtime.profileName}"`))
              .catch((e) =>
                pushSystemNote(`model → ${id}  ·  but failed to save default: ${(e as Error).message}`),
              );
          }}
          onAddProvider={() => setOverlay({ kind: "add-provider" })}
          onCancel={() => {
            setOverlay(null);
            setComposerKey((k) => k + 1); // restore composer focus
          }}
        />
      )}
      {overlay?.kind === "add-provider" && (
        <AddProviderDialog
          onDone={(msg) => {
            // Hop back to the model picker so the user sees the new
            // provider's models without manually re-running /model. The
            // picker remounts and re-enumerates on overlay swap.
            setOverlay({ kind: "model-picker" });
            pushSystemNote(msg);
          }}
          onCancel={() => {
            // Came in from /model → Cmd+A. Drop back to the picker on
            // cancel too, so the user lands where they started.
            setOverlay({ kind: "model-picker" });
          }}
        />
      )}
      {overlay?.kind === "fallback-editor" && (
        <FallbackEditor
          profile={runtime.profileName}
          onChanged={pushSystemNote}
          onClose={() => {
            setOverlay(null);
            setComposerKey((k) => k + 1);
          }}
        />
      )}
    </box>
  );
}

// ----- Welcome splash (cold start) -----

// Sharp-edged block "us" logomark. The S hangs below the U, sharing the
// U's right column as its left edge and stepping down-and-right.
// (Earlier rotational draft accidentally read as a swastika — this is the
// vertically-stacked replacement.)
const LOGOMARK: ReadonlyArray<string> = [
  "██   ██",
  "██   ██",
  "██   ████████",
  "███████",
  "     ████████",
  "           ██",
  "     ████████",
];

function Logomark(props: { fg: string }) {
  return (
    <box flexDirection="column">
      {LOGOMARK.map((line, i) => (
        <text key={i} fg={props.fg}>{line}</text>
      ))}
    </box>
  );
}

function WelcomeSplash(props: { profile: string; modelId: string }) {
  return (
    <box
      flexGrow={1}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      paddingTop={2}
      paddingBottom={2}
    >
      <box flexDirection="column" alignItems="flex-start">
        <box alignSelf="center">
          <Logomark fg={C.fg1} />
        </box>
        <text> </text>
        <text fg={C.fg4}>THE VOID AND THE LASER</text>
        <text> </text>
        <text>
          <span fg={C.fg3}>{"[ "}</span>
          <span fg={C.fg1} attributes={ATTR_BOLD}>{props.profile.toUpperCase()}</span>
          <span fg={C.fg3}>{" ]"}</span>
          <span fg={C.fg5}>{"   "}</span>
          <span fg={C.fg3}>{props.modelId.toUpperCase()}</span>
        </text>
        <text> </text>
        <text>
          <span fg={C.laser}>/help</span>
          <span fg={C.fg4}>{"    commands"}</span>
        </text>
        <text>
          <span fg={C.laser}>/clear</span>
          <span fg={C.fg4}>{"   forget history"}</span>
        </text>
        <text>
          <span fg={C.laser}>/exit</span>
          <span fg={C.fg4}>{"    end session"}</span>
        </text>
      </box>
    </box>
  );
}

// ----- Transcript -----

function Transcript(props: { turns: Turn[] }) {
  return (
    <scrollbox
      flexGrow={1}
      stickyScroll
      stickyStart="bottom"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
    >
      {props.turns.map((t) => (
        <TurnView key={t.id} turn={t} />
      ))}
    </scrollbox>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  if (turn.kind === "user") {
    return (
      <box flexDirection="row" marginBottom={1}>
        <text fg={C.laser} attributes={ATTR_BOLD}>{"> "}</text>
        <text fg={C.fg1}>{turn.text}</text>
      </box>
    );
  }

  if (turn.kind === "assistant") {
    const label = `[ ${turn.agent.toUpperCase()} ]`;
    if (!turn.text && turn.streaming) {
      return (
        <box flexDirection="row" marginBottom={1}>
          <text fg={C.fg3}>{`${label} `}</text>
          <text fg={C.fg5}>{"…"}</text>
        </box>
      );
    }
    return (
      <box flexDirection="column" marginBottom={1}>
        <text fg={C.fg3}>{label}</text>
        <box paddingLeft={2} flexDirection="column">
          <markdown
            content={turn.text || " "}
            syntaxStyle={markdownSyntax()}
            streaming={turn.streaming}
            fg={C.fg2}
          />
        </box>
      </box>
    );
  }

  if (turn.kind === "system") {
    return (
      <box flexDirection="column" marginBottom={1}>
        <text fg={C.fg5}>{"[ SYSTEM ]"}</text>
        <box paddingLeft={2} flexDirection="column">
          {turn.text.split("\n").map((line, i) => (
            <text key={i} fg={C.fg4}>{line || " "}</text>
          ))}
        </box>
      </box>
    );
  }

  if (turn.kind === "tool") {
    // tool turn — hairline single border
    return (
      <box
        flexDirection="column"
        marginBottom={1}
        border
        borderStyle="single"
        borderColor={C.border1}
        paddingLeft={1}
        paddingRight={1}
      >
        <text>
          <span fg={C.fg3}>{"[ TOOL ] "}</span>
          <span fg={C.fg2} attributes={ATTR_BOLD}>{turn.name}</span>
        </text>
        <text fg={C.fg5}>{oneLine(turn.args)}</text>
        {turn.result == null ? (
          <text fg={C.laser}>{"running…"}</text>
        ) : (
          <box flexDirection="column">
            {truncateLines(turn.result, 8)
              .split("\n")
              .map((line, i) => (
                <text key={i} fg={C.fg3}>{line || " "}</text>
              ))}
          </box>
        )}
      </box>
    );
  }

  if (turn.kind === "cost") {
    const tokens = turn.summary.total;
    const pct = turn.contextWindow > 0 ? Math.min(999, Math.round((tokens / turn.contextWindow) * 100)) : 0;
    const spent = turn.summary.costMicroUsd / 1_000_000;
    return (
      <box
        flexDirection="column"
        marginBottom={1}
        border
        borderStyle="single"
        borderColor={C.border1}
        paddingLeft={1}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <text fg={C.fg1} attributes={ATTR_BOLD}>{"Context"}</text>
        <text fg={C.fg4}>{`${numberFmt(tokens)} tokens`}</text>
        <text fg={C.fg4}>{`${pct}% used`}</text>
        <text fg={C.fg4}>{`${usdFmt(spent)} spent`}</text>
      </box>
    );
  }

  // compaction turn
  const saved = turn.tokensBefore - turn.tokensAfter;
  return (
    <box
      flexDirection="column"
      marginBottom={1}
      border
      borderStyle="single"
      borderColor={C.border2}
      paddingLeft={1}
      paddingRight={1}
    >
      <text>
        <span fg={C.fg3}>{"[ COMPACTED ] "}</span>
        <span fg={C.fg2} attributes={ATTR_BOLD}>{`${turn.droppedCount} msgs`}</span>
        <span fg={C.fg5}>{`   ${kFmt(turn.tokensBefore)} → ${kFmt(turn.tokensAfter)}  ·  saved ${kFmt(saved)}`}</span>
      </text>
      <text fg={C.fg5}>{"summary written to memory"}</text>
    </box>
  );
}

function kFmt(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

function numberFmt(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function usdFmt(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function shortLabel(id: string): string {
  const m = id.match(/-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return id;
  const [, Y, M, D, h, mn] = m;
  return `${Y}-${M}-${D} ${h}:${mn}`;
}

// ----- Tag row above composer (right-aligned, hairline-thin meta) -----

function TagRow(props: { text: string; disabled: boolean }) {
  return (
    <box flexDirection="row" justifyContent="flex-end" paddingRight={2}>
      <text fg={props.disabled ? C.fg5 : C.fg4}>{props.text}</text>
    </box>
  );
}

// ----- Composer (sharp edges, laser when active) -----

const COMPOSER_MAX_LINES = 5;

function Composer(props: {
  onSubmit: (v: string) => void;
  onValueChange?: (v: string) => void;
  disabled: boolean;
}) {
  // The underlying TextareaRenderable handle. We read `.plainText` off it
  // on submit. Height is governed by minHeight/maxHeight on the textarea
  // itself — opentui auto-grows it; we don't track lines manually.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const taRef = useRef<any>(null);
  const borderColor = props.disabled ? C.border1 : C.laser;

  return (
    <box
      flexDirection="row"
      border
      borderStyle="single"
      borderColor={borderColor}
      paddingLeft={1}
      paddingRight={1}
      // The artifacting we saw earlier (horizontal dashes through the
      // placeholder text) was opentui's box collapsing the content row
      // onto the border row when paddingTop/Bottom were 0 and the
      // textarea was 1 row tall. Explicit 1-row vertical padding gives
      // the textarea its own row, separate from the border lines.
      paddingTop={0}
      paddingBottom={0}
      alignItems="center"
    >
      <box width={2} flexShrink={0}>
        <text fg={props.disabled ? C.fg5 : C.laser} attributes={ATTR_BOLD}>{"> "}</text>
      </box>
      <box flexGrow={1}>
        <textarea
          ref={taRef}
          focused={!props.disabled}
          placeholder={
            props.disabled
              ? ""
              : "type a message · enter to send · shift+enter for newline"
          }
          textColor={C.fg2}
          focusedTextColor={C.fg1}
          placeholderColor={C.fg5}
          // wrapMode "none" + single-line minHeight avoids the horizontal
          // line artifacts we saw with "word" wrap on a height-1 textarea.
          // The textarea grows up to maxHeight as the user adds newlines.
          wrapMode="none"
          minHeight={1}
          maxHeight={COMPOSER_MAX_LINES}
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "return", shift: true, action: "newline" },
            { name: "linefeed", action: "newline" },
          ]}
          onContentChange={() => {
            const ta = taRef.current;
            if (!ta) return;
            const text = cleanTextareaValue(ta);
            props.onValueChange?.(text);
          }}
          onSubmit={() => {
            const ta = taRef.current;
            const text = cleanTextareaValue(ta);
            if (props.disabled || !text.trim()) return;
            props.onSubmit(text);
          }}
        />
      </box>
    </box>
  );
}

// ----- Status bar (bottom: hints left, cwd right) -----

function StatusBar(props: {
  status: string;
  errorMsg: string | null;
  env: EnvInfo;
  tokenUsage: { used: number; window: number } | null;
}) {
  let leftLabel: string;
  let leftColor: string = C.fg5;
  if (props.errorMsg) {
    leftLabel = `error: ${props.errorMsg}`;
    leftColor = C.danger;
  } else {
    switch (props.status) {
      case "thinking":
        leftLabel = "thinking…";
        leftColor = C.laser;
        break;
      case "tool":
        leftLabel = "running tools…";
        leftColor = C.laser;
        break;
      case "compacting":
        leftLabel = "compacting…";
        leftColor = C.laser;
        break;
      case "exiting":
        leftLabel = "bye.";
        break;
      default:
        leftLabel = "?  for shortcuts";
        leftColor = C.fg4;
    }
  }
  return (
    <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
      <text fg={leftColor}>{leftLabel}</text>
      <box flexDirection="row" flexShrink={1}>
        {props.tokenUsage && (
          <>
            <TokenMeter usage={props.tokenUsage} />
            <text fg={C.border2}>{"  "}</text>
          </>
        )}
        <EnvChips env={props.env} />
      </box>
    </box>
  );
}

function TokenMeter({ usage }: { usage: { used: number; window: number } }) {
  const ratio = usage.window > 0 ? usage.used / usage.window : 0;
  let color: string = C.fg5;
  if (ratio >= 0.95) color = C.laser;
  else if (ratio >= 0.8) color = C.warning;
  return (
    <text>
      <span fg={color}>{kFmtTokens(usage.used)}</span>
      <span fg={C.fg5}>{`/${kFmtTokens(usage.window)}`}</span>
    </text>
  );
}

function kFmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function EnvChips({ env }: { env: EnvInfo }) {
  const segments: Array<{ key: string; node: React.ReactNode }> = [];

  // cwd (always)
  segments.push({
    key: "cwd",
    node: <text fg={C.fg5}>{compactPath(env.cwd)}</text>,
  });

  // git
  if (env.git) {
    segments.push({ key: "sep-git", node: <text fg={C.border2}>{"  "}</text> });
    segments.push({
      key: "git",
      node: (
        <text>
          <span fg={C.fg4}>{env.git.branch}</span>
          {env.git.dirty ? <span fg={C.laser}>{"●"}</span> : <span fg={C.fg5}>{""}</span>}
          {env.git.inProgress ? (
            <span fg={C.warning}>{"  " + env.git.inProgress}</span>
          ) : (
            <span fg={C.fg5}>{""}</span>
          )}
        </text>
      ),
    });
  }

  // python venv
  if (env.python) {
    segments.push({ key: "sep-py", node: <text fg={C.border2}>{"  "}</text> });
    segments.push({
      key: "py",
      node: (
        <text>
          <span fg={C.fg5}>{"py:"}</span>
          <span fg={C.fg4}>{env.python.venv}</span>
        </text>
      ),
    });
  }

  // node manager
  if (env.node) {
    segments.push({ key: "sep-node", node: <text fg={C.border2}>{"  "}</text> });
    segments.push({
      key: "node",
      node: <text fg={C.fg5}>{env.node.manager}</text>,
    });
  }

  // docker
  if (env.docker) {
    segments.push({ key: "sep-docker", node: <text fg={C.border2}>{"  "}</text> });
    segments.push({
      key: "docker",
      node: (
        <text>
          <span fg={C.fg5}>{"docker:"}</span>
          <span fg={C.fg4}>{env.docker.context}</span>
        </text>
      ),
    });
  }

  // aws
  if (env.aws) {
    segments.push({ key: "sep-aws", node: <text fg={C.border2}>{"  "}</text> });
    segments.push({
      key: "aws",
      node: (
        <text>
          <span fg={C.fg5}>{"aws:"}</span>
          <span fg={C.fg4}>{env.aws.profile}</span>
        </text>
      ),
    });
  }

  // k8s
  if (env.k8s) {
    segments.push({ key: "sep-k8s", node: <text fg={C.border2}>{"  "}</text> });
    segments.push({
      key: "k8s",
      node: (
        <text>
          <span fg={C.fg5}>{"k8s:"}</span>
          <span fg={C.fg4}>{env.k8s.context}</span>
        </text>
      ),
    });
  }

  // terraform
  if (env.tf) {
    segments.push({ key: "sep-tf", node: <text fg={C.border2}>{"  "}</text> });
    segments.push({
      key: "tf",
      node: (
        <text>
          <span fg={C.fg5}>{"tf:"}</span>
          <span fg={C.fg4}>{env.tf.workspace}</span>
        </text>
      ),
    });
  }

  // nix shell
  if (env.nix) {
    segments.push({ key: "sep-nix", node: <text fg={C.border2}>{"  "}</text> });
    segments.push({
      key: "nix",
      node: (
        <text>
          <span fg={C.fg5}>{"nix:"}</span>
          <span fg={C.fg4}>{env.nix.name}</span>
        </text>
      ),
    });
  }

  return (
    <box flexDirection="row" flexShrink={1}>
      {segments.map((s) => (
        <box key={s.key}>{s.node}</box>
      ))}
    </box>
  );
}

// ----- helpers -----

function cryptoId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
}

function oneLine(s: string): string {
  const compact = s.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? compact.slice(0, 77) + "…" : compact;
}

function truncateLines(s: string, max: number): string {
  const lines = s.split("\n");
  if (lines.length <= max) return s;
  return [...lines.slice(0, max - 1), `… (${lines.length - max + 1} more lines)`].join("\n");
}
