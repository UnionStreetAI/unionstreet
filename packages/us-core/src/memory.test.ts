import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileMemoryStore } from "./memory.ts";

const usHome = await mkdtemp(join(tmpdir(), "union-street-memory-test-"));
process.env.US_HOME = usHome;
process.env.US_MEMORY_SYNC = "0";

const core = await import("./index.ts");

afterAll(async () => {
  await rm(usHome, { recursive: true, force: true });
});

describe("memory store", () => {
  test("FileMemoryStore_WhenAnchorsAreWritten_ReturnsNewestFirstAndMirrorsMemoryEvent", async () => {
    await core.initProfile("memory-agent", { role: "agent" });
    const store = new FileMemoryStore();

    await store.writeAnchor(anchor("older", 10));
    await store.writeAnchor(anchor("newer", 20));
    const recent = await store.recentAnchors("memory-agent", 10);
    const latest = await store.latestAnchor("memory-agent");
    const events = await core.queryMemoryEvents({ peer: "memory-agent", kind: "memory.anchor" });

    expect(recent.map((record) => record.id), "Recent anchors should be returned newest-first for context rebuilds.").toEqual(["newer", "older"]);
    expect(latest?.id, "Latest anchor should be the newest anchor by timestamp.").toBe("newer");
    expect(events.map((event) => event.payload && typeof event.payload === "object" ? (event.payload as any).id : undefined), "Anchor writes should also create memory events for the control plane.").toEqual(["newer", "older"]);
  });

  test("writeMemoryEvent_WhenSyncDisabled_WritesLocalEventAndAuditWithoutOutbox", async () => {
    await core.initProfile("memory-local", { role: "agent" });

    await core.writeMemoryEvent({
      kind: "session.message",
      peer: "memory-local",
      sessionId: "session-1",
      trace: "trace-memory-local",
      role: "user",
      payload: { content: "hello" },
    });
    const events = await core.queryMemoryEvents({ peer: "memory-local", trace: "trace-memory-local" });
    const audit = await core.queryEvents({ type: "memory.write", actor: "memory-local", trace: "trace-memory-local" });
    const outboxPath = join(core.profilePaths("memory-local").memoryDir, "sync-outbox.jsonl");

    expect(events, "Local memory events should be queryable by peer and trace.").toHaveLength(1);
    expect(events[0]?.role, "Session memory events should preserve role metadata for transcript reconstruction.").toBe("user");
    expect(audit[0]?.payload, "Every memory write should produce a redacted audit event for dashboards and logs.").toMatchObject({ kind: "session.message", role: "user" });
    await expect(readFile(outboxPath, "utf8"), "Disabled memory sync should not create a remote-sync outbox.").rejects.toThrow();
  });

  test("resolveMemorySyncConfig_WhenEnvOverridesAreProvided_UsesEnvUrlAndWorkspace", async () => {
    const originalSync = process.env.US_MEMORY_SYNC;
    const originalUrl = process.env.US_MEMORY_SYNC_URL;
    process.env.US_MEMORY_SYNC = "1";
    process.env.US_MEMORY_SYNC_URL = "https://memory.example.test/events";
    await core.initProfile("memory-sync", { role: "agent" });

    const cfg = await core.resolveMemorySyncConfig("memory-sync");

    process.env.US_MEMORY_SYNC = originalSync;
    process.env.US_MEMORY_SYNC_URL = originalUrl;
    expect(cfg.enabled, "US_MEMORY_SYNC=1 should enable remote memory sync even without global config.").toBe(true);
    expect(cfg.url, "US_MEMORY_SYNC_URL should win over config-derived endpoints.").toBe("https://memory.example.test/events");
    expect(cfg.workspaceId, "Default workspace should be local unless runtime or config supplies a Honcho workspace.").toBe("local");
  });
});

function anchor(id: string, ts: number) {
  return {
    id,
    peer: "memory-agent",
    sessionId: "session-1",
    trace: "trace-memory",
    model: "gpt-test",
    summary: `summary ${id}`,
    isUpdate: false,
    tokensBefore: 100,
    tokensAfter: 20,
    droppedCount: 3,
    ts,
  };
}
