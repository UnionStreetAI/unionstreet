# Plugin Architecture

Union Street plugins should be installable capability bundles, not just folders
of Terraform. The strongest plugin systems in adjacent agent runtimes converge
on the same shape: a manifest, explicit enablement, typed capability surfaces,
runtime hooks, tool/app integration, and a distribution/marketplace story.

## Prior Art

- OpenAI Codex plugins bundle skills, app integrations, and MCP servers. They
  use a required `.codex-plugin/plugin.json` manifest and can be exposed through
  repo or personal marketplace catalogs.
- OpenCode plugins are JavaScript or TypeScript modules loaded from project,
  global, or npm sources. They return hooks and tools, including tool execution
  hooks, shell environment hooks, TUI hooks, and compaction hooks.
- Hermes plugins use a `plugin.yaml` plus Python registration code. Plugins are
  discovered from bundled, user, project, pip, and Nix sources, but they are
  disabled by default until explicitly enabled. Hermes also treats memory and
  context-engine providers as exclusive plugin slots.
- OpenClaw recognizes native plugins and compatibility bundles such as
  `.codex-plugin`, `.claude-plugin`, and `.cursor-plugin`. Its plugin system
  covers channels, model providers, tools, skills, speech, transcription, media,
  image/video generation, web search/fetch, memory, and context engines. It has
  allow/deny controls, per-plugin config, exclusive slots, doctor commands, and
  install/update flows.
- Claude Code plugins use `.claude-plugin/plugin.json` and optional directories
  for commands, agents, skills, hooks, MCP config, and README documentation.

## What Union Street Should Standardize

### 1. Manifest

Every plugin should have a normalized `unionstreet.plugin.json` in addition to
any compatibility manifests we ship for Codex or Claude.

```json
{
  "schema_version": "v1",
  "name": "runtime-kubernetes",
  "version": "0.1.0",
  "description": "Run Union Street agents on Kubernetes.",
  "kind": ["runtime"],
  "capabilities": {
    "runtime": ["render", "plan", "apply", "destroy", "status"],
    "tools": [],
    "hooks": ["runtime.before_apply", "runtime.after_apply"],
    "mcp": [],
    "skills": []
  },
  "entrypoints": {
    "runtime": "./src/runtime.ts",
    "terraform": "./terraform",
    "skills": "./skills",
    "mcp": "./mcp.json"
  },
  "config_schema": "./config.schema.json",
  "permissions": {
    "network": ["kubernetes-api"],
    "filesystem": ["workspace"],
    "secrets": ["runtime:*"]
  }
}
```

Compatibility manifests should be generated from this source of truth:

- `.codex-plugin/plugin.json`
- `.claude-plugin/plugin.json`
- optional marketplace entries under `.agents/plugins/marketplace.json`

### 2. Capability Types

Union Street should split plugins into two top-level families.

Infrastructure plugins:

- `runtime`: local, Docker, Kubernetes, AWS, GCP, Azure, Daytona, Modal, Vercel.
- `storage`: local, PVC, S3, GCS, Azure Blob/File, Vercel Blob/KV, Modal volume.
- `ingress`: local HTTP, Kubernetes ingress, ALB, GCP LB, Azure Gateway, Vercel,
  Modal, Daytona.
- `secrets`: env, file, 1Password, Vault, AWS/GCP/Azure secret managers.
- `observability`: Langfuse, OTEL, Datadog, Honeycomb, CloudWatch, Stackdriver.

Behavior and app integration plugins:

- `skills`: task instructions and workflows.
- `tools`: callable typed tools with schemas.
- `mcp`: packaged MCP server/client configuration.
- `hooks`: lifecycle interception for tool calls, LLM calls, runtime apply,
  session start/end, compaction, delegation, scheduler, webhooks, and approvals.
- `channels`: Slack, Teams, Matrix, Discord, email.
- `apps`: GitHub, Linear, Jira, Notion, Google Drive, Gmail, Salesforce.
- `memory`: Honcho, local, pgvector, LanceDB, remote memory services.
- `context_engine`: summarization/compaction engines.
- `model_provider`: OpenAI-compatible gateways and provider-specific adapters.

### 3. Enablement And Policy

Default stance should be fail-closed:

- Installed does not mean enabled.
- Project/workspace plugins are disabled by default unless explicitly allowed.
- User/global plugins may be enabled in user config.
- Enterprise config can allowlist or denylist plugin ids and marketplace roots.
- Deny wins over allow.
- Exclusive slots select exactly one active plugin for categories such as
  `memory`, `context_engine`, `model_provider`, and `runtime`.
