# Testing Battery

Union Street uses named battery tiers so changes can be checked against the right level of risk.

## Fast Gate

```sh
bun run doctor
bun run check:fast
```

Runs the parallel local regression gate:

- macOS/Linux prerequisite check, including the local Honcho memory stack
- package typechecks
- isolated test files
- prompt/events/scheduler smoke scripts
- ultimate stub run
- dashboard build
- CLI end-to-end smoke

Use this for normal implementation work before handing off changes.

## Adversarial Gate

```sh
bun run check:adversarial
```

Runs hostile local pressure tests:

- `test:stress`
- `test:ballistic`
- `test:mogadishu-mile`

Use this after touching runtime, auth, events, usage, memory, scheduler, Lash, plugins, or agent orchestration behavior.

## Full Local Gate

```sh
bun run check:full
```

Runs `check:fast` plus the full adversarial battery. This is the default local production-readiness gate before trusting a broad change.

## Live Provider Gate

```sh
bun run check:live
```

Runs the optional live-provider battery. It requires real credentials such as `US_ULTIMATE_API_KEY` and should not be part of default local or CI runs until the environment is explicitly provisioned.

## Current Boundary

The v1 supported deployment target is a local macOS or Linux machine running
Bun, Node 20+, Git, Postgres, pgvector, and uv. File-backed profile memory is a
durable local log, but Honcho-backed memory peering is part of the supported
local runtime. Docker, Kubernetes, Vercel, Daytona, and other live runtime paths
should remain optional gates until credentials, cost controls, cleanup, and
network policy are explicitly configured.
