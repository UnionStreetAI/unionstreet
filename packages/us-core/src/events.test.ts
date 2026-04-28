import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const usHome = await mkdtemp(join(tmpdir(), "union-street-events-test-"));
process.env.US_HOME = usHome;

const core = await import("./index.ts");

afterAll(async () => {
  await rm(usHome, { recursive: true, force: true });
});

describe("control plane events", () => {
  test("writeEvent_WhenPayloadContainsSecrets_RedactsRecursivelyAndNormalizesPrincipals", async () => {
    const event = await core.writeEvent({
      type: "audit.test",
      actor: "@coo",
      subject: "agent:vp-eng",
      target: " @mgr-eng-platform ",
      trace: "trace-events-redact",
      outcome: "failure",
      payload: {
        api_key: "sk-secret",
        nested: { accessToken: "access-secret", harmless: "visible" },
        list: [{ refresh_token: "refresh-secret" }],
      },
    });

    const events = await core.queryEvents({ trace: "trace-events-redact" });

    expect(event.actor, "Actor handles should normalize away @ prefixes for stable filtering.").toBe("coo");
    expect(event.subject, "Agent subjects should normalize to profile ids for event queries.").toBe("vp-eng");
    expect(event.severity, "Failure outcomes should default to error severity.").toBe("error");
    expect(events[0]?.payload, "Sensitive payload keys should be redacted recursively before append.").toEqual({
      api_key: "<redacted>",
      nested: { accessToken: "<redacted>", harmless: "visible" },
      list: [{ refresh_token: "<redacted>" }],
    });
  });

  test("queryEvents_WhenFiltersAndLimitsAreProvided_ReturnsNewestMatchingEventsOnly", async () => {
    await core.writeEvent({ type: "audit.test", actor: "coo", trace: "trace-filter", outcome: "info", ts: 10, payload: { n: 1 } });
    await core.writeEvent({ type: "audit.test", actor: "vp-eng", trace: "trace-filter", outcome: "deny", ts: 20, payload: { n: 2 } });
    await core.writeEvent({ type: "memory.write", actor: "vp-eng", trace: "trace-filter", outcome: "success", ts: 30, payload: { n: 3 } });
    await core.writeEvent({ type: "audit.test", actor: "vp-eng", trace: "other-trace", outcome: "deny", ts: 40, payload: { n: 4 } });

    const events = await core.queryEvents({
      type: ["audit.test", "memory.write"],
      actor: "@vp-eng",
      trace: "trace-filter",
      outcome: ["deny", "success"],
      limit: 1,
    });

    expect(events.map((event) => event.type), "Event queries should apply all filters and then limit newest-first results.").toEqual(["memory.write"]);
    expect(events[0]?.payload, "The returned newest matching event should preserve non-secret payload data.").toEqual({ n: 3 });
  });

  test("readEvents_WhenLogContainsCorruptLine_SkipsBadLineAndKeepsReadableEvents", async () => {
    await mkdir(core.EVENTS_DIR, { recursive: true });
    await writeFile(core.EVENTS_PATH, [
      JSON.stringify({ id: "ok-1", ts: 1, type: "audit.test", outcome: "info", severity: "info" }),
      "{not json",
      JSON.stringify({ id: "ok-2", ts: 2, type: "audit.test", outcome: "info", severity: "info" }),
      "",
    ].join("\n"));

    const events = await core.readEvents();

    expect(events.map((event) => event.id), "Corrupt partial JSONL lines should not make the audit log unreadable.").toEqual(["ok-1", "ok-2"]);
  });
});
