---
name: understanding-pulse
description: Configure and explain Union Street pulse heartbeats, recurring self-checks, pulse cadence, and pulse instructions. Use when agents should periodically wake up and inspect work.
license: MIT
compatibility: Requires Union Street agent pack pulse fields and scheduler.
---

# Understanding Pulse

Pulse is an agent heartbeat. It is for recurring situational awareness, not one-off work.

## Fields

- `pulse.enabled`: whether the agent wakes on heartbeat.
- `pulse.cadence`: human cadence such as `every 30m`.
- `pulse.instructions`: repeatable self-check instructions.

## Good Pulse Instructions

- Inspect assigned domain.
- Check stale work and blockers.
- Delegate only if a direct report is clearly useful.
- Report material findings upward.
- Record memory-worthy state.

Validate with scheduler commands and relevant tests after changing pulse behavior.

## Reference Config

Use `references/pulse.yaml` for a repeatable heartbeat configuration.
