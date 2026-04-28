/**
 * `/model` overlay — opencode-style: filter input on top, list grouped
 * by provider below.
 *
 *   ↑↓ navigate (skips section headers)
 *   type to filter
 *   enter   select
 *   esc     cancel
 *   ⌘a      add provider
 *
 * For each provider authed in `auth-profiles.json` we:
 *   - codex (oauth)        → /codex/models
 *   - api_key + base_url    → <base_url>/models   (custom OpenAI-compat,
 *                              gateways, anything OpenAI-shape)
 *   - api_key (known id)    → use a hardcoded default base for that id
 *
 * Anthropic native and Google native need their own clients (different
 * schemas) — those slot in later. Providers we can't enumerate just
 * don't appear in the list. Adding them via Cmd+A still persists the
 * key; the picker renders an empty group with a hint.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { MouseEvent } from "@opentui/core";
import {
  CODEX_MODELS,
  CODEX_PROVIDER,
  listCodexModels,
  listOpenAIModels,
  type LiveCodexModel,
} from "@unionstreet/ai-codex";
import {
  resolveAuthProfiles,
  findProvider,
  getModelsForAuthKey,
  getProviderLabel,
  sanitizeOpenAICompatBaseUrl,
  type AuthProfilesFile,
  type ApiKeyCred,
  type OAuthCred,
  type RegistryModel,
} from "@unionstreet/us-core";
import { C, ATTR_BOLD } from "./theme.ts";

export interface ModelPickerProps {
  current: string;
  currentProvider: string;
  /** Active profile — used to resolve auth across all configured providers. */
  profile: string;
  /** Apply the model for this session only. */
  onSelect(id: string, provider: string): void;
  /** Apply for this session AND persist as the profile default. */
  onSetDefault(id: string, provider: string): void;
  /** Cmd+A — open the Add Provider dialog. */
  onAddProvider(): void;
  onCancel(): void;
}

/**
 * Default OpenAI-compatible API roots for known providers. Used when the
 * cred itself doesn't carry a `base_url`. Providers not in this map and
 * without a base_url fall through to KNOWN_MODELS (or get skipped).
 */
const OPENAI_COMPAT_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  together: "https://api.together.xyz/v1",
  cerebras: "https://api.cerebras.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  perplexity: "https://api.perplexity.ai",
  xai: "https://api.x.ai/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  "opencode-zen": "https://api.opencode.ai/v1",
  "vercel-ai-gateway": "https://gateway.ai.vercel.ai/v1",
};

/**
 * For UI labeling only. The model lists themselves come from models.dev
 * (or live /v1/models when applicable) — never hardcoded here.
 */
const PROVIDER_LABEL_HINTS: Record<string, string> = {
  codex: "OPENAI · CHATGPT",
  claude: "ANTHROPIC · CLAUDE PRO",
};

interface DisplayModel {
  id: string;
  description: string;
  display_name?: string;
  context_window?: number;
}

interface ProviderGroup {
  id: string;
  label: string;
  authMethod: string;
  models: DisplayModel[];
  baseUrl?: string;
  /** "loading" | "live" | "fallback" | "error" */
  state: "loading" | "live" | "fallback" | "error";
}

type Row =
  | { kind: "header"; title: string }
  | { kind: "model"; rowKey: string; group: ProviderGroup; model: DisplayModel }
  | { kind: "placeholder"; group: ProviderGroup; message: string };

const MIN_PICKER_WIDTH = 68;
const MAX_PICKER_WIDTH = 110;
const VISIBLE_ROWS = 12;

