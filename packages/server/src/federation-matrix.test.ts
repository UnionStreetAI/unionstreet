import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { DelegationRelation } from "./federation.ts";

const usHome = await mkdtemp(join(tmpdir(), "union-street-federation-matrix-"));
process.env.US_HOME = usHome;
process.env.US_MEMORY_SYNC = "0";

const core = await import("./index.ts");
const demo = core.buildDemoFederationConfig();
const packs = core.buildDemoAgentPacks(demo.org);
const nodesById = new Map(demo.org.map((node) => [node.id, node]));
const childrenByManager = new Map<string, string[]>();
for (const node of demo.org) {
  if (!node.manager) continue;
  const children = childrenByManager.get(node.manager) ?? [];
  children.push(node.id);
  childrenByManager.set(node.manager, children);
}

await mkdir(dirname(core.FEDERATION_PATH), { recursive: true });
await writeFile(core.FEDERATION_PATH, JSON.stringify(demo.config, null, 2));
for (const node of demo.org) {
  await core.initProfile(node.id, { role: node.roles[0] ?? "agent", capabilities: node.roles });
  const pack = packs.find((candidate) => candidate.id === node.id);
  if (pack) await core.writeAgentPack(node.id, pack);
}

afterAll(async () => {
  await rm(usHome, { recursive: true, force: true });
});

for (const caller of demo.org) {
  for (const target of demo.org) {
    test(`canDelegateTo_When${titleCaseId(caller.id)}Targets${titleCaseId(target.id)}_EnforcesOrgVisibilityPolicy`, async () => {
      const expected = expectedDelegation(caller.id, target.id);

      const decision = await core.canDelegateTo(caller.id, target.id);

      expect(
        decision.allowed,
        `Delegation ${caller.id} -> ${target.id} must match the org policy contract; expected allowed=${expected.allowed}, got ${JSON.stringify(decision)}.`,
      ).toBe(expected.allowed);
      if (expected.allowed) {
        expect(
          decision.relation,
          `Expected ${caller.id} -> ${target.id} to be allowed as ${expected.relation}; got ${JSON.stringify(decision)}.`,
        ).toBe(expected.relation);
        expect(
          decision.depth,
          `Expected ${caller.id} -> ${target.id} delegation depth ${expected.depth}; depth controls one-level-up and top-down Lash policy.`,
        ).toBe(expected.depth);
      } else {
        expect(
          decision.reason.length,
          `Denied delegation ${caller.id} -> ${target.id} must include an actionable denial reason for audit and UI feedback.`,
        ).toBeGreaterThan(0);
      }
    });
  }
}

for (const node of demo.org) {
  test(`resolveDelegationTargets_WhenCalledBy${titleCaseId(node.id)}_ReturnsOnlyPermittedProfiles`, async () => {
    const expected = demo.org
      .filter((candidate) => expectedDelegation(node.id, candidate.id).allowed)
      .map((candidate) => candidate.id)
      .sort();

    const targets = await core.resolveDelegationTargets(node.id);

    const actual = targets.map((target) => target.profile).sort();
    expect(
      actual,
      `Resolved delegation targets for ${node.id} must exactly match allowed org visibility; expected ${expected.join(", ") || "none"}, got ${actual.join(", ") || "none"}.`,
    ).toEqual(expected);
  });
}

for (const node of demo.org) {
  test(`mintFederatedAgentToken_WhenUsingDefaultAudienceFor${titleCaseId(node.id)}_VerifiesWithAgentClaims`, async () => {
    const expectedSubject = `agent:${node.id}`;

    const token = await core.mintFederatedAgentToken(node.id, { ttlSeconds: 60 });
    const verified = await core.verifyFederatedAgentToken(token, { audience: "union-street-demo" });

    expect(
      verified.us_profile,
      `Default-audience token for ${node.id} must verify back to the same profile; cross-profile identity drift would break audit trails.`,
    ).toBe(node.id);
    expect(
      verified.sub,
      `Default-audience token for ${node.id} must use the stable agent subject claim.`,
    ).toBe(expectedSubject);
    expect(
      verified.us_principals,
      `Default-audience token for ${node.id} must include its own principal so downstream policy can authorize it without profile lookups.`,
    ).toContain(expectedSubject);
  });
}

