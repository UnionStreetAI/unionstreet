# runtime-docker

Docker runtime provider for agent workspaces. Intended shape: one container per agent or session, mounted persistent volume, and a host-routed HTTP endpoint for MCP, Lash, webhooks, and control traffic.

Contract outputs: `compute_endpoint`, `storage_mount`, `ingress_url`, `control_url`.

## Current implementation

Docker is the first mechanical runtime provider for Union Street agents. The
core provider can render a deterministic `docker run` plan, start or reuse an
agent container, inspect container status, and destroy the container.

```sh
us-dev runtime render <profile> --provider docker --image ghcr.io/unionstreet/agent-runtime:latest
us-dev runtime ensure <profile> --provider docker --image ghcr.io/unionstreet/agent-runtime:latest
us-dev runtime destroy <profile> --provider docker
```

The image scaffolding lives under `docker/`:

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

These scripts build from this repository root; Lash is consumed from the
published `@lashprotocol/lash` package.