export function ModelPicker({
  current,
  currentProvider,
  profile,
  onSelect,
  onSetDefault,
  onAddProvider,
  onCancel,
}: ModelPickerProps) {
  const [query, setQuery] = useState("");
  // Selection is keyed on model id (stable across async group reshuffles),
  // not row index. The row index is derived on each render from the
  // current model id; if the id isn't in the rows yet (model still
  // loading), we fall back to the first model row.
  const [selectedRowKey, setSelectedRowKey] = useState<string>(
    rowKey("recent", currentProvider, current),
  );
  const [recentKeys, setRecentKeys] = useState<string[]>([
    modelKey(currentProvider, current),
  ]);
  const [groups, setGroups] = useState<ProviderGroup[]>([]);
  const cancelled = useRef(false);

  const { width: screenWidth, height: screenHeight } = useTerminalDimensions();
  const pickerWidth = clamp(screenWidth - 6, MIN_PICKER_WIDTH, MAX_PICKER_WIDTH);
  const innerWidth = Math.max(48, pickerWidth - 6);
  const viewportRows = clamp(VISIBLE_ROWS, 6, Math.max(6, screenHeight - 12));
  const columns = modelColumns(innerWidth);

  // Enumerate authed providers and fetch their model lists in parallel.
  useEffect(() => {
    cancelled.current = false;
    void enumerateProviderGroups(profile, (g) => {
      if (cancelled.current) return;
      setGroups((prev) => upsertGroup(prev, g));
    });
    return () => {
      cancelled.current = true;
    };
  }, [profile]);

  // Build the row list (Recent first, then provider sections) after filtering.
  // The filter matches against the group's id/label too, so typing
  // "anthropic" surfaces the whole ANTHROPIC · CLAUDE PRO section even
  // though individual model ids are `claude-sonnet-...`.
  const rows: Row[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: Row[] = [];

    const allModelRows = groups.flatMap((g) =>
      g.models.map((m) => ({
        kind: "model" as const,
        rowKey: rowKey("provider", g.id, m.id),
        group: g,
        model: m,
      })),
    );
    const matchesQuery = (row: Extract<Row, { kind: "model" }>) =>
      !q ||
      normalizedModelName(row.model).toLowerCase().includes(q) ||
      normalizedProviderName(row.group).toLowerCase().includes(q) ||
      row.model.id.toLowerCase().includes(q);

    const recent = recentKeys
      .map((key) => allModelRows.find((r) => modelKey(r.group.id, r.model.id) === key))
      .filter((r): r is Extract<Row, { kind: "model" }> => Boolean(r))
      .map((r) => ({ ...r, rowKey: rowKey("recent", r.group.id, r.model.id) }))
      .filter(matchesQuery);

    if (recent.length) {
      out.push({ kind: "header", title: "Recent" });
      out.push(...recent);
    }

    for (const g of groups) {
      const groupMatches =
        q.length > 0 &&
        (g.id.toLowerCase().includes(q) ||
          g.label.toLowerCase().includes(q) ||
          normalizedProviderName(g).toLowerCase().includes(q));

      const matched =
        !q || groupMatches
          ? g.models
          : g.models.filter(
              (m) =>
                m.id.toLowerCase().includes(q) ||
                m.description.toLowerCase().includes(q) ||
                m.display_name?.toLowerCase().includes(q) ||
                normalizedModelName(m).toLowerCase().includes(q),
            );

      // Always show authed groups — even when empty — so the user can
      // see what they configured. Placeholder rows explain WHY a group
      // is empty (still loading vs. no /models endpoint discovered).
      const shouldRender =
        matched.length > 0 || (!q && (g.state === "loading" || g.state === "fallback" || g.state === "error"));
      if (!shouldRender) continue;

      out.push({ kind: "header", title: normalizedProviderName(g) });
      if (matched.length > 0) {
        for (const m of matched) {
          out.push({
            kind: "model",
            rowKey: rowKey("provider", g.id, m.id),
            group: g,
            model: m,
          });
        }
      } else {
        out.push({
          kind: "placeholder",
          group: g,
          message:
            g.state === "loading"
              ? "loading models…"
              : g.state === "error"
              ? "couldn't list models for this provider"
              : "no models discovered yet",
        });
      }
    }
    return out;
  }, [groups, query, recentKeys]);

  // Indices of model rows in the current `rows` list (skips headers).
  const modelRowIndices = useMemo(
    () => rows.map((r, i) => (r.kind === "model" ? i : -1)).filter((i) => i >= 0),
    [rows],
  );

  // Derive the selected ROW INDEX from the selected MODEL ID. As async
  // groups arrive and the rows reshuffle, the index for a given id stays
  // consistent — no more selection drift / flashing.
  const selectedRow = useMemo(() => {
    const idx = rows.findIndex((r) => r.kind === "model" && r.rowKey === selectedRowKey);
    if (idx >= 0) return idx;
    return modelRowIndices[0] ?? 0;
  }, [rows, modelRowIndices, selectedRowKey]);

  function move(delta: number) {
    if (modelRowIndices.length === 0) return;
    const here = modelRowIndices.indexOf(selectedRow);
    const nextHere = clamp(here < 0 ? 0 : here + delta, 0, modelRowIndices.length - 1);
    const targetRowIdx = modelRowIndices[nextHere]!;
    const target = rows[targetRowIdx];
    if (target?.kind === "model") setSelectedRowKey(target.rowKey);
  }

  function handleMouseScroll(ev: MouseEvent) {
    const direction = ev.scroll?.direction;
    if (direction === "up") {
      ev.preventDefault();
      ev.stopPropagation();
      move(-3);
    } else if (direction === "down") {
      ev.preventDefault();
      ev.stopPropagation();
      move(+3);
    }
  }

  function commit() {
    const r = rows[selectedRow];
    if (r?.kind === "model") {
      rememberRecent(r.group.id, r.model.id);
      onSelect(r.model.id, r.group.id);
    }
    else onCancel();
  }

  function commitAndSetDefault() {
    const r = rows[selectedRow];
    if (r?.kind === "model") {
      rememberRecent(r.group.id, r.model.id);
      onSetDefault(r.model.id, r.group.id);
    }
    else onCancel();
  }

  function rememberRecent(provider: string, id: string) {
    const key = modelKey(provider, id);
    setRecentKeys((prev) => [key, ...prev.filter((k) => k !== key)].slice(0, 8));
  }

  useKeyboard((ev) => {
    if (ev.name === "escape") onCancel();
    else if (ev.name === "up") move(-1);
    else if (ev.name === "down") move(+1);
    else if (ev.name === "pageup") move(-viewportRows);
    else if (ev.name === "pagedown") move(+viewportRows);
    else if (ev.name === "home") move(-modelRowIndices.length);
    else if (ev.name === "end") move(+modelRowIndices.length);
    else if (isWheelUp(ev.name)) move(-3);
    else if (isWheelDown(ev.name)) move(+3);
    else if (ev.ctrl && ev.name === "n") move(+1);
    else if (ev.ctrl && ev.name === "p") move(-1);
    // ctrl+d — set as default (typing 'd' goes into the filter, so we
    // require the modifier).
    else if (ev.ctrl && ev.name === "d") commitAndSetDefault();
    // cmd+a / ctrl+a — open Add Provider dialog. opencode does the same.
    else if ((ev.meta || ev.ctrl) && ev.name === "a") onAddProvider();
  });

  const start = clamp(
    selectedRow - Math.floor(viewportRows / 2),
    0,
    Math.max(0, rows.length - viewportRows),
  );
  const visible = rows.slice(start, start + viewportRows);
  const hiddenAbove = start;
  const hiddenBelow = Math.max(0, rows.length - start - viewportRows);

  // Header status text top-right (loading/live count/etc.)
  const codexGroup = groups.find((g) => g.id === CODEX_PROVIDER.id);
  const statusLabel =
    codexGroup?.state === "loading"
      ? "loading…"
      : codexGroup?.state === "live"
      ? `${codexGroup.models.length} models · live`
      : codexGroup?.state === "error"
      ? "offline list"
      : "snapshot";

  return (
    <box
      position="absolute"
      left={0}
      right={0}
      bottom={5}
      flexDirection="column"
      alignItems="center"
      onMouseScroll={handleMouseScroll}
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
        width={pickerWidth}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={C.fg1} attributes={ATTR_BOLD}>{"Select model"}</text>
          <text fg={C.fg5}>{statusLabel}</text>
        </box>
        <text> </text>

        {/* filter input */}
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
              placeholder="filter models…"
              textColor={C.fg2}
              focusedTextColor={C.fg1}
              placeholderColor={C.fg5}
              onInput={(v) => {
                setQuery(v);
              }}
              onSubmit={() => commit()}
            />
          </box>
        </box>

        <text> </text>

        {/* rows */}
        <text fg={C.fg5}>{hiddenAbove > 0 ? `  ↑ ${hiddenAbove} more` : " "}</text>
        {rows.length === 0 ? (
          <text fg={C.fg5}>{"  (no matches — esc to cancel)"}</text>
        ) : (
          <box flexDirection="column" height={viewportRows} onMouseScroll={handleMouseScroll}>
            {visible.map((row, i) => {
              const absoluteIndex = start + i;
              if (row.kind === "header") return renderHeader(row.title, absoluteIndex, innerWidth);
              if (row.kind === "placeholder") return renderPlaceholder(row, absoluteIndex, innerWidth);
              return renderModelRow(
                row,
                absoluteIndex,
                absoluteIndex === selectedRow,
                current,
                currentProvider,
                setSelectedRowKey,
                (id, provider) => {
                  rememberRecent(provider, id);
                  onSelect(id, provider);
                },
                columns,
              );
            })}
            {Array.from({ length: Math.max(0, viewportRows - visible.length) }, (_, i) => (
              <box key={`blank-${i}`} height={1}>
                <text>{" "}</text>
              </box>
            ))}
          </box>
        )}
        <text fg={C.fg5}>{hiddenBelow > 0 ? `  ↓ ${hiddenBelow} more` : " "}</text>

        <text> </text>
        <text>
          <span fg={C.fg5}>{"↑↓ select   "}</span>
          <span fg={C.laser}>{"⏎"}</span>
          <span fg={C.fg5}>{" use   "}</span>
          <span fg={C.laser}>{"^d"}</span>
          <span fg={C.fg5}>{" default   "}</span>
          <span fg={C.laser}>{"⌘a"}</span>
          <span fg={C.fg5}>{" connect provider   "}</span>
          <span fg={C.laser}>{"esc"}</span>
        </text>
      </box>
    </box>
  );
}

