import yaml from "js-yaml";
import type { ResolvedAgentRuntime } from "./cloud-runtime.ts";

export type KubernetesAgentWorkloadKind = "Deployment" | "Job" | "Pod";

export interface KubernetesRenderOptions {
  namespace?: string;
  workloadKind?: KubernetesAgentWorkloadKind;
  image?: string;
  imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  serviceAccountName?: string;
  externalSecretName?: string;
  secretEnv?: Record<string, string>;
  appName?: string;
  includeNamespace?: boolean;
}

export interface KubernetesRenderedManifest {
  kind: string;
  name: string;
  manifest: KubernetesManifest;
}

export type KubernetesManifest = Record<string, unknown>;

export interface KubernetesManifestValidation {
  ok: boolean;
  errors: string[];
}

const DEFAULT_NAMESPACE = "union-street";
const DEFAULT_AGENT_IMAGE = "ghcr.io/unionstreet/agent-runtime:latest";
const DEFAULT_SERVICE_ACCOUNT = "union-street-agent";
const DEFAULT_APP_NAME = "union-street";
const DEFAULT_PORT = 8787;

export function renderAgentKubernetesManifests(
  runtime: ResolvedAgentRuntime,
  options: KubernetesRenderOptions = {},
): KubernetesRenderedManifest[] {
  const namespace = dnsLabel(options.namespace ?? runtime.workspace.labels?.namespace ?? DEFAULT_NAMESPACE);
  const appName = dnsLabel(options.appName ?? DEFAULT_APP_NAME);
  const profileName = dnsLabel(runtime.profile);
  const workloadName = resourceName("us-agent", runtime.profile);
  const serviceName = workloadName;
  const configName = resourceName("us-agent", runtime.profile, "config");
  const renderedSecretName = resourceName("us-agent", runtime.profile, "secrets");
  const externalSecretName = options.externalSecretName ? dnsLabel(options.externalSecretName) : undefined;
  const secretName = options.secretEnv && Object.keys(options.secretEnv).length ? renderedSecretName : externalSecretName;
  const pvcName = resourceName("us-agent", runtime.profile, "workspace");
  const serviceAccountName = dnsLabel(options.serviceAccountName ?? DEFAULT_SERVICE_ACCOUNT);
  const image = options.image ?? runtime.compute.image ?? runtime.workspace.image ?? DEFAULT_AGENT_IMAGE;
  const workloadKind = options.workloadKind ?? "Deployment";
  const labels = baseLabels(appName, profileName);
  const port = readPort(runtime.ingress.internalUrl ?? runtime.ingress.url) ?? DEFAULT_PORT;
  const mountPath = runtime.storage.mountPath || runtime.workspace.workdir || "/workspace";
  const configEnv = runtimeConfigEnv(runtime, namespace, serviceName);
  const command = runtime.compute.command;

  const manifests: KubernetesRenderedManifest[] = [];
  if (options.includeNamespace ?? true) {
    manifests.push(named("Namespace", namespace, {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: namespace,
        labels: {
          "app.kubernetes.io/part-of": appName,
        },
      },
    }));
  }

  manifests.push(named("ServiceAccount", serviceAccountName, {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: {
      name: serviceAccountName,
      namespace,
      labels,
    },
  }));

  manifests.push(named("ConfigMap", configName, {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: configName,
      namespace,
      labels,
    },
    data: configEnv,
  }));

  if (options.secretEnv && Object.keys(options.secretEnv).length) {
    manifests.push(named("Secret", renderedSecretName, {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: renderedSecretName,
        namespace,
        labels,
      },
      type: "Opaque",
      stringData: options.secretEnv,
    }));
  }

  if (runtime.storage.persistent) {
    manifests.push(named("PersistentVolumeClaim", pvcName, {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name: pvcName,
        namespace,
        labels,
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: {
          requests: {
            storage: runtime.workspace.size ?? "10Gi",
          },
        },
      },
    }));
  }

  manifests.push(named(workloadKind, workloadName, workloadManifest({
    kind: workloadKind,
    name: workloadName,
    namespace,
    labels,
    serviceAccountName,
    image,
    imagePullPolicy: options.imagePullPolicy ?? "IfNotPresent",
    command,
    configName,
    secretName,
    pvcName,
    persistent: runtime.storage.persistent,
    mountPath,
    port,
    resources: runtimeResources(runtime),
    ttlSecondsAfterFinished: runtime.workspace.ttlMinutes ? runtime.workspace.ttlMinutes * 60 : undefined,
  })));

  manifests.push(named("Service", serviceName, {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: serviceName,
      namespace,
      labels,
    },
    spec: {
      type: "ClusterIP",
      selector: labels,
      ports: [{
        name: "http",
        port,
        targetPort: "http",
      }],
    },
  }));

  const ingressHost = runtime.ingress.public && runtime.ingress.url ? readPublicIngressHost(runtime.ingress.url) : undefined;
  if (ingressHost) {
    manifests.push(named("Ingress", serviceName, ingressManifest({
      name: serviceName,
      namespace,
      labels,
      serviceName,
      port,
      host: ingressHost,
    })));
  }

  manifests.push(named("NetworkPolicy", workloadName, {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: workloadName,
      namespace,
      labels,
    },
    spec: {
      podSelector: { matchLabels: labels },
      policyTypes: ["Ingress", "Egress"],
      ingress: [{
        ports: [{ protocol: "TCP", port }],
      }],
      egress: networkPolicyEgress(runtime.workspace.network),
    },
  }));

  return manifests;
}

