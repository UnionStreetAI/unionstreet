import { useEffect, useMemo, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { inspectMcpStatus, type McpStatus, type McpServerInfo } from "@unionstreet/server";
import { C, ATTR_BOLD } from "./theme.ts";
import { compactPath } from "./env.ts";

export function McpOverlay(props: { cwd: string; profile: string; onCancel(): void }) {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const { width, height } = useTerminalDimensions();

  useEffect(() => {
    let cancelled = false;
    inspectMcpStatus(props.cwd, props.profile)
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [props.cwd, props.profile]);

  const rows = useMemo(() => status?.servers ?? [], [status]);
  const maxRows = Math.max(6, Math.min(14, height - 14));
  const safeSelected = rows.length ? Math.min(selected, rows.length - 1) : 0;
  const start = clamp(safeSelected - Math.floor(maxRows / 2), 0, Math.max(0, rows.length - maxRows));
  const visible = rows.slice(start, start + maxRows);
  const boxWidth = clamp(width - 8, 72, 118);

  function move(delta: number) {
    if (!rows.length) return;
    setSelected((cur) => clamp(cur + delta, 0, rows.length - 1));
  }

  useKeyboard((ev) => {
    if (ev.name === "escape") props.onCancel();
    else if (ev.name === "up") move(-1);
    else if (ev.name === "down") move(1);
    else if (ev.name === "pageup") move(-maxRows);
    else if (ev.name === "pagedown") move(maxRows);
  });

  return (
    <box
      position="absolute"
      top={1}
      left={0}
      right={0}
      bottom={0}
      alignItems="flex-start"
      justifyContent="center"
      zIndex={1000}
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
        width={boxWidth}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text>
            <span fg={C.fg3}>{"[ "}</span>
            <span fg={C.fg1} attributes={ATTR_BOLD}>{"MCP"}</span>
            <span fg={C.fg3}>{" ]"}</span>
          </text>
          <text fg={C.fg5}>{"esc"}</text>
        </box>
        <text> </text>

        {error ? (
          <text fg={C.danger}>{`  ${error}`}</text>
        ) : !status ? (
          <text fg={C.laser}>{"  scanning MCP config…"}</text>
        ) : (
          <>
            <box flexDirection="row">
              <Metric label="configured" value={String(status.servers.length)} />
              <Metric label="enabled" value={String(status.servers.filter((s) => s.enabled).length)} />
              <Metric label="granted" value={String(status.servers.filter((s) => status.grants[s.name]?.allowed).length)} />
              <Metric label="builtin tools" value={String(status.builtinTools.length)} />
            </box>
            {status.identity && (
              <text fg={C.fg5}>{`  ${status.identity.subject}  roles:${listOrNone(status.identity.roles)}  groups:${listOrNone(status.identity.groups)}`}</text>
            )}
            <text> </text>

            {rows.length ? (
              <box flexDirection="column">
                {visible.map((server, i) => {
                  const absoluteIndex = start + i;
                  return (
                    <ServerRow
                      key={`${server.source}:${server.name}`}
                      server={server}
                      decision={status.grants[server.name]}
                      selected={absoluteIndex === safeSelected}
                      width={boxWidth - 6}
                      onSelect={() => setSelected(absoluteIndex)}
                    />
                  );
                })}
              </box>
            ) : (
              <box flexDirection="column">
                <text fg={C.fg2}>{"  no configured MCP servers found"}</text>
                <text fg={C.fg5}>{"  checked .mcp.json, mcp.json, opencode.json(c), and ~/.config/opencode"}</text>
              </box>
            )}

            <text> </text>
            <text fg={C.fg3} attributes={ATTR_BOLD}>{"BUILT-IN TOOLS"}</text>
            <box flexDirection="row" flexWrap="wrap">
              {status.builtinTools.map((tool) => (
                <box key={tool.name} marginRight={2}>
                  <text fg={C.fg2}>{tool.name}</text>
                </box>
              ))}
            </box>

            {rows[safeSelected] && (
              <>
                <text> </text>
                <ServerDetail server={rows[safeSelected]!} decision={status.grants[rows[safeSelected]!.name]} />
              </>
            )}
          </>
        )}

        <text> </text>
        <text>
          <span fg={C.fg5}>{"↑↓ select"}</span>
          <span fg={C.fg5}>{"    esc close"}</span>
        </text>
      </box>
    </box>
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <box marginRight={4}>
      <text>
        <span fg={C.fg1} attributes={ATTR_BOLD}>{props.value}</span>
        <span fg={C.fg5}>{` ${props.label}`}</span>
      </text>
    </box>
  );
}

function ServerRow(props: { server: McpServerInfo; decision?: McpStatus["grants"][string]; selected: boolean; width: number; onSelect(): void }) {
  const status = props.decision?.allowed ? "granted" : props.server.enabled ? "blocked" : "disabled";
  const detail = props.server.url ?? props.server.command ?? props.server.transport;
  const credential = props.server.credential?.configured ? `${props.server.credential.source}/${props.server.credential.kind}` : "no auth";
  return (
    <box
      flexDirection="row"
      backgroundColor={props.selected ? C.surface3 : C.void}
      paddingLeft={1}
      paddingRight={1}
      onMouseDown={props.onSelect}
    >
      <box width={24} flexShrink={0}>
        <text fg={props.selected ? C.fg1 : C.fg2} attributes={props.selected ? ATTR_BOLD : 0}>
          {truncate(props.server.name, 22)}
        </text>
      </box>
      <box width={11} flexShrink={0}>
        <text fg={props.decision?.allowed ? C.success : props.server.enabled ? C.laser : C.fg5}>{status}</text>
      </box>
      <box width={10} flexShrink={0}>
        <text fg={C.fg4}>{props.server.transport}</text>
      </box>
      <box width={14} flexShrink={0}>
        <text fg={props.server.credential?.configured ? C.fg3 : C.fg5}>{credential}</text>
      </box>
      <box flexGrow={1}>
        <text fg={C.fg5}>{truncate(detail, Math.max(12, props.width - 61))}</text>
      </box>
    </box>
  );
}

function ServerDetail(props: { server: McpServerInfo; decision?: McpStatus["grants"][string] }) {
  return (
    <box flexDirection="column" border borderStyle="single" borderColor={C.border2} paddingLeft={1} paddingRight={1}>
      <text>
        <span fg={C.fg5}>{"source  "}</span>
        <span fg={C.fg3}>{compactPath(props.server.source)}</span>
      </text>
      <text>
        <span fg={C.fg5}>{"auth    "}</span>
        <span fg={C.fg3}>{props.server.auth}</span>
      </text>
      <text>
        <span fg={C.fg5}>{"cred    "}</span>
        <span fg={props.server.credential?.configured ? C.success : C.fg5}>
          {props.server.credential?.configured
            ? `${props.server.credential.source}/${props.server.credential.kind}${credentialExpiry(props.server.credential.expiresInSeconds)}`
            : "none for this agent"}
        </span>
      </text>
      <text>
        <span fg={C.fg5}>{"grant   "}</span>
        <span fg={props.decision?.allowed ? C.success : C.laser}>
          {props.decision?.allowed ? `allowed tools:${listOrNone(props.decision.tools)}` : "not granted to this agent"}
        </span>
      </text>
      {props.decision?.requireApproval && (
        <text>
          <span fg={C.fg5}>{"policy  "}</span>
          <span fg={C.laser}>{"approval required"}</span>
        </text>
      )}
      {props.server.url && (
        <text>
          <span fg={C.fg5}>{"url     "}</span>
          <span fg={C.fg3}>{props.server.url}</span>
        </text>
      )}
      {props.server.command && (
        <text>
          <span fg={C.fg5}>{"command "}</span>
          <span fg={C.fg3}>{truncate(props.server.command, 88)}</span>
        </text>
      )}
    </box>
  );
}

function credentialExpiry(seconds: number | undefined): string {
  if (typeof seconds !== "number") return "";
  if (seconds <= 0) return " expired";
  if (seconds < 3600) return ` ${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return ` ${Math.round(seconds / 3600)}h`;
  return ` ${Math.round(seconds / 86400)}d`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…";
}

function listOrNone(items: string[]): string {
  return items.length ? items.join(",") : "none";
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
