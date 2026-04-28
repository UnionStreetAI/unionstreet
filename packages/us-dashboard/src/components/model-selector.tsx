import { Check, ChevronDown, Search, Star, Zap } from "lucide-react";
import { useMemo, useState } from "react";

export interface DashboardModel {
  id: string;
  name?: string;
  context?: string;
  recent?: boolean;
}

export interface DashboardModelGroup {
  id: string;
  label: string;
  models: DashboardModel[];
}

export interface ModelSelection {
  provider: string;
  id: string;
}

interface ModelSelectorProps {
  groups: DashboardModelGroup[];
  value: ModelSelection;
  defaultValue?: ModelSelection;
  onChange(value: ModelSelection): void;
  onSetDefault?(value: ModelSelection): void;
  compact?: boolean;
}

export function ModelSelector({
  groups,
  value,
  defaultValue,
  onChange,
  onSetDefault,
  compact = false,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = findModel(groups, value);
  const recent = useMemo(() => {
    const rows = groups.flatMap((group) => group.models.map((model) => ({ group, model })));
    const marked = rows.filter((row) => row.model.recent);
    const active = current ? [{ group: current.group, model: current.model }] : [];
    return uniqueRows([...active, ...marked]).slice(0, 6);
  }, [groups, current]);
  const visibleRecent = recent.length > 1 ? recent : [];
  const recentKeys = useMemo(() => new Set(visibleRecent.map(rowKey)), [visibleRecent]);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return groups
        .map((group) => ({
          ...group,
          models: group.models.filter((model) => !recentKeys.has(rowKey({ group, model }))),
        }))
        .filter((group) => group.models.length > 0);
    }
    return groups
      .map((group) => ({
        ...group,
        models: group.models.filter((model) => {
          const name = normalizedModelName(model).toLowerCase();
          const provider = normalizedProviderName(group).toLowerCase();
          return name.includes(q) || provider.includes(q) || model.id.toLowerCase().includes(q);
        }),
      }))
      .filter((group) => group.models.length > 0);
  }, [groups, query, recentKeys]);

  function choose(next: ModelSelection) {
    onChange(next);
    setOpen(false);
    setQuery("");
  }

  return (
    <div className={`model-selector ${compact ? "compact" : ""}`}>
      <button className="model-trigger" type="button" onClick={() => setOpen((next) => !next)}>
        <Zap size={compact ? 15 : 16} />
        <span>{current ? normalizedModelName(current.model) : formatModelId(value.id)}</span>
        {current && <em>{normalizedProviderName(current.group)}</em>}
        <ChevronDown size={15} />
      </button>

      {open && (
        <div className="model-popover">
          <label className="model-search">
            <Search size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models" autoFocus />
          </label>

          {visibleRecent.length > 0 && (
            <ModelSection
              title="Recent"
              rows={visibleRecent}
              value={value}
              defaultValue={defaultValue}
              onChoose={choose}
              onSetDefault={onSetDefault}
            />
          )}

          {filteredGroups.map((group) => (
            <ModelSection
              key={group.id}
              title={normalizedProviderName(group)}
              rows={group.models.map((model) => ({ group, model }))}
              value={value}
              defaultValue={defaultValue}
              onChoose={choose}
              onSetDefault={onSetDefault}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ModelSection(props: {
  title: string;
  rows: Array<{ group: DashboardModelGroup; model: DashboardModel }>;
  value: ModelSelection;
  defaultValue?: ModelSelection;
  onChoose(value: ModelSelection): void;
  onSetDefault?(value: ModelSelection): void;
}) {
  return (
    <section className="model-section">
      <h3>{props.title}</h3>
      <div className="model-list">
        {props.rows.map(({ group, model }) => {
          const selection = { provider: group.id, id: model.id };
          const selected = sameModel(props.value, selection);
          const isDefault = props.defaultValue ? sameModel(props.defaultValue, selection) : false;
          return (
            <div className={`model-row ${selected ? "selected" : ""}`} key={`${props.title}-${group.id}-${model.id}`}>
              <button type="button" onClick={() => props.onChoose(selection)}>
                <span className="model-current">{selected && <Check size={14} />}</span>
                <span className="model-name">{normalizedModelName(model)}</span>
                <span className="model-provider">{normalizedProviderName(group)}</span>
                {model.context && <span className="model-context">{model.context}</span>}
              </button>
              {props.onSetDefault && (
                <button className={`model-default ${isDefault ? "active" : ""}`} type="button" onClick={() => props.onSetDefault?.(selection)} aria-label="Set default model">
                  <Star size={13} fill={isDefault ? "currentColor" : "none"} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function findModel(groups: DashboardModelGroup[], value: ModelSelection) {
  for (const group of groups) {
    const model = group.models.find((candidate) => candidate.id === value.id && group.id === value.provider);
    if (model) return { group, model };
  }
  return undefined;
}

function uniqueRows(rows: Array<{ group: DashboardModelGroup; model: DashboardModel }>) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = rowKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rowKey(row: { group: DashboardModelGroup; model: DashboardModel }) {
  return `${row.group.id}\u0000${row.model.id}`;
}

function sameModel(a: ModelSelection, b: ModelSelection) {
  return a.provider === b.provider && a.id === b.id;
}

function normalizedModelName(model: DashboardModel): string {
  const raw = model.name && model.name !== model.id ? model.name : model.id;
  return formatModelId(raw);
}

function formatModelId(raw: string): string {
  const leaf = raw.split("/").filter(Boolean).at(-1) ?? raw;
  return titleWords(leaf.replace(/[_-]+/g, " ").replace(/\b(\d+)b\b/gi, "$1B").replace(/\bit\b/gi, "IT"))
    .replace(/\bGpt\b/g, "GPT")
    .replace(/\bGlm\b/g, "GLM")
    .replace(/\bApi\b/g, "API")
    .replace(/\bAi\b/g, "AI")
    .replace(/\bIt\b/g, "IT")
    .replace(/\bOss\b/g, "OSS");
}

function normalizedProviderName(group: DashboardModelGroup): string {
  const key = group.id.replace(/^custom-openai-compat:/, "custom-");
  if (key === "codex" || key === "openai" || key === "openai-codex") return "OpenAI";
  if (key === "claude" || key === "anthropic" || key === "anthropic-oauth") return "Anthropic";
  if (key === "opencode-zen") return "OpenCode Zen";
  return titleWords(group.label.replace(/\s*·.*$/, "").replace(/\([^)]*\)/g, " "));
}

function titleWords(raw: string): string {
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.length <= 2 && /^[a-z]+$/i.test(word) ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1)))
    .join(" ");
}
