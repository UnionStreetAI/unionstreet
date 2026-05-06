/**
 * `Cmd+A` on the model picker → add a provider.
 *
 * Two stages:
 *   1. Pick a provider from the curated catalog (server/providers.ts).
 *      Western providers only — sorted: popular first, then alphabetical.
 *   2. If api_key: prompt for the key, save to auth-profiles.json.
 *      If oauth: show a note pointing the user at `us-dev auth <subcmd>`
 *      (we don't run the OAuth browser flow inside the TUI in this build).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import open from "open";
import {
  PROVIDERS,
  GLOBAL_AUTH_PROFILES_PATH,
  profilePaths,
  sanitizeOpenAICompatBaseUrl,
  updateAuthProfiles,
  type ProviderInfo,
  type OAuthCred,
} from "@unionstreet/server";
import {
  loginOpenAICodex,
  loginAnthropic,
  type OAuthCredentials,
} from "@unionstreet/us-auth";
import { C, ATTR_BOLD } from "./theme.ts";

export interface AddProviderDialogProps {
  /**
   * If provided, the API key lands in the profile-local override.
   * Otherwise it lands in the shared global auth-profiles.json.
   */
  profileForOverride?: string;
  onDone(message: string): void;
  onCancel(): void;
}

const PICKER_WIDTH = 76;

type Stage =
  | { kind: "pick" }
  | { kind: "api_key"; provider: ProviderInfo }
  | { kind: "oauth"; provider: ProviderInfo };

export function AddProviderDialog({
  profileForOverride,
  onDone,
  onCancel,
}: AddProviderDialogProps) {
  const [stage, setStage] = useState<Stage>({ kind: "pick" });

  return stage.kind === "pick" ? (
    <PickStage
      onPick={(p) => {
        // Prefer api_key when available (fastest path). OAuth providers
        // (codex / anthropic-pro / github-copilot) drop into the inline
        // OAuth stage which actually drives the flow — no more CLI hop.
        if (p.authMethods.includes("api_key")) setStage({ kind: "api_key", provider: p });
        else setStage({ kind: "oauth", provider: p });
      }}
      onCancel={onCancel}
    />
  ) : stage.kind === "api_key" ? (
    <ApiKeyStage
      provider={stage.provider}
      profileForOverride={profileForOverride}
      onSaved={(msg) => onDone(msg)}
      onBack={() => setStage({ kind: "pick" })}
      onCancel={onCancel}
    />
  ) : (
    <OAuthStage
      provider={stage.provider}
      profileForOverride={profileForOverride}
      onSaved={onDone}
      onCancel={onCancel}
    />
  );
}

// ----- stage 1: provider picker -----

function PickStage({
  onPick,
  onCancel,
}: {
  onPick(p: ProviderInfo): void;
  onCancel(): void;
}) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { height: screenHeight } = useTerminalDimensions();

  const sorted = useMemo(() => {
    const popular = PROVIDERS.filter((p) => p.category === "popular");
    const other = PROVIDERS.filter((p) => p.category === "other").slice().sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    return [...popular, ...other];
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q),
    );
  }, [sorted, query]);

  const safeIndex = filtered.length > 0 ? Math.min(selectedIndex, filtered.length - 1) : 0;

  function move(delta: number) {
    if (filtered.length === 0) return;
    setSelectedIndex((cur) => {
      const next = cur + delta;
      if (next < 0) return filtered.length - 1;
      if (next >= filtered.length) return 0;
      return next;
    });
  }

  function commit() {
    const p = filtered[safeIndex];
    if (p) onPick(p);
    else onCancel();
  }

  useKeyboard((ev) => {
    if (ev.name === "escape") onCancel();
    else if (ev.name === "up") move(-1);
    else if (ev.name === "down") move(+1);
    else if (ev.ctrl && ev.name === "n") move(+1);
    else if (ev.ctrl && ev.name === "p") move(-1);
  });

  const maxRows = Math.max(8, Math.min(20, Math.floor(screenHeight * 0.6)));
  const start = clamp(safeIndex - Math.floor(maxRows / 2), 0, Math.max(0, filtered.length - maxRows));
  const visible = filtered.slice(start, start + maxRows);

  return (
    <DialogShell width={PICKER_WIDTH} title="ADD PROVIDER" hint={`${PROVIDERS.length} providers`}>
      <FilterInput
        query={query}
        onInput={(v) => {
          setQuery(v);
          setSelectedIndex(0);
        }}
        onSubmit={commit}
        placeholder="filter providers…"
      />
      <text> </text>
      {filtered.length === 0 ? (
        <text fg={C.fg5}>{"  (no matches — esc to cancel)"}</text>
      ) : (
        <box flexDirection="column">
          {visible.map((p, i) => {
            const absoluteIndex = start + i;
            const isSelected = absoluteIndex === safeIndex;
            return (
              <box
                key={p.id}
                flexDirection="row"
                backgroundColor={isSelected ? C.surface3 : C.void}
                paddingLeft={1}
                paddingRight={1}
                onMouseDown={() => onPick(p)}
                onMouseMove={() => {
                  if (!isSelected) setSelectedIndex(absoluteIndex);
                }}
              >
                <box width={4} flexShrink={0}>
                  <text fg={C.fg5}>{regionFlag(p.region)}</text>
                </box>
                <box width={28} flexShrink={0}>
                  <text fg={isSelected ? C.fg1 : C.fg2} attributes={isSelected ? ATTR_BOLD : 0}>
                    {p.name}
                  </text>
                </box>
                <box width={10} flexShrink={0}>
                  <text fg={p.authMethods[0] === "oauth" ? C.laser : C.fg5}>
                    {p.authMethods[0] === "oauth" ? "oauth" : "api key"}
                  </text>
                </box>
                <box flexGrow={1}>
                  <text fg={isSelected ? C.fg3 : C.fg5}>{truncate(p.description, 32)}</text>
                </box>
              </box>
            );
          })}
        </box>
      )}
      <text> </text>
      <text>
        <span fg={C.fg5}>{"↑↓ navigate    type to filter    enter select    esc cancel"}</span>
      </text>
    </DialogShell>
  );
}

