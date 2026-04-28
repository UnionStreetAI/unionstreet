import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";

describe("OCI image scaffolding", () => {
  test("runtime and agent images bind to all interfaces for container networking", async () => {
    const runtimeDockerfile = await fs.readFile("docker/Dockerfile.runtime", "utf8");
    const agentDockerfile = await fs.readFile("docker/Dockerfile.agent", "utf8");

    for (const dockerfile of [runtimeDockerfile, agentDockerfile]) {
      expect(dockerfile).toContain("0.0.0.0");
      expect(dockerfile).toContain("EXPOSE 8787");
      expect(dockerfile).toContain("runtime\", \"serve\"");
      expect(dockerfile).toContain("USER bun");
      expect(dockerfile).toContain("HEALTHCHECK");
      expect(dockerfile).toContain("/health");
    }
  });

  test("dashboard image uses an unprivileged nginx runtime", async () => {
    const dashboardDockerfile = await fs.readFile("docker/Dockerfile.dashboard", "utf8");

    expect(dashboardDockerfile).toContain("nginxinc/nginx-unprivileged");
    expect(dashboardDockerfile).toContain("EXPOSE 8080");
    expect(dashboardDockerfile).not.toContain("nginx:1.27-alpine");
  });

  test("image builds use the current checkout plus a named lash-ts context", async () => {
    const runtimeDockerfile = await fs.readFile("docker/Dockerfile.runtime", "utf8");
    const agentDockerfile = await fs.readFile("docker/Dockerfile.agent", "utf8");
    const dashboardDockerfile = await fs.readFile("docker/Dockerfile.dashboard", "utf8");
    const docs = await fs.readFile("docker/README.md", "utf8");
    const pkg = JSON.parse(await fs.readFile("package.json", "utf8")) as { scripts: Record<string, string> };

    for (const dockerfile of [runtimeDockerfile, agentDockerfile, dashboardDockerfile]) {
      expect(dockerfile).toContain("--from=lash-ts . ./lash-ts");
      expect(dockerfile).toContain(". ./union-street");
      expect(dockerfile).not.toContain("COPY union-street ./union-street");
    }
    expect(pkg.scripts["image:runtime"]).toContain("--build-context lash-ts=../lash-ts");
    expect(pkg.scripts["image:runtime"]?.endsWith(" .")).toBe(true);
    expect(docs).toContain("file:../../../lash-ts");
    expect(docs).toContain("--build-context lash-ts=../lash-ts");
  });

  test("root package exposes build scripts for every image", async () => {
    const pkg = JSON.parse(await fs.readFile("package.json", "utf8")) as { scripts: Record<string, string> };

    expect(pkg.scripts["image:runtime"]).toContain("docker/Dockerfile.runtime");
    expect(pkg.scripts["image:agent"]).toContain("docker/Dockerfile.agent");
    expect(pkg.scripts["image:dashboard"]).toContain("docker/Dockerfile.dashboard");
    expect(pkg.scripts["image:all"]).toContain("image:runtime");
    expect(pkg.scripts["image:all"]).toContain("image:agent");
    expect(pkg.scripts["image:all"]).toContain("image:dashboard");
  });
});
