import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const usHome = await mkdtemp(join(tmpdir(), "union-street-cli-control-test-"));
const workdir = await mkdtemp(join(tmpdir(), "union-street-cli-control-work-"));
process.env.US_HOME = usHome;
process.env.HOME = workdir;
process.env.US_MEMORY_SYNC = "0";
process.env.US_STREAM_MODEL_STUB = "1";
process.env.US_USAGE_DISABLE_MODELS_DEV_COSTS = "1";

const core = await import("@unionstreet/us-core");
const { init } = await import("./init.ts");
const { profileList, profileUse } = await import("./profile.ts");
const { schedulerCommand } = await import("./scheduler.ts");
const { eventsCommand } = await import("./events.ts");
const { runtimeEnsure, runtimeStatus } = await import("./runtime.ts");
const { loadProfileRuntime } = await import("./chat.tsx");

beforeAll(async () => {
  const demo = core.buildDemoFederationConfig();
  await Bun.write(core.FEDERATION_PATH, JSON.stringify(demo.config, null, 2));
  const packsById = new Map(core.buildDemoAgentPacks(demo.org).map((pack) => [pack.id, pack]));
  for (const node of demo.org.slice(0, 5)) {
    await core.initProfile(node.id, { role: node.roles[0] ?? "agent", capabilities: node.roles });
    const pack = packsById.get(node.id);
    if (pack) await core.writeAgentPack(node.id, pack);
  }
  const coo = await core.readAgentPack("coo");
  await core.writeAgentPack("coo", {
    ...coo,
    pulse: { enabled: true, cadence: "every 30m", instructions: "heartbeat check" },
    schedule: [
      {
        id: "monday-sync",
        name: "Monday sync",
        cron: "0 9 * * MON",
        timezone: "UTC",
        prompt: "Run Monday sync.",
        deliverables: ["status"],
      },
    ],
  });
  await core.initProfile("cli-noauth", { role: "agent" });
  await core.setProfileModel("cli-noauth", "model-without-credentials", "provider-without-credentials");
});

afterAll(async () => {
  await rm(usHome, { recursive: true, force: true });
  await rm(workdir, { recursive: true, force: true });
});

async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n");
}

describe("CLI control-plane commands", () => {
  test("initCommand_WhenProfileDoesNotExist_CreatesAtomicAgentPackAndProfileFiles", async () => {
    const output = await captureOutput(() => init("sales-agent", { role: "sales", capability: ["crm", "reporting"] }));
    const pack = await core.readAgentPack("sales-agent");

    expect(output, "init should tell operators which profile path was created.").toContain('Profile "sales-agent"');
    expect(pack.id, "init must create the atomic agent.yaml pack alongside legacy profile files.").toBe("sales-agent");
    expect(pack.identity.roles, "init should preserve requested capabilities as agent identity roles.").toEqual(["crm", "reporting"]);
    expect(pack.lash.structured, "New profiles should default to structured Lash-capable coordination.").toBe("preferred");
  });

  test("profileCommands_WhenProfilesExist_ListAndPinDefaultProfile", async () => {
    await profileUse("coo");

    const output = await captureOutput(() => profileList());
    const config = await core.readGlobalConfig();

    expect(config.default_profile, "profile use should persist the selected default in global config.").toBe("coo");
    expect(output, "profile list should render the selected default profile for human verification.").toContain("coo");
    expect(output, "profile list should include initialized peer profiles, not just the default.").toContain("vp-eng");
  });

  test("schedulerCommand_WhenDueTickRuns_ClaimsRunAndCanPrintRuns", async () => {
    const dueAt = Date.UTC(2026, 3, 27, 9, 1);

    const dueOutput = await captureOutput(() => schedulerCommand("due", { profile: "@coo", now: dueAt }));
    const tickOutput = await captureOutput(() => schedulerCommand("tick", { profile: "@coo", now: dueAt }));
    const runsOutput = await captureOutput(() => schedulerCommand("runs"));

    expect(dueOutput, "scheduler due should normalize @profile filters and show the due schedule job.").toContain("schedule:coo:monday-sync");
    expect(tickOutput, "scheduler tick should claim every due job, including the always-on pulse and the explicit schedule.").toContain("claimed 2 scheduler runs");
    expect(runsOutput, "scheduler runs should expose persisted schedule run history for audit and debugging.").toContain("schedule:coo:monday-sync");
    expect(runsOutput, "scheduler runs should expose persisted pulse run history for heartbeat auditability.").toContain("pulse:coo");
  });

  test("eventsCommand_WhenEventsExist_FiltersHumanAndJsonOutput", async () => {
    await core.writeEvent({
      type: "audit.test",
      actor: "@coo",
      target: "@vp-eng",
      trace: "trace-cli-events",
      outcome: "success",
      reason: "CLI command test",
    });

    const human = await captureOutput(() => eventsCommand("query", { actor: "@coo", trace: "trace-cli-events", limit: 5 }));
    const json = await captureOutput(() => eventsCommand("query", { actor: "coo", trace: "trace-cli-events", json: true }));
    const parsed = JSON.parse(json);

    expect(human, "events query should show normalized actor and target handles in human output.").toContain("@coo");
    expect(human, "events query should include trace ids so operators can stitch a run timeline.").toContain("trace:trace-cli-events");
    expect(parsed[0].actor, "events query --json should produce machine-readable filtered event rows.").toBe("coo");
    expect(parsed[0].target, "events query --json should normalize target handles without @ prefixes.").toBe("vp-eng");
  });

  test("runtimeCommands_WhenProfileExists_ExposeAndEnsureConcreteWorkspaceContract", async () => {
    const statusOutput = await captureOutput(() => runtimeStatus("coo"));
    const ensureOutput = await captureOutput(() => runtimeEnsure("coo"));
    const events = await core.queryEvents({ type: "runtime.workspace.ensure", actor: "coo", limit: 1 });

    expect(statusOutput, "runtime status should render the selected profile's runtime contract.").toContain("@coo");
    expect(statusOutput, "runtime status should include workspace details, not just a placeholder.").toContain("workspace");
    expect(ensureOutput, "runtime ensure should confirm workspace materialization.").toContain("workspace ensured");
    expect(events[0]?.actor, "runtime ensure should emit a control-plane audit event for the agent.").toBe("coo");
  });

  test("loadProfileRuntime_WhenConfiguredProviderHasNoCredential_StillBuildsChatRuntimeWithAuthWarning", async () => {
    const persisted: unknown[] = [];

    const runtime = await loadProfileRuntime({
      name: "cli-noauth",
      source: "test",
      persistFor: () => async (entry: unknown) => {
        persisted.push(entry);
      },
      exit: () => {},
    });

    expect(runtime.profileName, "Chat runtime should resolve the requested profile even before auth exists.").toBe("cli-noauth");
    expect(runtime.authWarning, "TUI startup should surface missing provider credentials instead of failing to render.").toContain("No auth credential found");
    expect(runtime.token, "Missing auth should leave the token empty so later model calls fail explicitly.").toBe("");
    expect(runtime.systemPrompt, "Chat runtime should compose the profile prompt from the agent files.").toContain("# SOUL");
    expect(persisted, "Building chat runtime should not write session turns before the user sends a message.").toEqual([]);
  });

  test("schedulerCommand_WhenNowIsInvalid_FailsWithActionableMessage", async () => {
    const promise = schedulerCommand("status", { now: "definitely-not-a-date" });

    await expect(
      promise,
      "Invalid scheduler time input should fail before scanning jobs so CLI users can correct the flag.",
    ).rejects.toThrow("Invalid --now value");
  });
});
