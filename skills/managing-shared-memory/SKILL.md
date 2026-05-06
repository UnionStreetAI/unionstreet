---
name: managing-shared-memory
description: Configure and audit Union Street Honcho-backed memory, profile memory namespaces, memory sync, traces, anchors, and shared institutional memory. Use when agents forget context, memory is collapsed, or memory boundaries need design.
license: MIT
compatibility: Requires Union Street local v1 with Postgres, pgvector, uv, and Honcho memory config.
---

# Managing Shared Memory

Memory is core infrastructure. Local JSONL is a durable log, but Honcho-backed memory peering is the supported v1 behavior.

## Checks

1. Run `bun run us doctor`; Postgres, pgvector, and uv must pass.
2. Inspect the profile pack:
   - `memory.provider` should usually be `honcho`.
   - `memory.peerProfile` should be the agent id.
   - `sharedNamespaces` should include `institutional` and relevant `group:<department>`.
3. Query runtime state with `bun run us runtime status <agent>`.
4. Inspect memory events through runtime/API or profile JSONL when debugging.

## Rules

- Never collapse many agents into one workspace unless explicitly designing shared memory.
- Keep departmental shared namespaces scoped.
- Preserve trace/session ids when writing memory so Lash runs remain reconstructable.
- If remote sync fails, look for `sync-outbox.jsonl` before assuming memory vanished.

## Reference Config

Use `references/memory-config.yaml` for profile-scoped Honcho memory shape.
