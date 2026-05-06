# Plugin Architecture

Union Street plugins are explicit capability bundles. A plugin can contribute
skills, MCP configuration, CLI guidance, app metadata, custom tools, or a runtime
provider contract. Installing a plugin does not make it available to every
agent; agents receive plugin capabilities through profile and fleet policy.

## Design Goals

- Keep capability grants visible in agent configuration.
- Treat app/workflow plugins and runtime plugins as different risk classes.
- Support compatibility with Codex and Claude plugin manifests without making
  those manifests the source of truth.
- Make plugin inspection and validation possible before any agent receives a
  capability.
- Fail closed when plugin metadata, config, or policy is invalid.

## Manifest

Every Union Street plugin has a `unionstreet.plugin.json` manifest:

```json
{
  "schema_version": "v1",
  "name": "github",
  "version": "0.1.0",
  "description": "GitHub workflow plugin for Union Street agents.",
  "kind": ["skills", "tools", "cli"],
  "capabilities": {
    "skills": ["pr-review", "issue-triage"],
    "tools": ["github_pr_summary"],
    "mcp": [],
    "runtime": []
  },
  "entrypoints": {
    "skills": "./skills",
    "tools": "./tools",
    "config": "./config.schema.json"
  }
}
```

Compatibility manifests such as `.codex-plugin/plugin.json` and
`.claude-plugin/plugin.json` may be shipped next to the Union Street manifest,
but the Union Street manifest is the normalized capability record.

## Capability Families

App and workflow plugins provide behavior:

- `skills`: task instructions and operating playbooks
- `tools`: callable typed tools
- `mcp`: remote or local MCP configuration
- `cli`: command guidance for safe local workflows
- `apps`: metadata for external services such as GitHub, Linear, Stripe, Vercel,
  Neon, or cloud providers

Runtime plugins provide infrastructure contracts:

- `runtime-local`
- `runtime-docker`
- `runtime-kubernetes`
- `runtime-vercel`
- `runtime-render`
- cloud providers such as AWS, GCP, Azure, Daytona, and Modal

Runtime plugins are not considered production-ready just because their manifest
exists. Their README and tests define the current supported surface.

## Enablement Model

Union Street uses an explicit grant model:

- installed does not mean enabled
- enabled does not mean globally granted
- project and workspace plugins should be treated as untrusted until reviewed
- deny policy wins over allow policy
- runtime, memory, and model-provider slots should resolve to one active
  provider at a time

A fleet plan can grant plugins by department or agent:

```yaml
agents:
  - id: vp-engineering
    plugins:
      - github
      - linear
  - id: growth-lead
    plugins:
      - gtm
```

## Current Implementation

The pre-alpha implementation includes:

- bundled plugin manifests under `plugins/*/unionstreet.plugin.json`
- app/workflow plugins for GitHub, Linear, Stripe, Vercel, cloud CLIs, Neon,
  GitLab, Cloudflare, and GTM
- runtime provider manifests for local, Docker, Kubernetes, Vercel, Render, AWS,
  GCP, Azure, Daytona, and Modal
- CLI inspection and doctor paths through `bun run us plugins ...`
- server-side plugin manifest loading and capability summaries
- repo-local Union Street skills under `skills/`

The strongest runtime implementation today is local host mode. Docker has real
planning/start/status/destroy mechanics. Kubernetes supports render and dry-run
validation. Other runtime plugins are public contracts and roadmap surfaces.

## Security Requirements

Before remote marketplace installation or production plugin loading, Union
Street needs:

- manifest signature or pinned git SHA for remote sources
- package integrity verification
- no auto-enable for remote or workspace plugins
- declared permissions for filesystem, network, secrets, subprocesses, browser
  use, and app connectors
- audit events for install, enable, disable, config changes, tool registration,
  MCP registration, hook execution, and runtime apply
- per-plugin secret scopes
- no inherited ambient environment by default

## Roadmap

1. Keep `us plugins list`, `inspect`, and `doctor` read-only and reliable.
2. Generate compatibility manifests from Union Street manifests.
3. Wire policy enforcement into profile and fleet config.
4. Promote Docker from local runner to fully documented runtime provider.
5. Promote Kubernetes from render/dry-run to reconcile/apply.
6. Add a typed hook bus for model calls, tool calls, delegation, scheduler,
   runtime, webhook, and compaction events.
7. Add marketplace signing, pinning, and enterprise allow/deny controls.