function renderPlaceholder(
  row: Extract<Row, { kind: "placeholder" }>,
  key: number,
  width: number,
) {
  return (
    <box
      key={`p-${row.group.id}-${key}`}
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
    >
      <box width={2} flexShrink={0}>
        <text fg={C.fg5}>{" "}</text>
      </box>
      <box width={Math.max(1, width - 3)} flexShrink={0}>
        <text fg={C.fg5}>{truncate(row.message, Math.max(1, width - 4))}</text>
      </box>
    </box>
  );
}

function renderHeader(title: string, key: number, width: number) {
  return (
    <box key={`h-${title}-${key}`} flexDirection="row" paddingLeft={1} paddingRight={1} marginTop={key === 0 ? 0 : 1}>
      <text fg={C.fg1} attributes={ATTR_BOLD}>{truncate(title, Math.max(1, width - 2))}</text>
    </box>
  );
}

function renderModelRow(
  row: Extract<Row, { kind: "model" }>,
  absoluteIndex: number,
  isSelected: boolean,
  current: string,
  currentProvider: string,
  setSelectedRowKey: (key: string) => void,
  onSelect: (id: string, provider: string) => void,
  columns: ModelColumns,
) {
  void absoluteIndex;
  const m = row.model;
  const isCurrent = m.id === current && row.group.id === currentProvider;
  const name = normalizedModelName(m);
  const provider = normalizedProviderName(row.group);
  return (
    <box
      key={`m-${row.group.id}-${m.id}`}
      flexDirection="row"
      backgroundColor={isSelected ? C.surface3 : C.void}
      paddingLeft={1}
      paddingRight={1}
      onMouseDown={() => onSelect(m.id, row.group.id)}
    >
      <box width={2} flexShrink={0}>
        <text fg={isCurrent ? C.laser : C.fg5}>{isCurrent ? "●" : " "}</text>
      </box>
      <box width={columns.name} flexShrink={0}>
        <text
          fg={isSelected ? C.fg1 : C.fg2}
          attributes={isSelected ? ATTR_BOLD : 0}
        >
          {truncate(name, columns.name - 1)}
        </text>
      </box>
      <box width={columns.provider} flexShrink={0}>
        <text fg={C.fg5}>{truncate(provider, columns.provider - 1)}</text>
      </box>
    </box>
  );
}

