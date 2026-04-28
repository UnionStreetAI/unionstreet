import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const usHome = await mkdtemp(join(tmpdir(), "union-street-fallback-test-"));
process.env.US_HOME = usHome;

const core = await import("./index.ts");

afterAll(async () => {
  await rm(usHome, { recursive: true, force: true });
});

describe("fallback model chains", () => {
  test("readModelChain_WhenAgentPackExists_ReturnsPrimaryThenFallbackTargets", async () => {
    const demo = core.buildDemoFederationConfig();
    const coo = demo.org.find((node) => node.id === "coo")!;
    await core.initProfile("coo", { role: "coo" });
    await core.writeAgentPack("coo", {
      ...core.buildAgentPackFromOrgNode(coo, demo.org),
      model: {
        primary: { provider: "codex", id: "gpt-primary" },
        fallback: [
          { provider: "anthropic", id: "claude-fallback" },
          { provider: "custom-openai-compat:local", id: "gemma" },
        ],
      },
    });

    const chain = await core.readModelChain("coo");

    expect(chain, "Agent packs should be the canonical model chain source when present.").toEqual([
      { provider: "codex", id: "gpt-primary" },
      { provider: "anthropic", id: "claude-fallback" },
      { provider: "custom-openai-compat:local", id: "gemma" },
    ]);
  });

  test("setFallbackChain_WhenLegacyProfileHasNoAgentPack_PersistsFallbacksInConfig", async () => {
    await core.initProfile("legacy-fallback", { role: "agent" });
    await core.setProfileModel("legacy-fallback", "codex", "gpt-5.4");

    await core.setFallbackChain("legacy-fallback", [
      { provider: "anthropic", id: "claude-sonnet" },
      { provider: "openrouter", id: "deepseek" },
    ]);
    const chain = await core.readModelChain("legacy-fallback");

    expect(chain, "Legacy config fallback chains should round-trip primary first, then configured fallbacks.").toEqual([
      { provider: "codex", id: "gpt-5.4" },
      { provider: "anthropic", id: "claude-sonnet" },
      { provider: "openrouter", id: "deepseek" },
    ]);
  });

  test("isRetryableError_WhenErrorsRepresentAuthRateNetworkOrUpstreamFailure_ReturnsTrue", () => {
    const retryable = [
      core.isRetryableError(new Error("HTTP 429 rate limit")),
      core.isRetryableError("401 unauthorized"),
      core.isRetryableError("provider returned 503"),
      core.isRetryableError("network ECONNRESET"),
      core.isRetryableError({ message: "upstream overloaded" }),
    ];
    const terminal = [
      core.isRetryableError("invalid request: malformed tool schema"),
      core.isRetryableError("context length exceeded by user input"),
    ];

    expect(retryable, "Fallback should trigger for transient, auth, rate-limit, and upstream failure classes.").toEqual([true, true, true, true, true]);
    expect(terminal, "Fallback should not hide deterministic user/config errors.").toEqual([false, false]);
  });
});
