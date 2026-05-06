---
name: defining-delegations-and-reports-with-lash
description: Configure and debug Union Street Lash delegation, report routing, peer calls, trace propagation, direct reports, and manager visibility. Use when agents need to delegate or report through the org graph.
license: MIT
compatibility: Requires Union Street Lash-enabled agent packs and federation policy.
---

# Defining Delegations And Reports With Lash

Lash is the peer-to-peer work path. Chain of command decides who can wake whom.

## Pack Fields

- `lash.thread`: stable routing thread, usually `lash:<manager>/<agent>`.
- `lash.delegate`: `none`, `direct_reports`, or `descendants`.
- `lash.report`: usually `manager` for non-root agents.
- `lash.structured`: prefer `preferred` unless testing fallback behavior.

## Debugging

1. Check `agent.yaml` manager/directReports.
2. Check federation status for the agent.
3. Verify the caller can only delegate to allowed peers.
4. Preserve `trace` through every delegate/report call.
5. Inspect memory events for `lash.wake` and report turns.

## Reference Config

Use `references/lash-routing.yaml` for a minimal manager/direct-report routing model.
