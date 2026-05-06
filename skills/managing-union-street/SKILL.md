---
name: managing-union-street
description: Manage a Union Street agent fleet from outside Union Street. Use when configuring, auditing, onboarding, repairing, or operating Union Street agents, fleets, plugins, memory, Lash delegation, schedules, webhooks, messaging, environments, or performance.
license: MIT
compatibility: Works with Claude Code, Codex, and Agent Skills-compatible coding agents in a Union Street repository.
metadata:
  union-street-role: core-graph
---

# Managing Union Street

Use this as the root skill for Union Street fleet management. Stay outside the fleet: inspect configs, edit plans, run the CLI, validate, and leave a reviewable trail.

## First Moves

1. Run `bun run us setup --check` to verify the local machine and default profile.
2. Inspect fleet shape with `bun run us profile list`, `bun run us federation status`, and `bun run us plugins doctor`.
3. For org changes, prefer a reviewable fleet plan:
   - `bun run us onboard create --out fleet.yaml ...`
   - `bun run us fleet validate fleet.yaml`
   - `bun run us fleet apply fleet.yaml --replace` only after review.
4. After changes, run focused tests first, then `bun run check:fast`.

## Core Graph

For the full graph and task ownership map, read `references/core-graph.md`.
For a compact end-to-end bootstrap example, read `references/local-fleet-bootstrap.yaml`.

- Agent definition: use `defining-an-agent`.
- Shared memory: use `managing-shared-memory`.
- Chain of command: use `governing-chain-of-command`.
- Lash delegation/reporting: use `defining-delegations-and-reports-with-lash`.
- Agents prompting agents: use `agents-prompting-agents`.
- MCP install/auth: use `installing-mcp-servers`.
- Token and usage accounting: use `token-accounting`.
- Pulse: use `understanding-pulse`.
- Schedules: use `setting-agent-schedules`.
- Webhook work creation: use `creating-work-with-webhooks`.
- Local/cloud environment shape: use `managing-agent-environments`.
- Messaging gateways: use `configuring-messaging-gateways`.
- Plugins and bundled skills/tools: use `installing-plugins`.
- Performance review: use `evaluating-agent-performance`.

## Guardrails

- Treat `agent.yaml`, `federation.yaml`, profile files, plugin manifests, and memory config as control-plane state.
- Do not hand-edit many profiles when a fleet plan can express the same change.
- Do not grant global tools/plugins when department or agent scope is enough.
- Do not bypass bearer auth for mutating runtime APIs.
- Keep Docker/Kubernetes/cloud sandboxes as v2 unless the user explicitly asks for that runtime.
