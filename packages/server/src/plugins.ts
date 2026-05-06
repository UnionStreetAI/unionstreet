import { promises as fs } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { readAgentPack } from "./agent-pack.ts";
import type { UsTool, UsToolContext } from "./tools/index.ts";

export const UNION_STREET_PLUGIN_MANIFEST = "unionstreet.plugin.json";
export const CODEX_PLUGIN_MANIFEST = ".codex-plugin/plugin.json";
export const CLAUDE_PLUGIN_MANIFEST = ".claude-plugin/plugin.json";

export type PluginManifestSource = "unionstreet" | "codex" | "claude";

export type PluginKind =
  | "runtime"
  | "storage"
  | "ingress"
  | "secrets"
  | "observability"
  | "skills"
  | "tools"
  | "mcp"
  | "hooks"
  | "channels"
  | "apps"
  | "memory"
  | "context_engine"
  | "model_provider";

export interface PluginCapabilities {
  runtime: string[];
  tools: string[];
  hooks: string[];
  mcp: string[];
  skills: string[];
  apps: string[];
  commands: string[];
}

export interface PluginPermissions {
  network: string[];
  filesystem: string[];
  secrets: string[];
  subprocess: boolean;
}

export type PluginAuthMode = "none" | "oauth" | "bearer_token" | "api_key" | "cli_session" | "oidc";

export interface PluginAuthRequirement {
  mode: PluginAuthMode;
  description?: string;
  scopes: string[];
  secrets: string[];
}

export interface PluginManifest {
  schemaVersion: "v1";
  name: string;
  version: string;
  description: string;
  kind: PluginKind[];
  capabilities: PluginCapabilities;
  auth: PluginAuthRequirement;
  entrypoints: Record<string, string>;
  configSchema?: string;
  permissions: PluginPermissions;
  source: PluginManifestSource;
}

export interface DiscoveredPlugin {
  root: string;
  manifestPath: string;
  manifest: PluginManifest;
  warnings: string[];
}

export interface InvalidPlugin {
  root: string;
  manifestPath?: string;
  error: string;
}

export interface PluginInventory {
  plugins: DiscoveredPlugin[];
  invalid: InvalidPlugin[];
}

export interface PluginDoctorResult {
  ok: boolean;
  plugins: DiscoveredPlugin[];
  invalid: InvalidPlugin[];
  warnings: Array<{ plugin: string; message: string }>;
}

export interface AgentPluginResolution {
  profile: string;
  requested: string[];
  plugins: DiscoveredPlugin[];
  missing: string[];
}

export interface ResolvedPluginSkill {
  plugin: string;
  name: string;
  description?: string;
  path: string;
  content: string;
}

export interface ResolvedPluginCommand {
  plugin: string;
  command: string;
}

export interface ResolvedPluginMcpConfig {
  plugin: DiscoveredPlugin;
  path: string;
}

export interface ResolvedAgentPluginCapabilities extends AgentPluginResolution {
  skills: ResolvedPluginSkill[];
  commands: ResolvedPluginCommand[];
  mcpConfigs: ResolvedPluginMcpConfig[];
  tools: UsTool[];
}

const PluginKindSchema = z.enum([
  "runtime",
  "storage",
  "ingress",
  "secrets",
  "observability",
  "skills",
  "tools",
  "mcp",
  "hooks",
  "channels",
  "apps",
  "memory",
  "context_engine",
  "model_provider",
]);

const CapabilitiesSchema = z.object({
  runtime: z.array(z.string().min(1)).default([]),
  tools: z.array(z.string().min(1)).default([]),
  hooks: z.array(z.string().min(1)).default([]),
  mcp: z.array(z.string().min(1)).default([]),
  skills: z.array(z.string().min(1)).default([]),
  apps: z.array(z.string().min(1)).default([]),
  commands: z.array(z.string().min(1)).default([]),
}).default({});

const PermissionsSchema = z.object({
  network: z.array(z.string().min(1)).default([]),
  filesystem: z.array(z.string().min(1)).default([]),
  secrets: z.array(z.string().min(1)).default([]),
  subprocess: z.boolean().default(false),
}).default({});

const AuthSchema = z.object({
  mode: z.enum(["none", "oauth", "bearer_token", "api_key", "cli_session", "oidc"]),
  description: z.string().min(1).optional(),
  scopes: z.array(z.string().min(1)).default([]),
  secrets: z.array(z.string().min(1)).default([]),
}).optional();

