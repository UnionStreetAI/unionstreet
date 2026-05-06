#!/usr/bin/env bun
/**
 * `us` — Union Street CLI entrypoint.
 */
import { cac } from "cac";
import { doctor } from "./commands/doctor.ts";
import { setup } from "./commands/setup.ts";
import { onboard } from "./commands/onboard.ts";
import { init } from "./commands/init.ts";
import { authCodex, authClaude, authStatus } from "./commands/auth.ts";
import { profileList, profileUse } from "./commands/profile.ts";
import { chat } from "./commands/chat.tsx";
import { prompt } from "./commands/prompt.ts";
import { federationDemoOrg, federationJwks, federationStatus, federationToken, federationVerify } from "./commands/federation.ts";
import { runtimeDestroy, runtimeEnsure, runtimeRender, runtimeServe, runtimeStatus } from "./commands/runtime.ts";
import { agentMcpCommand, mcpCommand } from "./commands/mcp.ts";
import { eventsCommand } from "./commands/events.ts";
import { schedulerCommand } from "./commands/scheduler.ts";
import { fleetCommand } from "./commands/fleet.ts";
import { pluginsCommand } from "./commands/plugins.ts";
import { startLashPeerStdioServer } from "@unionstreet/server";
import { resetTerminalModes } from "./terminalModes.ts";

resetTerminalModes();
process.once("exit", resetTerminalModes);

const cli = cac("us-dev");

cli
  .command("doctor", "Verify local prerequisites and Honcho memory dependencies")
  .action(async () => {
    const ok = await doctor();
    process.exit(ok ? 0 : 1);
  });

