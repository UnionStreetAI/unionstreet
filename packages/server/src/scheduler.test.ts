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
  const vpEng = demo.org.find((node) => node.id === "vp-eng")!;
  await core.initProfile("vp-eng", { role: "vp-eng" });
  await core.writeAgentPack("vp-eng", core.buildAgentPackFromOrgNode(vpEng, demo.org));
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

  test("createScheduledOrchestration_WhenRouteIsOrdered_PersistsCalendarEventOnOwningAgent", async () => {
    const input = {
      owner: "coo",
      name: "Engineering escalation review",
      cron: "30 10 * * TUE",
      timezone: "America/Los_Angeles",
      prompt: "Review engineering risks and return an executive-ready summary.",
      deliverables: ["risk list", "next owner"],
      route: ["coo", "vp-eng"],
    };

    const schedule = await core.createScheduledOrchestration(input);
    try {
      const pack = await core.readAgentPack("coo");
      const jobs = await core.listSchedulerJobs(["coo"]);

      expect(schedule.route, "Created schedules must preserve the exact ordered agent route selected by the operator.").toEqual(["coo", "vp-eng"]);
      expect(
        pack.schedule.some((item) => item.id === schedule.id && item.route?.join(">") === "coo>vp-eng"),
        "The owner agent pack should become the durable source of truth for the new calendar route.",
      ).toBe(true);
      expect(
        jobs.some((job) => job.id === `schedule:coo:${schedule.id}` && job.route.join(">") === "coo>vp-eng"),
        "Compiled scheduler jobs must expose the route so runtime execution can invoke agents in order.",
      ).toBe(true);
    } finally {
      await removeSchedule("coo", schedule.id);
    }
  });

  test("executeSchedulerRun_WhenScheduleHasRoute_HandsExecutorTheOrderedRoute", async () => {
    const schedule = await core.createScheduledOrchestration({
      owner: "coo",
      name: "Ordered execution proof",
      cron: "30 11 * * TUE",
      timezone: "UTC",
      prompt: "Run this route in order.",
      deliverables: ["ordered transcript"],
      route: ["coo", "vp-eng"],
    });
    const dueAt = Date.UTC(2026, 3, 28, 11, 30);

    try {
      const routedRun = {
        id: "ordered-execution-test",
        jobId: `schedule:coo:${schedule.id}`,
        kind: "schedule" as const,
        profile: "coo",
        dueAt,
        dueKey: `schedule:coo:${schedule.id}@${dueAt}`,
        status: "claimed" as const,
        ts: dueAt,
        prompt: "Run this route in order.",
      };
      const seenRoutes: string[][] = [];

      const completed = await core.executeSchedulerRun(routedRun, async (job) => {
        seenRoutes.push(job.route);
        return { trace: "test-trace", sessionId: "test-session", result: { route: job.route } };
      });

      expect(seenRoutes, "Scheduler execution must preserve the operator-selected route when invoking the executor.").toEqual([["coo", "vp-eng"]]);
      expect(completed.result, "Completed scheduler runs should retain the route result for audit/debug inspection.").toEqual({ route: ["coo", "vp-eng"] });
    } finally {
      await removeSchedule("coo", schedule.id);
    }
  });

  test("createScheduledOrchestration_WhenRouteStartsBelowOwner_RejectsAmbiguousOwnership", async () => {
    const promise = core.createScheduledOrchestration({
      owner: "coo",
      name: "Invalid route",
      cron: "45 10 * * WED",
      timezone: "UTC",
      prompt: "This should not be persisted.",
      deliverables: ["none"],
      route: ["vp-eng", "coo"],
    });

    await expect(
      promise,
      "Calendar events must fail fast when the first invoked agent is not the owning profile, otherwise ownership and audit policy become ambiguous.",
    ).rejects.toThrow("route must start with owner @coo");
  });

  test("createScheduledOrchestration_WhenRouteRepeatsAgent_RejectsLoopBeforePersisting", async () => {
    const promise = core.createScheduledOrchestration({
      owner: "coo",
      name: "Looping route",
      cron: "0 12 * * THU",
      timezone: "UTC",
      prompt: "This should not persist.",
      deliverables: ["none"],
      route: ["coo", "vp-eng", "coo"],
    });

    await expect(
      promise,
      "Calendar routes must reject repeated agents so a scheduled event cannot accidentally loop or multiply prompt execution.",
    ).rejects.toThrow("route cannot contain repeated agents");
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

async function removeSchedule(profile: string, scheduleId: string) {
  const pack = await core.readAgentPack(profile);
  await core.writeAgentPack(profile, {
    ...pack,
    schedule: pack.schedule.filter((schedule) => schedule.id !== scheduleId),
  });
}