const ManifestSchema = z.object({
  schema_version: z.literal("v1").default("v1"),
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  version: z.string().min(1),
  description: z.string().min(1),
  kind: z.array(PluginKindSchema).optional(),
  capabilities: CapabilitiesSchema,
  auth: AuthSchema,
  entrypoints: z.record(z.string().min(1)).default({}),
  config_schema: z.string().min(1).optional(),
  permissions: PermissionsSchema,
});

const MANIFEST_CANDIDATES: Array<{ path: string; source: PluginManifestSource }> = [
  { path: UNION_STREET_PLUGIN_MANIFEST, source: "unionstreet" },
  { path: CODEX_PLUGIN_MANIFEST, source: "codex" },
  { path: CLAUDE_PLUGIN_MANIFEST, source: "claude" },
];

export async function discoverPlugins(root = process.cwd()): Promise<PluginInventory> {
  const pluginRoot = join(root, "plugins");
  const plugins: DiscoveredPlugin[] = [];
  const invalid: InvalidPlugin[] = [];
  let entries;
  try {
    entries = await fs.readdir(pluginRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return { plugins, invalid };
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(pluginRoot, entry.name);
    const candidate = await findManifest(dir);
    if (!candidate) {
      invalid.push({ root: dir, error: "missing plugin manifest" });
      continue;
    }
    try {
      const raw = await fs.readFile(candidate.manifestPath, "utf8");
      const parsed = JSON.parse(raw);
      const manifest = normalizePluginManifest(parsed, candidate.source);
      const warnings = await pluginWarnings(dir, manifest);
      plugins.push({ root: dir, manifestPath: candidate.manifestPath, manifest, warnings });
    } catch (error) {
      invalid.push({
        root: dir,
        manifestPath: candidate.manifestPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  plugins.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  invalid.sort((a, b) => a.root.localeCompare(b.root));
  return { plugins, invalid };
}

export async function inspectPlugin(name: string, root = process.cwd()): Promise<DiscoveredPlugin | undefined> {
  const inventory = await discoverPlugins(root);
  return inventory.plugins.find((plugin) => plugin.manifest.name === name);
}

export async function doctorPlugins(root = process.cwd()): Promise<PluginDoctorResult> {
  const inventory = await discoverPlugins(root);
  const warnings = inventory.plugins.flatMap((plugin) =>
    plugin.warnings.map((message) => ({ plugin: plugin.manifest.name, message }))
  );
  return {
    ok: inventory.invalid.length === 0,
    plugins: inventory.plugins,
    invalid: inventory.invalid,
    warnings,
  };
}

export async function resolvePluginsForAgent(profile: string, root = process.cwd()): Promise<AgentPluginResolution> {
  const pack = await readAgentPack(profile);
  const requested = [...new Set(pack.toolkit.plugins)].sort();
  if (!requested.length) {
    return { profile, requested, plugins: [], missing: [] };
  }
  const inventory = await discoverPlugins(root);
  const byName = new Map(inventory.plugins.map((plugin) => [plugin.manifest.name, plugin]));
  const plugins = requested.flatMap((name) => {
    const plugin = byName.get(name);
    return plugin ? [plugin] : [];
  });
  return {
    profile,
    requested,
    plugins,
    missing: requested.filter((name) => !byName.has(name)),
  };
}

export async function pluginMcpConfigPathsForAgent(profile: string, root = process.cwd()): Promise<Array<{ plugin: DiscoveredPlugin; path: string }>> {
  return (await resolvePluginCapabilitiesForAgent(profile, root)).mcpConfigs;
}

export async function resolvePluginCapabilitiesForAgent(profile: string, root = process.cwd()): Promise<ResolvedAgentPluginCapabilities> {
  const resolved = await resolvePluginsForAgent(profile, root);
  const capabilities = await resolvePluginCapabilities(resolved.plugins, root);
  return { ...resolved, ...capabilities };
}

export async function resolvePluginCapabilities(plugins: DiscoveredPlugin[], root = process.cwd()): Promise<{
  skills: ResolvedPluginSkill[];
  commands: ResolvedPluginCommand[];
  mcpConfigs: ResolvedPluginMcpConfig[];
  tools: UsTool[];
}> {
  const skills = (await Promise.all(plugins.map((plugin) => loadPluginSkills(plugin, root)))).flat();
  const tools = (await Promise.all(plugins.map((plugin) => loadPluginTools(plugin, root)))).flat();
  return {
    skills,
    tools,
    commands: plugins.flatMap((plugin) => plugin.manifest.capabilities.commands.map((command) => ({ plugin: plugin.manifest.name, command }))),
    mcpConfigs: plugins.flatMap((plugin) => {
      const mcp = plugin.manifest.entrypoints.mcp;
      return mcp ? [{ plugin, path: join(plugin.root, mcp) }] : [];
    }),
  };
}

export function relativePluginPath(path: string, root = process.cwd()): string {
  const rel = relative(root, path);
  return rel.startsWith("..") ? path : rel || ".";
}

function normalizePluginManifest(input: unknown, source: PluginManifestSource): PluginManifest {
  const parsed = ManifestSchema.parse(input);
  const kind = parsed.kind?.length ? parsed.kind : inferKinds(parsed.name, parsed.capabilities, parsed.entrypoints);
  return {
    schemaVersion: parsed.schema_version,
    name: parsed.name,
    version: parsed.version,
    description: parsed.description,
    kind,
    capabilities: parsed.capabilities,
    auth: parsed.auth ?? inferAuth(parsed.capabilities, parsed.permissions),
    entrypoints: parsed.entrypoints,
    ...(parsed.config_schema ? { configSchema: parsed.config_schema } : {}),
    permissions: parsed.permissions,
    source,
  };
}

function inferAuth(capabilities: PluginCapabilities, permissions: PluginPermissions): PluginAuthRequirement {
  if (permissions.secrets.some((secret) => /oidc/i.test(secret))) return { mode: "oidc", scopes: [], secrets: permissions.secrets };
  if (capabilities.mcp.length) return { mode: "oauth", scopes: [], secrets: permissions.secrets };
  if (permissions.secrets.some((secret) => /token|bearer/i.test(secret))) return { mode: "bearer_token", scopes: [], secrets: permissions.secrets };
  if (permissions.secrets.length) return { mode: "api_key", scopes: [], secrets: permissions.secrets };
  if (permissions.subprocess && capabilities.commands.length) return { mode: "cli_session", scopes: [], secrets: [] };
  return { mode: "none", scopes: [], secrets: [] };
}

function inferKinds(name: string, capabilities: PluginCapabilities, entrypoints: Record<string, string>): PluginKind[] {
  const kinds = new Set<PluginKind>();
  if (name.startsWith("runtime-") || capabilities.runtime.length || entrypoints.runtime || entrypoints.terraform) kinds.add("runtime");
  if (capabilities.tools.length) kinds.add("tools");
  if (capabilities.hooks.length) kinds.add("hooks");
  if (capabilities.mcp.length || entrypoints.mcp) kinds.add("mcp");
  if (capabilities.skills.length || entrypoints.skills) kinds.add("skills");
  if (capabilities.apps.length || entrypoints.apps) kinds.add("apps");
  return kinds.size ? [...kinds] : ["skills"];
}

async function pluginWarnings(root: string, manifest: PluginManifest): Promise<string[]> {
  const warnings: string[] = [];
  if (manifest.source !== "unionstreet") warnings.push(`missing ${UNION_STREET_PLUGIN_MANIFEST}; using ${manifest.source} compatibility manifest`);
  if (manifest.version === "0.0.0") warnings.push("version is still 0.0.0");
  if (!(await exists(join(root, "README.md")))) warnings.push("missing README.md");
  for (const [key, path] of Object.entries(manifest.entrypoints)) {
    if (!(await exists(join(root, path)))) warnings.push(`entrypoint "${key}" does not exist: ${path}`);
  }
  if (manifest.kind.includes("runtime") && !(await exists(join(root, "terraform"))) && !manifest.entrypoints.runtime) {
    warnings.push("runtime plugin has neither terraform/ nor entrypoints.runtime");
  }
  return warnings;
}

async function loadPluginSkills(plugin: DiscoveredPlugin, root: string): Promise<ResolvedPluginSkill[]> {
  const entrypoint = plugin.manifest.entrypoints.skills;
  if (!entrypoint) return [];
  const skillsRoot = join(plugin.root, entrypoint);
  const files = await findSkillFiles(skillsRoot);
  return Promise.all(files.map(async (path) => {
    const raw = await fs.readFile(path, "utf8");
    const parsed = parseSkillMarkdown(raw);
    return {
      plugin: plugin.manifest.name,
      name: parsed.name ?? basename(path, extname(path)),
      ...(parsed.description ? { description: parsed.description } : {}),
      path: relativePluginPath(path, root),
      content: parsed.body,
    };
  }));
}

async function findSkillFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const out: string[] = [];
  if (await exists(join(root, "SKILL.md"))) out.push(join(root, "SKILL.md"));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, "SKILL.md");
    if (await exists(path)) out.push(path);
  }
  return out.sort();
}

function parseSkillMarkdown(raw: string): { name?: string; description?: string; body: string } {
  if (!raw.startsWith("---\n")) return { body: raw.trim() };
  const end = raw.indexOf("\n---", 4);
  if (end < 0) return { body: raw.trim() };
  const frontmatter = raw.slice(4, end).trim();
  const body = raw.slice(end + 4).trim();
  const fields = Object.fromEntries(frontmatter.split("\n").map((line) => {
    const index = line.indexOf(":");
    if (index < 0) return ["", ""];
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }).filter(([key]) => key));
  return {
    ...(fields.name ? { name: fields.name } : {}),
    ...(fields.description ? { description: fields.description } : {}),
    body,
  };
}

async function loadPluginTools(plugin: DiscoveredPlugin, root: string): Promise<UsTool[]> {
  const entrypoint = plugin.manifest.entrypoints.tools;
  if (!entrypoint) return [];
  const toolsRoot = join(plugin.root, entrypoint);
  let entries;
  try {
    entries = await fs.readdir(toolsRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const tools: UsTool[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !/\.(ts|js|mjs)$/.test(entry.name)) continue;
    const file = join(toolsRoot, entry.name);
    let mod: Record<string, unknown>;
    try {
      mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
    } catch {
      continue;
    }
    const stem = sanitizeToolName(basename(entry.name, extname(entry.name)));
    for (const [exportName, value] of Object.entries(mod)) {
      if (exportName === "__esModule") continue;
      const name = exportName === "default" ? stem : `${stem}_${sanitizeToolName(exportName)}`;
      const tool = normalizePluginTool(plugin, name, value, root);
      if (tool) tools.push(tool);
    }
  }
  return tools.sort((a, b) => a.definition.name.localeCompare(b.definition.name));
}

function normalizePluginTool(plugin: DiscoveredPlugin, localName: string, value: unknown, root: string): UsTool | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.definition) && typeof value.execute === "function") {
    const definition = value.definition as unknown as UsTool["definition"];
    return {
      definition: { ...definition, name: pluginToolName(plugin.manifest.name, definition.name || localName) },
      execute: (args, ctx) => runPluginTool(plugin, value.execute as PluginToolExecute, args, ctx, root),
    };
  }
  if (typeof value.execute !== "function") return undefined;
  const description = typeof value.description === "string" && value.description.trim()
    ? value.description.trim()
    : `Plugin tool ${localName} from ${plugin.manifest.name}.`;
  const parameters = normalizeToolParameters(value.parameters ?? value.args);
  return {
    definition: {
      type: "function",
      name: pluginToolName(plugin.manifest.name, localName),
      description,
      parameters,
    },
    execute: (args, ctx) => runPluginTool(plugin, value.execute as PluginToolExecute, args, ctx, root),
  };
}

