# Tools

Union Street scopes tools to agents.

The default rule is simple: do not give every agent every credential. Grant MCP
servers and plugin capabilities to the profiles, groups, or departments that
need them.

## MCP access is agent-scoped

Add the server to a fleet plan or agent pack, apply the plan, then authenticate
for the profile:

```sh
us coo mcp auth linear
us coo mcp status
```

Equivalent global command with explicit profile:

```sh
us mcp auth linear -p coo
us mcp status -p coo
```

Credentials are stored for the agent unless explicitly saved globally.

## Why this matters

Without scoped tools, multi-agent systems drift toward one shared credential
bucket. That makes it hard to answer basic questions:

- Which agent used this tool?
- Why did it have access?
- Which peer could it wake?
- Which secret was materialized?
- What should be revoked?

Union Street makes tool access part of the profile and federation story.

## Plugins and skills

Plugins can package skills, tools, CLI commands, and manifests. They are not
global by default. Inspect what exists:

```sh
us plugins list
us plugins inspect github
us plugins doctor
us plugins agent coo
```

When a plugin includes skills, grant the plugin or skill bundle intentionally in
the fleet plan.

## Security defaults

- Prefer profile-scoped credentials.
- Do not paste secrets into fleet plans.
- Avoid broad global grants.
- Remote MCP URLs reject private, loopback, metadata, non-HTTP, and
  embedded-credential targets by default.
- Local dummy/dev MCP servers require an explicit escape hatch.

Related skills:

```sh
bunx skills add https://github.com/UnionStreetAI/unionstreet --skill installing-mcp-servers
bunx skills add https://github.com/UnionStreetAI/unionstreet --skill installing-plugins
```
