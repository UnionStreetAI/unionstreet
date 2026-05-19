# Union Street

Union Street is a local-first multi-agent runtime for building small, explicit
agent organizations: profiles, managers, direct reports, schedules, memory,
MCP tools, and peer-to-peer delegation over [Lash](https://github.com/UnionStreetAI/lash-ts).

It is not another model wrapper. Union Street is the control plane around the
work: who an agent is, what it may access, how it delegates, where it runs, what
it remembers, and how its work is audited.

## Why It Exists

Most agent projects start as a chat loop and slowly accrete operational rules.
Union Street starts from the other end:

- every agent is a named profile with a role, model chain, manager, direct
  reports, runtime, toolkit, memory policy, schedules, and pulse settings
- delegation is an explicit protocol event, not a hidden subroutine
- memory is local and inspectable first, with Honcho-backed peering for shared
  context
- MCP credentials and tools are granted per agent instead of assumed globally
- runtime contracts describe compute, storage, ingress, and workspace boundaries
- tests exercise local prompts, events, scheduling, MCP, Lash, auth, and runtime
  guardrails together

The result is a boringly inspectable harness for agent teams: local enough to
hack on, structured enough to grow into real operations.

## Current Status

**Pre-alpha.** This repository is ready for source-level evaluation, local
development, and architecture review. It is not a production runtime.

What works today:

- local profile creation and profile-scoped agent packs
- interactive chat entrypoints and non-interactive prompt runs
- model/provider auth status and setup flows
- MCP status, auth metadata, and private-URL guardrails
- Lash-shaped peer wake/delegation/result flows
- scheduler, pulse, events, usage, sessions, and local memory records
- runtime HTTP API with OpenAPI and a typed SDK
- local host runtime as the v1 target
- Docker runtime planning/start/status/destroy mechanics
- Kubernetes manifest render and dry-run validation
- plugin manifests, plugin inspection, and repo-local skill bundles
- npm install via `bunx @unionstreet/us` (single package; pre-alpha)

What is intentionally not promised yet:

- production hardening for untrusted agents
- Kubernetes apply/reconcile
- complete cloud runtime providers
- hands-off onboarding on a fresh machine without model-provider credentials

## Quick Start

Requirements:

- macOS or Linux
- Bun 1.3+
- Node 20+
- Git
- Postgres 16/17 with pgvector
- `uv`

Install and verify:

```sh
curl -fsSL https://unionstreet.ai/install.sh | bash
us doctor
```

From git (contributors):

```sh
curl -fsSL https://bun.sh/install | bash
bun install
bun run doctor
```

See [Install script](docs/install.md) for pinned versions and GitHub-hosted URLs.

On macOS, the local memory substrate can be installed with:

```sh
brew install postgresql@17 pgvector
brew services start postgresql@17
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Create a profile and open the chat UI:

```sh
bun run us init coder
bun run us chat coder
# or: bun run us tui coder
```

Run a non-interactive local sanity check:

```sh
bun run us federation demo-org --profiles
bun run us runtime status coo
bun run check:fast
```

## Architecture

Union Street is organized around a few explicit contracts:

- **Agent packs** define identity, chain of command, model routing, toolkit,
  memory, runtime, schedules, and pulse behavior.
- **Federation** gives each agent a principal, manager, direct reports, roles,
  and groups.
- **Lash** carries peer delegation and structured results through normal MCP
  tool calls.
- **Runtime contracts** describe where an agent runs: head, compute, storage,
  ingress, and workspace.
- **Events and usage** are append-only JSONL records with recursive redaction.
- **Plugins and skills** package capabilities without making them globally
  available by default.

Read more:

- [Docs For Humans](docs/index.md) — the conceptual map.
- [Quickstart](docs/quickstart.md) — install, setup, first profile, first fleet.
- [Agent Organizations](docs/agent-organizations.md) — profiles, managers,
  reports, roles, groups, and fleet plans.
- [Identity](docs/identity.md) — OIDC-style principals for agents.
- [Tools](docs/tools.md) — scoped MCP auth and plugin grants.
- [Runtime](docs/runtime.md) — laptop, Docker/Kubernetes shape, and VPC story.
- [Skills](docs/skills.md) — installable operating playbooks for AI agents.
- [Control Plane And Runtime Contracts](docs/control-plane-runtime.md)
- [Plugin Architecture](docs/plugin-architecture.md)
- [Server SDK](docs/server-sdk.md)
- [Testing Battery](docs/testing.md)
- Marketing site: [unionstreet-web](https://github.com/UnionStreetAI/unionstreet-web) (`unionstreet.ai`)

## Runtime Targets

Local host mode is the v1 target and default. Docker is the first mechanical
runtime provider. Kubernetes can render and validate manifests, but does not
apply them yet. Cloud and sandbox backends under `plugins/runtime-*` are
provider contracts and hardening targets unless their README says otherwise.

```sh
bun run us runtime status coder
bun run us runtime ensure coder
bun run us runtime render coder --provider docker
bun run us runtime render coder --provider kubernetes --dry-run
```

Root `.mcp.json` files are treated as local operator config and are ignored by
git. Use [.mcp.example.json](.mcp.example.json) as the checked-in demo shape.

## Repository Layout

- [packages/server](packages/server) owns agents, federation, Lash, memory,
  plugins, providers, runtime HTTP, events, usage, scheduler, and OpenAPI.
- [packages/us-cli](packages/us-cli) is the local `us` entrypoint.
- [packages/sdk](packages/sdk) is the typed client for the runtime API.
- [packages/us-dashboard](packages/us-dashboard) is the local dashboard.
- [plugins](plugins) contains app, workflow, and runtime provider plugins.
- [skills](skills) contains Union Street operating playbooks for agents.
- [docs](docs) contains the public contracts and testing notes.

## Development Gates

For normal changes:

```sh
bun install --frozen-lockfile
bun run check:full
bun audit
```

Install from npm (Bun 1.3+): `bunx @unionstreet/us`. Maintainers: [Release pipeline](docs/release.md).

Live provider tests are opt-in:

```sh
bun run check:live
```

## License

MIT. See [LICENSE](LICENSE).