export function validateKubernetesManifests(manifests: KubernetesRenderedManifest[]): KubernetesManifestValidation {
  const errors: string[] = [];
  const seen = new Set<string>();
  const byKindName = new Set(manifests.map((entry) => `${entry.kind}/${entry.name}`));
  const podLabelSets = manifests.flatMap((entry) => renderedPodLabels(entry));

  for (const entry of manifests) {
    const manifest = entry.manifest;
    const metadata = readRecord(manifest.metadata);
    const spec = readRecord(manifest.spec);
    const namespace = readString(metadata.namespace);
    const key = `${entry.kind}/${namespace ?? "_cluster"}/${entry.name}`;

    if (seen.has(key)) errors.push(`duplicate manifest identity: ${key}`);
    seen.add(key);
    if (!readString(manifest.apiVersion)) errors.push(`${entry.kind}/${entry.name} missing apiVersion`);
    if (manifest.kind !== entry.kind) errors.push(`${entry.kind}/${entry.name} kind metadata does not match manifest kind`);
    if (readString(metadata.name) !== entry.name) errors.push(`${entry.kind}/${entry.name} metadata.name does not match rendered name`);
    if (!isDnsLabel(entry.name)) errors.push(`${entry.kind}/${entry.name} is not a valid DNS label`);
    if (namespace && !isDnsLabel(namespace)) errors.push(`${entry.kind}/${entry.name} namespace is not a valid DNS label`);

    if (entry.kind === "Deployment") validateDeployment(entry, spec, byKindName, errors);
    if (entry.kind === "Job") validateJob(entry, spec, byKindName, errors);
    if (entry.kind === "Pod") validatePodSpec(entry, spec, byKindName, errors, `${entry.kind}/${entry.name}`);
    if (entry.kind === "Service") validateService(entry, spec, podLabelSets, errors);
    if (entry.kind === "Ingress") validateIngress(entry, spec, byKindName, errors);
    if (entry.kind === "NetworkPolicy") validateNetworkPolicy(entry, spec, podLabelSets, errors);
  }

  return { ok: errors.length === 0, errors };
}

export function dumpKubernetesManifests(manifests: KubernetesRenderedManifest[]): string {
  return manifests
    .map((entry) => yaml.dump(entry.manifest, { lineWidth: 120, noRefs: true }).trimEnd())
    .join("\n---\n") + "\n";
}

function workloadManifest(input: {
  kind: KubernetesAgentWorkloadKind;
  name: string;
  namespace: string;
  labels: Record<string, string>;
  serviceAccountName: string;
  image: string;
  imagePullPolicy: "Always" | "IfNotPresent" | "Never";
  command?: string[];
  configName: string;
  secretName?: string;
  pvcName: string;
  persistent: boolean;
  mountPath: string;
  port: number;
  resources: Record<string, unknown>;
  ttlSecondsAfterFinished?: number;
}): KubernetesManifest {
  const template = podTemplate({
    ...input,
    restartPolicy: input.kind === "Job" ? "OnFailure" : "Always",
  });
  if (input.kind === "Pod") {
    return {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: input.name,
        namespace: input.namespace,
        labels: input.labels,
      },
      spec: template.spec,
    };
  }
  if (input.kind === "Job") {
    return {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: input.name,
        namespace: input.namespace,
        labels: input.labels,
      },
      spec: {
        ...(input.ttlSecondsAfterFinished ? { ttlSecondsAfterFinished: input.ttlSecondsAfterFinished } : {}),
        backoffLimit: 1,
        template,
      },
    };
  }
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: input.labels,
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { ...input.labels } },
      strategy: { type: "RollingUpdate" },
      template,
    },
  };
}

