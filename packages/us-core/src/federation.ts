import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import yaml from "js-yaml";
import { FEDERATION_KEYS_PATH, FEDERATION_PATH } from "./paths.ts";
import { listProfiles } from "./profile.ts";
import { readAgentPack, type AgentPack } from "./agent-pack.ts";
import type { McpServerInfo } from "./mcp-status.ts";
import { writeEvent } from "./events.ts";

export type FederationPrincipalKind = "human" | "agent" | "group" | "role" | "service";

export interface FederationPrincipal {
  id: string;
  kind: FederationPrincipalKind;
  displayName?: string;
  email?: string;
  title?: string;
  manager?: string;
  roles?: string[];
  groups?: string[];
  external?: Record<string, string>;
  disabled?: boolean;
}

export interface FederationGrant {
  id?: string;
  resource: "mcp";
  servers: string[];
  tools: string[];
  effect?: "allow" | "deny";
  principals?: string[];
  agents?: string[];
  groups?: string[];
  roles?: string[];
  requireApproval?: boolean;
}

export interface FederationConfig {
  version: 1;
  issuer: string;
  audiences: string[];
  principals: {
    humans: Record<string, FederationPrincipal>;
    agents: Record<string, FederationPrincipal>;
    groups: Record<string, FederationPrincipal & { members?: string[] }>;
    roles: Record<string, FederationPrincipal>;
    services: Record<string, FederationPrincipal>;
  };
  grants: FederationGrant[];
  oidcProviders: Record<string, FederationOidcProvider>;
}

export interface FederationOidcProvider {
  issuer: string;
  audience?: string;
  jwksUri?: string;
  groupsClaim?: string;
  rolesClaim?: string;
  emailClaim?: string;
  nameClaim?: string;
  subjectClaim?: string;
  mappings?: {
    groups?: Record<string, string>;
    roles?: Record<string, string>;
  };
}

export interface ExternalFederatedIdentity {
  provider: string;
  subject: string;
  email?: string;
  displayName?: string;
  groups: string[];
  roles: string[];
  principals: string[];
  claims: Record<string, unknown>;
}

export interface FederatedAgentIdentity {
  subject: string;
  profile: string;
  roles: string[];
  groups: string[];
  principals: string[];
}

export interface FederatedClaims {
  iss: string;
  sub: string;
  aud: string[];
  iat: number;
  exp: number;
  jti: string;
  us_profile: string;
  us_roles: string[];
  us_groups: string[];
  us_principals: string[];
}

export interface McpGrantDecision {
  server: string;
  allowed: boolean;
  requireApproval: boolean;
  tools: string[];
  matchedGrants: FederationGrant[];
}

export interface FederationOrgNode {
  id: string;
  displayName: string;
  title: string;
  manager?: string;
  roles: string[];
  groups: string[];
}

export type DelegationRelation = "manager" | "direct_report" | "descendant" | "unfederated";

export interface DelegationTarget {
  profile: string;
  relation: DelegationRelation;
  depth: number;
  displayName?: string;
  title?: string;
}

export interface DelegationDecision {
  allowed: boolean;
  reason: string;
  relation?: DelegationRelation;
  depth?: number;
  allowedTargets: DelegationTarget[];
}

interface FederationKeys {
  kid: string;
  alg: "EdDSA";
  publicJwk: Jwk;
  privateJwk: Jwk;
}

type Jwk = Record<string, unknown>;

const DEFAULT_AUDIENCE = "urn:union-street:agents";
const MCP_AUDIENCE_PREFIX = "urn:union-street:mcp-agent:";

export function federatedAgentMcpAudience(profile: string): string {
  return `${MCP_AUDIENCE_PREFIX}${profile}`;
}

export async function ensureFederationConfig(): Promise<FederationConfig> {
  try {
    return await readFederationConfig();
  } catch {
    const cfg = defaultFederationConfig();
    await fs.mkdir(dirname(FEDERATION_PATH), { recursive: true });
    await fs.writeFile(FEDERATION_PATH, yaml.dump(cfg));
    return cfg;
  }
}

export async function readFederationConfig(): Promise<FederationConfig> {
  const raw = await fs.readFile(FEDERATION_PATH, "utf8");
  const parsed = yaml.load(raw);
  return normalizeFederationConfig(parsed);
}

export async function writeFederationConfig(config: FederationConfig): Promise<void> {
  await fs.mkdir(dirname(FEDERATION_PATH), { recursive: true });
  await fs.writeFile(FEDERATION_PATH, yaml.dump(normalizeFederationConfig(config), { lineWidth: 100 }));
}

