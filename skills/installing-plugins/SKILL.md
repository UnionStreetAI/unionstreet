---
name: installing-plugins
description: Install, inspect, grant, and debug Union Street plugins that bundle skills, MCP servers, CLI guidance, custom tools, apps, or runtime providers. Use when adding plugins to agents or departments.
license: MIT
compatibility: Requires Union Street plugin manifests and plugin CLI commands.
---

# Installing Plugins

Plugins are capability bundles. Grant them only where needed.

## Workflow

1. Inspect registry with `bun run us plugins list`.
2. Validate with `bun run us plugins doctor`.
3. Inspect a plugin with `bun run us plugins inspect <plugin>`.
4. Add plugin ids to fleet plan `plugins` for the head, department, or specific agent.
5. Apply the plan and verify with `bun run us plugins agent <agent>`.

## Rules

- Skills teach behavior.
- MCP provides external tool protocols.
- CLI guidance teaches command usage.
- Custom tools become model-callable tools.
- Runtime provider plugins do not mean the runtime is production-ready.

## Reference Config

Use `references/plugin-grant.yaml` for the relationship between plugin manifests and per-agent grants.
