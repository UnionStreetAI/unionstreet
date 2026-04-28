/**
 * Inline slash command menu — appears above the composer the moment the
 * user types `/`. Filters as they type. Arrow keys navigate, Enter selects
 * (which fills the composer with `/cmd ` if the command takes an arg, or
 * runs it directly if not). Esc dismisses.
 *
 * Filter source: the composer's current value, passed in as `query`.
 *   "/m"      → shows /model
 *   "/mo"     → shows /model
 *   "/clr"    → shows /clear
 *
 * Selection is driven by the parent (App) via `selectedIndex` so the
 * up/down handler can live next to other global keyboard handling.
 */
import { C, ATTR_BOLD } from "./theme.ts";
import type { SlashCommand } from "./slash.ts";

export interface SlashMenuProps {
  commands: SlashCommand[];
  query: string;
  selectedIndex: number;
  onPick(cmd: SlashCommand): void;
}

export function filterSlashCommands(
  commands: SlashCommand[],
  query: string,
): SlashCommand[] {
  const q = query.replace(/^\/+/, "").trim().toLowerCase();
  if (!q) return commands;
  return commands.filter((c) => c.name.toLowerCase().startsWith(q));
}

const PICKER_WIDTH = 56;

export function SlashMenu({ commands, selectedIndex, onPick }: SlashMenuProps) {
  if (commands.length === 0) return null;

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
      width={PICKER_WIDTH}
    >
      <text>
        <span fg={C.fg3}>{"[ "}</span>
        <span fg={C.fg1} attributes={ATTR_BOLD}>{"COMMANDS"}</span>
        <span fg={C.fg3}>{" ]"}</span>
      </text>
      {commands.map((cmd, i) => {
        const isSelected = i === selectedIndex;
        const usage = cmd.arg ? `/${cmd.name} <${cmd.arg}>` : `/${cmd.name}`;
        return (
          <box
            key={cmd.name}
            flexDirection="row"
            backgroundColor={isSelected ? C.surface3 : C.void}
            paddingLeft={1}
            paddingRight={1}
            onMouseDown={() => onPick(cmd)}
          >
            <box width={20} flexShrink={0}>
              <text fg={isSelected ? C.laser : C.fg2} attributes={isSelected ? ATTR_BOLD : 0}>
                {usage}
              </text>
            </box>
            <box flexGrow={1}>
              <text fg={isSelected ? C.fg2 : C.fg4}>{cmd.summary}</text>
            </box>
          </box>
        );
      })}
    </box>
  );
}
