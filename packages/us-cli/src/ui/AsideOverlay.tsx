/**
 * `/aside` — single-shot fork with full tool access.
 *
 * Shape: `/aside <prompt>` fires the prompt at the model. The agent runs
 * a normal tool loop (bash/read/ls/grep/write/edit available). When it's
 * done, the overlay sits there showing the response. Esc closes.
 *
 * Properties:
 *   - **One shot.** No follow-up composer. If you want more, open another
 *     aside.
 *   - **No slash commands.** The aside is a fork — slash routing belongs
 *     to the main composer.
 *   - **Tools available.** Agent can act on the workspace as needed.
 *   - **Main thread untouched.** This overlay's messages never reach the
 *     main runtime. Tool calls hit the workspace though, so writes are
 *     real (not sandboxed).
 *   - **Esc closes** unconditionally.
 *
 * If `/aside` is invoked with no arg, the overlay opens with a one-line
 * input that captures the prompt; once submitted, the input goes away
 * and the agent runs.
 */
import { useEffect, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { type ChatMessage, type ToolCall } from "@unionstreet/ai-codex";
import {
  STARTER_TOOLS,
  streamModel,
  toolDefinitions,
  toolByName,
  type UsToolContext,
} from "@unionstreet/us-core";
import { C, ATTR_BOLD, markdownSyntax } from "./theme.ts";
import { cleanTextareaValue } from "./terminalInput.ts";

export interface AsideOverlayProps {
  /** Prompt typed after `/aside `. May be empty — overlay will collect one. */
  initialPrompt?: string;
  /** Profile name driving the aside (used for the `[ NAME ]` label). */
  agent: string;
  token: string;
  providerId: string;
  modelId: string;
  sessionId?: string;
  onClose(): void;
}

type AsideEvent =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; agent: string; text: string; streaming: boolean }
  | { kind: "tool"; id: string; name: string; args: string; result: string | null };

const ASIDE_SYSTEM = `You are answering an aside — a side question that won't go into the main agent's permanent context. Be direct and brief. You have filesystem and shell tools available; use them when needed. The user will dismiss this overlay with esc when they're done reading.`;

const TOOLS = STARTER_TOOLS;
const TOOL_DEFS = toolDefinitions(TOOLS);
const TOOL_MAP = toolByName(TOOLS);
const MAX_STEPS = 30;

