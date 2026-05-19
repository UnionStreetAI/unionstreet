# Agent Organizations

Union Street models agent work as a small organization.

That means agents are not anonymous subroutines. They have names, roles,
managers, direct reports, tools, schedules, memory, runtime boundaries, and
identity.

## Why an org chart?

Multi-agent systems get hard when every agent can talk to every other agent and
use every tool. An org chart gives the system a default shape:

- head agents coordinate
- department leads delegate to direct reports
- specialists do narrow work
- reports flow back up
- grants can be scoped by role, group, department, or profile

This is not about corporate theater. It is about visible routing.

## The core objects

### Profile

The addressable agent: `coo`, `vp-engineering`, `analyst`, `designer`.

### Agent pack

The profile’s source of truth: identity, model chain, manager, reports, tools,
memory, runtime, schedules, and pulse.

### Fleet plan

A reviewable YAML plan for creating or changing multiple agents.

### Federation

The live graph of principals, managers, direct reports, roles, groups, and
grants.

## Create a fleet

Use `onboard create` to generate a plan:

```sh
us onboard create \
  --name local-product-company \
  --mission "Run a focused agent organization" \
  --root coo \
  --department engineering:Engineering \
  --department operations:Operations \
  --plugin github \
  --mcp linear \
  --out fleet.yaml
```

Review it like infrastructure:

```sh
us fleet validate fleet.yaml
```

Apply only after review:

```sh
us fleet apply fleet.yaml --replace
```

## Inspect the graph

```sh
us federation status
us federation status coo
us profile list
```

Look for:

- exactly one root agent
- every non-root agent has a valid manager
- direct reports match the intended hierarchy
- grants are scoped, not global by default
- MCP tools are granted to the right agents or groups

## Good defaults

- Head agents can delegate across descendants.
- Department leads delegate to direct reports.
- Specialists report to managers and get narrow tool access.
- Use fleet plans for broad changes.
- Keep hand edits for single-profile experiments.

Related skills:

```sh
bunx skills add https://github.com/UnionStreetAI/unionstreet --skill managing-union-street
bunx skills add https://github.com/UnionStreetAI/unionstreet --skill governing-chain-of-command
bunx skills add https://github.com/UnionStreetAI/unionstreet --skill defining-an-agent
```
