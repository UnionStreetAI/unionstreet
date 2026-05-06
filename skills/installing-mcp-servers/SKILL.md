---
name: installing-mcp-servers
description: Install, authenticate, scope, and inspect MCP servers for Union Street agents. Use when adding GitHub, Linear, Slack, browser, or other MCP access to a profile or department.
license: MIT
compatibility: Requires Union Street MCP auth commands and agent packs.
---

# Installing MCP Servers

MCP access must be agent-scoped.

## Workflow

1. Add server id to the agent or department fleet plan field `mcp`.
2. Apply the plan so federation grants are created.
3. Authenticate with `bun run us mcp auth <server> -p <agent>` or `bun run us <agent> mcp auth <server>`.
4. Inspect with `bun run us mcp status -p <agent>`.
5. Verify `bun run us plugins agent <agent>` if the MCP server is part of a plugin bundle.

## Security

- Prefer profile-scoped credentials over global credentials.
- Never paste secrets into plan files.
- Remote MCP URLs must reject loopback/private/metadata addresses unless explicitly in local dev mode.

## Reference Config

Use `references/mcp-grant.yaml` for the safe path from fleet plan to scoped auth.
