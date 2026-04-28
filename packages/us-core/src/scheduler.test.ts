import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const usHome = await mkdtemp(join(tmpdir(), "union-street-scheduler-unit-test-"));
process.env.US_HOME = usHome;
process.env.US_MEMORY_SYNC = "0";
process.env.US_STREAM_MODEL_STUB = "1";

const core = await import("./index.ts");

beforeAll(async () => {
  const demo = core.buildDemoFederationConfig();
  await Bun.write(core.FEDERATION_PATH, JSON.stringify(demo.config, null, 2));
  const coo = demo.org.find((node) => node.id === "coo")!;
  const pack = core.buildAgentPackFromOrgNode(coo, demo.org);
  await core.initProfile("coo", { role: "coo" });
  await core.writeAgentPack("coo", {
    ...pack,
    pulse: { ...pack.pulse, enabled: false },
    schedule: [
      {
        id: "valid-monday",
        name: "Valid Monday",
        cron: "15 9 * * MON",
        timezone: "UTC",
        prompt: "Monday status",
        deliverables: ["status"],
      },
      {
        id: "invalid-cron",
        name: "Invalid Cron",
        cron: "bad cron",
        timezone: "UTC",
        prompt: "Should never run",
        deliverables: ["none"],
      },
    ],
  });
});

afterAll(async () => {
  await rm(usHome, { recursive: true, force: true });
});

describe("scheduler unit behavior", () => {
  test("dueSchedulerJobs_WhenPackHasInvalidCron_IgnoresInvalidScheduleWithoutBlockingValidJobs", async () => {
    const monday0916 = Date.UTC(2026, 3, 27, 9, 16);

    const due = await core.dueSchedulerJobs(monday0916, ["coo"]);

    expect(due.map((job) => job.id), "Invalid cron entries should not make valid schedule jobs disappear.").toEqual(["schedule:coo:valid-monday"]);
    expect(due[0]?.dueAt, "Cron jobs should be due at the most recent matching minute, not the query time.").toBe(Date.UTC(2026, 3, 27, 9, 15));
  });

  test("claimDueSchedulerJobs_WhenCalledTwiceForSameDueWindow_IsIdempotentUntilFailure", async () => {
    const monday0916 = Date.UTC(2026, 3, 27, 9, 16);

    const first = await core.claimDueSchedulerJobs(monday0916, ["coo"]);
    const second = await core.claimDueSchedulerJobs(monday0916, ["coo"]);

    expect(first, "First claim should create exactly one run for the due schedule window.").toHaveLength(1);
    expect(second, "Second claim for the same non-failed due window should not duplicate work.").toEqual([]);
  });

  test("claimDueSchedulerJobs_WhenManyTicksRaceForSameDueWindow_ClaimsExactlyOneRun", async () => {
    const thirdMonday0916 = Date.UTC(2026, 4, 11, 9, 16);

    const batches = await Promise.all(
      Array.from({ length: 12 }, () => core.claimDueSchedulerJobs(thirdMonday0916, ["coo"])),
    );

    const claimed = batches.flat();
    expect(
      claimed,
      "Concurrent scheduler ticks for the same profile and due window must be serialized so only one worker owns the job.",
    ).toHaveLength(1);
    expect(
      claimed[0]?.dueKey,
      "The single claimed run must still target the deterministic due window requested by every racing tick.",
    ).toBe(`schedule:coo:valid-monday@${Date.UTC(2026, 4, 11, 9, 15)}`);
  });

  test("claimDueSchedulerJobs_WhenPriorRunFailed_AllowsRetryForSameDueWindow", async () => {
    const nextMonday0916 = Date.UTC(2026, 4, 4, 9, 16);
    const claimed = await core.claimDueSchedulerJobs(nextMonday0916, ["coo"]);
    expect(claimed, "The next weekly window should be claimable before simulating failure.").toHaveLength(1);
    await core.executeSchedulerRun(claimed[0]!, async () => {
      throw new Error("temporary executor failure");
    });

    const retry = await core.claimDueSchedulerJobs(nextMonday0916, ["coo"]);

    expect(retry, "Failed scheduler runs should not permanently suppress retry of the same due key.").toHaveLength(1);
    expect(retry[0]?.dueKey, "The retry should target the same due window that failed.").toBe(claimed[0]?.dueKey);
  });
});