export async function resolveAgentPrincipal(profile: string): Promise<FederatedAgentIdentity> {
  const cfg = await ensureFederationConfig();
  const profiles = await listProfiles();
  const pack = await readOptionalAgentPack(profile);
  const subject = pack?.oidc.subject ?? pack?.identity.subject ?? `agent:${profile}`;
  const agent = cfg.principals.agents[profile] ?? cfg.principals.agents[subject];
  if (agent?.disabled) throw new Error(`agent "${profile}" is disabled in federation config`);
  const groups = new Set<string>([...(agent?.groups ?? []), ...(pack?.identity.groups ?? [])]);
  const roles = new Set<string>([...(agent?.roles ?? []), ...(pack?.identity.roles ?? [])]);

  for (const [groupId, group] of Object.entries(cfg.principals.groups)) {
    const members = group.members ?? [];
    if (members.includes(profile) || members.includes(subject) || (groupId === "all-agents" && profiles.includes(profile))) {
      groups.add(groupId);
    }
  }
  for (const groupId of groups) {
    const group = cfg.principals.groups[groupId];
    for (const role of group?.roles ?? []) roles.add(role);
  }

  return {
    subject,
    profile,
    roles: [...roles].sort(),
    groups: [...groups].sort(),
    principals: [subject, profile, ...[...groups].map((g) => `group:${g}`), ...[...roles].map((r) => `role:${r}`)],
  };
}

export async function resolveMcpGrantsForAgent(
  profile: string,
  servers: McpServerInfo[],
): Promise<Map<string, McpGrantDecision>> {
  const cfg = await ensureFederationConfig();
  const identity = await resolveAgentPrincipal(profile);
  const out = new Map<string, McpGrantDecision>();
  for (const server of servers) {
    const matched = cfg.grants.filter(
      (grant) =>
        grant.resource === "mcp" &&
        matchesAny(grant.servers, server.name) &&
        grantAppliesToIdentity(grant, identity),
    );
    const deniedAll = matched.some((g) => g.effect === "deny" && matchesAny(g.tools.length ? g.tools : ["*"], "*"));
    const allowedGrants = matched.filter((g) => g.effect !== "deny");
    const tools = new Set<string>();
    for (const grant of allowedGrants) {
      for (const tool of grant.tools.length ? grant.tools : ["*"]) tools.add(tool);
    }
    const allowed = server.enabled && allowedGrants.length > 0 && !deniedAll;
    out.set(server.name, {
      server: server.name,
      allowed,
      requireApproval: allowedGrants.some((g) => g.requireApproval === true),
      tools: [...tools].sort(),
      matchedGrants: matched,
    });
    await writeEvent({
      type: "federation.mcp.grant.resolve",
      actor: profile,
      subject: profile,
      resource: `mcp:${server.name}`,
      outcome: allowed ? "allow" : "deny",
      reason: allowed ? undefined : server.enabled ? "no matching allow grant" : "server disabled",
      payload: {
        server: server.name,
        enabled: server.enabled,
        matchedGrants: matched.map((grant) => grant.id ?? "(anonymous)"),
        tools: [...tools].sort(),
      },
    });
  }
  return out;
}

export async function resolveDelegationTargets(profile: string): Promise<DelegationTarget[]> {
  const cfg = await ensureFederationConfig();
  const profiles = await listProfiles();
  const agents = cfg.principals.agents;
  const packs = await readAgentPacks(profiles);
  const caller = agentPrincipalFor(agents, profile);
  const callerPack = packs.get(profile);

  // Keep local scratch profiles usable until they opt into federation. Once an
  // org graph exists, unknown callers must not inherit anonymous visibility.
  if (!caller && !callerPack && Object.keys(agents).length === 0) {
    return profiles
      .filter((p) => p !== profile)
      .map((p) => ({ profile: p, relation: "unfederated", depth: 1 }));
  }
  if (!caller && !callerPack) {
    return [];
  }

  const callerId = caller?.id ?? callerPack!.id;
  const targets = new Map<string, DelegationTarget>();

  const managerId = callerPack?.identity.manager ?? caller?.manager;
  if (managerId) {
    const managerProfile = profileId(managerId);
    if (managerProfile) {
      const manager = agentPrincipalFor(agents, managerProfile);
      if (manager) {
        const managerPack = packs.get(managerProfile);
        targets.set(managerProfile, {
          profile: managerProfile,
          relation: "manager",
          depth: 1,
          displayName: managerPack?.identity.displayName ?? manager?.displayName,
          title: managerPack?.identity.title ?? manager?.title,
        });
      }
    }
  }

  const directReportIds = new Set<string>([
    ...(callerPack?.identity.directReports ?? []),
    ...Object.values(agents).filter((agent) => profileId(agent.manager) === callerId).map((agent) => agent.id),
  ]);
  for (const reportId of directReportIds) {
    const report = agentPrincipalFor(agents, reportId);
    if (!report && agents[reportId]?.disabled) continue;
    const reportPack = packs.get(reportId);
    targets.set(reportId, {
      profile: reportId,
      relation: "direct_report",
      depth: 1,
      displayName: reportPack?.identity.displayName ?? report?.displayName,
      title: reportPack?.identity.title ?? report?.title,
    });
  }

  // Root agents are allowed to drive the full tree below them. Everyone
  // else sees only their manager and direct reports.
  if (!managerId) {
    const descendants = mergeDescendants(descendantsOf(agents, callerId), descendantsOfPacks(packs, callerId));
    for (const target of descendants) {
      if (target.depth <= 1) continue;
      const targetPack = packs.get(target.id);
      const targetAgent = agentPrincipalFor(agents, target.id);
      targets.set(target.id, {
        profile: target.id,
        relation: "descendant",
        depth: target.depth,
        displayName: targetPack?.identity.displayName ?? targetAgent?.displayName,
        title: targetPack?.identity.title ?? targetAgent?.title,
      });
    }
  }

  return [...targets.values()].sort((a, b) => {
    const relationRank = relationOrder(a.relation) - relationOrder(b.relation);
    if (relationRank !== 0) return relationRank;
    return a.profile.localeCompare(b.profile);
  });
}

