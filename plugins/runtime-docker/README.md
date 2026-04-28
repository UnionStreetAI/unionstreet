# runtime-docker

Docker runtime provider for agent workspaces. Intended shape: one container per agent or session, mounted persistent volume, and a host-routed HTTP endpoint for MCP, Lash, webhooks, and control traffic.

Contract outputs: `compute_endpoint`, `storage_mount`, `ingress_url`, `control_url`.

## Current implementation

Docker is currently the image/parity layer, not the canonical production
orchestrator. The image scaffolding lives under `docker/`:

- `Dockerfile.runtime` runs the runtime/head API on `0.0.0.0:8787`
- `Dockerfile.agent` runs an agent-runtime-compatible API image
- `Dockerfile.dashboard` builds the dashboard and serves static assets

Build scripts are available from the repo root:

```sh
bun run image:runtime
bun run image:agent
bun run image:dashboard
bun run image:all
```

The current package graph depends on sibling `lash-ts`, so these scripts build
with the parent `Code` directory as Docker context.
