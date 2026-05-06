import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const usHome = await mkdtemp(join(tmpdir(), "union-street-cli-setup-test-"));
const workdir = await mkdtemp(join(tmpdir(), "union-street-cli-setup-work-"));
process.env.US_HOME = usHome;
process.env.HOME = workdir;
process.env.US_MEMORY_SYNC = "1";

const core = await import("@unionstreet/server");
const { setup } = await import("./setup.ts");

afterAll(async () => {
  await rm(usHome, { recursive: true, force: true });
  await rm(workdir, { recursive: true, force: true });
});

async function captureOutput(fn: () => Promise<boolean>): Promise<{ ok: boolean; output: string }> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const ok = await fn();
    return { ok, output: logs.join("\n") };
  } finally {
    console.log = originalLog;
  }
}

describe("setup command", () => {
  test("setup_WhenRunForFreshHost_CreatesDefaultHonchoBackedProfile", async () => {
    const { ok, output } = await captureOutput(() => setup({ profile: "coo", skipDoctor: true }));
    const cfg = await core.readGlobalConfig();
    const pack = await core.readAgentPack("coo");

    expect(ok, "Setup should succeed even before model auth; auth is a next step, not a file-system bootstrap blocker.").toBe(true);
    expect(cfg.default_profile, "Setup should pin the starter profile as the default so `us chat` has a deterministic target.").toBe("coo");
    expect(pack.memory.provider, "Setup-created profiles must use Honcho memory because memory peering is core infra.").toBe("honcho");
    expect(pack.runtime.compute, "V1 setup should target local host runtime, leaving Docker/Kubernetes/cloud for v2.").toBe("local");
    expect(output, "Setup should print the auth gap as an explicit next action instead of hiding it.").toContain("model auth");
  });

  test("setupCheck_WhenProfileAlreadyExists_ReportsReadyShapeWithoutMutating", async () => {
    const { ok, output } = await captureOutput(() => setup({ profile: "coo", check: true, skipDoctor: true }));

    expect(ok, "Check mode should pass for the profile shape created by setup, even when model auth is still a next step.").toBe(true);
    expect(output, "Check mode should expose readiness checks for onboarding diagnostics.").toContain("readiness");
    expect(output, "Check mode should verify the default profile setting.").toContain("default profile");
    expect(output, "Check mode should surface model auth status.").toContain("model auth");
  });
});
