---
name: governing-chain-of-command
description: Design, inspect, or repair Union Street hierarchy, departments, managers, direct reports, roles, groups, and federation grants. Use when changing org structure or delegation authority.
license: MIT
compatibility: Requires Union Street fleet plans or federation/agent pack files.
---

# Governing Chain Of Command

Chain of command is enforced by agent packs and federation policy. Do not model it only in prose.

## Workflow

1. For broad changes, generate a fleet plan and validate it.
2. Ensure exactly one root agent.
3. Every non-root agent needs a manager that exists.
4. Avoid cycles and ambiguous dual managers.
5. Confirm `identity.directReports` and federation principals match the graph.
6. Confirm grants are scoped by agent/group/role, not broad global access.

## Validation Commands

```sh
bun run us fleet validate fleet.yaml
bun run us federation status
bun run us federation status <agent>
```

## Reference Config

Use `references/fleet-plan.yaml` for a small hierarchy that validates and applies cleanly.
