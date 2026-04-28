# Union Street — `us`

Minimal multi-agent harness. Recursive delegation, peered memory, autonomous wakeups.

> Set up once. Watch the agents go.

## Install

```sh
# 1. Bun (if not already)
curl -fsSL https://bun.sh/install | bash

# 2. Postgres 17 + pgvector (honcho memory store)
brew install postgresql@17 pgvector
brew services start postgresql@17

# 3. us
bun install -g @unionstreet/us

# verify
us doctor
```

## Quick start

```sh
us init coder
us chat coder
```

## Agent Runtimes

Every profile has a runtime contract with four parts:

- `head` coordinates the agent with Honcho/control-plane state.
- `compute` describes where the agent runs: host, container, pod, VM, function, or sandbox.
- `storage` describes the agent workspace mount or bucket/volume.
- `ingress` describes the HTTP/S URL used for MCP, Lash, webhooks, and control callbacks.

Local host mode is the default. Cloud and sandbox backends live under `plugins/runtime-*` and expose the same Terraform-shaped outputs: `compute_endpoint`, `storage_mount`, `ingress_url`, and `control_url`.

```sh
us runtime status coder
us runtime ensure coder
```

## Status

Pre-alpha. See `unionstreet-agent/` (sibling repo for design notes).

## Layout

- `packages/us-core` — agent loop, prompt assembly, MCP client
- `packages/us-runtime` — gateway daemon, peer registry, honcho lifecycle, webhook ingress
- `packages/us-cli` — `us` entrypoint
- `plugins/*` — channel, storage, and runtime provider plugins

Built on [`lash`](https://github.com/UnionStreetAI/lash-ts) for peer-to-peer MCP and [`honcho`](https://honcho.dev) for memory.
