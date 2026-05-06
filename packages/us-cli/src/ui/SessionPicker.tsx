/**
 * `/resume` overlay — picks an older session JSONL and replays it.
 *
 * Mirrors ModelPicker shape: filter input on top, custom-rendered list,
 * arrow keys + click + enter, esc cancels. Sessions sorted newest-first.
 *
 * The list shows: timestamp, age, turn count, last user message preview.
 * On select the parent (App) calls `resumeSession(file)` which swaps the
 * runtime + replaces messages/turns + pushes a system note.
 */
import { useEffect, useMemo, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import {
  listSessions,
  sessionAgeLabel,
  shortSessionLabel,
  type SessionInfo,
} from "@unionstreet/server";
import { C, ATTR_BOLD } from "./theme.ts";

export interface SessionPickerProps {
  profile: string;
  /** File path of the active session — marked with a current-marker. */
  currentFile?: string;
  onSelect(session: SessionInfo): void;
  onCancel(): void;
}

const PICKER_WIDTH = 80;

export function SessionPicker({ profile, currentFile, onSelect, onCancel }: SessionPickerProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");

  const { height: screenHeight } = useTerminalDimensions();

  useEffect(() => {
    let cancelled = false;
    listSessions(profile)
      .then((list) => {
        if (cancelled) return;
        setSessions(list);
        setLoadState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setLoadState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [profile]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.firstUserPreview.toLowerCase().includes(q) ||
        s.lastUserPreview.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q),
    );
  }, [sessions, query]);

  const safeIndex = filtered.length > 0 ? Math.min(selectedIndex, filtered.length - 1) : 0;

  function commit() {
    const s = filtered[safeIndex];
    if (s) onSelect(s);
    else onCancel();
  }

  function move(delta: number) {
    if (filtered.length === 0) return;
    setSelectedIndex((cur) => {
      const next = cur + delta;
      if (next < 0) return filtered.length - 1;
      if (next >= filtered.length) return 0;
      return next;
    });
  }

  useKeyboard((ev) => {
    if (ev.name === "escape") onCancel();
    else if (ev.name === "up") move(-1);
    else if (ev.name === "down") move(+1);
    else if (ev.ctrl && ev.name === "n") move(+1);
    else if (ev.ctrl && ev.name === "p") move(-1);
  });

  // Window the rendered rows around the selection.
  const maxRows = Math.max(8, Math.min(20, Math.floor(screenHeight * 0.6)));
  const start = clamp(
    safeIndex - Math.floor(maxRows / 2),
    0,
    Math.max(0, filtered.length - maxRows),
  );
  const visible = filtered.slice(start, start + maxRows);

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
        width={PICKER_WIDTH}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text>
            <span fg={C.fg3}>{"[ "}</span>
            <span fg={C.fg1} attributes={ATTR_BOLD}>{"RESUME SESSION"}</span>
            <span fg={C.fg3}>{" ]"}</span>
            <span fg={C.fg5}>{`   @${profile}`}</span>
          </text>
          <text fg={C.fg5}>
            {loadState === "loading"
              ? "loading…"
              : loadState === "error"
              ? "error reading sessions/"
              : `${sessions.length} sessions`}
          </text>
        </box>
        <text> </text>

        {/* filter */}
        <box
          flexDirection="row"
          backgroundColor={C.surface1}
          border
          borderStyle="single"
          borderColor={C.border2}
          paddingLeft={1}
          paddingRight={1}
          alignItems="center"
        >
          <box width={2} flexShrink={0}>
            <text fg={C.fg5}>{"⌕ "}</text>
          </box>
          <box flexGrow={1}>
            <input
              value={query}
              focused
              placeholder="filter by message text…"
              textColor={C.fg2}
              focusedTextColor={C.fg1}
              placeholderColor={C.fg5}
              onInput={(v) => {
                setQuery(v);
                setSelectedIndex(0);
              }}
              onSubmit={() => commit()}
            />
          </box>
        </box>

        <text> </text>

        {filtered.length === 0 ? (
          <text fg={C.fg5}>
            {loadState === "loading"
              ? "  loading…"
              : sessions.length === 0
              ? "  no sessions yet — start chatting and a file lands in <profile>/sessions/"
              : "  (no matches — esc to cancel)"}
          </text>
        ) : (
          <box flexDirection="column">
            {visible.map((s, i) => {
              const absoluteIndex = start + i;
              return (
                <SessionRow
                  key={s.id}
                  session={s}
                  isSelected={absoluteIndex === safeIndex}
                  isCurrent={s.file === currentFile}
                  onSelect={() => onSelect(s)}
                  onHover={() => {
                    if (absoluteIndex !== safeIndex) setSelectedIndex(absoluteIndex);
                  }}
                />
              );
            })}
          </box>
        )}

        <text> </text>
        <text>
          <span fg={C.fg5}>{"↑↓ navigate    type to filter    enter resume    esc cancel"}</span>
        </text>
      </box>
    </box>
  );
}

function SessionRow(props: {
  session: SessionInfo;
  isSelected: boolean;
  isCurrent: boolean;
  onSelect(): void;
  onHover(): void;
}) {
  const s = props.session;
  return (
    <box
      flexDirection="row"
      backgroundColor={props.isSelected ? C.surface3 : C.void}
      paddingLeft={1}
      paddingRight={1}
      onMouseDown={props.onSelect}
      onMouseMove={props.onHover}
    >
      <box width={2} flexShrink={0}>
        <text fg={props.isCurrent ? C.laser : C.fg5}>
          {props.isCurrent ? "●" : " "}
        </text>
      </box>
      <box width={18} flexShrink={0}>
        <text
          fg={props.isSelected ? C.fg1 : C.fg2}
          attributes={props.isSelected ? ATTR_BOLD : 0}
        >
          {shortSessionLabel(s.id)}
        </text>
      </box>
      <box width={10} flexShrink={0}>
        <text fg={C.fg5}>{sessionAgeLabel(s.ts)}</text>
      </box>
      <box width={8} flexShrink={0}>
        <text fg={C.fg5}>{`${s.turnCount} turns`}</text>
      </box>
      <box flexGrow={1}>
        <text fg={props.isSelected ? C.fg3 : C.fg5}>
          {s.lastUserPreview || "(no user messages)"}
        </text>
      </box>
    </box>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