for (const node of demo.org) {
  test(`mintFederatedAgentToken_WhenMintedForMcpAudienceOf${titleCaseId(node.id)}_RejectsGenericReplay`, async () => {
    const audience = core.federatedAgentMcpAudience(node.id);

    const token = await core.mintFederatedAgentToken(node.id, { audience: [audience], ttlSeconds: 60 });
    const verified = await core.verifyFederatedAgentToken(token, { audience });

    expect(
      verified.us_profile,
      `MCP-scoped token for ${node.id} must verify only for the target MCP audience and keep the issuing agent profile.`,
    ).toBe(node.id);
    await expect(
      core.verifyFederatedAgentToken(token, { audience: "union-street-demo" }),
      `MCP-scoped token for ${node.id} must not be replayable as a generic Union Street org token.`,
    ).rejects.toThrow("audience mismatch");
  });
}

for (const node of demo.org) {
  test(`resolveAgentPrincipal_WhenResolving${titleCaseId(node.id)}_MergesPackAndFederationClaims`, async () => {
    const expectedSubject = `agent:${node.id}`;

    const principal = await core.resolveAgentPrincipal(node.id);

    expect(
      principal.profile,
      `Resolved principal for ${node.id} must keep the requested profile; policy checks depend on profile-stable identity.`,
    ).toBe(node.id);
    expect(
      principal.subject,
      `Resolved principal for ${node.id} must expose the agent subject from the atomic pack.`,
    ).toBe(expectedSubject);
    expect(
      principal.groups,
      `Resolved principal for ${node.id} must include all-agents so shared org policy applies uniformly.`,
    ).toContain("all-agents");
    expect(
      principal.roles,
      `Resolved principal for ${node.id} must include the baseline agent role before role-specific grants are applied.`,
    ).toContain("agent");
    for (const group of node.groups) {
      expect(
        principal.groups,
        `Resolved principal for ${node.id} is missing federation group '${group}', which would silently narrow or widen access.`,
      ).toContain(group);
    }
    for (const role of node.roles) {
      expect(
        principal.roles,
        `Resolved principal for ${node.id} is missing federation role '${role}', which would make role-based grants inaccurate.`,
      ).toContain(role);
    }
  });
}

test("canDelegateTo_WhenCallerProfileDoesNotExist_DeniesWithReason", async () => {
  const unknownCaller = "missing-agent";
  const targetProfile = "coo";

  const decision = await core.canDelegateTo(unknownCaller, targetProfile);

  expect(
    decision.allowed,
    "Unknown callers must be denied rather than treated as anonymous root agents.",
  ).toBe(false);
  expect(
    decision.reason.length,
    "Unknown-caller denial must include a reason so CLI and dashboard surfaces can show actionable policy feedback.",
  ).toBeGreaterThan(0);
});

test("canDelegateTo_WhenTargetProfileDoesNotExist_DeniesWithReason", async () => {
  const callerProfile = "coo";
  const unknownTarget = "missing-agent";

  const decision = await core.canDelegateTo(callerProfile, unknownTarget);

  expect(
    decision.allowed,
    "Unknown delegation targets must be denied so agents cannot delegate to identities outside the federation graph.",
  ).toBe(false);
  expect(
    decision.reason.length,
    "Unknown-target denial must include a reason so operators can distinguish missing identity from policy denial.",
  ).toBeGreaterThan(0);
});

function expectedDelegation(callerId: string, targetId: string): { allowed: false } | { allowed: true; relation: DelegationRelation; depth: number } {
  if (callerId === targetId) return { allowed: false };
  const caller = nodesById.get(callerId);
  const target = nodesById.get(targetId);
  if (!caller || !target) return { allowed: false };
  if (target.manager === callerId) return { allowed: true, relation: "direct_report", depth: 1 };
  if (caller.manager === targetId) return { allowed: true, relation: "manager", depth: 1 };
  if (!caller.manager) {
    const depth = descendantDepth(callerId, targetId);
    if (depth) return { allowed: true, relation: "descendant", depth };
  }
  return { allowed: false };
}

function descendantDepth(rootId: string, targetId: string): number | undefined {
  const queue: Array<{ id: string; depth: number }> = (childrenByManager.get(rootId) ?? []).map((id) => ({ id, depth: 1 }));
  while (queue.length) {
    const next = queue.shift()!;
    if (next.id === targetId) return next.depth;
    for (const child of childrenByManager.get(next.id) ?? []) {
      queue.push({ id: child, depth: next.depth + 1 });
    }
  }
  return undefined;
}

function titleCaseId(id: string): string {
  return id.split("-").map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join("");
}
