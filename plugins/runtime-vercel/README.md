# runtime-vercel

Vercel Sandbox runtime provider for Union Street agents. Intended shape: one
Vercel Sandbox per agent or durable agent workspace, a runtime API process
inside the sandbox, and public HTTPS control ingress for Lash peer wakeups,
MCP callbacks, webhooks, and runtime control traffic.

Contract outputs: `sandbox_id`, `sandbox_name`, `control_url`,
`workspace_mount`, `snapshot_id`, `status`.

## Auth contract

Union Street should support two auth modes:

1. `oidc`
   - Best when Union Street is running on Vercel or locally linked to a Vercel
     project.
   - Required env: `VERCEL_OIDC_TOKEN`.
   - Local setup: `vercel link`, then `vercel env pull`.
   - The token is short lived, so operators must refresh local credentials.

2. `access_token`
   - Best when Union Street runs outside Vercel, including local laptops,
     external CI, Docker, Kubernetes, AWS, Modal, Daytona, or Render.
   - Required env: `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `VERCEL_TOKEN`.
   - `VERCEL_TOKEN` must have access to the configured team/project.

Union Street should prefer OIDC when `VERCEL_OIDC_TOKEN` is present, then fall
back to access-token mode only when the team/project/token triple is complete.
Never inject broad Vercel credentials into untrusted agent code unless the task
requires Vercel API access inside the sandbox.

## Runtime shape

Vercel Sandbox is not a Docker image runner. It starts an Amazon Linux 2023
microVM with Node.js or Python runtimes. To run a Union Street agent, the
adapter should:

- create or resume a sandbox by deterministic name, e.g. `us-agent-vp-eng`
- upload or clone the Union Street runtime bundle into `/vercel/sandbox`
- materialize the target profile/agent pack/federation state into the sandbox
- start the runtime API with `US_PROFILE=<agent>` and a bearer token
- expose the runtime API port and return its public control URL
- call `POST /api/peers/:target/wake` for Lash peer delegation
- stop or delete the sandbox according to the agent runtime policy

## Persistence

Default mode should be ephemeral. Durable agents should opt into one of:

- named persistent sandbox: stable `sandbox.name`, automatic resume when
  supported by the installed Vercel Sandbox SDK/CLI
- snapshot: `snapshotId` seed for faster boot and reproducible environments

Agent runtime config should make the persistence policy explicit:

```yaml
runtime:
  provider: vercel
  plugin: runtime-vercel
  workspace: /vercel/sandbox
  region: iad1
  ttlMinutes: 60
  persistent: false
  labels:
    team: eng
```
