import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPlugins, doctorPlugins, inspectPlugin, resolvePluginCapabilities } from "./plugins.ts";

const root = await mkdtemp(join(tmpdir(), "union-street-plugins-test-"));

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("plugin discovery", () => {
  test("repoPlugins_WhenGithubAndLinearAreInspected_KeepCliAndMcpIntegrationSurfacesSeparate", async () => {
    const repoRoot = join(import.meta.dir, "../../..");
    const github = await inspectPlugin("github", repoRoot);
    const linear = await inspectPlugin("linear", repoRoot);
    const githubCapabilities = await resolvePluginCapabilities(github ? [github] : [], repoRoot);
    const linearCapabilities = await resolvePluginCapabilities(linear ? [linear] : [], repoRoot);

    expect(github?.manifest.capabilities.commands, "GitHub should be a CLI-first plugin built around gh/git commands.").toContain("gh pr");
    expect(github?.manifest.auth.mode, "GitHub's implementation surface is internal; user-facing install should only need to know it uses local CLI/token auth.").toBe("cli_session");
    expect(githubCapabilities.mcpConfigs, "GitHub should not expose an MCP config because GitHub MCP is not the supported integration path.").toEqual([]);
    expect(githubCapabilities.skills.map((skill) => skill.name), "GitHub CLI guidance should be injected as a plugin skill alongside workflows.").toContain("github-cli");
    expect(linear?.manifest.capabilities.mcp, "Linear should be an MCP-first plugin.").toEqual(["linear"]);
    expect(linear?.manifest.auth.mode, "Linear should tell onboarding that it needs OAuth without making users choose an MCP-shaped plugin.").toBe("oauth");
    expect(linearCapabilities.commands, "Linear should not require a local CLI wrapper.").toEqual([]);
    expect(linearCapabilities.mcpConfigs[0]?.path, "Linear should expose a concrete MCP config for agents that are granted the plugin.").toContain("plugins/linear/.mcp.json");
  });

  test("repoPlugins_WhenCloudCliPluginsAreInspected_AreSkillsAndCliOnly", async () => {
    const repoRoot = join(import.meta.dir, "../../..");
    const expected = new Map([
      ["vercel", "vercel-cli"],
      ["aws", "aws-cli"],
      ["gcp", "gcp-cli"],
      ["azure", "azure-cli"],
      ["cloudflare", "cloudflare-wrangler"],
    ]);

    for (const [pluginName, skillName] of expected) {
      const plugin = await inspectPlugin(pluginName, repoRoot);
      const capabilities = await resolvePluginCapabilities(plugin ? [plugin] : [], repoRoot);

      expect(plugin?.manifest.kind, `${pluginName}: cloud operator plugins should be skills/apps, not runtime providers.`).toEqual(["skills", "apps"]);
      expect(plugin?.manifest.auth.mode, `${pluginName}: cloud plugins should expose the auth primitive separately from their capability surface.`).toMatch(/^(cli_session|bearer_token)$/);
      expect(plugin?.manifest.capabilities.runtime, `${pluginName}: runtime capabilities belong in runtime-* plugins, not CLI guidance plugins.`).toEqual([]);
      expect(plugin?.manifest.capabilities.mcp, `${pluginName}: these provider plugins should not imply MCP support.`).toEqual([]);
      expect(capabilities.mcpConfigs, `${pluginName}: no MCP config should be exposed.`).toEqual([]);
      expect(capabilities.tools, `${pluginName}: no custom tools should be loaded for the basics-only plugin.`).toEqual([]);
      expect(capabilities.commands.length, `${pluginName}: command affordances should teach the CLI surface.`).toBeGreaterThan(0);
      expect(capabilities.skills.map((skill) => skill.name), `${pluginName}: one concise CLI skill should be loaded.`).toEqual([skillName]);
    }
  });

  test("repoPlugins_WhenGtmPluginIsInspected_LoadsVendoredMarketingSkillGraph", async () => {
    const repoRoot = join(import.meta.dir, "../../..");
    const gtm = await inspectPlugin("gtm", repoRoot);
    const capabilities = await resolvePluginCapabilities(gtm ? [gtm] : [], repoRoot);
    const skillNames = capabilities.skills.map((skill) => skill.name);

    expect(gtm?.manifest.kind, "GTM should be a capability plugin, not a runtime or MCP provider.").toEqual(["skills", "apps"]);
    expect(gtm?.manifest.auth.mode, "Skills-only GTM should install without asking the user for OAuth, bearer tokens, or API keys.").toBe("none");
    expect(gtm?.manifest.capabilities.runtime, "GTM skills must not imply sandbox/runtime placement.").toEqual([]);
    expect(gtm?.manifest.capabilities.mcp, "GTM skill graph should not smuggle app access through MCP.").toEqual([]);
    expect(skillNames.length, "The GTM plugin should vendor the full marketing skill graph from marketingskills.").toBe(40);
    expect(skillNames, "The product marketing context skill should be available because the other marketing skills depend on it.").toContain("product-marketing-context");
    expect(skillNames, "RevOps should be available for GTM lifecycle and handoff work.").toContain("revops");
    expect(skillNames, "Sales enablement should be available for decks, one-pagers, and objection handling.").toContain("sales-enablement");
    expect(capabilities.mcpConfigs, "No MCP config should be exposed by the GTM skill bundle.").toEqual([]);
    expect(capabilities.tools, "Vendored marketing skills should load as skills only, not executable tools.").toEqual([]);
  });

  test("discoverPlugins_WhenUnionStreetManifestExists_NormalizesCapabilitiesAndPolicyFields", async () => {
    const pluginRoot = join(root, "plugins", "runtime-kubernetes");
    await mkdir(join(pluginRoot, "src"), { recursive: true });
    await mkdir(join(pluginRoot, "terraform"), { recursive: true });
    await writeFile(join(pluginRoot, "README.md"), "# runtime-kubernetes\n");
    await writeFile(join(pluginRoot, "src", "runtime.ts"), "export {}\n");
    await writeFile(join(pluginRoot, "unionstreet.plugin.json"), JSON.stringify({
      schema_version: "v1",
      name: "runtime-kubernetes",
      version: "0.1.0",
      description: "Kubernetes runtime provider",
      kind: ["runtime"],
      capabilities: {
        runtime: ["render", "plan", "apply", "status"],
        hooks: ["runtime.before_apply"],
        apps: ["github"],
      },
      entrypoints: {
        runtime: "./src/runtime.ts",
        terraform: "./terraform",
      },
      permissions: {
        network: ["kubernetes-api"],
        filesystem: ["workspace"],
        secrets: ["runtime:*"],
        subprocess: true,
      },
    }));

    const inventory = await discoverPlugins(root);
    const plugin = inventory.plugins.find((item) => item.manifest.name === "runtime-kubernetes");

    expect(inventory.invalid, "Valid manifests should not be reported as invalid.").toHaveLength(0);
    expect(plugin?.manifest.source, "Union Street manifests should be preferred as the source of truth.").toBe("unionstreet");
    expect(plugin?.manifest.kind, "Explicit plugin kind should survive normalization.").toEqual(["runtime"]);
    expect(plugin?.manifest.capabilities.runtime, "Runtime capabilities should be typed and preserved.").toEqual(["render", "plan", "apply", "status"]);
    expect(plugin?.manifest.capabilities.apps, "App capabilities should be typed and preserved for integration plugins.").toEqual(["github"]);
    expect(plugin?.manifest.auth.mode, "Manifests without explicit auth should infer auth from secrets so older plugins remain usable.").toBe("api_key");
    expect(plugin?.manifest.permissions.secrets, "Permission declarations should be retained for later policy enforcement.").toEqual(["runtime:*"]);
    expect(plugin?.warnings, "A production-shaped manifest should not produce warnings.").toEqual([]);
  });

  test("discoverPlugins_WhenOnlyCodexManifestExists_LoadsCompatibilityManifestWithWarnings", async () => {
    const pluginRoot = join(root, "plugins", "runtime-docker");
    await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
    await writeFile(join(pluginRoot, "README.md"), "# runtime-docker\n");
    await writeFile(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
      schema_version: "v1",
      name: "runtime-docker",
      version: "0.0.0",
      description: "Docker runtime provider",
    }));

    const plugin = await inspectPlugin("runtime-docker", root);

    expect(plugin?.manifest.source, "Codex manifests should be usable during migration.").toBe("codex");
    expect(plugin?.manifest.kind, "runtime-* compatibility manifests should infer runtime kind.").toEqual(["runtime"]);
    expect(plugin?.warnings, "Compatibility manifests should make migration gaps visible.").toEqual(expect.arrayContaining([
      "missing unionstreet.plugin.json; using codex compatibility manifest",
      "version is still 0.0.0",
    ]));
  });

  test("doctorPlugins_WhenManifestIsInvalid_FailsClosedButKeepsValidInventory", async () => {
    const pluginRoot = join(root, "plugins", "bad-plugin");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, "unionstreet.plugin.json"), "{ nope");

    const result = await doctorPlugins(root);

    expect(result.ok, "Invalid manifests should fail plugin doctor.").toBe(false);
    expect(result.plugins.some((plugin) => plugin.manifest.name === "runtime-kubernetes"), "Valid plugins should remain inspectable when another plugin is invalid.").toBe(true);
    expect(result.invalid.some((plugin) => plugin.root.endsWith("bad-plugin")), "Invalid plugin roots should be reported.").toBe(true);
  });

  test("resolvePluginCapabilities_WhenPluginBundlesSkillsCliMcpAndTools_LoadsAllConcreteAgentCapabilities", async () => {
    const pluginRoot = join(root, "plugins", "github");
    await mkdir(join(pluginRoot, "skills", "pr-review"), { recursive: true });
    await mkdir(join(pluginRoot, "tools"), { recursive: true });
    await writeFile(join(pluginRoot, "README.md"), "# github\n");
    await writeFile(join(pluginRoot, ".mcp.json"), JSON.stringify({ mcpServers: { github: { command: "gh", args: ["mcp"] } } }));
    await writeFile(join(pluginRoot, "skills", "pr-review", "SKILL.md"), [
      "---",
      "name: pr-review",
      "description: Review pull requests",
      "---",
      "",
      "# PR Review",
      "",
      "Use gh pr view and git diff.",
    ].join("\n"));
    await writeFile(join(pluginRoot, "tools", "pr-summary.ts"), [
      "export default {",
      "  description: 'Summarize a pull request',",
      "  parameters: { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'], additionalProperties: false },",
      "  async execute(args, context) { return `plugin=${context.plugin.name} pr=${args.number}`; }",
      "};",
    ].join("\n"));
    await writeFile(join(pluginRoot, "unionstreet.plugin.json"), JSON.stringify({
      schema_version: "v1",
      name: "github",
      version: "0.1.0",
      description: "GitHub workflow plugin",
      kind: ["skills", "mcp", "tools", "apps"],
      capabilities: {
        skills: ["pr-review"],
        mcp: ["github"],
        tools: ["pr-summary"],
        apps: ["github"],
        commands: ["gh pr", "git"],
      },
      entrypoints: {
        skills: "./skills",
        mcp: "./.mcp.json",
        tools: "./tools",
      },
      permissions: { subprocess: true },
    }));

    const plugin = await inspectPlugin("github", root);
    const capabilities = await resolvePluginCapabilities(plugin ? [plugin] : [], root);

    expect(capabilities.skills.map((skill) => skill.name), "Plugin skills should be loaded from SKILL.md files.").toEqual(["pr-review"]);
    expect(capabilities.skills[0]?.content, "Skill body should be available for prompt composition, not just advertised by path.").toContain("Use gh pr view");
    expect(capabilities.commands.map((command) => command.command), "CLI affordances should be declared without requiring wrappers.").toEqual(["gh pr", "git"]);
    expect(capabilities.mcpConfigs[0]?.path.endsWith(".mcp.json"), "Plugin MCP config remains optional but discoverable.").toBe(true);
    expect(capabilities.tools.map((tool) => tool.definition.name), "Custom tools should be loaded with plugin-scoped names to avoid collisions.").toEqual(["github_pr_summary"]);
    expect(await capabilities.tools[0]!.execute({ number: 7 }, { cwd: root }), "Loaded custom tools should receive plugin execution context.").toBe("plugin=github pr=7");
  });

  test("resolvePluginCapabilities_WhenOneToolModuleExplodes_SkipsItWithoutPoisoningValidTools", async () => {
    const pluginRoot = join(root, "plugins", "hostile-tools");
    await mkdir(join(pluginRoot, "tools"), { recursive: true });
    await writeFile(join(pluginRoot, "README.md"), "# hostile-tools\n");
    await writeFile(join(pluginRoot, "tools", "explode.ts"), "throw new Error('top-level plugin import boom');\n");
    await writeFile(join(pluginRoot, "tools", "valid.ts"), [
      "export default {",
      "  description: 'Valid tool in a hostile plugin directory',",
      "  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },",
      "  async execute(args, context) { return `${context.plugin.name}:${args.value}`; }",
      "};",
    ].join("\n"));
    await writeFile(join(pluginRoot, "unionstreet.plugin.json"), JSON.stringify({
      schema_version: "v1",
      name: "hostile-tools",
      version: "0.1.0",
      description: "Plugin with one hostile tool module",
      kind: ["tools"],
      capabilities: { tools: ["explode", "valid"] },
      entrypoints: { tools: "./tools" },
      permissions: {},
    }));

    const plugin = await inspectPlugin("hostile-tools", root);
    const capabilities = await resolvePluginCapabilities(plugin ? [plugin] : [], root);

    expect(
      capabilities.tools.map((tool) => tool.definition.name),
      "A broken tool file must not make every other tool in the same plugin unavailable.",
    ).toEqual(["hostile_tools_valid"]);
    expect(await capabilities.tools[0]!.execute({ value: "still-runs" }, { cwd: root })).toBe("hostile-tools:still-runs");
  });

  const capabilityCases: Array<CapabilityFlags & { label: string }> = [
    { label: "skills only", skills: true },
    { label: "mcp only", mcp: true },
    { label: "cli only", cli: true },
    { label: "custom tools only", tools: true },
    { label: "custom tools + cli", tools: true, cli: true },
    { label: "custom tools + skills", tools: true, skills: true },
    { label: "custom tools + mcp", tools: true, mcp: true },
    { label: "skills + mcp", skills: true, mcp: true },
    { label: "skills + cli", skills: true, cli: true },
    { label: "mcp + cli", mcp: true, cli: true },
    { label: "skills + mcp + cli", skills: true, mcp: true, cli: true },
    { label: "skills + mcp + custom tools", skills: true, mcp: true, tools: true },
    { label: "skills + cli + custom tools", skills: true, cli: true, tools: true },
    { label: "mcp + cli + custom tools", mcp: true, cli: true, tools: true },
    { label: "skills + mcp + cli + custom tools", skills: true, mcp: true, cli: true, tools: true },
  ];

  for (const item of capabilityCases) {
    test(`resolvePluginCapabilities_WhenPluginIs${titleCase(item.label)}_LoadsOnlyDeclaredCapabilities`, async () => {
      const name = `perm-${item.label.replaceAll(" + ", "-").replaceAll(" ", "-")}`;
      const plugin = await createCapabilityPlugin(name, item);
      const capabilities = await resolvePluginCapabilities([plugin], root);

      expect(capabilities.skills.map((skill) => skill.name), `${item.label}: skill loading should match declaration.`).toEqual(item.skills ? [`${name}-skill`] : []);
      expect(capabilities.mcpConfigs.map((config) => config.plugin.manifest.name), `${item.label}: MCP config loading should match declaration.`).toEqual(item.mcp ? [name] : []);
      expect(capabilities.commands.map((command) => command.command), `${item.label}: CLI declarations should match manifest without requiring wrappers.`).toEqual(item.cli ? [`${name} do`] : []);
      expect(capabilities.tools.map((tool) => tool.definition.name), `${item.label}: custom tools should match files and be plugin-scoped.`).toEqual(item.tools ? [`${name.replaceAll("-", "_")}_ping`] : []);
      if (item.tools) {
        expect(await capabilities.tools[0]!.execute({ value: "ok" }, { cwd: root }), `${item.label}: custom tool should execute with plugin context.`).toBe(`${name}:ok`);
      }
    });
  }
});

