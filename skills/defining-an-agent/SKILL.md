---
name: defining-an-agent
description: Define or modify a Union Street agent profile, identity, model chain, SOUL instructions, toolkit, plugins, memory, and runtime. Use when creating agents or editing agent.yaml/profile files.
license: MIT
compatibility: Requires a Union Street repository and Bun CLI commands.
---

# Defining An Agent

Use profile scaffolding and agent packs as the source of truth.

## Workflow

1. Create or fill profile files with `bun run us init <agent> --role <role> --capability <cap>`.
2. Prefer fleet plans for multi-agent changes. Single-agent edits may touch `~/.us/profiles/<agent>/agent.yaml` and `SOUL.md`.
3. Ensure `agent.yaml` contains:
   - `identity.profile`, `subject`, `title`, `manager`, `directReports`, `groups`, `roles`
   - `model.primary` and `model.fallback`
   - `lash.thread`, `delegate`, `report`, `structured`
   - `toolkit.cli`, `toolkit.mcp`, `toolkit.plugins`, `permissions`
   - `memory.provider: honcho`, `peerProfile`, and shared namespaces
   - `runtime.environment: local/host` for v1 unless asked otherwise
4. Validate with `bun run us federation status <agent>`, `bun run us plugins agent <agent>`, and focused tests.

## Good Defaults

- Head agents: stronger model, `delegate: descendants`, report aggregation, admin plugins only when needed.
- Department leads: `delegate: direct_reports`, department namespace, department plugins.
- Specialists: narrow tools, `report: manager`, no broad delegation by default.

## Reference Config

Use `references/agent-pack.yaml` when you need a compact example of a mature local v1 agent pack.