- Every plugin has validated config before it can load.

Recommended config shape:

```yaml
plugins:
  enabled: true
  allow: ["runtime-kubernetes", "github", "linear"]
  deny: ["unknown-network-plugin"]
  marketplaces:
    - "./.agents/plugins/marketplace.json"
  slots:
    runtime: "runtime-kubernetes"
    memory: "honcho"
    context_engine: "default"
  entries:
    runtime-kubernetes:
      enabled: true
      config:
        namespace: "union-street"
        workload: "Job"
```

### 4. Hooks

Hooks should be typed and ordered. The first production set should be:

- `session.start`, `session.end`
- `llm.before`, `llm.after`
- `tool.before`, `tool.after`
- `mcp.before_call`, `mcp.after_call`
- `delegate.before`, `delegate.after`
- `runtime.before_plan`, `runtime.after_plan`
- `runtime.before_apply`, `runtime.after_apply`
- `scheduler.before_run`, `scheduler.after_run`
- `webhook.before_dispatch`, `webhook.after_dispatch`
- `compaction.before`
- `approval.requested`, `approval.resolved`

Hook handlers should receive immutable input and a constrained mutable output.
Plugins should not mutate process globals directly. Shell environment injection
should be a dedicated hook so secrets stay auditable.

### 5. Plugin Manager

Build a `PluginManager` in `packages/server` that owns:

- discovery from bundled `plugins/`, repo marketplace, user marketplace, npm/git
  marketplace entries, and explicit local paths;
- manifest validation with Zod;
- config schema validation;
- enable/disable/inspect/list/doctor commands;
- compatibility manifest generation;
- hook ordering and isolation;
- capability registration for tools, MCP servers, skills, providers, and runtime
  reconcilers.

CLI surface:

```sh
us plugins list
us plugins inspect runtime-kubernetes
us plugins enable runtime-kubernetes
us plugins disable runtime-kubernetes
us plugins doctor
us plugins marketplace list
us plugins marketplace add ./local-marketplace
```

### 6. Runtime Provider Contract

The current runtime folders should graduate from Terraform placeholders to
runtime provider plugins with a shared interface:

```ts
export interface RuntimeProviderPlugin {
  id: string;
  capabilities: {
    render: boolean;
    plan: boolean;
    apply: boolean;
    destroy: boolean;
    status: boolean;
  };
  render(contract: ResolvedAgentRuntime, options: RuntimeOptions): Promise<RuntimePlan>;
  plan?(contract: ResolvedAgentRuntime, options: RuntimeOptions): Promise<RuntimePlan>;
  apply?(plan: RuntimePlan, options: RuntimeOptions): Promise<RuntimeApplyResult>;
  destroy?(contract: ResolvedAgentRuntime, options: RuntimeOptions): Promise<RuntimeDestroyResult>;
  status?(contract: ResolvedAgentRuntime, options: RuntimeOptions): Promise<RuntimeStatus>;
}
```

`runtime-kubernetes` should be the first fully real provider because the repo
already has manifest rendering. Docker should be second because it gives a fast,
local production-like sandbox for plugin and MCP tests. Cloud plugins can then
share the same plan/apply/status lifecycle.

### 7. Security Requirements

Production plugin loading needs:

- manifest signature or pinned git SHA for remote marketplaces;
- package integrity verification for npm or tarball installs;
- dangerous-code scanning before install/update;
- no auto-enable for remote or workspace plugins;
- declared permissions for filesystem, network, secrets, subprocess, browser,
  and app connectors;
- audit events for install, enable, disable, config change, hook execution, tool
  registration, and runtime apply;
- per-plugin secret scopes and no inherited ambient environment by default.

## Build Order

1. Add manifest/schema support and a read-only `us plugins list/inspect/doctor`.
2. Generate `.codex-plugin` and marketplace metadata from Union Street manifests.
3. Wire enablement policy into profile/global config.
4. Convert `runtime-kubernetes` into the first real runtime provider plugin.
5. Convert `runtime-docker` into a local production-like runner with apply/status.
6. Add the hook bus and register the first behavior plugin: security/guardrails.
7. Add app integration plugin shape using MCP plus skills: GitHub, Linear, Slack.
8. Add observability plugin: OTEL/Langfuse hooks around LLM/tool/runtime events.
9. Add signing/pinning and enterprise allow/deny enforcement.

This gives us a plugin system that can serve both open-source developers and
enterprise operators: easy local bundles for workflows, serious policy gates for
production, and provider plugins that harden the runtime layer instead of merely
documenting where Terraform might live someday.