export async function canDelegateTo(callerProfile: string, targetProfile: string): Promise<DelegationDecision> {
  const caller = callerProfile.replace(/^@+/, "").trim();
  const target = targetProfile.replace(/^@+/, "").trim();
  const allowedTargets = await resolveDelegationTargets(caller);
  if (!target) {
    return { allowed: false, reason: "target profile is required", allowedTargets };
  }
  if (caller === target) {
    return { allowed: false, reason: "cannot delegate to yourself", allowedTargets };
  }
  const match = allowedTargets.find((entry) => entry.profile === target);
  if (!match) {
    const visible = allowedTargets.map((entry) => `@${entry.profile}`).join(", ") || "(none)";
    return {
      allowed: false,
      reason: `@${caller} can only delegate to its manager, direct reports, or descendants if it is the org root. Visible targets: ${visible}`,
      allowedTargets,
    };
  }
  return {
    allowed: true,
    reason: `allowed via ${match.relation}`,
    relation: match.relation,
    depth: match.depth,
    allowedTargets,
  };
}

export async function mintFederatedAgentToken(
  profile: string,
  opts: { ttlSeconds?: number; audience?: string[] } = {},
): Promise<string> {
  const cfg = await ensureFederationConfig();
  const keys = await ensureFederationKeys();
  const identity = await resolveAgentPrincipal(profile);
  const pack = await readOptionalAgentPack(profile);
  const now = Math.floor(Date.now() / 1000);
  const claims: FederatedClaims = {
    iss: pack?.oidc.issuer ?? cfg.issuer,
    sub: identity.subject,
    aud: opts.audience ?? pack?.oidc.audiences ?? cfg.audiences,
    iat: now,
    exp: now + (opts.ttlSeconds ?? 15 * 60),
    jti: randomUUID(),
    us_profile: profile,
    us_roles: identity.roles,
    us_groups: identity.groups,
    us_principals: identity.principals,
  };
  const token = signJwt(keys, claims);
  await writeEvent({
    type: "federation.token.mint",
    actor: profile,
    subject: profile,
    outcome: "success",
    payload: {
      audience: claims.aud,
      issuer: claims.iss,
      subject: claims.sub,
      ttlSeconds: opts.ttlSeconds ?? 15 * 60,
    },
  });
  return token;
}

export async function verifyFederatedAgentToken(
  token: string,
  opts: { now?: number; audience?: string } = {},
): Promise<FederatedClaims> {
  const cfg = await ensureFederationConfig();
  const keys = await ensureFederationKeys();
  const { header, claims, signingInput, signature } = parseJwt(token);
  if (header.kid && header.kid !== keys.kid) {
    await writeEvent({
      type: "federation.token.reject",
      outcome: "deny",
      reason: `unknown federation key id "${String(header.kid)}"`,
      payload: { kid: header.kid },
    });
    throw new Error(`unknown federation key id "${String(header.kid)}"`);
  }
  try {
    verifyJwtSignature(header, signingInput, signature, keys.publicJwk);
  } catch (error) {
    await writeEvent({
      type: "federation.token.reject",
      outcome: "deny",
      reason: (error as Error).message,
      payload: { kid: header.kid },
    });
    throw error;
  }
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const profile = readString(claims.us_profile);
  const pack = profile ? await readOptionalAgentPack(profile) : undefined;
  try {
    validateFederatedClaims(cfg, claims, now, {
      audience: opts.audience,
      issuer: pack?.oidc.issuer,
      subject: pack?.oidc.subject,
      audiences: pack?.oidc.audiences,
    });
  } catch (error) {
    await writeEvent({
      type: "federation.token.reject",
      actor: profile,
      subject: profile,
      outcome: "deny",
      reason: (error as Error).message,
      payload: {
        audience: claims.aud,
        expectedAudience: opts.audience,
        issuer: claims.iss,
        subject: claims.sub,
      },
    });
    throw error;
  }
  const verified = claims as unknown as FederatedClaims;
  await writeEvent({
    type: "federation.token.verify",
    actor: verified.us_profile,
    subject: verified.us_profile,
    outcome: "success",
    payload: {
      audience: verified.aud,
      issuer: verified.iss,
      subject: verified.sub,
    },
  });
  return verified;
}

