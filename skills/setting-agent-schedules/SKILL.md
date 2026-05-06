---
name: setting-agent-schedules
description: Configure Union Street agent schedules, cron jobs, due runs, scheduler ticks, and scheduled prompts. Use when creating recurring agent work beyond pulse.
license: MIT
compatibility: Requires Union Street scheduler commands and agent pack schedule entries.
---

# Setting Agent Schedules

Schedules are explicit recurring jobs. Use them when a prompt should run at a specific time or cadence.

## Fields

- `id`
- `name`
- `cron`
- `timezone`
- `prompt`
- `deliverables`

## Commands

```sh
bun run us scheduler status -p <agent>
bun run us scheduler due -p <agent>
bun run us scheduler tick -p <agent> --execute
bun run us scheduler runs -p <agent>
```

Keep scheduled prompts bounded and auditable.

## Reference Config

Use `references/schedule.yaml` for a compact recurring work entry.