function podTemplate(input: {
  labels: Record<string, string>;
  serviceAccountName: string;
  image: string;
  imagePullPolicy: "Always" | "IfNotPresent" | "Never";
  command?: string[];
  configName: string;
  secretName?: string;
  pvcName: string;
  persistent: boolean;
  mountPath: string;
  port: number;
  resources: Record<string, unknown>;
  restartPolicy: "Always" | "OnFailure";
}): KubernetesManifest {
  return {
    metadata: {
      labels: { ...input.labels },
    },
    spec: {
      serviceAccountName: input.serviceAccountName,
      restartPolicy: input.restartPolicy,
      containers: [{
        name: "agent-runtime",
        image: input.image,
        imagePullPolicy: input.imagePullPolicy,
        ...(input.command ? { command: input.command } : {}),
        ports: [{ name: "http", containerPort: input.port }],
        envFrom: envFromRefs(input.configName, input.secretName),
        volumeMounts: [{
          name: "workspace",
          mountPath: input.mountPath,
        }],
        readinessProbe: httpProbe("/health", input.port),
        livenessProbe: httpProbe("/health", input.port),
        resources: input.resources,
      }],
      volumes: [{
        name: "workspace",
        ...(input.persistent
          ? { persistentVolumeClaim: { claimName: input.pvcName } }
          : { emptyDir: {} }),
      }],
    },
  };
}

function ingressManifest(input: {
  name: string;
  namespace: string;
  labels: Record<string, string>;
  serviceName: string;
  port: number;
  host: string;
}): KubernetesManifest {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: input.labels,
    },
    spec: {
      rules: [{
        host: input.host,
        http: {
          paths: [{
            path: "/",
            pathType: "Prefix",
            backend: {
              service: {
                name: input.serviceName,
                port: { number: input.port },
              },
            },
          }],
        },
      }],
    },
  };
}

function runtimeConfigEnv(runtime: ResolvedAgentRuntime, namespace: string, serviceName: string): Record<string, string> {
  return {
    ...runtime.workspace.env,
    US_PROFILE: runtime.profile,
    US_RUNTIME_PROVIDER: "kubernetes",
    US_RUNTIME_PLUGIN: runtime.pluginId,
    US_HEAD_MODE: runtime.head.mode,
    US_HEAD_PROVIDER: runtime.head.provider,
    US_WORKSPACE_SCOPE: runtime.workspace.scope,
    US_WORKSPACE_PATH: runtime.workspacePath,
    US_STORAGE_PROVIDER: runtime.storage.provider,
    US_STORAGE_MOUNT: runtime.storage.mountPath,
    US_INGRESS_PROVIDER: runtime.ingress.provider,
    US_INGRESS_PUBLIC: String(runtime.ingress.public),
    US_INGRESS_AUTH: runtime.ingress.auth,
    US_AGENT_SECRET_GRANTS: runtime.secrets
      .filter((grant) => grant.allowed)
      .map((grant) => grant.id)
      .join(","),
    US_SERVICE_DNS: `${serviceName}.${namespace}.svc.cluster.local`,
    ...(runtime.head.endpoint ? { US_HEAD_ENDPOINT: runtime.head.endpoint } : {}),
    ...(runtime.ingress.url ? { US_INGRESS_URL: runtime.ingress.url } : {}),
    ...(runtime.ingress.internalUrl ? { US_INGRESS_INTERNAL_URL: runtime.ingress.internalUrl } : {}),
    ...(runtime.head.honcho?.baseUrl ? { HONCHO_BASE_URL: runtime.head.honcho.baseUrl } : {}),
    ...(runtime.head.honcho?.workspaceId ? { HONCHO_WORKSPACE_ID: runtime.head.honcho.workspaceId } : {}),
  };
}

