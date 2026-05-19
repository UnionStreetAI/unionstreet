# Runtime

Union Street is deployment-agnostic by contract.

The same system shape should make sense on a laptop, in Docker, in Kubernetes,
inside a sandbox provider, or in an airgapped VPC. The maturity level is not the
same for every target, but the contracts are intentionally shared.

## What exists today

The v1 target is the local Mac/Linux host runtime:

```sh
us runtime status coo
us runtime ensure coo
us runtime serve --port 8787
```

The local runtime is enough to create profiles, open the TUI, prompt agents,
inspect federation, use scoped MCP credentials, run scheduled work, stream
events, and call the HTTP API.

## Runtime contracts

Runtime state is described in sections:

- `head`
- `compute`
- `storage`
- `ingress`
- `workspace`
- `secrets`

Those sections are the bridge from local development to hosted execution.

## Docker and Kubernetes

Docker has planning/start/status/destroy mechanics. Kubernetes can render and
dry-run validate manifests.

```sh
us runtime render coo --provider docker
us runtime render coo --provider kubernetes --dry-run
```

Kubernetes apply/reconcile is not promised yet.

## VPC and airgapped environments

The important idea is not “cloud first” or “local first.” The important idea is
that the agent organization has explicit contracts:

- identity and bearer auth for runtime APIs
- scoped secrets
- workspace boundaries
- ingress policy
- profile-scoped tools
- append-only events and usage
- signed webhooks when external systems create work

That is the shape you need when the same system must run on a laptop during
development and inside a controlled VPC later.

## HTTP API

Serve the runtime:

```sh
US_RUNTIME_BEARER_TOKEN=dev-token us runtime serve --port 8787
```

Call it:

```sh
curl -sS http://127.0.0.1:8787/api/agents \
  -H "Authorization: Bearer $US_RUNTIME_BEARER_TOKEN"
```

Read the generated API reference:

- [Runtime API](../docs.html) on the website
- [Control Plane And Runtime Contracts](control-plane-runtime.md) in this repo
- `docs/openapi.json` for the OpenAPI document

Related skills:

```sh
bunx skills add https://github.com/UnionStreetAI/unionstreet --skill managing-agent-environments
bunx skills add https://github.com/UnionStreetAI/unionstreet --skill creating-work-with-webhooks
```
