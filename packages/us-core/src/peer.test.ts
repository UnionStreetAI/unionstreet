import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const usHome = await mkdtemp(join(tmpdir(), "union-street-peer-test-"));
process.env.US_HOME = usHome;
process.env.US_PEER_CALL_STUB = "1";
process.env.US_MEMORY_SYNC = "0";
process.env.US_USAGE_DISABLE_MODELS_DEV_COSTS = "1";

const core = await import("./index.ts");

beforeAll(async () => {
  const demo = core.buildDemoFederationConfig();
  await Bun.write(core.FEDERATION_PATH, JSON.stringify(demo.config, null, 2));
  const packs = new Map(core.buildDemoAgentPacks(demo.org).map((pack) => [pack.id, pack]));
  for (const node of demo.org) {
    await core.initProfile(node.id, { role: node.roles[0] ?? "agent", capabilities: node.roles });
    const pack = packs.get(node.id);
    if (pack) await core.writeAgentPack(node.id, pack);
  }
});

afterAll(async () => {
  await rm(usHome, { recursive: true, force: true });
});

describe("peer calls", () => {
  test("peerCall_WhenCallerDelegatesToVisibleDirectReport_WakesPeerAndPersistsUsageSessionAndMemoryEvents", async () => {
    const trace = core.createLashTrace();

    const result = await core.peerCall({
      callingPeer: "coo",
      targetPeer: "vp-eng",
      message: "Inspect engineering readiness.",
      trace,
      wakeKind: "delegate",
    });

    expect(result.ok, "A root COO delegation to VP Engineering should be allowed by federation visibility.").toBe(true);
    expect(result.response, "Stubbed peer responses should include target/caller context so tests prove the target was woken.").toContain("@vp-eng woke via delegate from @coo");
    expect(result.trace, "Peer calls must preserve the supplied Lash trace for upward/downward audit correlation.").toBe(trace);
    expect(result.thread?.id, "Peer calls must create a Lash thread scoped to the target when one is not supplied.").toBe(`vp-eng/${trace}`);
    expect(result.usage, "Peer wakeups must return model usage for accounting.").toEqual({ input: 1, output: 1, reasoning: 0, cache_read: 0, cache_write: 0, total: 2 });

    const usage = await core.queryUsageRecords({ actor: "vp-eng", trace });
    expect(usage, "Peer calls must write append-only usage rows with kind=lash for cost/audit views.").toHaveLength(1);
    expect(usage[0]?.kind, "Peer wakeup usage rows must be distinguishable from direct prompt/chat usage.").toBe("lash");

    const memoryEvents = await core.queryMemoryEvents({ peer: "vp-eng", trace });
    const memoryPayloads = memoryEvents.map((event) => JSON.stringify(event.payload));
    expect(
      memoryEvents.map((event) => event.kind),
      "Every peer wake should mirror the Lash wake plus incoming/outgoing session messages into memory events.",
    ).toEqual(expect.arrayContaining(["lash.wake", "session.message"]));
    expect(
      memoryPayloads.some((payload) => payload.includes("Inspect engineering readiness.")),
      "Target peer wake sessions must persist the incoming user message into memory/session events for future context.",
    ).toBe(true);
    expect(
      `${usage[0]?.provider}/${usage[0]?.model}`,
      "Target peer wake usage must persist provider/model metadata from the target agent pack.",
    ).toBe("codex/gpt-5.4");
  });

  test("peerCall_WhenCallerTargetsItself_ReturnsActionableDenial", async () => {
    const result = await core.peerCall({
      callingPeer: "coo",
      targetPeer: "coo",
      message: "self delegate",
    });

    expect(result, "Self-delegation should fail before any model or session work because it creates an invalid command loop.").toEqual({
      ok: false,
      error: "cannot delegate to yourself",
    });
  });

  test("peerCall_WhenCallerCannotSeeTarget_DeniesBeforeWakeSession", async () => {
    const result = await core.peerCall({
      callingPeer: "vp-eng",
      targetPeer: "vp-ops",
      message: "lateral request",
    });

    expect(result.ok, "A VP should not be able to delegate laterally to another VP through peerCall.").toBe(false);
    expect(result.error, "Denied peer calls should explain the federation reason instead of returning a generic model error.").toContain("can only delegate");
  });
});
