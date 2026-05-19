# Identity

Union Street treats agents as principals.

An agent is not just a prompt with a name. It has a stable subject, issuer,
audiences, roles, groups, manager, and direct reports. That identity is what
tool grants, peer visibility, runtime secrets, memory, usage, and audit records
attach to.

## The mental model

Every agent profile resolves into an OIDC-style identity:

```yaml
oidc:
  issuer: urn:union-street:demo-enterprise
  subject: agent:vp-engineering
  audiences:
    - union-street:runtime
```

Federation uses that identity alongside the org graph:

- profile
- subject
- roles
- groups
- manager
- direct reports
- disabled/enabled state

Disabled principals fail closed for principal resolution and delegation
visibility.

## Why OIDC-shaped?

Agent work crosses boundaries: local tools, MCP servers, runtime APIs, webhooks,
memory stores, sandboxes, and VPCs. OIDC gives Union Street a familiar shape for
claims and trust without inventing a new identity vocabulary.

It also gives external systems a place to connect. Corporate IdPs can map token
claims into Union Street federation groups. Agent packs can rotate subjects
without depending on stale rows elsewhere in the control plane.

## Inspect identity

```sh
us federation status
us federation status coo
us federation token coo
us federation jwks
```

For MCP-to-agent flows, mint a token with a target audience:

```sh
us federation token coo --mcp-target analyst
```

## Runtime API auth

`/health` is intentionally open for local supervisors.

`/api/*` routes are protected when `US_RUNTIME_BEARER_TOKEN` or runtime
`authToken` is configured. Public binds must use bearer auth.

## What identity protects

- MCP credentials and grants
- runtime secrets
- peer wake/delegation visibility
- profile-scoped memory
- usage accounting
- audit events
- webhook-created work

Related skills:

```sh
bunx skills add https://github.com/UnionStreetAI/unionstreet --skill managing-union-street
bunx skills add https://github.com/UnionStreetAI/unionstreet --skill governing-chain-of-command
```
