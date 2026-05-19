# Docs For Humans

Union Street is **The Multi-Agent System**: profiles, managers, direct reports,
scoped tools, memory, schedules, delegation, and OIDC identity for agent work.

These docs are the human map. They explain the concepts, the shape of the
system, and the shortest useful paths through it.

If you want an AI agent to operate Union Street directly, install the root
operating skill:

```sh
bunx skills add https://github.com/UnionStreetAI/unionstreet --skill managing-union-street
```

That skill routes agents to the repo-local playbooks under `skills/`: defining
agents, creating fleets, scoping MCP tools, configuring delegation, managing
memory, setting schedules, and inspecting runtime state.

## Start Here

- [Concepts](concepts.md) — the mental model: profiles, federation, delegation,
  tools, memory, and runtime.
- [Quickstart](quickstart.md) — install, check the host, create a profile, and
  open the TUI.
- [Agent Organizations](agent-organizations.md) — how profiles become an org
  chart with managers, reports, roles, and groups.
- [Identity](identity.md) — OIDC-style principals for agents.
- [Tools](tools.md) — scoped MCP auth and plugin grants.
- [Runtime](runtime.md) — running on a laptop, Docker/Kubernetes shape, and the
  airgapped VPC story.
- [Skills](skills.md) — how Union Street’s repo-local skills turn the docs into
  agent-operable procedures.

## Reference Docs

- [Control Plane And Runtime Contracts](control-plane-runtime.md)
- [Install Script](install.md)
- [Plugin Architecture](plugin-architecture.md)
- [Server SDK](server-sdk.md)
- [Storage And Embeddings](storage-and-embeddings.md)
- [Testing Battery](testing.md)
- [Release Pipeline](release.md)