cli
  .command("setup [profile]", "Onboard this Mac/Linux machine and create a ready local agent profile")
  .option("--role <role>", "Declared role for the starter profile")
  .option("--capability <cap>", "Declared capability (repeatable)")
  .option("--check", "Check onboarding readiness without creating files")
  .option("--skip-doctor", "Skip host prerequisite checks")
  .option("--skip-plugins", "Skip plugin doctor")
  .action(async (profile: string | undefined, args) => {
    try {
      const ok = await setup({
        profile,
        role: args.role,
        capability: args.capability,
        check: Boolean(args.check),
        skipDoctor: Boolean(args.skipDoctor),
        skipPlugins: Boolean(args.skipPlugins),
      });
      process.exit(ok ? 0 : 1);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

cli
  .command("onboard [action]", "Create/review/apply an initial agent fleet with departments, plugins, and skills")
  .option("--name <name>", "Fleet name")
  .option("--mission <mission>", "Fleet mission")
  .option("--root <profile>", "Root/head agent profile, defaults to coo")
  .option("--department <dept>", "Department id or id:Display Name (repeatable or comma-separated)")
  .option("--plugin <plugin>", "Plugin bundle to grant (repeatable or comma-separated)")
  .option("--skill <skill>", "Skill/plugin bundle to grant (repeatable or comma-separated)")
  .option("--mcp <server>", "MCP server to grant (repeatable or comma-separated)")
  .option("--model-provider <provider>", "Model provider for generated agents")
  .option("--model <model>", "Model id for generated agents")
  .option("--out <file>", "Write the fleet plan YAML to a file")
  .option("--apply", "Apply the generated fleet plan")
  .option("--replace", "Allow applying over existing generated profiles")
  .option("--skip-setup", "Skip machine/profile setup before planning")
  .option("--json", "Print JSON")
  .action(async (action: string | undefined, args) => {
    try {
      if (action && action !== "create") {
        console.error(`Unknown onboard action "${action}". Try: create`);
        process.exit(2);
      }
      const ok = await onboard({
        name: args.name,
        mission: args.mission,
        root: args.root,
        department: args.department,
        plugin: args.plugin,
        skill: args.skill,
        mcp: args.mcp,
        modelProvider: args.modelProvider,
        model: args.model,
        out: args.out,
        apply: Boolean(args.apply),
        replace: Boolean(args.replace),
        skipSetup: Boolean(args.skipSetup),
        json: Boolean(args.json),
      });
      process.exit(ok ? 0 : 1);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

cli
  .command("init <name>", "Initialize a new profile at ~/.us/profiles/<name>")
  .option("--role <role>", "Declared role for the profile registry")
  .option("--capability <cap>", "Declared capability (repeatable)")
  .action(async (name: string, args) => {
    try {
      await init(name, args);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

cli
  .command(
    "auth <action> [profile]",
    "Credential management: status | codex | claude. Profile is optional — without it, reads/writes the shared ~/.us/auth-profiles.json.",
  )
  .action(async (action: string, profile: string | undefined) => {
    try {
      switch (action) {
        case "status":
          await authStatus(profile);
          break;
        case "codex":
          await authCodex(profile);
          break;
        case "claude":
          await authClaude(profile);
          break;
        default:
          console.error(`Unknown auth action "${action}". Try: status | codex | claude`);
          process.exit(2);
      }
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

cli
  .command("profile <action> [name]", "Profile management: list | use <name>")
  .action(async (action: string, name: string | undefined) => {
    try {
      switch (action) {
        case "list":
          await profileList();
          break;
        case "use":
          if (!name) {
            console.error("`us-dev profile use` requires a profile name.");
            process.exit(2);
          }
          await profileUse(name);
          break;
        default:
          console.error(`Unknown profile action "${action}". Try: list | use <name>`);
          process.exit(2);
      }
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

cli
  .command("federation <action> [arg]", "Federation: status [agent] | token <agent> | jwks | demo-org | verify <provider>")
  .option("--profiles", "Create/fill matching agent profiles for demo-org")
  .option("--mcp", "Write demo .mcp.json for demo-org")
  .option("--token <jwt>", "JWT to verify for `federation verify <provider>`")
  .option("--audience <aud>", "Audience for `federation token`")
  .option("--mcp-target <profile>", "Mint `federation token` for a target agent MCP server")
  .action(async (action: string, arg: string | undefined, options) => {
    try {
      switch (action) {
        case "status":
          await federationStatus(arg);
          break;
        case "token":
          if (!arg) {
            console.error("`us-dev federation token` requires an agent/profile name.");
            process.exit(2);
          }
          await federationToken(arg, {
            audience: options.audience ? String(options.audience) : undefined,
            mcpTarget: options.mcpTarget ? String(options.mcpTarget) : undefined,
          });
          break;
        case "jwks":
          await federationJwks();
          break;
        case "demo-org":
          await federationDemoOrg({ profiles: Boolean(options.profiles), mcp: Boolean(options.mcp) });
          break;
        case "verify":
          if (!arg || !options.token) {
            console.error("`us-dev federation verify` requires a provider and --token <jwt>.");
            process.exit(2);
          }
          await federationVerify(arg, String(options.token));
          break;
        default:
          console.error(`Unknown federation action "${action}". Try: status [agent] | token <agent> | jwks | demo-org | verify <provider>`);
          process.exit(2);
      }
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

cli
  .command("chat [profile]", "Open a chat session. If profile is omitted, uses default or sole profile.")
  .option("-p, --profile <profile>", "Profile to run as, same as the optional positional profile.")
  .action(async (profile: string | undefined, options) => {
    try {
      await chat(options.profile ?? profile);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

cli
  .command("plugins [action] [name]", "Plugins: list | inspect <name> | doctor | agent <profile>")
  .option("--json", "Print JSON")
  .action(async (action: string | undefined, name: string | undefined, options) => {
    try {
      await pluginsCommand(action, name, { json: Boolean(options.json) });
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

cli
  .command("mcp <action> [server]", "MCP: status | auth <server> | logout <server>")
  .option("-p, --profile <profile>", "Agent profile whose MCP credentials/grants should be used")
  .option("--api-key <key>", "Save a pasted API key/token for `mcp auth`")
  .option("--access-token <token>", "Save a bearer/OAuth access token for `mcp auth`")
  .option("--refresh-token <token>", "Optional OAuth refresh token")
  .option("--expires-at <value>", "Optional OAuth expiry as epoch seconds/ms or ISO date")
  .option("--oauth", "Run OAuth authorization-code + PKCE flow")
  .option("--auth-url <url>", "OAuth authorization endpoint for MCP auth")
  .option("--token-url <url>", "OAuth token endpoint for MCP auth")
  .option("--client-id <id>", "OAuth public client id for MCP auth")
  .option("--client-secret <secret>", "Optional OAuth client secret for token exchange")
  .option("--redirect-uri <uri>", "OAuth redirect URI, defaults to http://localhost:1456/mcp/callback")
  .option("--callback-env <name>", "Read OAuth callback URL/code from an environment variable")
  .option("--scope <scope>", "OAuth scopes for MCP auth")
  .option("--audience <audience>", "Optional OAuth audience/resource")
  .option("--header <name>", "Header used for API key materialization, defaults to Authorization")
  .option("--provider <provider>", "Provider hint to store with the credential")
  .action(async (action: string, server: string | undefined, options) => {
    try {
      await mcpCommand(action, server, options);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

cli
  .command("events [action]", "Events/audit log: tail | query")
  .option("--agent <agent>", "Filter actor by agent/profile")
  .option("--actor <agent>", "Filter actor")
  .option("--subject <agent>", "Filter subject")
  .option("--target <agent>", "Filter target")
  .option("--type <type>", "Filter event type")
  .option("--outcome <outcome>", "Filter outcome")
  .option("--trace <trace>", "Filter Lash trace")
  .option("--limit <n>", "Maximum events to print")
  .option("--json", "Print JSON")
  .action(async (action: string | undefined, options) => {
    try {
      await eventsCommand(action, options);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

cli
  .command("scheduler [action]", "Scheduler: status | due | tick | runs")
  .option("-p, --profile <profile>", "Only inspect/tick one agent profile")
  .option("--now <value>", "Evaluate due jobs at epoch seconds/ms or ISO date")
  .option("--execute", "Execute claimed due jobs with the dry-run executor")
  .action(async (action: string | undefined, options) => {
    try {
      await schedulerCommand(action, options);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

cli
  .command("fleet <action> [arg]", "Fleet planning: plan <agent> -p <prompt> | validate <file> | apply <file>")
  .option("-p, --prompt <prompt>", "Prompt for `fleet plan`")
  .option("--out <path>", "Write generated plan YAML to a file")
  .option("--json", "Print JSON")
  .option("--replace", "Allow apply/validate to target profiles that already exist")
  .option("--dry-run", "Validate and preview apply without writing profiles/federation")
  .action(async (action: string | undefined, arg: string | undefined, options) => {
    try {
      await fleetCommand(action, arg, {
        prompt: options.prompt ? String(options.prompt) : undefined,
        out: options.out ? String(options.out) : undefined,
        json: Boolean(options.json),
        replace: Boolean(options.replace),
        dryRun: Boolean(options.dryRun),
      });
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

cli
  .command("<profile> mcp <action> [server]", "Agent-scoped MCP auth/status, e.g. `us-dev coo mcp auth linear`")
  .option("--api-key <key>", "Save a pasted API key/token for `mcp auth`")
  .option("--access-token <token>", "Save a bearer/OAuth access token for `mcp auth`")
  .option("--refresh-token <token>", "Optional OAuth refresh token")
  .option("--expires-at <value>", "Optional OAuth expiry as epoch seconds/ms or ISO date")
  .option("--oauth", "Run OAuth authorization-code + PKCE flow")
  .option("--auth-url <url>", "OAuth authorization endpoint for MCP auth")
  .option("--token-url <url>", "OAuth token endpoint for MCP auth")
  .option("--client-id <id>", "OAuth public client id for MCP auth")
  .option("--client-secret <secret>", "Optional OAuth client secret for token exchange")
  .option("--redirect-uri <uri>", "OAuth redirect URI, defaults to http://localhost:1456/mcp/callback")
  .option("--callback-env <name>", "Read OAuth callback URL/code from an environment variable")
  .option("--scope <scope>", "OAuth scopes for MCP auth")
  .option("--audience <audience>", "Optional OAuth audience/resource")
  .option("--header <name>", "Header used for API key materialization, defaults to Authorization")
  .option("--provider <provider>", "Provider hint to store with the credential")
  .action(async (profile: string, action: string, server: string | undefined, options) => {
    try {
      await agentMcpCommand(profile, action, server, options);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

cli
  .command("[profile]", "Run `us-dev [profile] -p <prompt>` or open chat for a profile")
  .option("-p, --prompt <prompt>", "Run one non-interactive prompt as the selected profile")
  .action(async (profile: string | undefined, options) => {
    try {
      const text = typeof options.prompt === "string" ? options.prompt.trim() : "";
      if (text) {
        await prompt(profile, text);
      } else if (profile) {
        await chat(profile);
      } else {
        cli.outputHelp();
      }
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

cli
  .command("runtime <action> [profile]", "Runtime/workspace: status [profile] | ensure <profile> | render <profile> | destroy <profile> | serve")
  .option("--port <port>", "Port for `runtime serve`, defaults to 8787")
  .option("--host <host>", "Host for `runtime serve`, defaults to 127.0.0.1")
  .option("--provider <provider>", "Provider override for supported runtime actions, e.g. kubernetes")
  .option("--dry-run", "Print rendered provider resources without creating them")
  .option("--name <name>", "Provider resource name override, currently used for Docker containers")
  .option("--namespace <namespace>", "Kubernetes namespace for dry-run manifests")
  .option("--image <image>", "Container image for Kubernetes dry-run manifests")
  .option("--workload <kind>", "Kubernetes agent workload kind: Deployment | Job | Pod")
  .option("--external-secret <name>", "Existing Kubernetes Secret to project into rendered agent pods")
  .action(async (action: string, profile: string | undefined, options) => {
    try {
      switch (action) {
        case "status":
          await runtimeStatus(profile);
          break;
        case "ensure":
          if (!profile) {
            console.error("`us-dev runtime ensure` requires a profile.");
            process.exit(2);
          }
          await runtimeEnsure(profile, {
            provider: options.provider ? String(options.provider) : undefined,
            dryRun: Boolean(options.dryRun),
            namespace: options.namespace ? String(options.namespace) : undefined,
            image: options.image ? String(options.image) : undefined,
            name: options.name ? String(options.name) : undefined,
            workload: options.workload ? String(options.workload) : undefined,
            externalSecret: options.externalSecret ? String(options.externalSecret) : undefined,
          });
          break;
        case "render":
          if (!profile) {
            console.error("`us-dev runtime render` requires a profile.");
            process.exit(2);
          }
          await runtimeRender(profile, {
            provider: options.provider ? String(options.provider) : undefined,
            namespace: options.namespace ? String(options.namespace) : undefined,
            image: options.image ? String(options.image) : undefined,
            name: options.name ? String(options.name) : undefined,
            workload: options.workload ? String(options.workload) : undefined,
            externalSecret: options.externalSecret ? String(options.externalSecret) : undefined,
          });
          break;
        case "destroy":
          if (!profile) {
            console.error("`us-dev runtime destroy` requires a profile.");
            process.exit(2);
          }
          await runtimeDestroy(profile, {
            provider: options.provider ? String(options.provider) : undefined,
            name: options.name ? String(options.name) : undefined,
          });
          break;
        case "serve":
          await runtimeServe(options);
          break;
        default:
          console.error(`Unknown runtime action "${action}". Try: status [profile] | ensure <profile> | render <profile> | serve`);
          process.exit(2);
      }
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

cli
  .command("mcp-agent", "Run a Union Street agent Lash MCP server over stdio")
  .option("-p, --profile <profile>", "Profile to expose as an MCP peer")
  .action(async (options) => {
    try {
      const profile = options.profile;
      if (!profile) {
        console.error("`us-dev mcp-agent` requires --profile <profile>.");
        process.exit(2);
      }
      await startLashPeerStdioServer(String(profile));
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

cli.help();
cli.version("0.0.0");

const argv = process.argv.slice(2);
if (argv[1] === "mcp") {
  runAgentMcpArgv(argv).catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
} else {
  cli.parse();
}

async function runAgentMcpArgv(argv: string[]): Promise<void> {
  const [profile, _mcp, action, server, ...rest] = argv;
  if (!profile || !action) {
    console.error("Usage: us-dev <agent> mcp <status|auth|logout> [server]");
    process.exit(2);
  }
  const options = parseOptionArgs(rest);
  await agentMcpCommand(profile, action, server, options as Parameters<typeof agentMcpCommand>[3]);
}

function parseOptionArgs(args: string[]): Record<string, string | boolean | undefined> {
  const out: Record<string, string | boolean | undefined> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) continue;
    const [rawName, inlineValue] = arg.slice(2).split("=", 2);
    if (!rawName) continue;
    const name = rawName.replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase());
    const value = inlineValue ?? (args[i + 1]?.startsWith("--") || args[i + 1] === undefined ? true : args[++i]);
    out[name] = value;
  }
  return out;
}