interface CapabilityFlags {
  skills?: boolean;
  mcp?: boolean;
  cli?: boolean;
  tools?: boolean;
}

async function createCapabilityPlugin(name: string, flags: CapabilityFlags) {
  const pluginRoot = join(root, "plugins", name);
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(join(pluginRoot, "README.md"), `# ${name}\n`);

  const capabilities: Record<string, string[]> = {};
  const entrypoints: Record<string, string> = {};
  const kind: string[] = [];

  if (flags.skills) {
    kind.push("skills");
    capabilities.skills = [`${name}-skill`];
    entrypoints.skills = "./skills";
    await mkdir(join(pluginRoot, "skills", `${name}-skill`), { recursive: true });
    await writeFile(join(pluginRoot, "skills", `${name}-skill`, "SKILL.md"), [
      "---",
      `name: ${name}-skill`,
      `description: ${name} skill`,
      "---",
      "",
      `# ${name} Skill`,
      "",
      "Follow the plugin workflow.",
    ].join("\n"));
  }

  if (flags.mcp) {
    kind.push("mcp");
    capabilities.mcp = [name];
    entrypoints.mcp = "./.mcp.json";
    await writeFile(join(pluginRoot, ".mcp.json"), JSON.stringify({
      mcpServers: {
        [name]: {
          command: "node",
          args: ["server.js"],
        },
      },
    }));
  }

  if (flags.cli) {
    capabilities.commands = [`${name} do`];
  }

  if (flags.tools) {
    kind.push("tools");
    capabilities.tools = ["ping"];
    entrypoints.tools = "./tools";
    await mkdir(join(pluginRoot, "tools"), { recursive: true });
    await writeFile(join(pluginRoot, "tools", "ping.ts"), [
      "export default {",
      "  description: 'Ping test tool',",
      "  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },",
      "  async execute(args, context) { return `${context.plugin.name}:${args.value}`; }",
      "};",
    ].join("\n"));
  }

  await writeFile(join(pluginRoot, "unionstreet.plugin.json"), JSON.stringify({
    schema_version: "v1",
    name,
    version: "0.1.0",
    description: `${name} permutation plugin`,
    kind: kind.length ? kind : ["apps"],
    capabilities,
    entrypoints,
    permissions: {},
  }));

  const plugin = await inspectPlugin(name, root);
  if (!plugin) throw new Error(`test failed to create plugin ${name}`);
  return plugin;
}

function titleCase(value: string): string {
  return value.replace(/(^|[ +])([a-z])/g, (_match, prefix: string, ch: string) => `${prefix}${ch.toUpperCase()}`).replace(/[^A-Za-z0-9]+/g, "");
}