function runtimeResources(runtime: ResolvedAgentRuntime): Record<string, unknown> {
  const requests: Record<string, string> = {};
  const limits: Record<string, string> = {};
  if (runtime.compute.cpu && runtime.compute.cpu !== "shared" && runtime.compute.cpu !== "host") {
    requests.cpu = runtime.compute.cpu;
  }
  if (runtime.compute.memory && runtime.compute.memory !== "host") {
    requests.memory = runtime.compute.memory;
  }
  if (runtime.compute.gpu) {
    limits["nvidia.com/gpu"] = runtime.compute.gpu;
  }
  return {
    ...(Object.keys(requests).length ? { requests } : {}),
    ...(Object.keys(limits).length ? { limits } : {}),
  };
}

function networkPolicyEgress(network: ResolvedAgentRuntime["workspace"]["network"]): Array<Record<string, unknown>> {
  if (network === "none") return [];
  if (network === "private") return [{ to: [{ namespaceSelector: {} }] }];
  return [{}];
}

function envFromRefs(configName: string, secretName: string | undefined): Array<Record<string, unknown>> {
  return [
    { configMapRef: { name: configName } },
    ...(secretName ? [{ secretRef: { name: secretName, optional: true } }] : []),
  ];
}

function httpProbe(path: string, port: number): Record<string, unknown> {
  return {
    httpGet: {
      path,
      port,
    },
    initialDelaySeconds: 5,
    periodSeconds: 10,
  };
}

function baseLabels(appName: string, profile: string): Record<string, string> {
  return {
    "app.kubernetes.io/name": appName,
    "app.kubernetes.io/component": "agent-runtime",
    "app.kubernetes.io/managed-by": "union-street",
    "unionstreet.ai/profile": profile,
  };
}

function named(kind: string, name: string, manifest: KubernetesManifest): KubernetesRenderedManifest {
  return { kind, name, manifest };
}

function dnsLabel(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return normalized || "union-street";
}

