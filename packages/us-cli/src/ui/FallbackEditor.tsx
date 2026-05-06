/**
 * `/fallback` — edit the per-profile model fallback chain.
 *
 * The chain is what the chat dispatch tries when the primary model fails
 * (auth, rate limit, 5xx, network). Primary is the entry at index 0
 * (locked here — change it via `/model` set-default); the rest is the
 * editable fallback list.
 *
 *   ↑↓        navigate
 *   ctrl+a    add an entry (paste `provider model-id`)
 *   ctrl+x    remove the highlighted entry
 *   ctrl+u    move highlighted up
 *   ctrl+d    move highlighted down
 *   esc       close
 */
import { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import {
  readModelChain,
  setFallbackChain,
  PROVIDERS,
  type ModelTarget,
} from "@unionstreet/server";
import { C, ATTR_BOLD } from "./theme.ts";

const WIDTH = 76;

export interface FallbackEditorProps {
  profile: string;
  onClose(): void;
  onChanged(message: string): void;
}

type Stage =
  | { kind: "list" }
  | { kind: "add"; provider: string; model: string; field: "provider" | "model" };

export function FallbackEditor({ profile, onClose, onChanged }: FallbackEditorProps) {
  const [chain, setChain] = useState<ModelTarget[]>([]);
  const [primary, setPrimary] = useState<ModelTarget | null>(null);
  const [selected, setSelected] = useState(0); // index into fallback list (chain.slice(1))
  const [stage, setStage] = useState<Stage>({ kind: "list" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readModelChain(profile).then((c) => {
      if (cancelled) return;
      const [p, ...rest] = c;
      setPrimary(p ?? null);
      setChain(rest);
    });
    return () => {
      cancelled = true;
    };
  }, [profile]);

  async function persist(nextFallback: ModelTarget[]) {
    try {
      await setFallbackChain(profile, nextFallback);
      setChain(nextFallback);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function move(delta: number) {
    if (chain.length === 0) return;
    setSelected((cur) => {
      const next = cur + delta;
      if (next < 0) return chain.length - 1;
      if (next >= chain.length) return 0;
      return next;
    });
  }

  function remove(index: number) {
    if (index < 0 || index >= chain.length) return;
    const next = chain.slice(0, index).concat(chain.slice(index + 1));
    setSelected(Math.max(0, Math.min(next.length - 1, index)));
    void persist(next);
    onChanged(`fallback chain: removed entry ${index + 1}`);
  }

  function reorder(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= chain.length) return;
    const next = chain.slice();
    [next[index], next[target]] = [next[target]!, next[index]!];
    setSelected(target);
    void persist(next);
  }

  useKeyboard((ev) => {
    if (stage.kind !== "list") return;
    if (ev.name === "escape") onClose();
    else if (ev.name === "up") move(-1);
    else if (ev.name === "down") move(+1);
    else if (ev.ctrl && ev.name === "a") {
      setStage({ kind: "add", provider: "", model: "", field: "provider" });
    } else if (ev.ctrl && ev.name === "x") remove(selected);
    else if (ev.ctrl && ev.name === "u") reorder(selected, -1);
    else if (ev.ctrl && ev.name === "d") reorder(selected, +1);
  });

  if (stage.kind === "add") {
    return (
      <AddStage
        provider={stage.provider}
        model={stage.model}
        field={stage.field}
        onSetField={(f) => setStage({ ...stage, field: f })}
        onProvider={(v) => setStage({ ...stage, provider: v })}
        onModel={(v) => setStage({ ...stage, model: v })}
        onSubmit={async (entry) => {
          if (!entry) {
            setStage({ kind: "list" });
            return;
          }
          const next = [...chain, entry];
          await persist(next);
          setStage({ kind: "list" });
          setSelected(next.length - 1);
          onChanged(`fallback chain: added ${entry.provider}/${entry.id}`);
        }}
        onCancel={() => setStage({ kind: "list" })}
      />
    );
  }

  return (
    <Shell title="FALLBACK CHAIN" hint={`@${profile}`}>
      {primary && (
        <>
          <text fg={C.fg5}>{"  primary"}</text>
          <box paddingLeft={2} marginBottom={1}>
            <text>
              <span fg={C.laser}>{"●  "}</span>
              <span fg={C.fg2} attributes={ATTR_BOLD}>{primary.provider}</span>
              <span fg={C.fg5}>{"  /  "}</span>
              <span fg={C.fg2}>{primary.id}</span>
              <span fg={C.fg5}>{"  (set via /model → ctrl+d)"}</span>
            </text>
          </box>
        </>
      )}
      <text fg={C.fg5}>
        {chain.length === 0 ? "  no fallbacks yet — ctrl+a to add" : "  fallbacks (in order)"}
      </text>
      <box flexDirection="column" paddingLeft={2}>
        {chain.map((entry, i) => {
          const isSelected = i === selected;
          return (
            <box
              key={`${entry.provider}-${entry.id}-${i}`}
              flexDirection="row"
              backgroundColor={isSelected ? C.surface3 : C.void}
              paddingLeft={1}
              paddingRight={1}
            >
              <box width={4} flexShrink={0}>
                <text fg={C.fg5}>{`${i + 1}.`}</text>
              </box>
              <box width={26} flexShrink={0}>
                <text
                  fg={isSelected ? C.fg1 : C.fg2}
                  attributes={isSelected ? ATTR_BOLD : 0}
                >
                  {entry.provider}
                </text>
              </box>
              <box flexGrow={1}>
                <text fg={isSelected ? C.fg2 : C.fg5}>{entry.id}</text>
              </box>
            </box>
          );
        })}
      </box>
      {error && (
        <>
          <text> </text>
          <text fg={C.danger}>{`  ${error}`}</text>
        </>
      )}
      <text> </text>
      <text>
        <span fg={C.laser}>{"^a"}</span>
        <span fg={C.fg5}>{" add   "}</span>
        <span fg={C.laser}>{"^x"}</span>
        <span fg={C.fg5}>{" remove   "}</span>
        <span fg={C.laser}>{"^u"}</span>
        <span fg={C.fg5}>{" up   "}</span>
        <span fg={C.laser}>{"^d"}</span>
        <span fg={C.fg5}>{" down   "}</span>
        <span fg={C.laser}>{"esc"}</span>
        <span fg={C.fg5}>{" close"}</span>
      </text>
    </Shell>
  );
}

// ----- add stage -----

function AddStage(props: {
  provider: string;
  model: string;
  field: "provider" | "model";
  onSetField(f: "provider" | "model"): void;
  onProvider(v: string): void;
  onModel(v: string): void;
  onSubmit(entry: ModelTarget | null): void;
  onCancel(): void;
}) {
  useKeyboard((ev) => {
    if (ev.name === "escape") props.onCancel();
    else if (ev.name === "tab") {
      props.onSetField(props.field === "provider" ? "model" : "provider");
    }
  });

  function commit() {
    const provider = props.provider.trim();
    const id = props.model.trim();
    if (!provider || !id) return;
    props.onSubmit({ provider, id });
  }

  return (
    <Shell title="ADD FALLBACK" hint="provider · model id">
      <text fg={C.fg5}>{"  provider id (e.g., anthropic, groq, openai)"}</text>
      <Field
        value={props.provider}
        focused={props.field === "provider"}
        placeholder="anthropic"
        onInput={props.onProvider}
        onSubmit={() => props.onSetField("model")}
      />
      <text> </text>
      <text fg={C.fg5}>{"  model id (e.g., claude-sonnet-4, llama-3.1-70b)"}</text>
      <Field
        value={props.model}
        focused={props.field === "model"}
        placeholder="claude-sonnet-4"
        onInput={props.onModel}
        onSubmit={commit}
      />

      <text> </text>
      <text fg={C.fg5}>
        {`  known providers: ${PROVIDERS.slice(0, 8).map((p) => p.id).join(", ")}…`}
      </text>
      <text> </text>
      <text>
        <span fg={C.laser}>{"tab"}</span>
        <span fg={C.fg5}>{" switch field   "}</span>
        <span fg={C.laser}>{"enter"}</span>
        <span fg={C.fg5}>{" save   "}</span>
        <span fg={C.laser}>{"esc"}</span>
        <span fg={C.fg5}>{" cancel"}</span>
      </text>
    </Shell>
  );
}

// ----- shared -----

function Shell({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <box
      position="absolute"
      left={0}
      right={0}
      bottom={5}
      flexDirection="column"
      alignItems="center"
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
        width={WIDTH}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text>
            <span fg={C.fg3}>{"[ "}</span>
            <span fg={C.fg1} attributes={ATTR_BOLD}>{title}</span>
            <span fg={C.fg3}>{" ]"}</span>
          </text>
          {hint && <text fg={C.fg5}>{hint}</text>}
        </box>
        <text> </text>
        {children}
      </box>
    </box>
  );
}

function Field(props: {
  value: string;
  focused: boolean;
  placeholder: string;
  onInput(v: string): void;
  onSubmit(): void;
}) {
  return (
    <box
      flexDirection="row"
      backgroundColor={C.surface1}
      border
      borderStyle="single"
      borderColor={props.focused ? C.laser : C.border2}
      paddingLeft={1}
      paddingRight={1}
      alignItems="center"
    >
      <box width={2} flexShrink={0}>
        <text fg={C.fg5}>{"› "}</text>
      </box>
      <box flexGrow={1}>
        <input
          value={props.value}
          focused={props.focused}
          placeholder={props.placeholder}
          textColor={C.fg2}
          focusedTextColor={C.fg1}
          placeholderColor={C.fg5}
          onInput={props.onInput}
          onSubmit={props.onSubmit}
        />
      </box>
    </box>
  );
}