export function AsideOverlay(props: AsideOverlayProps) {
  const { width, height } = useTerminalDimensions();
  const initial = (props.initialPrompt ?? "").trim();

  const [phase, setPhase] = useState<"awaiting-prompt" | "running" | "done" | "error">(
    initial.length > 0 ? "running" : "awaiting-prompt",
  );
  const [pendingPrompt, setPendingPrompt] = useState(initial);
  const [events, setEvents] = useState<AsideEvent[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Esc closes — full stop. (We only suppress while the user is actively
  // typing in the prompt input, so backspace doesn't accidentally close.)
  const typingRef = useRef(false);
  useKeyboard((ev) => {
    if (ev.name === "escape" && !typingRef.current) {
      props.onClose();
    }
  });

  // If we got an initial prompt, kick the run on first render.
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    if (phase === "running" && pendingPrompt.length > 0) {
      firedRef.current = true;
      void runAgent(pendingPrompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, pendingPrompt]);

  function pushEvent(e: AsideEvent) {
    setEvents((prev) => [...prev, e]);
  }
  function patchAssistant(id: string, patch: Partial<Extract<AsideEvent, { kind: "assistant" }>>) {
    setEvents((prev) => prev.map((e) => (e.kind === "assistant" && e.id === id ? { ...e, ...patch } : e)));
  }
  function patchTool(id: string, patch: Partial<Extract<AsideEvent, { kind: "tool" }>>) {
    setEvents((prev) => prev.map((e) => (e.kind === "tool" && e.id === id ? { ...e, ...patch } : e)));
  }

  async function runAgent(prompt: string) {
    pushEvent({ kind: "user", id: cryptoId(), text: prompt });

    const messages: ChatMessage[] = [
      { role: "system", content: ASIDE_SYSTEM },
      { role: "user", content: prompt },
    ];

    const ctx: UsToolContext = { cwd: process.cwd(), callingPeer: props.agent };

    try {
      let step = 0;
      while (true) {
        step++;
        if (step > MAX_STEPS) {
          pushEvent({
            kind: "assistant",
            id: cryptoId(),
            agent: props.agent,
            text: `[max_steps=${MAX_STEPS} reached, stopping]`,
            streaming: false,
          });
          break;
        }

        const assistantId = cryptoId();
        pushEvent({ kind: "assistant", id: assistantId, agent: props.agent, text: "", streaming: true });
        let assistantText = "";
        const pendingTools: ToolCall[] = [];

        for await (const ev of streamModel({
          profile: props.agent,
          provider: props.providerId,
          model: props.modelId,
          system: ASIDE_SYSTEM,
          messages,
          tools: TOOL_DEFS,
          sessionId: props.sessionId ? `${props.sessionId}-aside` : undefined,
          textVerbosity: "low",
        })) {
          if (ev.type === "text-delta") {
            assistantText += ev.text;
            patchAssistant(assistantId, { text: assistantText });
          } else if (ev.type === "tool-call") {
            pendingTools.push(ev.call);
          } else if (ev.type === "error") {
            throw new Error(ev.error);
          }
        }
        patchAssistant(assistantId, { streaming: false });

        messages.push({
          role: "assistant",
          content: assistantText || undefined,
          tool_calls: pendingTools.length ? pendingTools : undefined,
        });

        if (pendingTools.length === 0) break;

        for (const call of pendingTools) {
          const toolId = cryptoId();
          pushEvent({ kind: "tool", id: toolId, name: call.name, args: call.arguments, result: null });
          let result: string;
          try {
            const tool = TOOL_MAP.get(call.name);
            if (!tool) result = `error: unknown tool "${call.name}"`;
            else {
              const args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
              result = await tool.execute(args, ctx);
            }
          } catch (e) {
            result = `error: ${(e as Error).message}`;
          }
          patchTool(toolId, { result });
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
        }
      }

      setPhase("done");
    } catch (e) {
      setErrorMsg((e as Error).message);
      setPhase("error");
    }
  }

  const dialogHeight = Math.max(14, Math.floor(height * 0.7));
  const dialogWidth = Math.max(60, Math.min(width - 4, 100));

  return (
    <box
      position="absolute"
      left={0}
      right={0}
      top={0}
      bottom={0}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
    >
      <box
        flexDirection="column"
        backgroundColor={C.void}
        border
        borderStyle="single"
        borderColor={C.laser}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        width={dialogWidth}
        height={dialogHeight}
      >
        <Header phase={phase} />
        <text> </text>

        {phase === "awaiting-prompt" ? (
          <PromptInput
            onSubmit={(text) => {
              if (!text.trim()) return;
              typingRef.current = false;
              setPendingPrompt(text.trim());
              setPhase("running");
            }}
            onTypingChange={(t) => {
              typingRef.current = t;
            }}
          />
        ) : (
          <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
            {events.map((e) => (
              <AsideEventView key={e.id} event={e} />
            ))}
            {errorMsg && (
              <box marginTop={1}>
                <text fg={C.danger}>{`error: ${errorMsg}`}</text>
              </box>
            )}
          </scrollbox>
        )}

        <text> </text>
        <Footer phase={phase} />
      </box>
    </box>
  );
}

// ----- subviews -----

function Header({ phase }: { phase: "awaiting-prompt" | "running" | "done" | "error" }) {
  let status: React.ReactNode;
  switch (phase) {
    case "running":
      status = <span fg={C.laser}>running…</span>;
      break;
    case "done":
      status = <span fg={C.fg5}>done · esc to close</span>;
      break;
    case "error":
      status = <span fg={C.danger}>error · esc to close</span>;
      break;
    default:
      status = <span fg={C.fg5}>type a prompt · esc to close</span>;
  }
  return (
    <box flexDirection="row" justifyContent="space-between">
      <text>
        <span fg={C.fg3}>{"[ "}</span>
        <span fg={C.fg1} attributes={ATTR_BOLD}>{"ASIDE"}</span>
        <span fg={C.fg3}>{" ]"}</span>
        <span fg={C.fg5}>{"   ephemeral · tools available · main thread untouched"}</span>
      </text>
      <text>{status}</text>
    </box>
  );
}

function Footer({ phase }: { phase: "awaiting-prompt" | "running" | "done" | "error" }) {
  if (phase === "running" || phase === "awaiting-prompt") return <text> </text>;
  return (
    <text>
      <span fg={C.laser}>esc</span>
      <span fg={C.fg5}>{"  close and return to main"}</span>
    </text>
  );
}

function AsideEventView({ event }: { event: AsideEvent }) {
  if (event.kind === "user") {
    return (
      <box flexDirection="row" marginBottom={1}>
        <text fg={C.laser} attributes={ATTR_BOLD}>{"> "}</text>
        <text fg={C.fg1}>{event.text}</text>
      </box>
    );
  }
  if (event.kind === "assistant") {
    const label = `[ ${(event.agent ?? "AGENT").toUpperCase()} ]`;
    if (!event.text && event.streaming) {
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
        <box paddingLeft={2}>
          <markdown
            content={event.text || " "}
            syntaxStyle={markdownSyntax()}
            streaming={event.streaming}
            fg={C.fg2}
          />
        </box>
      </box>
    );
  }
  // tool
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
        <span fg={C.fg2} attributes={ATTR_BOLD}>{event.name}</span>
      </text>
      <text fg={C.fg5}>{oneLine(event.args)}</text>
      {event.result == null ? (
        <text fg={C.laser}>{"running…"}</text>
      ) : (
        <box flexDirection="column">
          {truncateLines(event.result, 6)
            .split("\n")
            .map((line, i) => (
              <text key={i} fg={C.fg3}>{line || " "}</text>
            ))}
        </box>
      )}
    </box>
  );
}

function PromptInput(props: {
  onSubmit: (text: string) => void;
  onTypingChange: (typing: boolean) => void;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const taRef = useRef<any>(null);
  return (
    <box
      flexDirection="row"
      border
      borderStyle="single"
      borderColor={C.laser}
      paddingLeft={1}
      paddingRight={1}
      alignItems="center"
    >
      <box width={2} flexShrink={0}>
        <text fg={C.laser} attributes={ATTR_BOLD}>{"> "}</text>
      </box>
      <box flexGrow={1}>
        <textarea
          ref={taRef}
          focused
          placeholder="ask anything · enter to send"
          textColor={C.fg2}
          focusedTextColor={C.fg1}
          placeholderColor={C.fg5}
          wrapMode="none"
          minHeight={1}
          maxHeight={3}
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "return", shift: true, action: "newline" },
            { name: "linefeed", action: "newline" },
          ]}
          onContentChange={() => {
            const ta = taRef.current;
            const text = cleanTextareaValue(ta);
            props.onTypingChange(text.length > 0);
          }}
          onSubmit={() => {
            const ta = taRef.current;
            const text = cleanTextareaValue(ta);
            if (!text.trim()) return;
            props.onSubmit(text);
          }}
        />
      </box>
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
