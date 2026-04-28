/**
 * Inline profile menu — appears above the composer the moment the user
 * types `@`. Filters as they type. Mirrors the shape of SlashMenu so
 * the keyboard story is identical.
 *
 * Picking a profile switches the active session to that peer's identity
 * (new system prompt, new auth, fresh transcript). The current session
 * file is preserved on disk; we just don't carry the message history
 * across the switch — the new profile is a sovereign agent.
 *
 * The menu always ends with a `[ + create new profile ]` row in laser.
 * Selecting it opens the CreateProfileOverlay. Sentinel value:
 * {@link CREATE_PROFILE_SENTINEL}.
 */
import { C, ATTR_BOLD } from "./theme.ts";

/** Returned to the App's `onPick` when the user chooses the create-new row. */
export const CREATE_PROFILE_SENTINEL = "::create-new::";

export interface ProfileMenuProps {
  profiles: string[];
  current: string;
  query: string;
  selectedIndex: number;
  onPick(name: string): void;
}

/**
 * Filter profiles by query, then append the create-new sentinel. The
 * sentinel is always present so users can create a peer mid-session.
 */
export function filterProfiles(profiles: string[], query: string): string[] {
  const q = query.replace(/^@+/, "").trim().toLowerCase();
  const matched = q
    ? profiles.filter((p) => p.toLowerCase().startsWith(q))
    : profiles;
  return [...matched, CREATE_PROFILE_SENTINEL];
}

const MENU_WIDTH = 56;

export function ProfileMenu({
  profiles,
  current,
  selectedIndex,
  onPick,
}: ProfileMenuProps) {
  return (
    <box
      flexDirection="column"
      backgroundColor={C.void}
      border
      borderStyle="single"
      borderColor={C.border2}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
      width={MENU_WIDTH}
    >
      <text>
        <span fg={C.fg3}>{"[ "}</span>
        <span fg={C.fg1} attributes={ATTR_BOLD}>{"PEERS"}</span>
        <span fg={C.fg3}>{" ]"}</span>
      </text>
      {profiles.map((name, i) => {
        const isSelected = i === selectedIndex;
        if (name === CREATE_PROFILE_SENTINEL) {
          return (
            <box
              key="__create"
              flexDirection="row"
              backgroundColor={isSelected ? C.surface3 : C.void}
              paddingLeft={1}
              paddingRight={1}
              onMouseDown={() => onPick(name)}
            >
              <box width={2} flexShrink={0}>
                <text fg={C.laser} attributes={ATTR_BOLD}>{"+"}</text>
              </box>
              <box width={20} flexShrink={0}>
                <text
                  fg={isSelected ? C.laser : C.laserDim}
                  attributes={isSelected ? ATTR_BOLD : 0}
                >
                  {"create new profile"}
                </text>
              </box>
              <box flexGrow={1}>
                <text fg={isSelected ? C.fg2 : C.fg5}>
                  {"spin up a new peer agent"}
                </text>
              </box>
            </box>
          );
        }
        const isCurrent = name === current;
        return (
          <box
            key={name}
            flexDirection="row"
            backgroundColor={isSelected ? C.surface3 : C.void}
            paddingLeft={1}
            paddingRight={1}
            onMouseDown={() => onPick(name)}
          >
            <box width={2} flexShrink={0}>
              <text fg={isCurrent ? C.laser : C.fg5}>{isCurrent ? "●" : " "}</text>
            </box>
            <box width={20} flexShrink={0}>
              <text
                fg={isSelected ? C.laser : C.fg2}
                attributes={isSelected ? ATTR_BOLD : 0}
              >
                {`@${name}`}
              </text>
            </box>
            <box flexGrow={1}>
              <text fg={isSelected ? C.fg2 : C.fg5}>
                {isCurrent ? "current" : "switch to this peer"}
              </text>
            </box>
          </box>
        );
      })}
    </box>
  );
}
