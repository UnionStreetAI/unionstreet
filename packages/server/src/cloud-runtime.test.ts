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
  await core.initProfile("runtime-daytona-agent-pack", { role: "agent" });
  await core.initProfile("runtime-docker-agent-pack", { role: "agent" });
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

  test("resolveAgentRuntime_WhenAgentPackSelectsSandboxProvider_UsesRuntimePluginWithoutProfileConfig", async () => {
    const pack = await core.readAgentPack("runtime-daytona-agent-pack");
    await core.writeAgentPack("runtime-daytona-agent-pack", {
      ...pack,
      runtime: {
        ...pack.runtime,
        environment: "daytona/sandbox",
        provider: "daytona",
        plugin: "runtime-daytona",
        compute: "daytona",
        storage: "daytona-volume",
        workspace: "/workspace/agent",
        region: "us",
        image: "ghcr.io/unionstreet/agent-runtime:latest",
        size: "medium",
        ttlMinutes: 60,
      },
    });

    const resolved = await core.resolveAgentRuntime("runtime-daytona-agent-pack");

    expect(resolved.workspace.provider, "Agent packs should be able to choose a runtime provider directly, without profile config.yaml.").toBe("daytona");
    expect(resolved.compute.target, "Daytona provider should normalize to sandbox compute.").toBe("sandbox");
    expect(resolved.storage.provider, "Daytona provider should normalize storage to the provider volume.").toBe("daytona-volume");
    expect(resolved.ingress.provider, "Daytona provider should normalize ingress to Daytona callbacks.").toBe("daytona");
    expect(resolved.workspacePath, "Remote/sandbox runtimes should use the pack workspace path directly.").toBe("/workspace/agent");
    expect(resolved.pluginId, "Agent pack runtime plugin should resolve to the provider plugin.").toBe("runtime-daytona");
    expect(resolved.terraformModule, "Remote runtime plugins should expose their Terraform module path.").toBe("plugins/runtime-daytona/terraform");
  });

  test("renderAgentDockerPlan_WhenAgentPackSelectsDocker_ProducesRunnableContainerContract", async () => {
    const pack = await core.readAgentPack("runtime-docker-agent-pack");
    await core.writeAgentPack("runtime-docker-agent-pack", {
      ...pack,
      runtime: {
        ...pack.runtime,
        environment: "local/docker",
        provider: "docker",
        plugin: "runtime-docker",
        compute: "docker",
        storage: "volume",
        workspace: "/workspace",
        image: "ghcr.io/unionstreet/agent-runtime:test",
        network: "egress",
        ttlMinutes: 30,
      },
    });

    const resolved = await core.resolveAgentRuntime("runtime-docker-agent-pack");
    const plan = core.renderAgentDockerPlan(resolved, { name: "Union Street Docker Agent" });

    expect(resolved.workspace.provider, "Agent packs should mechanically select Docker as the workspace provider.").toBe("docker");
    expect(resolved.compute.target, "Docker provider should normalize to container compute.").toBe("container");
    expect(resolved.storage.provider, "Docker provider should normalize to Docker volume/bind storage.").toBe("volume");
    expect(resolved.storage.mountPath, "Docker storage should mount inside the container, not at the host US_HOME path.").toBe("/workspace");
    expect(resolved.pluginId, "Docker agent packs should resolve the runtime-docker plugin.").toBe("runtime-docker");
    expect(plan.containerName, "Docker names should be sanitized and deterministic.").toBe("union-street-docker-agent");
    expect(plan.image, "Docker plans should carry the configured agent runtime image.").toBe("ghcr.io/unionstreet/agent-runtime:test");
    expect(plan.workspaceTarget, "Docker plans should mount the resolved workspace into the container workspace path.").toBe("/workspace");
    expect(plan.homeTarget, "Docker runtimes should mount Union Street home so sandboxed agents can resolve profiles and Lash state.").toBe("/home/bun/.us");
    expect(plan.homeSource, "Docker runtimes should bind a concrete Union Street home into the sandbox.").toContain("union-street-runtime");
    expect(plan.createArgs, "Docker plans should include a bind mount flag.").toContain("--mount");
    expect(plan.workspaceSource, "Docker plans should bind an agent-scoped host workspace.").toEndWith(join("workspaces", "runtime-docker-agent-pack", "workspace"));
    expect(plan.createArgs, "Docker plans should bind the host agent workspace into /workspace.").toContain(`type=bind,source=${plan.workspaceSource},target=/workspace`);
    expect(plan.createArgs, "Docker plans should bind Union Street home into the sandbox for profile/federation state.").toContain(`type=bind,source=${plan.homeSource},target=/home/bun/.us`);
    expect(plan.createArgs, "Docker plans should include environment flags.").toContain("-e");
    expect(plan.createArgs, "Docker plans should project runtime plugin metadata.").toContain("US_RUNTIME_PLUGIN=runtime-docker");
    expect(plan.createArgs, "Docker plans should be directly executable by the provider.").toContain("ghcr.io/unionstreet/agent-runtime:test");
  });
});
