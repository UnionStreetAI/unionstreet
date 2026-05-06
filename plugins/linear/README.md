# Linear Plugin

Linear MCP workflow plugin for Union Street.

## Capabilities

- Issue and project lookup through Linear's official remote MCP server.
- Issue creation and updates when granted and approved.
- Comment/status updates for agent-generated work.
- Planning context for departments that manage product, engineering, support, or operations queues.

## Requirements

- MCP client support for remote/HTTP MCP, or `npx -y mcp-remote https://mcp.linear.app/mcp`.
- Linear OAuth through the MCP auth flow, or a Linear API/OAuth token supplied as a bearer credential when supported by the client.

## Safety Defaults

Read first. Write actions such as creating issues, updating status, assigning owners, or posting comments should be proposed first unless `allowWriteActions` is enabled in plugin config.

## Source

Uses Linear's official remote MCP server at `https://mcp.linear.app/mcp`.
