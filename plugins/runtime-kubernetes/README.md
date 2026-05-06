# runtime-kubernetes

Kubernetes runtime provider for distributed Union Street agents. Intended shape: pod or deployment per agent pool, persistent volume claims for workspaces, and ingress/service endpoints for MCP, Lash, webhooks, and control traffic.

Contract outputs: `compute_endpoint`, `storage_mount`, `ingress_url`, `control_url`.

## Current implementation

`@unionstreet/server` can render a resolved agent runtime contract into a
Kubernetes resource bundle:

- `Namespace`
- `ServiceAccount`
- `ConfigMap`
- `Secret` only when secret values are explicitly supplied to the renderer
- `PersistentVolumeClaim` when storage is persistent
- `Deployment`, `Job`, or `Pod`
- `Service`
- `Ingress` when public ingress is configured with a non-loopback URL
- `NetworkPolicy`

Render manifests with:

```sh
bun run us runtime render <profile>
bun run us runtime render <profile> --namespace union-street --workload Job
bun run us runtime render <profile> --external-secret prod-agent-secrets
bun run us runtime ensure <profile> --provider kubernetes --dry-run
bun run us runtime ensure <profile> --provider kubernetes --dry-run --namespace union-street --workload Job
```

The render/dry-run path validates the generated resource bundle before writing
YAML. It is intentionally read-only. A later reconciler should apply the same
rendered manifests through the Kubernetes API or `kubectl`.
