/**
 * `@ → + create new profile` overlay.
 *
 * v1: a single-field prompt that creates a profile via `initProfile`,
 * then immediately switches to it. No SOUL/IDENTITY editing here — the
 * defaults are fine for a first session, and the user can edit those
 * files at their leisure.
 *
 * TODO (design): a richer "agent onboarding walkthrough" lives next.
 * Likely shape: a pre-baked skill (`$onboard` or auto-trigger on first
 * chat with a fresh profile) that:
 *   1. asks for the agent's purpose (one sentence) and writes SOUL.md
 *   2. asks role + capabilities and writes IDENTITY.md
 *   3. picks a default model + writes config.yaml
 *   4. opens auth flow if creds aren't shared from another peer yet
 *   5. optionally seeds AGENTS.md with delegation conventions
 */
import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { C, ATTR_BOLD } from "./theme.ts";

export interface CreateProfileOverlayProps {
  /** Pre-fills the input — comes from whatever the user typed after `@`. */
  initialName?: string;
  /** Existing profile names (for collision check). */
  existing: string[];
  onCreate(name: string): void;
  onCancel(): void;
}

const VALID_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

export function CreateProfileOverlay({
  initialName,
  existing,
  onCreate,
  onCancel,
}: CreateProfileOverlayProps) {
  const [name, setName] = useState(initialName ?? "");

  useKeyboard((ev) => {
    if (ev.name === "escape") onCancel();
  });

  const trimmed = name.trim();
  let error: string | null = null;
  if (!trimmed) error = null;
  else if (!VALID_NAME.test(trimmed))
    error =
      "lowercase letters, digits, _ or -, max 64 chars, must start with a letter";
  else if (existing.includes(trimmed)) error = `"${trimmed}" already exists`;

  function commit() {
    if (!trimmed || error) return;
    onCreate(trimmed);
  }

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
        width={56}
      >
        <text>
          <span fg={C.fg3}>{"[ "}</span>
          <span fg={C.fg1} attributes={ATTR_BOLD}>{"NEW PROFILE"}</span>
          <span fg={C.fg3}>{" ]"}</span>
        </text>
        <text fg={C.fg5}>
          {"a new sovereign peer. starts with default SOUL/IDENTITY."}
        </text>
        <text> </text>

        {/* name input */}
        <box
          flexDirection="row"
          backgroundColor={C.surface1}
          border
          borderStyle="single"
          borderColor={error ? C.danger : C.border2}
          paddingLeft={1}
          paddingRight={1}
          alignItems="center"
        >
          <box width={2} flexShrink={0}>
            <text fg={C.laser}>{"@"}</text>
          </box>
          <box flexGrow={1}>
            <input
              value={name}
              focused
              placeholder="name (lowercase, dashes ok)"
              textColor={C.fg2}
              focusedTextColor={C.fg1}
              placeholderColor={C.fg5}
              onInput={setName}
              onSubmit={() => commit()}
            />
          </box>
        </box>

        {error && (
          <>
            <text> </text>
            <text fg={C.danger}>{`  ${error}`}</text>
          </>
        )}

        <text> </text>
        <text>
          <span fg={C.fg5}>{"enter "}</span>
          <span fg={C.laser}>{"create"}</span>
          <span fg={C.fg5}>{"     esc cancel"}</span>
        </text>
        <text fg={C.fg5}>
          {"  edit SOUL.md / IDENTITY.md afterwards to teach the peer."}
        </text>
      </box>
    </box>
  );
}
