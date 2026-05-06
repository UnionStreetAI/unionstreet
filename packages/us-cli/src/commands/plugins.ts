import kleur from "kleur";
import {
  discoverPlugins,
  doctorPlugins,
  inspectPlugin,
  relativePluginPath,
  resolvePluginsForAgent,
  type DiscoveredPlugin,
} from "@unionstreet/server";

interface PluginsOptions {
  json?: boolean;
}

export async function pluginsCommand(action: string | undefined, name: string | undefined, options: PluginsOptions = {}): Promise<void> {
  switch (action ?? "list") {
    case "list":
      await printPluginList(options);
      return;
    case "inspect":
      if (!name) throw new Error("`us-dev plugins inspect` requires a plugin name.");
      await printPluginInspect(name, options);
      return;
    case "doctor":
      await printPluginDoctor(options);
      return;
    case "agent":
      if (!name) throw new Error("`us-dev plugins agent` requires a profile name.");
      await printAgentPlugins(name, options);
      return;
    default:
      throw new Error(`Unknown plugins action "${action}". Try: list | inspect <name> | doctor | agent <profile>`);
  }
}

async function printPluginList(options: PluginsOptions): Promise<void> {
  const inventory = await discoverPlugins();
  if (options.json) {
    console.log(JSON.stringify(inventory, null, 2));
    return;
  }

  console.log("");
  console.log(kleur.bold("plugins"));
  if (!inventory.plugins.length) {
    console.log(kleur.dim("  none"));
  }
  for (const plugin of inventory.plugins) {
    const warning = plugin.warnings.length ? kleur.yellow(`  ${plugin.warnings.length} warning${plugin.warnings.length === 1 ? "" : "s"}`) : "";
    console.log(`  ${kleur.cyan(plugin.manifest.name)} ${kleur.dim(plugin.manifest.version)}  auth:${plugin.manifest.auth.mode}  ${kleur.dim(plugin.manifest.source)}${warning}`);
    console.log(kleur.dim(`    ${plugin.manifest.description}`));
  }
  if (inventory.invalid.length) {
    console.log(kleur.yellow("  invalid"));
    for (const invalid of inventory.invalid) {
      console.log(`    ${kleur.dim(relativePluginPath(invalid.root))} ${kleur.yellow(invalid.error)}`);
    }
  }
  console.log("");
}

async function printPluginInspect(name: string, options: PluginsOptions): Promise<void> {
  const plugin = await inspectPlugin(name);
  if (!plugin) throw new Error(`Plugin "${name}" was not found.`);
  if (options.json) {
    console.log(JSON.stringify(plugin, null, 2));
    return;
  }

  console.log("");
  printPluginDetail(plugin);
  console.log("");
}

async function printPluginDoctor(options: PluginsOptions): Promise<void> {
  const result = await doctorPlugins();
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("");
  console.log(kleur.bold("plugin doctor"));
  console.log(`  status    ${result.ok ? kleur.green("ok") : kleur.yellow("needs attention")}`);
  console.log(`  loaded    ${kleur.cyan(String(result.plugins.length))}`);
  console.log(`  invalid   ${result.invalid.length ? kleur.yellow(String(result.invalid.length)) : kleur.dim("0")}`);
  console.log(`  warnings  ${result.warnings.length ? kleur.yellow(String(result.warnings.length)) : kleur.dim("0")}`);
  for (const warning of result.warnings) {
    console.log(`  ${kleur.yellow("warn")}      ${kleur.cyan(warning.plugin)} ${kleur.dim(warning.message)}`);
  }
  for (const invalid of result.invalid) {
    console.log(`  ${kleur.yellow("invalid")}   ${kleur.dim(relativePluginPath(invalid.root))} ${invalid.error}`);
  }
  console.log("");
}

async function printAgentPlugins(profile: string, options: PluginsOptions): Promise<void> {
  const resolution = await resolvePluginsForAgent(profile);
  if (options.json) {
    console.log(JSON.stringify(resolution, null, 2));
    return;
  }
  console.log("");
  console.log(kleur.bold(`plugins for @${profile}`));
  if (!resolution.requested.length) {
    console.log(kleur.dim("  none"));
  }
  for (const plugin of resolution.plugins) {
    console.log(`  ${kleur.cyan(plugin.manifest.name)} ${kleur.dim(plugin.manifest.version)}  ${plugin.manifest.kind.join(",")}`);
  }
  for (const missing of resolution.missing) {
    console.log(`  ${kleur.yellow("missing")} ${missing}`);
  }
  console.log("");
}

function printPluginDetail(plugin: DiscoveredPlugin): void {
  const { manifest } = plugin;
  console.log(kleur.bold(manifest.name));
  console.log(`  version    ${kleur.cyan(manifest.version)}`);
  console.log(`  source     ${kleur.dim(manifest.source)}`);
  console.log(`  kind       ${kleur.cyan(manifest.kind.join(", "))}`);
  console.log(`  auth       ${kleur.cyan(manifest.auth.mode)}${manifest.auth.description ? ` ${kleur.dim(manifest.auth.description)}` : ""}`);
  console.log(`  root       ${kleur.dim(relativePluginPath(plugin.root))}`);
  console.log(`  manifest   ${kleur.dim(relativePluginPath(plugin.manifestPath))}`);
  console.log(`  desc       ${manifest.description}`);
  printList("runtime", manifest.capabilities.runtime);
  printList("tools", manifest.capabilities.tools);
  printList("hooks", manifest.capabilities.hooks);
  printList("mcp", manifest.capabilities.mcp);
  printList("skills", manifest.capabilities.skills);
  printList("apps", manifest.capabilities.apps);
  printList("commands", manifest.capabilities.commands);
  const entrypoints = Object.entries(manifest.entrypoints);
  if (entrypoints.length) {
    console.log("  entrypoints");
    for (const [key, value] of entrypoints) console.log(`    ${kleur.cyan(key)} ${kleur.dim(value)}`);
  }
  if (manifest.configSchema) console.log(`  config     ${kleur.dim(manifest.configSchema)}`);
  printList("network", manifest.permissions.network);
  printList("files", manifest.permissions.filesystem);
  printList("secrets", manifest.permissions.secrets);
  printList("scopes", manifest.auth.scopes);
  console.log(`  subprocess ${manifest.permissions.subprocess ? kleur.yellow("yes") : kleur.dim("no")}`);
  for (const warning of plugin.warnings) console.log(`  ${kleur.yellow("warn")}       ${warning}`);
}

function printList(label: string, values: string[]): void {
  if (!values.length) return;
  console.log(`  ${label.padEnd(10)} ${values.join(", ")}`);
}