type PluginToolExecute = (args: Record<string, unknown>, ctx: UsToolContext & { plugin: { name: string; root: string; relativeRoot: string } }) => unknown | Promise<unknown>;

async function runPluginTool(plugin: DiscoveredPlugin, execute: PluginToolExecute, args: Record<string, unknown>, ctx: UsToolContext, root: string): Promise<string> {
  const result = await execute(args, {
    ...ctx,
    plugin: {
      name: plugin.manifest.name,
      root: plugin.root,
      relativeRoot: relativePluginPath(plugin.root, root),
    },
  });
  return typeof result === "string" ? result : JSON.stringify(result);
}

function normalizeToolParameters(value: unknown): Record<string, unknown> {
  if (isJsonSchemaObject(value)) return value;
  if (isRecord(value)) {
    return {
      type: "object",
      properties: value,
      additionalProperties: false,
    };
  }
  return { type: "object", properties: {}, additionalProperties: false };
}

function pluginToolName(plugin: string, name: string): string {
  return `${sanitizeToolName(plugin)}_${sanitizeToolName(name)}`;
}

function sanitizeToolName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === "object" && isRecord(value.properties);
}

async function findManifest(root: string): Promise<{ manifestPath: string; source: PluginManifestSource } | undefined> {
  for (const candidate of MANIFEST_CANDIDATES) {
    const manifestPath = join(root, candidate.path);
    if (await exists(manifestPath)) return { manifestPath, source: candidate.source };
  }
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
