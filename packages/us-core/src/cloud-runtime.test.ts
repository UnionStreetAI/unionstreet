import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const usHome = await mkdtemp(join(tmpdir(), "union-street-runtime-core-test-"));
process.env.US_HOME = usHome;
process.env.US_MEMORY_SYNC = "0";

const core = await import("./index.ts");

beforeAll(async () => {
  await core.initProfile("runtime-remote", { role: "agent" });
  await core.initProfile("runtime-local", { role: "agent" });
});

afterAll(async () => {
  await rm(usHome, { recursive: true, force: true });
});

describe("agent runtime resolution", () => {
  test("resolveAgentRuntime_WhenGlobalAndProfileRuntimeAreConfigured_MergesAndNormalizesProviderContract", async () => {
    await writeFile(core.profilePaths("runtime-remote").config, [
      "runtime:",
      "  head:",
      "    mode: remote",
      "    provider: aws",
      "  ingress:",
      "    public: true",
      "    auth: none",
      "    receives: [mcp, lash]",
      "  workspace:",
      "    provider: modal",
      "    region: us-east-1",
      "    workdir: /modal/work",
      "    plugin: runtime-modal-custom",
      "  compute:",
      "    memory: 8Gi",
    ].join("\n"));

    const resolved = await core.resolveAgentRuntime("runtime-remote");

    expect(resolved.workspace.provider, "Profile runtime config should override global workspace provider.").toBe("modal");
    expect(resolved.workspacePath, "Remote workspace paths should use configured workdir directly.").toBe("/modal/work");
    expect(resolved.compute.target, "Modal workspaces should default compute target to sandbox.").toBe("sandbox");
    expect(resolved.storage.provider, "Storage defaults should follow the resolved workspace provider.").toBe("modal-volume");
    expect(resolved.ingress.provider, "Ingress defaults should follow the resolved workspace provider when not overridden.").toBe("modal");
    expect(resolved.pluginId, "Explicit runtime plugins should override provider-derived plugin ids.").toBe("runtime-modal-custom");
    expect(resolved.terraformModule, "Non-local providers should expose the terraform module path used by first-party plugins.").toBe("plugins/runtime-modal-custom/terraform");
    expect(resolved.warnings, "Public auth:none and missing remote head endpoint should surface as deployment warnings.").toEqual(expect.arrayContaining([
      "remote head mode requires runtime.head.endpoint before deployment",
      "public ingress should not use auth: none",
    ]));
  });

  test("ensureAgentWorkspace_WhenWorkspaceIsLocal_CreatesAgentScopedDirectoryAndEmitsAuditEvent", async () => {
    await core.writeGlobalConfig({
      runtime: {
        head: { mode: "embedded", provider: "local" },
        workspace: { provider: "local", scope: "agent", root: join(usHome, "workspaces"), workdir: "repo" },
      },
    });
    await writeFile(core.profilePaths("runtime-local").config, `runtime:\n  workspace:\n    provider: local\n    root: ${join(usHome, "workspaces")}\n    workdir: repo\n`);

    const resolved = await core.ensureAgentWorkspace("runtime-local");
    const events = await core.queryEvents({ type: "runtime.workspace.ensure", actor: "runtime-local", limit: 1 });

    expect(resolved.workspacePath, "Local workspaces should be agent-scoped below the configured root.").toBe(join(usHome, "workspaces", "runtime-local", "repo"));
    expect(events[0]?.resource, "Runtime ensure should emit the concrete workspace path for audit/debugging.").toBe(resolved.workspacePath);
    expect(events[0]?.payload, "Runtime ensure events should expose provider/plugin shape for dashboards.").toMatchObject({
      provider: "local",
      pluginId: "runtime-local",
    });
  });
});