interface ModelColumns {
  name: number;
  provider: number;
}

function modelColumns(innerWidth: number): ModelColumns {
  const chrome = 2;
  const available = Math.max(24, innerWidth - chrome);
  const provider = clamp(Math.floor(available * 0.32), 14, 28);
  const name = Math.max(20, available - provider);
  return { name, provider };
}

function modelKey(provider: string, id: string): string {
  return `${provider}\u0000${id}`;
}

function rowKey(section: "recent" | "provider", provider: string, id: string): string {
  return `${section}\u0000${provider}\u0000${id}`;
}

function normalizedModelName(m: DisplayModel): string {
  const raw = m.display_name && m.display_name !== m.id ? m.display_name : m.id;
  return titleModelName(raw);
}

function normalizedProviderName(group: ProviderGroup): string {
  const key = providerBaseKey(group.id);
  if (key === "codex" || key === "openai" || key === "openai-codex") return "OpenAI";
  if (key === "claude" || key === "anthropic" || key === "anthropic-oauth") return "Anthropic";
  if (key === "opencode-zen") return "OpenCode Zen";
  if (key === "custom-openai-compat" && group.baseUrl) {
    return titleWords(providerNameFromUrl(group.baseUrl));
  }
  return titleWords(group.label.replace(/\s*·.*$/, "").replace(/\([^)]*\)/g, " "));
}