export async function readFederationJwks(): Promise<{ keys: Jwk[] }> {
  const keys = await ensureFederationKeys();
  return { keys: [{ ...keys.publicJwk, kid: keys.kid, alg: keys.alg, use: "sig" }] };
}

export async function verifyExternalOidcToken(
  providerId: string,
  token: string,
  opts: { jwks?: { keys: Jwk[] }; now?: number } = {},
): Promise<ExternalFederatedIdentity> {
  const cfg = await ensureFederationConfig();
  const provider = cfg.oidcProviders[providerId];
  if (!provider) throw new Error(`unknown OIDC provider "${providerId}"`);
  const { header, claims, signingInput, signature } = parseJwt(token);
  const jwks = opts.jwks ?? await fetchJwks(provider);
  const jwk = jwks.keys.find((key) => !header.kid || key.kid === header.kid);
  if (!jwk) throw new Error(`no matching JWK for kid "${String(header.kid ?? "")}"`);
  verifyJwtSignature(header, signingInput, signature, jwk);
  validateExternalClaims(provider, claims, opts.now ?? Math.floor(Date.now() / 1000));
  return mapExternalClaims(providerId, provider, claims);
}

export function buildDemoFederationConfig(): { config: FederationConfig; org: FederationOrgNode[] } {
  const org = demoOrg();
  const departments = ["operations", "engineering", "go-to-market", "finance"] as const;
  const groups: FederationConfig["principals"]["groups"] = {
    "all-agents": {
      id: "all-agents",
      kind: "group",
      displayName: "All agents",
      roles: ["agent"],
      members: org.map((node) => node.id),
    },
    executives: {
      id: "executives",
      kind: "group",
      displayName: "Executives",
      roles: ["executive"],
      members: org.filter((node) => node.roles.includes("executive")).map((node) => node.id),
    },
  };
  for (const dept of departments) {
    groups[dept] = {
      id: dept,
      kind: "group",
      displayName: titleWords(dept),
      roles: [dept],
      members: org.filter((node) => node.groups.includes(dept)).map((node) => node.id),
    };
  }

  const agents: Record<string, FederationPrincipal> = {};
  const humans: Record<string, FederationPrincipal> = {};
  for (const node of org) {
    agents[node.id] = {
      id: node.id,
      kind: "agent",
      displayName: `${node.displayName} Agent`,
      title: node.title,
      manager: node.manager,
      roles: node.roles,
      groups: node.groups,
      external: { okta: `00u-${node.id}` },
    };
    humans[node.id] = {
      id: node.id,
      kind: "human",
      displayName: node.displayName,
      email: `${node.id}@example.com`,
      title: node.title,
      manager: node.manager,
      roles: node.roles,
      groups: node.groups,
      external: { okta: `00u-${node.id}` },
    };
  }

  return {
    org,
    config: {
      version: 1,
      issuer: "urn:union-street:demo-enterprise",
      audiences: ["urn:union-street:agents", "union-street-demo"],
      oidcProviders: {
        okta: {
          issuer: "https://example.okta.com/oauth2/default",
          audience: "union-street-demo",
          jwksUri: "https://example.okta.com/oauth2/default/v1/keys",
          groupsClaim: "groups",
          rolesClaim: "roles",
          emailClaim: "email",
          nameClaim: "name",
          subjectClaim: "sub",
          mappings: {
            groups: {
              "US Executives": "executives",
              "US Operations": "operations",
              "US Engineering": "engineering",
              "US GTM": "go-to-market",
              "US Finance": "finance",
            },
            roles: {
              COO: "executive",
              VP: "vp",
              Director: "director",
              Manager: "manager",
            },
          },
        },
      },
      principals: {
        humans,
        agents,
        groups,
        roles: {
          agent: { id: "agent", kind: "role", displayName: "Agent" },
          executive: { id: "executive", kind: "role", displayName: "Executive" },
          vp: { id: "vp", kind: "role", displayName: "VP" },
          director: { id: "director", kind: "role", displayName: "Director" },
          manager: { id: "manager", kind: "role", displayName: "Manager" },
          reviewer: { id: "reviewer", kind: "role", displayName: "Reviewer" },
          operator: { id: "operator", kind: "role", displayName: "Operator" },
        },
        services: {},
      },
      grants: [
        {
          id: "exec-all-mcp",
          resource: "mcp",
          servers: ["github", "linear", "slack"],
          tools: ["*"],
          roles: ["executive"],
          requireApproval: true,
        },
        {
          id: "engineering-github",
          resource: "mcp",
          servers: ["github"],
          tools: ["repos.*", "pull_requests.*", "issues.*"],
          groups: ["engineering"],
        },
        {
          id: "ops-linear-slack",
          resource: "mcp",
          servers: ["linear", "slack"],
          tools: ["tickets.*", "messages.*", "channels.read"],
          groups: ["operations"],
        },
        {
          id: "gtm-crm",
          resource: "mcp",
          servers: ["hubspot", "slack"],
          tools: ["contacts.read", "deals.read", "messages.*"],
          groups: ["go-to-market"],
        },
        {
          id: "finance-read",
          resource: "mcp",
          servers: ["stripe", "quickbooks"],
          tools: ["*.read", "reports.*"],
          groups: ["finance"],
          requireApproval: true,
        },
        {
          id: "managers-no-stripe-write",
          resource: "mcp",
          effect: "deny",
          servers: ["stripe"],
          tools: ["*.write", "payouts.*"],
          roles: ["manager"],
        },
      ],
    },
  };
}