function resourceName(prefix: string, profile: string, suffix?: string): string {
  const hash = fnv1a(profile).slice(0, 8);
  const tail = suffix ? `-${suffix}` : "";
  const baseBudget = 63 - hash.length - tail.length - 1;
  const base = dnsLabel(`${prefix}-${profile}`).slice(0, Math.max(1, baseBudget)).replace(/-+$/g, "");
  return dnsLabel(`${base}-${hash}${tail}`);
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isDnsLabel(value: string): boolean {
  return /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(value);
}

function validateDeployment(entry: KubernetesRenderedManifest, spec: Record<string, unknown>, manifests: Set<string>, errors: string[]): void {
  const selector = readRecord(readRecord(spec.selector).matchLabels);
  const template = readRecord(spec.template);
  const templateLabels = readRecord(readRecord(template.metadata).labels);
  if (!Object.keys(selector).length) errors.push(`${entry.kind}/${entry.name} selector must not be empty`);
  if (!labelsContain(templateLabels, selector)) errors.push(`${entry.kind}/${entry.name} selector must match pod template labels`);
  validatePodSpec(entry, readRecord(template.spec), manifests, errors, `${entry.kind}/${entry.name}`);
}

function validateJob(entry: KubernetesRenderedManifest, spec: Record<string, unknown>, manifests: Set<string>, errors: string[]): void {
  const template = readRecord(spec.template);
  validatePodSpec(entry, readRecord(template.spec), manifests, errors, `${entry.kind}/${entry.name}`);
}

function validatePodSpec(
  entry: KubernetesRenderedManifest,
  spec: Record<string, unknown>,
  manifests: Set<string>,
  errors: string[],
  label: string,
): void {
  const containers = readArray(spec.containers);
  const volumes = readArray(spec.volumes);
  if (!containers.length) errors.push(`${label} must define at least one container`);
  for (const container of containers) {
    const raw = readRecord(container);
    const image = readString(raw.image);
    if (!image) errors.push(`${label} container missing image`);
    for (const mount of readArray(raw.volumeMounts)) {
      const mountName = readString(readRecord(mount).name);
      if (mountName && !volumes.some((volume) => readString(readRecord(volume).name) === mountName)) {
        errors.push(`${label} mounts missing volume ${mountName}`);
      }
    }
    for (const envFrom of readArray(raw.envFrom)) {
      const secretName = readString(readRecord(readRecord(envFrom).secretRef).name);
      const configName = readString(readRecord(readRecord(envFrom).configMapRef).name);
      if (secretName && !isDnsLabel(secretName)) errors.push(`${label} has invalid secretRef ${secretName}`);
      if (configName && !isDnsLabel(configName)) errors.push(`${label} has invalid configMapRef ${configName}`);
      if (configName && !manifests.has(`ConfigMap/${configName}`)) errors.push(`${label} references missing ConfigMap/${configName}`);
    }
  }
  for (const volume of volumes) {
    const raw = readRecord(volume);
    const claimName = readString(readRecord(raw.persistentVolumeClaim).claimName);
    if (claimName && !manifests.has(`PersistentVolumeClaim/${claimName}`)) {
      errors.push(`${label} references missing PersistentVolumeClaim/${claimName}`);
    }
  }
  if (entry.kind === "Deployment" && spec.restartPolicy && spec.restartPolicy !== "Always") {
    errors.push(`${label} deployment restartPolicy must be Always`);
  }
  if (entry.kind === "Job" && spec.restartPolicy !== "OnFailure" && spec.restartPolicy !== "Never") {
    errors.push(`${label} job restartPolicy must be OnFailure or Never`);
  }
}

function validateService(
  entry: KubernetesRenderedManifest,
  spec: Record<string, unknown>,
  podLabelSets: Array<Record<string, unknown>>,
  errors: string[],
): void {
  const selector = readRecord(spec.selector);
  const ports = readArray(spec.ports);
  if (!Object.keys(selector).length) errors.push(`${entry.kind}/${entry.name} must define a selector`);
  if (Object.keys(selector).length && !podLabelSets.some((labels) => labelsContain(labels, selector))) {
    errors.push(`${entry.kind}/${entry.name} selector must match a rendered workload`);
  }
  if (!ports.length) errors.push(`${entry.kind}/${entry.name} must expose at least one port`);
}

function validateIngress(entry: KubernetesRenderedManifest, spec: Record<string, unknown>, manifests: Set<string>, errors: string[]): void {
  for (const rule of readArray(spec.rules)) {
    for (const path of readArray(readRecord(readRecord(rule).http).paths)) {
      const serviceName = readString(readRecord(readRecord(readRecord(path).backend).service).name);
      if (!serviceName) errors.push(`${entry.kind}/${entry.name} ingress path missing backend service`);
      else if (!manifests.has(`Service/${serviceName}`)) errors.push(`${entry.kind}/${entry.name} references missing Service/${serviceName}`);
    }
  }
}

function validateNetworkPolicy(
  entry: KubernetesRenderedManifest,
  spec: Record<string, unknown>,
  podLabelSets: Array<Record<string, unknown>>,
  errors: string[],
): void {
  const selector = readRecord(readRecord(spec.podSelector).matchLabels);
  if (!Object.keys(selector).length) errors.push(`${entry.kind}/${entry.name} must select pods explicitly`);
  if (Object.keys(selector).length && !podLabelSets.some((labels) => labelsContain(labels, selector))) {
    errors.push(`${entry.kind}/${entry.name} selector must match a rendered workload`);
  }
  if (!readArray(spec.policyTypes).length) errors.push(`${entry.kind}/${entry.name} must define policyTypes`);
}

function renderedPodLabels(entry: KubernetesRenderedManifest): Array<Record<string, unknown>> {
  const manifest = entry.manifest;
  if (entry.kind === "Pod") return [readRecord(readRecord(manifest.metadata).labels)];
  if (entry.kind === "Deployment" || entry.kind === "Job") {
    return [readRecord(readRecord(readRecord(readRecord(manifest.spec).template).metadata).labels)];
  }
  return [];
}

function labelsContain(labels: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => labels[key] === value);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function readHost(value: string): string | undefined {
  try {
    return new URL(value).hostname || undefined;
  } catch {
    return undefined;
  }
}

function readPublicIngressHost(value: string): string | undefined {
  const host = readHost(value);
  if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1") return undefined;
  return host;
}

function readPort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.port) {
      const port = Number(url.port);
      return port > 0 ? port : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
