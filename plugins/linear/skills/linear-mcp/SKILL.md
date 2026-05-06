---
name: linear-mcp
description: Use Linear through the official remote MCP server. Use for finding, creating, and updating Linear issues, projects, cycles, comments, and team planning context.
---

# Linear MCP

Use the granted `linear` MCP server for Linear work. Do not invent a local CLI wrapper.

## Setup Shape

```json
{
  "mcpServers": {
    "linear": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.linear.app/mcp"]
    }
  }
}
```

## Workflow

1. Read existing issues/projects first.
2. Summarize relevant status, owners, blockers, and next actions.
3. Ask before creating or mutating issues unless write actions are explicitly allowed.
4. When creating work, include title, team/project, priority, description, links, and acceptance criteria.
5. When updating work, leave concise comments with evidence and trace context.

## Notes

- Linear MCP uses OAuth with the remote endpoint `https://mcp.linear.app/mcp`.
- API keys or OAuth tokens can also be passed as bearer credentials by clients that support it.
- Keep Linear access scoped to the agent or department that owns the work queue.
