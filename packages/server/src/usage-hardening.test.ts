import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const usHome = await mkdtemp(join(tmpdir(), "union-street-usage-hardening-test-"));
process.env.US_HOME = usHome;
process.env.US_USAGE_DISABLE_MODELS_DEV_COSTS = "1";

const core = await import("./index.ts");

afterAll(async () => {
  delete process.env.US_MODEL_COSTS_JSON;
  await rm(usHome, { recursive: true, force: true });
});

describe("usage accounting hardening", () => {
  test("writeUsageRecord_WhenUsageContainsNegativeOrMissingTotals_NormalizesToNonNegativeIntegers", async () => {
    const record = await core.writeUsageRecord({
      actor: "agent:coo",
      provider: "unknown-provider",
      model: "unknown-model",
      kind: "prompt",
      usage: {
        input: 12.9,
        output: -5,
        reasoning: Number.NaN,
        cache_read: 3.2,
        cache_write: 0,
        total: 0,
      },
    });

    expect(record.actor, "Usage actor normalization should accept agent: subjects from federation logs.").toBe("coo");
    expect(record.usage, "Usage buckets should be floored and clamped so cost math never receives NaN or negative values.").toEqual({
      input: 12,
      output: 0,
      reasoning: 0,
      cache_read: 3,
      cache_write: 0,
      total: 15,
    });
    expect(record.costSource, "Unknown providers with no rate card should remain unknown rather than inventing a price.").toBe("unknown");
  });

  test("writeUsageRecord_WhenMetadataContainsNestedSecrets_RedactsSensitiveFieldsRecursively", async () => {
    const record = await core.writeUsageRecord({
      actor: "coo",
      provider: "unknown-provider",
      model: "unknown-model",
      kind: "chat",
      usage: { input: 1, output: 1, total: 2 },
      metadata: {
        request: {
          Authorization: "Bearer secret-token",
          nested: {
            api_key: "sk-live",
            safe: "visible",
          },
        },
        prompt: "hello BALLISTIC_SECRET_DO_NOT_LEAK",
      },
    });

    expect(
      record.metadata,
      "Usage metadata should recursively redact credentials while preserving non-sensitive diagnostic fields.",
    ).toEqual({
      request: {
        Authorization: "<redacted>",
        nested: {
          api_key: "<redacted>",
          safe: "visible",
        },
      },
      prompt: "hello <redacted>",
    });
  });

  test("readUsageRecords_WhenLedgerContainsCorruptPartialLine_SkipsOnlyTheBadLine", async () => {
    await mkdir(dirname(core.USAGE_PATH), { recursive: true });
    await Bun.write(core.USAGE_PATH, "");
    await core.writeUsageRecord({
      actor: "coo",
      provider: "unknown-provider",
      model: "unknown-model",
      kind: "prompt",
      usage: { input: 1, output: 2, total: 3 },
    });
    await Bun.write(core.USAGE_PATH, `${await Bun.file(core.USAGE_PATH).text()}not-json\n`);
    await core.writeUsageRecord({
      actor: "vp-eng",
      provider: "unknown-provider",
      model: "unknown-model",
      kind: "prompt",
      usage: { input: 4, output: 5, total: 9 },
    });

    const records = await core.readUsageRecords();

    expect(
      records.map((record) => record.actor),
      "A corrupt ledger line should not make the entire usage file unreadable.",
    ).toEqual(["coo", "vp-eng"]);
  });

  test("writeUsageRecord_WhenEnvRateCardJsonIsInvalid_FallsBackToUnknownWithoutThrowing", async () => {
    process.env.US_MODEL_COSTS_JSON = "{not valid json";

    const record = await core.writeUsageRecord({
      actor: "coo",
      provider: "openai",
      model: "gpt-invalid-rate-card",
      kind: "prompt",
      usage: { input: 100, output: 50, total: 150 },
    });

    expect(record.costSource, "Invalid local rate-card JSON should not crash prompt logging.").toBe("unknown");
    expect(record.costMicroUsd, "Unknown cost should omit costMicroUsd so accounting can distinguish missing price from zero price.").toBeUndefined();
  });

  test("queryUsageRecords_WhenFilteringByTimeAndSession_ReturnsNewestMatchingRecordsOnly", async () => {
    await mkdir(dirname(core.USAGE_PATH), { recursive: true });
    await Bun.write(core.USAGE_PATH, "");
    await core.writeUsageRecord({
      actor: "coo",
      provider: "openai",
      model: "gpt-a",
      sessionId: "session-a",
      ts: 100,
      kind: "prompt",
      costMicroUsd: 1,
      usage: { input: 1, output: 1, total: 2 },
    });
    await core.writeUsageRecord({
      actor: "coo",
      provider: "openai",
      model: "gpt-b",
      sessionId: "session-a",
      ts: 300,
      kind: "prompt",
      costMicroUsd: 2,
      usage: { input: 2, output: 2, total: 4 },
    });
    await core.writeUsageRecord({
      actor: "coo",
      provider: "openai",
      model: "gpt-c",
      sessionId: "session-b",
      ts: 400,
      kind: "prompt",
      costMicroUsd: 3,
      usage: { input: 3, output: 3, total: 6 },
    });

    const records = await core.queryUsageRecords({ actor: "@coo", sessionId: "session-a", since: 200, limit: 1 });

    expect(
      records.map((record) => record.model),
      "Usage queries should combine actor/session/time filters and return newest records first with limit applied.",
    ).toEqual(["gpt-b"]);
  });
});
