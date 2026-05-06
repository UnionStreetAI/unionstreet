# Union Street — `us`

Minimal multi-agent harness. Recursive delegation, peered memory, autonomous wakeups.

> Set up once. Watch the agents go.

## Local install

```sh
# 1. Bun 1.3+ (macOS or Linux)
curl -fsSL https://bun.sh/install | bash

# 2. Dependencies
bun install

# 3. Verify this machine can run local agents with Honcho memory
bun run doctor
```

Node 20+, Git, Postgres, pgvector, and `uv` are required for a ready local v1
machine. Union Street writes profile-scoped JSONL memory events as a durable
local log, but Honcho-backed memory peering is part of the core local runtime
contract.

On macOS, install the Honcho memory dependencies with:

```sh
brew install postgresql@17 pgvector
brew services start postgresql@17
curl -LsSf https://astral.sh/uv/install.sh | sh
```

On Linux, install Bun, Node 20+, Git, a Postgres 16/17 server, the matching
`pgvector` extension package, and `uv` with your preferred package manager.
Postgres packaging differs by distro, so `bun run doctor` prints generic Linux
remediation instead of pretending there is one universal command.

## Quick start

```sh
bun run us init coder
bun run us chat coder
```

For a non-interactive local sanity check:

```sh
bun run us federation demo-org --profiles
bun run us runtime status coo
bun run check:fast
```

## Agent Runtimes

Every profile has a runtime contract with four parts:

- `head` coordinates the agent with Honcho/control-plane state.
- `compute` describes where the agent runs: host, container, pod, VM, function, or sandbox.
- `storage` describes the agent workspace mount or bucket/volume.
- `ingress` describes the HTTP/S URL used for MCP, Lash, webhooks, and control callbacks.

Local host mode is the v1 target and default. Docker, Kubernetes, cloud, and
sandbox backends live under `plugins/runtime-*`; those are v2 hardening targets
and should be treated as provider contracts/scaffolds unless a provider-specific
test says otherwise.

```sh
bun run us runtime status coder
bun run us runtime ensure coder
```

Runtime/API hardening, MCP URL policy, webhook signatures, secrets, scheduler, and accounting contracts are documented in [`docs/control-plane-runtime.md`](docs/control-plane-runtime.md).

Plugin direction and the proposed infra/behavior plugin contract are documented in [`docs/plugin-architecture.md`](docs/plugin-architecture.md).

## Status

Pre-alpha. This repository is ready for source-level evaluation, local
development, and architecture review. It is not a production runtime and the
Union Street packages are not published to npm yet; workspace dependencies are
intended to resolve inside this repo.

Works today:

- local profile creation, chat entrypoints, auth status, MCP status, scheduler,
  federation, prompt-runner, and runtime CLI flows covered by `bun run check:fast`
- the local runtime contract and loopback-first development path
- Docker runtime planning and image scaffolding that installs from public npm
- Kubernetes manifest render and dry-run validation
- SDK generation from the repo OpenAPI contract
- Lash peer protocol integration through published `@lashprotocol/lash`

Scaffold or hardening target:

- Kubernetes apply/reconcile is not implemented; the current path is render and
  validate only
- cloud/runtime provider plugins are provider contracts until their own
  provider-specific tests say otherwise
- a fresh machine still needs model-provider onboarding before real agent
  prompts can run
- npm publishing for Union Street packages needs a release process that rewrites
  workspace dependencies to versioned package dependencies

## Layout

- `packages/server` — agents, runs, memory, plugins, providers, runtime HTTP, and control-plane contracts
- `packages/us-cli` — `us` entrypoint
- `plugins/*` — channel, storage, and runtime provider plugins

Root `.mcp.json` files are treated as local operator config; use
`.mcp.example.json` as the checked-in demo shape.

Built on [`lash`](https://github.com/UnionStreetAI/lash-ts) for peer-to-peer MCP and [`honcho`](https://honcho.dev) for memory.
