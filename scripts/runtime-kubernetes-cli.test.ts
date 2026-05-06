import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

describe("runtime kubernetes CLI dry-run", () => {
  test("runtime render defaults to Kubernetes manifests", async () => {
    const usHome = await mkdtemp(join(tmpdir(), "us-kube-cli-render-"));
    await runCli(["init", "vp-eng"], usHome);

    const output = await runCli(["runtime", "render", "vp-eng"], usHome);
    const docs = yaml.loadAll(output) as Array<Record<string, any>>;

    expect(docs.map((doc) => doc.kind)).toContain("Deployment");
    expect(docs.find((doc) => doc.kind === "Deployment")?.metadata?.name).toBe("us-agent-vp-eng-20aa33e2");
  });

  test("renders parseable kube manifests from a local dev profile without mutating a cluster", async () => {
    const usHome = await mkdtemp(join(tmpdir(), "us-kube-cli-"));
    await runCli(["init", "vp-eng"], usHome);

    const output = await runCli([
      "runtime",
      "ensure",
      "vp-eng",
      "--provider",
      "kubernetes",
      "--dry-run",
      "--namespace",
      "test-agents",
      "--workload",
      "Job",
    ], usHome);
    const docs = yaml.loadAll(output) as Array<Record<string, any>>;
    const kinds = docs.map((doc) => doc.kind);

    expect(kinds).toContain("Namespace");
    expect(kinds).toContain("ConfigMap");
    expect(kinds).toContain("Job");
    expect(kinds).toContain("Service");
    expect(kinds).toContain("NetworkPolicy");
    expect(kinds).not.toContain("Ingress");
    expect(kinds).not.toContain("Secret");

    const config = docs.find((doc) => doc.kind === "ConfigMap");
    expect(config?.metadata?.namespace).toBe("test-agents");
    expect(config?.data?.US_RUNTIME_PLUGIN).toBe("runtime-kubernetes");
    expect(config?.data?.US_WORKSPACE_PATH).toBe("/workspace");
    expect(config?.data?.US_STORAGE_MOUNT).toBe("/workspace");
    expect(config?.data?.US_INGRESS_URL).toBeUndefined();
    expect(config?.data?.US_AGENT_SECRET_GRANTS).toBe("profile:vp-eng");

    const job = docs.find((doc) => doc.kind === "Job");
    expect(job?.spec?.template?.spec?.restartPolicy).toBe("OnFailure");
    expect(job?.spec?.template?.spec?.containers?.[0]?.ports?.[0]?.containerPort).toBe(8787);
    expect(job?.spec?.template?.spec?.containers?.[0]?.volumeMounts?.[0]?.mountPath).toBe("/workspace");
    expect(job?.spec?.template?.spec?.containers?.[0]?.envFrom).toEqual([
      { configMapRef: { name: "us-agent-vp-eng-20aa33e2-config" } },
    ]);
  });

  test("projects a named operator-managed secret when requested", async () => {
    const usHome = await mkdtemp(join(tmpdir(), "us-kube-cli-secret-"));
    await runCli(["init", "vp-eng"], usHome);

    const output = await runCli([
      "runtime",
      "ensure",
      "vp-eng",
      "--provider",
      "kubernetes",
      "--dry-run",
      "--external-secret",
      "prod-agent-secrets",
    ], usHome);
    const docs = yaml.loadAll(output) as Array<Record<string, any>>;
    const deployment = docs.find((doc) => doc.kind === "Deployment");

    expect(docs.some((doc) => doc.kind === "Secret")).toBe(false);
    expect(deployment?.spec?.template?.spec?.containers?.[0]?.envFrom).toEqual([
      { configMapRef: { name: "us-agent-vp-eng-20aa33e2-config" } },
      { secretRef: { name: "prod-agent-secrets", optional: true } },
    ]);
  });

  test("renders a Docker runtime plan without touching the Docker daemon", async () => {
    const usHome = await mkdtemp(join(tmpdir(), "us-docker-cli-render-"));
    await runCli(["init", "vp-eng"], usHome);

    const output = await runCli([
      "runtime",
      "ensure",
      "vp-eng",
      "--provider",
      "docker",
      "--dry-run",
      "--image",
      "ghcr.io/unionstreet/agent-runtime:test",
      "--name",
      "vp eng docker",
    ], usHome);

    expect(output).toContain("# Docker runtime plan for @vp-eng");
    expect(output).toContain("container: vp-eng-docker");
    expect(output).toContain("image: ghcr.io/unionstreet/agent-runtime:test");
    expect(output).toContain("US_RUNTIME_PLUGIN=runtime-docker");
    expect(output).toContain("docker run -d --name vp-eng-docker");
  });

  test("rejects unsupported dry-run provider and invalid workload values", async () => {
    const usHome = await mkdtemp(join(tmpdir(), "us-kube-cli-errors-"));
    await runCli(["init", "vp-eng"], usHome);

    await expect(runCli(["runtime", "ensure", "vp-eng", "--dry-run"], usHome)).rejects.toThrow("--provider kubernetes");
    await expect(runCli([
      "runtime",
      "ensure",
      "vp-eng",
      "--provider",
      "kubernetes",
    ], usHome)).rejects.toThrow("reconciliation is not implemented");
    await expect(runCli([
      "runtime",
      "ensure",
      "vp-eng",
      "--provider",
      "kubernetes",
      "--dry-run",
      "--workload",
      "CronJob",
    ], usHome)).rejects.toThrow("Invalid Kubernetes workload");
  });

  test("runtime serve rejects public binding unless bearer auth is configured", async () => {
    const usHome = await mkdtemp(join(tmpdir(), "us-kube-cli-serve-auth-"));

    await expect(runCli([
      "runtime",
      "serve",
      "--host",
      "0.0.0.0",
      "--port",
      "0",
    ], usHome, { US_RUNTIME_BEARER_TOKEN: "" })).rejects.toThrow("requires US_RUNTIME_BEARER_TOKEN");
  });
});

async function runCli(args: string[], usHome: string, env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(["bun", "run", "packages/us-cli/src/index.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      US_HOME: usHome,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  if (exit !== 0) throw new Error(stderr || stdout || `CLI exited ${exit}`);
  return stdout;
}
