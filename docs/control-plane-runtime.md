# Control Plane And Runtime Contracts

Union Street treats the head node as an enterprise control plane. Local mode is
the default, but the contracts below are the same shape expected from Docker,
Kubernetes, and cloud runtime plugins.

## Runtime API

- `/health` is intentionally unauthenticated for local supervisors and browser
  dashboards.
- `/api/*` routes are protected when `US_RUNTIME_BEARER_TOKEN` or
  `authToken` is configured. Public binds must use bearer auth.
- Request bodies are capped at 1 MB and malformed JSON fails before agent work
  starts.
- Profile route params and query filters are validated before reading any
  profile-scoped path.

## Federation And Lash

- Each agent is an OIDC-style principal with a stable profile, subject, roles,
  groups, manager, and direct reports.
- Agent packs are authoritative for per-agent OIDC subject, model chain, Lash
  thread policy, runtime, schedule, pulse, toolkit, and memory peer settings.
- Delegation flows down through direct reports. Root agents can traverse
  descendants. Reports flow one level up to the direct manager.
- Disabled federation principals fail closed for principal resolution and
  delegation visibility.

## MCP

- MCP auth is agent-scoped: `us-dev coo mcp auth linear`.
- API-key and OAuth credentials are stored in the agent's `auth-profiles.json`
  unless explicitly saved globally.
- Remote/cloud OAuth can be completed by opening the printed URL anywhere and
  pasting the callback URL/code into the CLI prompt. Non-interactive jobs should
  pass an environment variable name with `--callback-env`, never the callback
  value itself on the command line.
- Remote MCP URLs reject private, local, loopback, metadata, non-HTTP, and
  embedded-credential targets by default.
- Local dummy/dev MCP servers require the explicit escape hatch
  `US_MCP_ALLOW_PRIVATE_URLS=1`.

## Webhooks

- Webhook sources are validated as lowercase source ids.
- If `US_WEBHOOK_<SOURCE>_SECRET` or `US_WEBHOOK_SECRET` is configured,
  webhooks require an HMAC SHA-256 signature in `x-us-signature` or
  `x-hub-signature-256`.
- Rejected webhooks do not create successful ingress audit events.

## Runtime, Secrets, And Workspaces

- Runtime contracts expose `head`, `compute`, `storage`, `ingress`, and
  `workspace` sections.
- Secrets are grant-resolved by agent identity, not by arbitrary env-file paths
  in the agent pack.
- Materialized secret files contain only grants allowed for that agent and are
  emitted with restrictive permissions.

## Scheduler And Pulse

- Pulse is a 30-minute heartbeat when enabled.
- Calendar schedules compile from agent pack cron entries.
- Scheduler runs are append-only and file-locked. Restarts must not duplicate a
  claimed or completed due window.

## Events, Usage, And Memory

- Control-plane events are append-only JSONL with recursive secret redaction.
- Usage records are append-only JSONL and track input, output, reasoning, cache
  read/write, total tokens, and micro-USD cost source.
- Custom/free providers can set accounting mode `free`; cost remains zero no
  matter how many tokens are used.
- Honcho memory sync is enabled by config/env and can point at an alternative
  sink URL.