// ----- stage 2: api key -----

function ApiKeyStage(props: {
  provider: ProviderInfo;
  profileForOverride?: string;
  onSaved(message: string): void;
  onBack(): void;
  onCancel(): void;
}) {
  const { provider } = props;
  const needsBaseUrl = provider.needsBaseUrl ?? false;
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  // Two-field forms: tab cycles focus. Single-field forms: only key has focus.
  const [focus, setFocus] = useState<"baseUrl" | "key">(needsBaseUrl ? "baseUrl" : "key");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useKeyboard((ev) => {
    if (saving) return;
    if (ev.name === "escape") props.onCancel();
    else if (ev.name === "tab" && needsBaseUrl) {
      setFocus((f) => (f === "baseUrl" ? "key" : "baseUrl"));
    }
  });

  async function save() {
    if (!key.trim()) return;
    if (needsBaseUrl && !baseUrl.trim()) {
      setError("base URL is required for this provider");
      return;
    }
    const sanitizedBaseUrl = needsBaseUrl ? sanitizeOpenAICompatBaseUrl(baseUrl) : undefined;
    const authKey = providerAuthKey(provider, sanitizedBaseUrl);
    setSaving(true);
    setError(null);
    const path = props.profileForOverride
      ? profilePaths(props.profileForOverride).authProfiles
      : GLOBAL_AUTH_PROFILES_PATH;
    try {
      await updateAuthProfiles(path, (cur) => ({
        ...cur,
        providers: {
          ...cur.providers,
          [authKey]: {
            kind: "api_key",
            api_key: key.trim(),
            ...(sanitizedBaseUrl ? { base_url: sanitizedBaseUrl } : {}),
          },
        },
      }));
      const where = props.profileForOverride
        ? `profile:${props.profileForOverride}`
        : "global";
      props.onSaved(`saved api key for @${authKey} (${where})`);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  return (
    <DialogShell width={PICKER_WIDTH} title={`ADD KEY · ${provider.name.toUpperCase()}`} hint="api key">
      <text fg={C.fg4}>{provider.description}</text>
      {provider.apiKeyUrl && <text fg={C.fg5}>{`get one at: ${provider.apiKeyUrl}`}</text>}
      <text> </text>

      {needsBaseUrl && (
        <>
          <text fg={C.fg5}>{"  base url"}</text>
          <FilterInput
            query={baseUrl}
            onInput={setBaseUrl}
            onSubmit={() => setFocus("key")}
            placeholder={provider.baseUrlHint ?? "https://…"}
            prefix="@"
            focused={focus === "baseUrl"}
          />
          <text> </text>
        </>
      )}

      <text fg={C.fg5}>{needsBaseUrl ? "  api key" : ""}</text>
      <FilterInput
        query={key}
        onInput={setKey}
        onSubmit={() => void save()}
        placeholder={provider.apiKeyHint ?? "paste your api key…"}
        prefix="·"
        focused={focus === "key"}
      />

      {error && (
        <>
          <text> </text>
          <text fg={C.danger}>{`  ${error}`}</text>
        </>
      )}
      <text> </text>
      <text>
        <span fg={C.fg5}>
          {props.profileForOverride
            ? `will save to profile:${props.profileForOverride}`
            : "will save to ~/.us/auth-profiles.json (shared)"}
        </span>
      </text>
      <text> </text>
      <text>
        {needsBaseUrl && (
          <>
            <span fg={C.laser}>{"tab"}</span>
            <span fg={C.fg5}>{" switch field   "}</span>
          </>
        )}
        <span fg={C.fg5}>{"enter "}</span>
        <span fg={C.laser}>{saving ? "saving…" : "save"}</span>
        <span fg={C.fg5}>{"     esc cancel"}</span>
      </text>
    </DialogShell>
  );
}

// ----- stage 2: in-TUI oauth -----

type OAuthPhase =
  | { kind: "starting" }
  | { kind: "browser_opened"; url: string }
  | { kind: "needs_input"; question: string; placeholder?: string }
  | { kind: "saving" }
  | { kind: "done"; key: string }
  | { kind: "error"; message: string };

interface OAuthDriver {
  /** Provider id key used in auth-profiles.json. */
  authKey: string;
  /** Underlying us-auth login fn. */
  run(opts: {
    onAuth: (info: { url: string; instructions?: string }) => void;
    onPrompt: (p: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
    onProgress?: (msg: string) => void;
    signal?: AbortSignal;
  }): Promise<OAuthCredentials>;
}

function driverFor(provider: ProviderInfo): OAuthDriver | null {
  switch (provider.id) {
    case "openai-codex":
      return {
        authKey: "codex",
        run: (opts) => loginOpenAICodex(opts),
      };
    case "anthropic-oauth":
      return {
        authKey: "claude",
        run: (opts) => loginAnthropic(opts),
      };
    // github-copilot / gemini-cli / antigravity have us-auth flows too;
    // wire them in when those providers get a model client.
    default:
      return null;
  }
}

function OAuthStage(props: {
  provider: ProviderInfo;
  profileForOverride?: string;
  onSaved(msg: string): void;
  onCancel(): void;
}) {
  const { provider } = props;
  const [phase, setPhase] = useState<OAuthPhase>({ kind: "starting" });
  const [promptValue, setPromptValue] = useState("");
  const promptResolverRef = useRef<((v: string) => void) | null>(null);
  const abortRef = useRef<AbortController>(new AbortController());

  useKeyboard((ev) => {
    if (ev.name === "escape" && phase.kind !== "saving") {
      try {
        abortRef.current.abort();
      } catch {
        // best-effort
      }
      props.onCancel();
    }
  });

  useEffect(() => {
    const driver = driverFor(provider);
    if (!driver) {
      setPhase({
        kind: "error",
        message: `OAuth flow for "${provider.id}" isn't wired yet — check back when this provider gets a model client.`,
      });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const creds = await driver.run({
          onAuth: ({ url }) => {
            if (cancelled) return;
            setPhase({ kind: "browser_opened", url });
            // Open the user's browser so they can complete the flow.
            void open(url).catch(() => {
              // ignore — user can copy the URL from the dialog
            });
          },
          onPrompt: (p) =>
            new Promise<string>((resolve) => {
              if (cancelled) return resolve("");
              setPromptValue("");
              promptResolverRef.current = resolve;
              setPhase({
                kind: "needs_input",
                question: p.message,
                placeholder: p.placeholder,
              });
            }),
          onProgress: () => {
            // could surface a status line; quiet for now
          },
          signal: abortRef.current.signal,
        });
        if (cancelled) return;
        setPhase({ kind: "saving" });
        await persistOAuth(provider, driver.authKey, creds, props.profileForOverride);
        const where = props.profileForOverride
          ? `profile:${props.profileForOverride}`
          : "global";
        if (!cancelled) {
          setPhase({ kind: "done", key: driver.authKey });
          props.onSaved(`saved oauth for @${driver.authKey} (${where})`);
        }
      } catch (e) {
        if (cancelled) return;
        setPhase({
          kind: "error",
          message: (e as Error).message || "oauth failed",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <DialogShell
      width={PICKER_WIDTH}
      title={`OAUTH · ${provider.name.toUpperCase()}`}
      hint={oauthHint(phase)}
    >
      <text fg={C.fg4}>{provider.description}</text>
      <text> </text>

      {phase.kind === "starting" && <text fg={C.laser}>{"  starting browser flow…"}</text>}

      {phase.kind === "browser_opened" && (
        <>
          <text fg={C.fg2}>{"  browser opened. complete the login there."}</text>
          <text fg={C.fg5}>{"  if it didn't open, paste this:"}</text>
          <text fg={C.laser}>{`  ${phase.url}`}</text>
        </>
      )}

      {phase.kind === "needs_input" && (
        <>
          <text fg={C.fg2}>{`  ${phase.question}`}</text>
          <text> </text>
          <FilterInput
            query={promptValue}
            onInput={setPromptValue}
            onSubmit={() => {
              promptResolverRef.current?.(promptValue);
              promptResolverRef.current = null;
              setPhase({ kind: "starting" });
            }}
            placeholder={phase.placeholder ?? "paste the value…"}
            prefix="·"
          />
        </>
      )}

      {phase.kind === "saving" && <text fg={C.laser}>{"  saving credentials…"}</text>}

      {phase.kind === "done" && (
        <text fg={C.success}>{`  ✓ saved. closing…`}</text>
      )}

      {phase.kind === "error" && <text fg={C.danger}>{`  ${phase.message}`}</text>}

      <text> </text>
      <text fg={C.fg5}>{"esc to cancel"}</text>
    </DialogShell>
  );
}

function oauthHint(p: OAuthPhase): string {
  switch (p.kind) {
    case "starting":
      return "starting…";
    case "browser_opened":
      return "waiting for browser";
    case "needs_input":
      return "input required";
    case "saving":
      return "saving";
    case "done":
      return "done";
    case "error":
      return "error";
  }
}

async function persistOAuth(
  provider: ProviderInfo,
  authKey: string,
  creds: OAuthCredentials,
  profileForOverride?: string,
): Promise<void> {
  const path = profileForOverride
    ? profilePaths(profileForOverride).authProfiles
    : GLOBAL_AUTH_PROFILES_PATH;
  await updateAuthProfiles(path, (cur) => {
    const stored: OAuthCred = {
      kind: "oauth",
      provider: provider.id,
      access: creds.access,
      refresh: creds.refresh,
      expires: creds.expires,
      ...stripStandardFields(creds),
    };
    return {
      ...cur,
      providers: { ...cur.providers, [authKey]: stored },
    };
  });
}

function stripStandardFields(creds: OAuthCredentials): Record<string, unknown> {
  const { access: _a, refresh: _r, expires: _e, ...rest } = creds;
  return rest;
}

// ----- shared bits -----

function DialogShell(props: {
  width: number;
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
        width={props.width}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text>
            <span fg={C.fg3}>{"[ "}</span>
            <span fg={C.fg1} attributes={ATTR_BOLD}>{props.title}</span>
            <span fg={C.fg3}>{" ]"}</span>
          </text>
          {props.hint && <text fg={C.fg5}>{props.hint}</text>}
        </box>
        <text> </text>
        {props.children}
      </box>
    </box>
  );
}

function FilterInput(props: {
  query: string;
  onInput(v: string): void;
  onSubmit(): void;
  placeholder: string;
  prefix?: string;
  focused?: boolean;
}) {
  const isFocused = props.focused ?? true;
  return (
    <box
      flexDirection="row"
      backgroundColor={C.surface1}
      border
      borderStyle="single"
      borderColor={isFocused ? C.laser : C.border2}
      paddingLeft={1}
      paddingRight={1}
      alignItems="center"
    >
      <box width={2} flexShrink={0}>
        <text fg={C.fg5}>{(props.prefix ?? "⌕") + " "}</text>
      </box>
      <box flexGrow={1}>
        <input
          value={props.query}
          focused={isFocused}
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

function regionFlag(r: ProviderInfo["region"]): string {
  switch (r) {
    case "us":
      return "US";
    case "eu":
      return "EU";
    case "ca":
      return "CA";
    case "il":
      return "IL";
  }
}

function providerAuthKey(provider: ProviderInfo, baseUrl: string | undefined): string {
  if (provider.id !== "custom-openai-compat" || !baseUrl) return provider.id;
  return `custom-openai-compat:${slugFromBaseUrl(baseUrl)}`;
}

function slugFromBaseUrl(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname.replace(/^api\./, "");
    const slug = host
      .split(".")
      .filter((part) => part && part !== "com" && part !== "ai" && part !== "cloud")
      .join("-");
    return slug || "custom";
  } catch {
    return "custom";
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
