# Concepts

Union Street gives agent work the things normal systems get: identity,
permissions, routing, memory, schedules, events, and runtime boundaries.

The shortest version:

- **Profiles** name the agents.
- **Agent packs** define who they are and what they can do.
- **Federation** turns profiles into principals with managers, reports, roles,
  and groups.
- **Delegation** moves work between agents through the org graph.
- **MCP tools** are granted per agent instead of globally.
- **Memory** is local and inspectable first.
- **Runtime contracts** describe where agents run and what they can access.
- **Events and usage** leave a trail.

## Profile

A profile is the addressable agent. You can chat with it, prompt it, inspect it,
give it tools, put it in a fleet, and route work to or from it.

```sh
us init coder --role engineer
us tui coder
```

Profiles live under `~/.us/profiles/<name>`. The important files are the agent
pack and instructions that describe identity, model routing, tools, memory,
runtime, schedules, and delegation behavior.

## Agent Pack

An agent pack is the source of truth for a profile. It is not just prompt text.
It carries operational state:

- identity and OIDC subject
- model chain
- manager and direct reports
- roles and groups
- toolkit and plugin grants
- MCP access
- memory policy
- runtime shape
- schedules and pulse

For one agent, `us init` is enough. For multiple agents, use a fleet plan.

## Federation

Federation is the org graph plus identity. It answers:

- Who is this agent?
- Who manages it?
- Who reports to it?
- What roles and groups does it have?
- What can it see or delegate to?

Union Street treats agents as OIDC-style principals. That gives tool access,
peer visibility, runtime secrets, memory, usage, and audit records something
real to hang from.

## Delegation

Delegation is visible work routing. A head agent can ask a direct report to do
work, receive a structured report, and preserve trace context.

The goal is not hidden recursion inside one transcript. The goal is agent work
that can be inspected later.

## Tools

Tools are scoped. An agent can have MCP credentials without every other agent
sharing them. Prefer grants by agent, group, or department over global access.

## Runtime

Union Street runs as a local CLI and runtime API today. The contract shape is
designed to carry forward into Docker, Kubernetes, VPC, and sandbox providers:
compute, storage, ingress, workspace, secrets, and identity.

Read next:

- [Quickstart](quickstart.md)
- [Agent Organizations](agent-organizations.md)
- [Identity](identity.md)
