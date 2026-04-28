import { describe, expect, test } from "bun:test";
import yaml from "js-yaml";
import {
  dumpKubernetesManifests,
  renderAgentKubernetesManifests,
  validateKubernetesManifests,
  type KubernetesManifest,
} from "./kubernetes-runtime.ts";
import type { ResolvedAgentRuntime } from "./cloud-runtime.ts";

describe("renderAgentKubernetesManifests", () => {
  test("renders a complete deployment-oriented agent runtime bundle", () => {
    const manifests = renderAgentKubernetesManifests(baseRuntime(), {
      namespace: "Union Street Dev",
      image: "registry.example.com/us/agent-runtime:test",
    });

    expect(manifests.map((entry) => entry.kind)).toEqual([
      "Namespace",
      "ServiceAccount",
      "ConfigMap",
      "PersistentVolumeClaim",
      "Deployment",
      "Service",
      "Ingress",
      "NetworkPolicy",
    ]);
    expect(validateKubernetesManifests(manifests)).toEqual({ ok: true, errors: [] });

    const deployment = manifestOf(manifests, "Deployment");
    expect(path(deployment, "metadata.namespace")).toBe("union-street-dev");
    expect(path(deployment, "metadata.name")).toBe("us-agent-vp-eng-20aa33e2");
    expect(path(deployment, "spec.template.spec.serviceAccountName")).toBe("union-street-agent");
    expect(path(deployment, "spec.template.spec.containers.0.image")).toBe("registry.example.com/us/agent-runtime:test");
    expect(path(deployment, "spec.template.spec.containers.0.ports.0.containerPort")).toBe(8787);
    expect(path(deployment, "spec.template.spec.containers.0.readinessProbe.httpGet.path")).toBe("/health");
    expect(path(deployment, "spec.template.spec.containers.0.livenessProbe.httpGet.path")).toBe("/health");
    expect(path(deployment, "spec.template.spec.volumes.0.persistentVolumeClaim.claimName")).toBe("us-agent-vp-eng-20aa33e2-workspace");
    expect(path(deployment, "spec.template.spec.containers.0.envFrom")).toEqual([
      { configMapRef: { name: "us-agent-vp-eng-20aa33e2-config" } },
    ]);

    const config = manifestOf(manifests, "ConfigMap");
    expect(path(config, "data.US_PROFILE")).toBe("vp-eng");
    expect(path(config, "data.US_RUNTIME_PROVIDER")).toBe("kubernetes");
    expect(path(config, "data.US_SERVICE_DNS")).toBe("us-agent-vp-eng-20aa33e2.union-street-dev.svc.cluster.local");
    expect(path(config, "data.US_AGENT_SECRET_GRANTS")).toBe("profile:vp-eng,github");
    expect(path(config, "data.FEATURE_FLAG")).toBe("on");

    const ingress = manifestOf(manifests, "Ingress");
    expect(path(ingress, "spec.rules.0.host")).toBe("agents.example.com");
    expect(path(ingress, "spec.rules.0.http.paths.0.backend.service.name")).toBe("us-agent-vp-eng-20aa33e2");
  });

  test("projects real secret values only when the caller supplies them", () => {
    const manifests = renderAgentKubernetesManifests(baseRuntime(), {
      secretEnv: {
        OPENAI_API_KEY: "sk-test",
        GITHUB_TOKEN: "ghp-test",
      },
    });

    const secret = manifestOf(manifests, "Secret");
    expect(path(secret, "stringData")).toEqual({
      OPENAI_API_KEY: "sk-test",
      GITHUB_TOKEN: "ghp-test",
    });
    const deployment = manifestOf(manifests, "Deployment");
    expect(path(deployment, "spec.template.spec.containers.0.envFrom")).toEqual([
      { configMapRef: { name: "us-agent-vp-eng-20aa33e2-config" } },
      { secretRef: { name: "us-agent-vp-eng-20aa33e2-secrets", optional: true } },
    ]);
  });

  test("projects an operator-managed external secret without rendering secret contents", () => {
    const manifests = renderAgentKubernetesManifests(baseRuntime(), {
      externalSecretName: "prod-agent-secrets",
    });

    expect(manifests.some((entry) => entry.kind === "Secret")).toBe(false);
    const deployment = manifestOf(manifests, "Deployment");
    expect(path(deployment, "spec.template.spec.containers.0.envFrom")).toEqual([
      { configMapRef: { name: "us-agent-vp-eng-20aa33e2-config" } },
      { secretRef: { name: "prod-agent-secrets", optional: true } },
    ]);
  });

  test("uses collision-resistant names for profiles that sanitize to the same DNS label", () => {
    const first = renderAgentKubernetesManifests(baseRuntime({ profile: "agent.alpha" }), { includeNamespace: false });
    const second = renderAgentKubernetesManifests(baseRuntime({ profile: "agent_alpha" }), { includeNamespace: false });

    expect(path(manifestOf(first, "Deployment"), "metadata.name")).not.toBe(path(manifestOf(second, "Deployment"), "metadata.name"));
    expect(validateKubernetesManifests(first).ok).toBe(true);
    expect(validateKubernetesManifests(second).ok).toBe(true);
  });

  test("reports structural errors that would make rendered resources fail cluster validation", () => {
    const manifests = renderAgentKubernetesManifests(baseRuntime(), { includeNamespace: false });
    const deployment = manifestOf(manifests, "Deployment");
    const spec = deployment.spec as Record<string, any>;
    spec.selector.matchLabels["unionstreet.ai/profile"] = "different";

    const validation = validateKubernetesManifests(manifests);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain("selector must match pod template labels");
  });

  test("reports cross-resource wiring errors for services, policies, and volumes", () => {
    const manifests = renderAgentKubernetesManifests(baseRuntime(), { includeNamespace: false });
    const service = manifestOf(manifests, "Service");
    const policy = manifestOf(manifests, "NetworkPolicy");
    const deployment = manifestOf(manifests, "Deployment");

    (service.spec as Record<string, any>).selector["unionstreet.ai/profile"] = "different";
    (policy.spec as Record<string, any>).podSelector.matchLabels["unionstreet.ai/profile"] = "different";
    (deployment.spec as Record<string, any>).template.spec.volumes[0].persistentVolumeClaim.claimName = "missing-workspace";

    const validation = validateKubernetesManifests(manifests);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain("Service/us-agent-vp-eng-20aa33e2 selector must match a rendered workload");
    expect(validation.errors.join("\n")).toContain("NetworkPolicy/us-agent-vp-eng-20aa33e2 selector must match a rendered workload");
    expect(validation.errors.join("\n")).toContain("references missing PersistentVolumeClaim/missing-workspace");
  });

  test("keeps generated Kubernetes names valid for long and symbol-heavy profiles", () => {
    const manifests = renderAgentKubernetesManifests(baseRuntime({
      profile: "VP Eng / Production Agents With A Very Long Name That Would Otherwise Blow Past DNS Limits!!!",
    }), {
      includeNamespace: false,
      externalSecretName: "Prod Agent Secret",
    });

    expect(validateKubernetesManifests(manifests)).toEqual({ ok: true, errors: [] });
    for (const entry of manifests) {
      expect(entry.name.length).toBeLessThanOrEqual(63);
      expect(entry.name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    }
    const deployment = manifestOf(manifests, "Deployment");
    expect(path(deployment, "spec.template.spec.containers.0.envFrom.1.secretRef.name")).toBe("prod-agent-secret");
  });

  test("preserves reserved runtime config even when workspace env tries to override it", () => {
    const manifests = renderAgentKubernetesManifests(baseRuntime({
      workspace: {
        env: {
          US_PROFILE: "attacker",
          US_RUNTIME_PROVIDER: "local",
          FEATURE_FLAG: "on",
        },
      },
    }));

    const config = manifestOf(manifests, "ConfigMap");
    expect(path(config, "data.US_PROFILE")).toBe("vp-eng");
    expect(path(config, "data.US_RUNTIME_PROVIDER")).toBe("kubernetes");
    expect(path(config, "data.FEATURE_FLAG")).toBe("on");
  });

  test("does not render public ingress for loopback or non-public runtime URLs", () => {
    const loopback = renderAgentKubernetesManifests(baseRuntime({
      ingress: {
        url: "http://127.0.0.1:0",
        public: true,
      },
    }));
    const internalOnly = renderAgentKubernetesManifests(baseRuntime({
      ingress: {
        url: "https://agents.example.com/vp-eng",
        public: false,
      },
    }));

    expect(loopback.some((entry) => entry.kind === "Ingress")).toBe(false);
    expect(internalOnly.some((entry) => entry.kind === "Ingress")).toBe(false);
  });

  test("renders job workloads with OnFailure restart policy and ttl cleanup", () => {
    const runtime = baseRuntime({
      workspace: {
        ttlMinutes: 15,
      },
    });
    const manifests = renderAgentKubernetesManifests(runtime, {
      workloadKind: "Job",
      includeNamespace: false,
    });

    expect(manifests.some((entry) => entry.kind === "Namespace")).toBe(false);
    const job = manifestOf(manifests, "Job");
    expect(path(job, "apiVersion")).toBe("batch/v1");
    expect(path(job, "spec.ttlSecondsAfterFinished")).toBe(900);
    expect(path(job, "spec.template.spec.restartPolicy")).toBe("OnFailure");
  });

  test("uses emptyDir and restrictive egress for non-persistent no-network runtimes", () => {
    const manifests = renderAgentKubernetesManifests(baseRuntime({
      storage: {
        persistent: false,
      },
      workspace: {
        network: "none",
      },
    }));

    expect(manifests.some((entry) => entry.kind === "PersistentVolumeClaim")).toBe(false);
    const deployment = manifestOf(manifests, "Deployment");
    expect(path(deployment, "spec.template.spec.volumes.0.emptyDir")).toEqual({});

    const policy = manifestOf(manifests, "NetworkPolicy");
    expect(path(policy, "spec.egress")).toEqual([]);
  });

  test("dumps parseable multi-document yaml", () => {
    const rendered = renderAgentKubernetesManifests(baseRuntime(), { includeNamespace: false });
    const docs = yaml.loadAll(dumpKubernetesManifests(rendered)) as KubernetesManifest[];

    expect(docs).toHaveLength(rendered.length);
    expect(docs.map((doc) => doc.kind)).toEqual(rendered.map((entry) => entry.kind));
  });
});

function baseRuntime(overrides: {
  profile?: string;
  storage?: Partial<ResolvedAgentRuntime["storage"]>;
  ingress?: Partial<ResolvedAgentRuntime["ingress"]>;
  workspace?: Partial<ResolvedAgentRuntime["workspace"]>;
} = {}): ResolvedAgentRuntime {
  return {
    profile: overrides.profile ?? "vp-eng",
    head: {
      mode: "remote",
      provider: "kubernetes",
      endpoint: "https://head.example.com",
      honcho: {
        baseUrl: "https://honcho.example.com",
        workspaceId: "prod",
      },
    },
    compute: {
      provider: "kubernetes",
      target: "pod",
      image: "ghcr.io/unionstreet/agent-runtime:test",
      cpu: "500m",
      memory: "1Gi",
    },
    storage: {
      provider: "volume",
      mountPath: "/workspace",
      persistent: true,
      encryption: "provider-managed",
      ...overrides.storage,
    },
    ingress: {
      provider: "kubernetes-ingress",
      url: "https://agents.example.com/vp-eng",
      internalUrl: "https://us-agent-vp-eng.union-street.svc.cluster.local",
      public: true,
      auth: "federation-jwt",
      receives: ["mcp", "lash", "webhook", "control"],
      ...overrides.ingress,
    },
    workspace: {
      provider: "kubernetes",
      scope: "agent",
      workdir: "/workspace",
      region: "local",
      size: "20Gi",
      network: "egress",
      persistent: true,
      labels: {
        namespace: "agents",
      },
      env: {
        FEATURE_FLAG: "on",
      },
      ...overrides.workspace,
    },
    workspacePath: "/workspace",
    pluginId: "runtime-kubernetes",
    terraformModule: "plugins/runtime-kubernetes/terraform",
    secrets: [
      { id: "profile:vp-eng", allowed: true, reason: "implicit", env: [], missing: [] },
      { id: "github", allowed: true, reason: "allowed", provider: "local", env: ["GITHUB_TOKEN"], missing: [] },
      { id: "finance", allowed: false, reason: "denied", provider: "local", env: ["STRIPE_KEY"], missing: [] },
    ],
    warnings: [],
  };
}

function manifestOf(manifests: Array<{ kind: string; manifest: KubernetesManifest }>, kind: string): KubernetesManifest {
  const match = manifests.find((entry) => entry.kind === kind);
  expect(match, `expected manifest kind ${kind}`).toBeDefined();
  return match!.manifest;
}

function path(value: unknown, keyPath: string): unknown {
  return keyPath.split(".").reduce<unknown>((current, key) => {
    if (current == null) return undefined;
    if (Array.isArray(current)) return current[Number(key)];
    if (typeof current === "object") return (current as Record<string, unknown>)[key];
    return undefined;
  }, value);
}
