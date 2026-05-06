---
name: configuring-messaging-gateways
description: Configure Union Street channel and messaging gateway integrations such as Slack, email, Discord, or other ingress/egress channels. Use when agents need to receive or send messages outside the CLI.
license: MIT
compatibility: Requires channel plugins, MCP servers, or webhook integrations depending on gateway.
---

# Configuring Messaging Gateways

Messaging gateways should be scoped like tools: per agent, department, or head agent.

## Workflow

1. Decide whether the gateway is ingress, egress, or both.
2. Prefer plugin/MCP configuration over ad hoc scripts.
3. Add grants to the relevant fleet plan agents.
4. Store credentials in auth profiles or environment secret grants, never in prompts.
5. Test a rejected unauthorized message and an accepted authorized message.

Keep human-facing channels approval-gated until behavior is proven.