function defaultFederationConfig(): FederationConfig {
  return {
    version: 1,
    issuer: "urn:union-street:local",
    audiences: [DEFAULT_AUDIENCE],
    principals: {
      humans: {},
      agents: {},
      groups: {
        "all-agents": {
          id: "all-agents",
          kind: "group",
          displayName: "All agents",
          roles: ["agent"],
          members: [],
        },
      },
      roles: {
        agent: { id: "agent", kind: "role", displayName: "Agent" },
        reviewer: { id: "reviewer", kind: "role", displayName: "Reviewer" },
        operator: { id: "operator", kind: "role", displayName: "Operator" },
      },
      services: {},
    },
    grants: [],
    oidcProviders: {},
  };
}

function normalizeFederationConfig(value: unknown): FederationConfig {
  const base = defaultFederationConfig();
  const raw = isRecord(value) ? value : {};
  const principals = isRecord(raw.principals) ? raw.principals : {};
  return {
    version: 1,
    issuer: readString(raw.issuer) ?? base.issuer,
    audiences: readStringArray(raw.audiences, base.audiences),
    principals: {
      humans: normalizePrincipalMap(principals.humans, "human"),
      agents: normalizePrincipalMap(principals.agents, "agent"),
      groups: { ...base.principals.groups, ...normalizeGroupMap(principals.groups) },
      roles: { ...base.principals.roles, ...normalizePrincipalMap(principals.roles, "role") },
      services: normalizePrincipalMap(principals.services, "service"),
    },
    grants: Array.isArray(raw.grants) ? raw.grants.map(normalizeGrant).filter(Boolean) as FederationGrant[] : [],
    oidcProviders: normalizeOidcProviders(raw.oidcProviders),
  };
}

function normalizePrincipalMap(value: unknown, kind: FederationPrincipalKind): Record<string, FederationPrincipal> {
  if (!isRecord(value)) return {};
  const out: Record<string, FederationPrincipal> = {};
  for (const [id, raw] of Object.entries(value)) {
    const item = isRecord(raw) ? raw : {};
    out[id] = {
      id: readString(item.id) ?? id,
      kind,
      ...(readString(item.displayName) ? { displayName: readString(item.displayName) } : {}),
      ...(readString(item.email) ? { email: readString(item.email) } : {}),
      ...(readString(item.title) ? { title: readString(item.title) } : {}),
      ...(readString(item.manager) ? { manager: readString(item.manager) } : {}),
      roles: readStringArray(item.roles),
      groups: readStringArray(item.groups),
      ...(isRecord(item.external) ? { external: Object.fromEntries(Object.entries(item.external).map(([k, v]) => [k, String(v)])) } : {}),
      disabled: item.disabled === true,
    };
  }
  return out;
}

function normalizeGroupMap(value: unknown): FederationConfig["principals"]["groups"] {
  const base = normalizePrincipalMap(value, "group") as FederationConfig["principals"]["groups"];
  for (const [id, group] of Object.entries(base)) {
    const raw = isRecord(value) ? value[id] : undefined;
    group.members = isRecord(raw) ? readStringArray(raw.members) : [];
  }
  return base;
}

function normalizeGrant(value: unknown): FederationGrant | undefined {
  if (!isRecord(value)) return undefined;
  return {
    ...(readString(value.id) ? { id: readString(value.id) } : {}),
    resource: "mcp",
    servers: readStringArray(value.servers, ["*"]),
    tools: readStringArray(value.tools, ["*"]),
    effect: value.effect === "deny" ? "deny" : "allow",
    principals: readStringArray(value.principals),
    agents: readStringArray(value.agents),
    groups: readStringArray(value.groups),
    roles: readStringArray(value.roles),
    requireApproval: value.requireApproval === true,
  };
}

