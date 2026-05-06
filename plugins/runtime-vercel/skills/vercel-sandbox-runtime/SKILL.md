---
name: vercel-sandbox-runtime
description: Configure and operate Union Street agents in Vercel Sandboxes, including auth mode selection, persistent sandbox policy, snapshots, tags, and Lash runtime wakeups.
---

# Vercel Sandbox Runtime

Use Vercel Sandbox as a remote runtime when an agent must execute in an
isolated microVM outside the head node.

## Auth Selection

Prefer `oidc` when `VERCEL_OIDC_TOKEN` is available. This is the native Vercel
path: local operators run `vercel link` and `vercel env pull`; Vercel-hosted
Union Street instances receive managed OIDC automatically.

Use `access_token` when Union Street runs outside Vercel. Require all three
environment variables before creating a sandbox:

- `VERCEL_TEAM_ID`
- `VERCEL_PROJECT_ID`
- `VERCEL_TOKEN`

Do not continue with partial access-token config. Do not pass `VERCEL_TOKEN` to
agent code unless the delegated task explicitly needs to call Vercel APIs.

## Runtime Wake Shape

The provider should create or resume a sandbox, start Union Street's runtime API
inside it, expose the control port, then call:

```txt
POST /api/peers/:target/wake
```

The request must preserve `caller`, `message`, `trace`, `thread`, `chain`, and
`wakeKind` so Lash delegation remains transport-independent.

## Persistence Policy

Default to ephemeral sandboxes for one-off delegated tasks. Use named persistent
sandboxes only when the agent config explicitly asks for durable state.
Snapshots are preferred for warm starts and reproducible base environments.

Tag sandboxes with at least:

- `unionstreet=true`
- `profile=<agent>`
- `plugin=runtime-vercel`
- `trace=<lash-trace>` when created for a delegated wake