function providerLabelForAuthKey(
  key: string,
  baseUrl: string | undefined,
  catalogName: string | undefined,
  registryName: string | undefined,
): string {
  const baseKey = providerBaseKey(key);
  if (PROVIDER_LABEL_HINTS[baseKey]) return PROVIDER_LABEL_HINTS[baseKey];
  if (baseKey === "custom-openai-compat" && baseUrl) {
    return titleWords(providerNameFromUrl(baseUrl));
  }
  if (registryName) return registryName;
  if (catalogName) return catalogName;
  return titleWords(baseKey.replace(/[-_]+/g, " "));
}

function titleModelName(raw: string): string {
  const leaf = raw.split("/").filter(Boolean).at(-1) ?? raw;
  return titleWords(
    leaf
      .replace(/[_-]+/g, " ")
      .replace(/\b(\d+)b\b/gi, "$1B")
      .replace(/\bit\b/gi, "IT"),
  )
    .replace(/\bGpt\b/g, "GPT")
    .replace(/\bGlm\b/g, "GLM")
    .replace(/\bApi\b/g, "API")
    .replace(/\bAi\b/g, "AI")
    .replace(/\bIt\b/g, "IT")
    .replace(/\bOss\b/g, "OSS");
}

function providerNameFromUrl(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname.replace(/^api\./, "");
    const parts = host.split(".").filter((p) => p && p !== "cloud" && p !== "ai" && p !== "com");
    return parts.reverse().join(" ");
  } catch {
    return "Custom";
  }
}

