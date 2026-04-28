import kleur from "kleur";
import { promises as fs } from "node:fs";
import yaml from "js-yaml";
import {
  buildDemoFederationConfig,
  buildDemoAgentPacks,
  ensureFederationConfig,
  federatedAgentMcpAudience,
  inspectMcpStatus,
  initProfile,
  mintFederatedAgentToken,
  readFederationJwks,
  resolveAgentPrincipal,
  verifyExternalOidcToken,
  writeAgentPack,
  FEDERATION_PATH,
  FEDERATION_KEYS_PATH,
} from "@unionstreet/us-core";

export async function federationStatus(agent?: string): Promise<void> {
  const cfg = await ensureFederationConfig();
  console.log(kleur.bold("federation") + kleur.dim(`  ${FEDERATION_PATH}`));
  console.log(`  issuer     ${kleur.cyan(cfg.issuer)}`);
  console.log(`  audiences  ${kleur.dim(cfg.audiences.join(", "))}`);
  console.log(`  grants     ${kleur.dim(String(cfg.grants.length))}`);
  console.log("");
  if (!agent) {
    console.log(kleur.dim("pass an agent/profile name to see resolved groups, roles, and MCP grants."));
    return;
  }

  const identity = await resolveAgentPrincipal(agent);
  console.log(kleur.bold(`agent:${agent}`));
  console.log(`  subject    ${kleur.cyan(identity.subject)}`);
  console.log(`  groups     ${kleur.dim(identity.groups.join(", ") || "none")}`);
  console.log(`  roles      ${kleur.dim(identity.roles.join(", ") || "none")}`);

  const mcp = await inspectMcpStatus(process.cwd(), agent);
  if (!mcp.servers.length) {
    console.log("");
    console.log(kleur.dim("  no MCP servers configured in checked config files."));
    return;
  }
  console.log("");
  console.log(kleur.bold("MCP grants"));
  for (const server of mcp.servers) {
    const grant = mcp.grants[server.name];
    const allowed = grant?.allowed ? kleur.green("allowed") : kleur.yellow("blocked");
    const tools = grant?.tools.length ? grant.tools.join(",") : "none";
    console.log(`  ${server.name.padEnd(24)} ${allowed}  ${kleur.dim(tools)}`);
  }
}

export async function federationToken(agent: string, opts: { audience?: string; mcpTarget?: string } = {}): Promise<void> {
  await ensureFederationConfig();
  const audience = opts.mcpTarget ? federatedAgentMcpAudience(opts.mcpTarget) : opts.audience;
  const token = await mintFederatedAgentToken(agent, {
    ...(audience ? { audience: [audience] } : {}),
    ttlSeconds: audience ? 60 : undefined,
  });
  console.log(token);
}

export async function federationJwks(): Promise<void> {
  const jwks = await readFederationJwks();
  console.log(JSON.stringify(jwks, null, 2));
  console.error(kleur.dim(`keys: ${FEDERATION_KEYS_PATH}`));
}

export async function federationDemoOrg(args: { profiles?: boolean; mcp?: boolean } = {}): Promise<void> {
  const { config, org } = buildDemoFederationConfig();
  await fs.mkdir(FEDERATION_PATH.replace(/\/[^/]+$/, ""), { recursive: true });
  await fs.writeFile(FEDERATION_PATH, yaml.dump(config));
  if (args.profiles) {
    const packsById = new Map(buildDemoAgentPacks(org).map((pack) => [pack.id, pack]));
    for (const node of org) {
      await initProfile(node.id, { role: node.roles[0] ?? "agent", capabilities: node.roles });
      const pack = packsById.get(node.id);
      if (pack) await writeAgentPack(node.id, pack);
    }
  }
  if (args.mcp) {
    await fs.writeFile(
      ".mcp.json",
      JSON.stringify({
        mcp: {
          github: { type: "remote", url: "https://mcp.example.com/github", enabled: true, oauth: true },
          linear: { type: "remote", url: "https://mcp.example.com/linear", enabled: true, oauth: true },
          slack: { type: "remote", url: "https://mcp.example.com/slack", enabled: true, oauth: true },
          hubspot: { type: "remote", url: "https://mcp.example.com/hubspot", enabled: true, oauth: true },
          stripe: { type: "remote", url: "https://mcp.example.com/stripe", enabled: true, oauth: true },
          quickbooks: { type: "remote", url: "https://mcp.example.com/quickbooks", enabled: true, oauth: true },
        },
      }, null, 2),
    );
  }
  console.log(kleur.bold("demo enterprise federation"));
  console.log(`  org nodes   ${kleur.cyan(String(org.length))}`);
  console.log(`  config      ${kleur.dim(FEDERATION_PATH)}`);
  console.log(`  profiles    ${args.profiles ? kleur.green("created/filled") : kleur.dim("skipped")}`);
  console.log(`  mcp config  ${args.mcp ? kleur.green(".mcp.json") : kleur.dim("skipped")}`);
}

export async function federationVerify(provider: string, token: string): Promise<void> {
  const identity = await verifyExternalOidcToken(provider, token);
  console.log(kleur.bold(`external:${provider}`));
  console.log(`  subject    ${kleur.cyan(identity.subject)}`);
  console.log(`  email      ${kleur.dim(identity.email ?? "none")}`);
  console.log(`  groups     ${kleur.dim(identity.groups.join(", ") || "none")}`);
  console.log(`  roles      ${kleur.dim(identity.roles.join(", ") || "none")}`);
}