function normalizeOidcProviders(value: unknown): FederationConfig["oidcProviders"] {
  if (!isRecord(value)) return {};
  const out: FederationConfig["oidcProviders"] = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const issuer = readString(raw.issuer);
    if (!issuer) continue;
    out[id] = {
      issuer,
      ...(readString(raw.audience) ? { audience: readString(raw.audience) } : {}),
      ...(readString(raw.jwksUri) ? { jwksUri: readString(raw.jwksUri) } : {}),
      ...(readString(raw.groupsClaim) ? { groupsClaim: readString(raw.groupsClaim) } : {}),
      ...(readString(raw.rolesClaim) ? { rolesClaim: readString(raw.rolesClaim) } : {}),
      ...(readString(raw.emailClaim) ? { emailClaim: readString(raw.emailClaim) } : {}),
      ...(readString(raw.nameClaim) ? { nameClaim: readString(raw.nameClaim) } : {}),
      ...(readString(raw.subjectClaim) ? { subjectClaim: readString(raw.subjectClaim) } : {}),
      ...(isRecord(raw.mappings) ? { mappings: normalizeOidcMappings(raw.mappings) } : {}),
    };
  }
  return out;
}

function normalizeOidcMappings(value: Record<string, unknown>): FederationOidcProvider["mappings"] {
  return {
    groups: normalizeStringMap(value.groups),
    roles: normalizeStringMap(value.roles),
  };
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)]));
}

function grantAppliesToIdentity(grant: FederationGrant, identity: FederatedAgentIdentity): boolean {
  const checks: boolean[] = [];
  if (grant.principals?.length) {
    checks.push(
      matchesAny(grant.principals, identity.subject) ||
        matchesAny(grant.principals, identity.profile) ||
        identity.principals.some((principal) => matchesAny(grant.principals!, principal)),
    );
  }
  if (grant.agents?.length) {
    checks.push(matchesAny(grant.agents, identity.profile) || matchesAny(grant.agents, identity.subject));
  }
  if (grant.groups?.length) {
    checks.push(identity.groups.some((group) => matchesAny(grant.groups!, group)));
  }
  if (grant.roles?.length) {
    checks.push(identity.roles.some((role) => matchesAny(grant.roles!, role)));
  }
  return checks.length === 0 || checks.every(Boolean);
}

function matchesAny(patterns: string[], value: string): boolean {
  return patterns.some((pattern) => globMatch(pattern, value));
}

function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}