function titleWords(raw: string): string {
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length <= 2 && /^[a-z]+$/i.test(w) ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function isWheelUp(name: string): boolean {
  return /^(wheelup|scrollup|mousewheelup|wheel-up|scroll-up|mousewheel-up)$/i.test(name);
}

function isWheelDown(name: string): boolean {
  return /^(wheeldown|scrolldown|mousewheeldown|wheel-down|scroll-down|mousewheel-down)$/i.test(name);
}

function providerBaseKey(key: string): string {
  return key.startsWith("custom-openai-compat:") ? "custom-openai-compat" : key;
}

/** Upsert a group by id (preserving order of first appearance). */
function upsertGroup(prev: ProviderGroup[], next: ProviderGroup): ProviderGroup[] {
  const idx = prev.findIndex((g) => g.id === next.id);
  if (idx < 0) return [...prev, next];
  const out = prev.slice();
  out[idx] = next;
  return out;
}

/**
 * Walk the merged auth-profiles for the active profile, dispatch the
 * right `/models` fetcher per provider, and surface each group to the
 * caller via the `onGroup` callback as it lands.
 *
 * - codex (oauth) → listCodexModels
 * - api_key with stored base_url → listOpenAIModels(base_url)
 * - api_key with known provider id → listOpenAIModels(default base)
 * - everything else → skipped silently (no enumerator)
 */
async function enumerateProviderGroups(
  profile: string,
  onGroup: (g: ProviderGroup) => void,
): Promise<void> {
  let auth: AuthProfilesFile;
  try {
    const resolved = await resolveAuthProfiles(profile);
    auth = resolved.merged;
  } catch {
    return;
  }
  const entries = Object.entries(auth.providers).sort(([a], [b]) => {
    const rank = (key: string) => {
      const baseKey = providerBaseKey(key);
      if (baseKey === "codex" || baseKey === "openai" || baseKey === "openai-codex") return 0;
      if (baseKey === "claude" || baseKey === "anthropic" || baseKey === "anthropic-oauth") return 1;
      return 2;
    };
    const ar = rank(a);
    const br = rank(b);
    return ar === br ? a.localeCompare(b) : ar - br;
  });

  // Always try Codex even if not in providers (default install). If there's
  // no codex auth we get nothing back; the group renders as fallback.
  const codexCred = auth.providers.codex;
  if (codexCred?.kind === "oauth") {
    onGroup({
      id: CODEX_PROVIDER.id,
      label: CODEX_PROVIDER.label,
      authMethod: CODEX_PROVIDER.authMethod,
      models: CODEX_MODELS.map((m) => ({ id: m.id, description: m.description })),
      state: "loading",
    });
    listCodexModels({ token: (codexCred as OAuthCred).access })
      .then((live: LiveCodexModel[]) => {
        if (live.length === 0) return;
        onGroup({
          id: CODEX_PROVIDER.id,
          label: CODEX_PROVIDER.label,
          authMethod: CODEX_PROVIDER.authMethod,
          models: live.map((m) => ({
            id: m.id,
            description: m.description,
            display_name: m.display_name,
            context_window: m.context_window,
          })),
          state: "live",
        });
      })
      .catch(() => {
        onGroup({
          id: CODEX_PROVIDER.id,
          label: CODEX_PROVIDER.label,
          authMethod: CODEX_PROVIDER.authMethod,
          models: CODEX_MODELS.map((m) => ({ id: m.id, description: m.description })),
          state: "error",
        });
      });
  }

  for (const [key, cred] of entries) {
    if (key === "codex") continue; // handled above

    const baseKey = providerBaseKey(key);
    const info = findProvider(baseKey);
    const authMethod = cred.kind === "oauth" ? "oauth" : "api key";

    // Resolve a label, preferring (in order):
    //   1. an explicit hint (codex / claude),
    //   2. the models.dev registry's "name" for this provider,
    //   3. the curated PROVIDERS catalog name,
    //   4. uppercased auth key as last resort.
    const baseUrl =
      cred.kind === "api_key"
        ? sanitizeOpenAICompatBaseUrl((cred as ApiKeyCred).base_url ?? OPENAI_COMPAT_BASE[baseKey] ?? "")
        : undefined;
    const fallbackLabel = providerLabelForAuthKey(key, baseUrl, info?.name, undefined);

    // Step 1: render group immediately with whatever the registry knows.
    // No hardcoded fallbacks — the registry IS the fallback.
    onGroup({
      id: key,
      label: fallbackLabel,
      authMethod,
      baseUrl,
      models: [],
      state: "loading",
    });

    void Promise.all([
      getModelsForAuthKey(key).catch((): RegistryModel[] => []),
      getProviderLabel(key).catch((): string | undefined => undefined),
    ]).then(([registryModels, registryLabel]) => {
      const label = providerLabelForAuthKey(key, baseUrl, info?.name, registryLabel) ?? fallbackLabel;
      const baselineModels: DisplayModel[] = registryModels.map((m) => ({
        id: m.id,
        description: m.name ?? "",
        display_name: m.name,
        context_window: m.limit?.context,
      }));
      onGroup({
        id: key,
        label,
        authMethod,
        baseUrl,
        models: baselineModels,
        state: baselineModels.length ? "fallback" : "loading",
      });

      // Step 2: try to live-fetch via OpenAI-compat /models. On success,
      // it overrides the registry baseline (it's authoritative for what
      // THIS account can actually call). On failure, baseline stays.
      if (cred.kind !== "api_key") return;
      const apiCred = cred as ApiKeyCred;
      if (!baseUrl) return;

      listOpenAIModels({ baseUrl, apiKey: apiCred.api_key })
        .then((live: LiveCodexModel[]) => {
          if (live.length === 0) return;
          onGroup({
            id: key,
            label,
            authMethod,
            baseUrl,
            models: live.map((m) => ({
              id: m.id,
              description: m.description,
              display_name: m.display_name,
              context_window: m.context_window,
            })),
            state: "live",
          });
        })
        .catch(() => {
          onGroup({
            id: key,
            label,
            authMethod,
            baseUrl,
            models: baselineModels,
            state: baselineModels.length ? "fallback" : "error",
          });
        });
    });
  }
}
