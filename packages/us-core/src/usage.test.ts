import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const usHome = await mkdtemp(join(tmpdir(), "union-street-usage-test-"));
const summaryActor = `usage-summary-${randomUUID()}`;
const summaryTrace = `trace-${randomUUID()}`;
process.env.US_HOME = usHome;
process.env.US_USAGE_DISABLE_MODELS_DEV_COSTS = "1";

const {
  GLOBAL_AUTH_PROFILES_PATH,
  queryUsageRecords,
  summarizeUsage,
  updateAuthProfiles,
  writeUsageRecord,
} = await import("./index.ts");

afterAll(async () => {
  delete process.env.US_MODEL_COSTS_JSON;
  await rm(usHome, { recursive: true, force: true });
});

describe("usage accounting", () => {
  test("writeUsageRecord_WhenEnvRateCardExists_ComputesOpenCodeStyleTokenCost", async () => {
    process.env.US_MODEL_COSTS_JSON = JSON.stringify({
      "openai/gpt-test": {
        input: 2,
        output: 8,
        cache_read: 0.5,
        cache_write: 1,
      },
    });

    const record = await writeUsageRecord({
      actor: "@coo",
      provider: "openai",
      model: "gpt-test",
      kind: "prompt",
      usage: {
        input: 1_000,
        output: 100,
        reasoning: 10,
        cache_read: 20,
        cache_write: 30,
        total: 1_160,
      },
    });

    expect(
      record.actor,
      "Usage records must normalize @-prefixed agent handles so accounting queries can use either CLI or profile notation.",
    ).toBe("coo");
    expect(
      record.costSource,
      "An explicit local rate card must win before remote model registry lookup so deterministic tests and private providers do not hit the network.",
    ).toBe("env:rate_card");
    expect(
      record.costMicroUsd,
      "Cost is stored in micro-USD: tokens multiplied by USD-per-million rates, including reasoning charged at output rate.",
    ).toBe(2_920);
  });

  test("writeUsageRecord_WhenProviderAccountingIsFree_StoresZeroCostForCustomProvider", async () => {
    delete process.env.US_MODEL_COSTS_JSON;
    await updateAuthProfiles(GLOBAL_AUTH_PROFILES_PATH, (current) => ({
      ...current,
      providers: {
        ...current.providers,
        "custom-openai-compat:gemma-thurgood-cloud": {
          kind: "api_key",
          api_key: "test-key",
          base_url: "https://gemma.thurgood.cloud/v1/chat/completions",
          accounting: { mode: "free", note: "test-local provider" },
        },
      },
    }));

    const record = await writeUsageRecord({
      actor: "coo",
      provider: "custom-openai-compat:gemma-thurgood-cloud",
      model: "google/gemma-4-31B-it",
      kind: "chat",
      usage: {
        input: 4_000,
        output: 800,
        reasoning: 0,
        cache_read: 1_200,
        cache_write: 0,
        total: 6_000,
      },
    });

    expect(
      record.costSource,
      "Provider-level accounting policy must override generic registry pricing for custom endpoints because their bill may be external or free.",
    ).toBe("provider:free");
    expect(
      record.costMicroUsd,
      "A free custom provider must remain zero-cost regardless of token volume so local/internal endpoints do not create fake spend.",
    ).toBe(0);
  });

  test("summarizeUsage_WhenRecordsContainAllBuckets_AggregatesSessionAccounting", async () => {
    await writeUsageRecord({
      actor: summaryActor,
      provider: "openai",
      model: "gpt-test",
      kind: "prompt",
      trace: summaryTrace,
      costMicroUsd: 2_920,
      usage: {
        input: 1_000,
        output: 100,
        reasoning: 10,
        cache_read: 20,
        cache_write: 30,
        total: 1_160,
      },
    });
    await writeUsageRecord({
      actor: summaryActor,
      provider: "custom-openai-compat:gemma-thurgood-cloud",
      model: "google/gemma-4-31B-it",
      kind: "chat",
      trace: summaryTrace,
      costMicroUsd: 0,
      usage: {
        input: 4_000,
        output: 800,
        reasoning: 0,
        cache_read: 1_200,
        cache_write: 0,
        total: 6_000,
      },
    });

    const records = await queryUsageRecords({ actor: summaryActor, trace: summaryTrace, limit: 10 });

    const summary = summarizeUsage(records);

    expect(
      summary.calls,
      "The usage summary should count every persisted model call so sessions can report model-call volume separately from tokens.",
    ).toBe(2);
    expect(summary.input, "Summary input must include only non-cached input tokens.").toBe(5_000);
    expect(summary.output, "Summary output must include visible output tokens across calls.").toBe(900);
    expect(summary.reasoning, "Summary reasoning must stay separate from visible output for OpenAI-style accounting.").toBe(10);
    expect(summary.cacheRead, "Summary cache reads must be first-class so cache hit rates can be audited.").toBe(1_220);
    expect(summary.cacheWrite, "Summary cache writes must be first-class so prompt-cache creation costs can be audited.").toBe(30);
    expect(summary.total, "Summary total must preserve provider-reported total token counts for reconciliation.").toBe(7_160);
    expect(summary.costMicroUsd, "Summary cost should add micro-USD values across known paid and free providers.").toBe(2_920);
  });
});