async function ensureFederationKeys(): Promise<FederationKeys> {
  try {
    const raw = JSON.parse(await fs.readFile(FEDERATION_KEYS_PATH, "utf8")) as FederationKeys;
    if (raw.kid && raw.publicJwk && raw.privateJwk) return raw;
  } catch {
    // create below
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keys: FederationKeys = {
    kid: randomUUID(),
    alg: "EdDSA",
    publicJwk: publicKey.export({ format: "jwk" }) as Jwk,
    privateJwk: privateKey.export({ format: "jwk" }) as Jwk,
  };
  await fs.mkdir(dirname(FEDERATION_KEYS_PATH), { recursive: true });
  await fs.writeFile(FEDERATION_KEYS_PATH, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

function signJwt(keys: FederationKeys, claims: FederatedClaims): string {
  const header = { alg: keys.alg, typ: "JWT", kid: keys.kid };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(claims)}`;
  const privateKey = requirePrivateKey(keys.privateJwk);
  const signature = cryptoSign(null, Buffer.from(signingInput), privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

function requirePrivateKey(jwk: Jwk): KeyObject {
  return createPrivateKey({ key: jwk, format: "jwk" });
}

async function fetchJwks(provider: FederationOidcProvider): Promise<{ keys: Jwk[] }> {
  if (!provider.jwksUri) throw new Error("OIDC provider has no jwksUri");
  const response = await fetch(provider.jwksUri);
  if (!response.ok) throw new Error(`JWKS fetch failed: HTTP ${response.status}`);
  const body = await response.json() as unknown;
  if (!isRecord(body) || !Array.isArray(body.keys)) throw new Error("JWKS response did not contain keys[]");
  return { keys: body.keys.filter(isRecord) };
}

function parseJwt(token: string): { header: Record<string, unknown>; claims: Record<string, unknown>; signingInput: string; signature: Buffer } {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error("invalid JWT");
  const header = JSON.parse(base64urlDecode(parts[0]).toString("utf8")) as Record<string, unknown>;
  const claims = JSON.parse(base64urlDecode(parts[1]).toString("utf8")) as Record<string, unknown>;
  return {
    header,
    claims,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: base64urlDecode(parts[2]),
  };
}

function verifyJwtSignature(header: Record<string, unknown>, signingInput: string, signature: Buffer, jwk: Jwk): void {
  const alg = readString(header.alg);
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const verifierAlg =
    alg === "RS256" ? "RSA-SHA256" :
    alg === "ES256" ? "sha256" :
    alg === "EdDSA" ? null :
    undefined;
  if (verifierAlg === undefined) throw new Error(`unsupported JWT alg "${alg ?? "unknown"}"`);
  const ok = cryptoVerify(verifierAlg, Buffer.from(signingInput), key, signature);
  if (!ok) throw new Error("JWT signature verification failed");
}

function validateExternalClaims(provider: FederationOidcProvider, claims: Record<string, unknown>, now: number): void {
  const issuer = readString(claims.iss);
  if (issuer !== provider.issuer) throw new Error(`issuer mismatch: expected ${provider.issuer}, got ${issuer ?? "<missing>"}`);
  const exp = Number(claims.exp ?? 0);
  if (!exp || exp <= now) throw new Error("token is expired");
  const nbf = Number(claims.nbf ?? 0);
  if (nbf && nbf > now) throw new Error("token is not valid yet");
  if (provider.audience && !claimHasAudience(claims.aud, provider.audience)) {
    throw new Error(`audience mismatch: expected ${provider.audience}`);
  }
}

function validateFederatedClaims(
  cfg: FederationConfig,
  claims: Record<string, unknown>,
  now: number,
  context: {
    audience?: string;
    issuer?: string;
    subject?: string;
    audiences?: string[];
  } = {},
): void {
  const subject = readString(claims.sub);
  const profile = readString(claims.us_profile);
  const issuer = readString(claims.iss);
  const acceptedIssuer = context.issuer ?? cfg.issuer;
  if (issuer !== acceptedIssuer) {
    throw new Error(`issuer mismatch: expected ${acceptedIssuer}, got ${issuer ?? "<missing>"}`);
  }
  const acceptedSubject = context.subject ?? (profile ? `agent:${profile}` : undefined);
  if (!subject || !profile || !acceptedSubject || subject !== acceptedSubject) {
    throw new Error("token subject/profile mismatch");
  }
  const exp = Number(claims.exp ?? 0);
  if (!exp || exp <= now) throw new Error("token is expired");
  const nbf = Number(claims.nbf ?? 0);
  if (nbf && nbf > now) throw new Error("token is not valid yet");
  const acceptedAudiences = context.audience ? [context.audience] : context.audiences ?? cfg.audiences;
  if (!acceptedAudiences.some((aud) => claimHasAudience(claims.aud, aud))) {
    throw new Error(`audience mismatch: expected one of ${acceptedAudiences.join(", ")}`);
  }
  const agents = cfg.principals.agents;
  if (Object.keys(agents).length && !agentPrincipalFor(agents, profile)) {
    throw new Error(`token profile "${profile}" is not a federated agent`);
  }
}

function mapExternalClaims(
  providerId: string,
  provider: FederationOidcProvider,
  claims: Record<string, unknown>,
): ExternalFederatedIdentity {
  const subject = readString(claims[provider.subjectClaim ?? "sub"]);
  if (!subject) throw new Error("OIDC token is missing subject");
  const rawGroups = readClaimStringArray(claims[provider.groupsClaim ?? "groups"]);
  const rawRoles = readClaimStringArray(claims[provider.rolesClaim ?? "roles"]);
  const groups = rawGroups.map((g) => provider.mappings?.groups?.[g] ?? g).sort();
  const roles = rawRoles.map((r) => provider.mappings?.roles?.[r] ?? r).sort();
  return {
    provider: providerId,
    subject,
    ...(readString(claims[provider.emailClaim ?? "email"]) ? { email: readString(claims[provider.emailClaim ?? "email"]) } : {}),
    ...(readString(claims[provider.nameClaim ?? "name"]) ? { displayName: readString(claims[provider.nameClaim ?? "name"]) } : {}),
    groups,
    roles,
    principals: [`external:${providerId}:${subject}`, ...groups.map((g) => `group:${g}`), ...roles.map((r) => `role:${r}`)],
    claims,
  };
}

function claimHasAudience(value: unknown, audience: string): boolean {
  return typeof value === "string" ? value === audience : Array.isArray(value) && value.includes(audience);
}

function readClaimStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function base64urlDecode(value: string): Buffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function base64urlJson(value: unknown): string {
  return base64url(Buffer.from(JSON.stringify(value)));
}

function base64url(value: Buffer): string {
  return value.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function demoOrg(): FederationOrgNode[] {
  const nodes: FederationOrgNode[] = [
    node("coo", "Morgan Lee", "COO", undefined, ["executive"], ["executives"]),
    node("vp-ops", "Avery Patel", "VP Operations", "coo", ["vp"], ["operations"]),
    node("vp-eng", "Jordan Kim", "VP Engineering", "coo", ["vp"], ["engineering"]),
    node("vp-gtm", "Riley Chen", "VP Go-to-Market", "coo", ["vp"], ["go-to-market"]),
    node("vp-finance", "Casey Rivera", "VP Finance", "coo", ["vp"], ["finance"]),
    node("dir-ops-platform", "Sam Taylor", "Director Ops Platform", "vp-ops", ["director"], ["operations"]),
    node("dir-ops-support", "Jamie Brooks", "Director Support", "vp-ops", ["director"], ["operations"]),
    node("dir-eng-product", "Quinn Murphy", "Director Product Engineering", "vp-eng", ["director", "reviewer"], ["engineering"]),
    node("dir-eng-infra", "Skyler Singh", "Director Infrastructure", "vp-eng", ["director", "operator"], ["engineering"]),
    node("dir-gtm-sales", "Drew Morgan", "Director Sales", "vp-gtm", ["director"], ["go-to-market"]),
    node("dir-gtm-marketing", "Parker Nguyen", "Director Marketing", "vp-gtm", ["director"], ["go-to-market"]),
    node("dir-finance-fpna", "Emerson Davis", "Director FP&A", "vp-finance", ["director"], ["finance"]),
    node("dir-finance-revops", "Hayden Wilson", "Director Revenue Ops", "vp-finance", ["director"], ["finance"]),
    node("mgr-ops-sre", "Rowan Garcia", "Manager Ops SRE", "dir-ops-platform", ["manager", "operator"], ["operations"]),
    node("mgr-ops-qa", "Finley Martinez", "Manager QA", "dir-ops-support", ["manager"], ["operations"]),
    node("mgr-eng-apps", "Tatum Johnson", "Manager App Engineering", "dir-eng-product", ["manager", "reviewer"], ["engineering"]),
    node("mgr-eng-platform", "Reese Anderson", "Manager Platform", "dir-eng-infra", ["manager", "operator"], ["engineering"]),
    node("mgr-gtm-enterprise", "Blake Thompson", "Manager Enterprise Sales", "dir-gtm-sales", ["manager"], ["go-to-market"]),
    node("mgr-gtm-content", "Alexis White", "Manager Content", "dir-gtm-marketing", ["manager"], ["go-to-market"]),
    node("mgr-finance-billing", "Kai Thomas", "Manager Billing", "dir-finance-revops", ["manager"], ["finance"]),
  ];
  return nodes;
}

function node(
  id: string,
  displayName: string,
  title: string,
  manager: string | undefined,
  roles: string[],
  groups: string[],
): FederationOrgNode {
  return { id, displayName, title, ...(manager ? { manager } : {}), roles, groups };
}

function titleWords(value: string): string {
  return value.split(/[-_\s]+/).filter(Boolean).map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
}

function profileId(value: string | undefined): string | undefined {
  return value?.replace(/^agent:/, "").trim() || undefined;
}

function agentPrincipalFor(
  agents: FederationConfig["principals"]["agents"],
  profile: string | undefined,
): FederationPrincipal | undefined {
  const id = profileId(profile);
  if (!id) return undefined;
  const agent = agents[id] ?? agents[`agent:${id}`];
  return agent?.disabled ? undefined : agent;
}

function descendantsOf(
  agents: FederationConfig["principals"]["agents"],
  rootProfile: string,
): Array<{ agent: FederationPrincipal; depth: number }> {
  const out: Array<{ agent: FederationPrincipal; depth: number }> = [];
  const queue: Array<{ id: string; depth: number }> = [{ id: rootProfile, depth: 0 }];
  const seen = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    for (const agent of Object.values(agents)) {
      if (agent.disabled) continue;
      if (profileId(agent.manager) !== current.id) continue;
      out.push({ agent, depth: current.depth + 1 });
      queue.push({ id: agent.id, depth: current.depth + 1 });
    }
  }
  return out;
}

async function readOptionalAgentPack(profile: string): Promise<AgentPack | undefined> {
  try {
    return await readAgentPack(profile);
  } catch {
    return undefined;
  }
}

async function readAgentPacks(profiles: string[]): Promise<Map<string, AgentPack>> {
  const out = new Map<string, AgentPack>();
  await Promise.all(profiles.map(async (profile) => {
    const pack = await readOptionalAgentPack(profile);
    if (pack) out.set(profile, pack);
  }));
  return out;
}

function descendantsOfPacks(
  packs: Map<string, AgentPack>,
  rootProfile: string,
): Array<{ id: string; depth: number }> {
  const out: Array<{ id: string; depth: number }> = [];
  const queue: Array<{ id: string; depth: number }> = [{ id: rootProfile, depth: 0 }];
  const seen = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    for (const pack of packs.values()) {
      if (pack.identity.manager !== current.id) continue;
      out.push({ id: pack.id, depth: current.depth + 1 });
      queue.push({ id: pack.id, depth: current.depth + 1 });
    }
  }
  return out;
}

function mergeDescendants(
  federationDescendants: Array<{ agent: FederationPrincipal; depth: number }>,
  packDescendants: Array<{ id: string; depth: number }>,
): Array<{ id: string; depth: number }> {
  const out = new Map<string, { id: string; depth: number }>();
  for (const item of federationDescendants) {
    out.set(item.agent.id, { id: item.agent.id, depth: item.depth });
  }
  for (const item of packDescendants) {
    const existing = out.get(item.id);
    if (!existing || item.depth < existing.depth) out.set(item.id, item);
  }
  return [...out.values()];
}

function relationOrder(relation: DelegationRelation): number {
  switch (relation) {
    case "manager":
      return 0;
    case "direct_report":
      return 1;
    case "descendant":
      return 2;
    case "unfederated":
      return 3;
  }
}
