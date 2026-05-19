# Skills

Union Street ships docs for humans and skills for agents.

Human docs explain the system. Skills tell an AI agent how to operate it.

## Install the root skill

```sh
bunx skills add https://github.com/UnionStreetAI/unionstreet --skill managing-union-street
```

Use this when an agent is configuring, auditing, onboarding, repairing, or
operating a Union Street fleet.

## Core skill graph

`managing-union-street` routes to focused skills:

```text
managing-union-street
├── defining-an-agent
├── managing-shared-memory
├── governing-chain-of-command
│   └── defining-delegations-and-reports-with-lash
├── agents-prompting-agents
├── installing-mcp-servers
├── token-accounting
├── understanding-pulse
├── setting-agent-schedules
├── creating-work-with-webhooks
├── managing-agent-environments
├── configuring-messaging-gateways
├── installing-plugins
└── evaluating-agent-performance
```

## What the root skill tells agents to do

The root skill keeps agents outside the fleet. They inspect config, edit plans,
run the CLI, validate changes, and leave a reviewable trail.

First moves:

```sh
bun run us setup --check
bun run us profile list
bun run us federation status
bun run us plugins doctor
```

For org changes, agents should prefer a plan:

```sh
bun run us onboard create --out fleet.yaml ...
bun run us fleet validate fleet.yaml
bun run us fleet apply fleet.yaml --replace
```

## Task ownership

- Initial setup: `managing-union-street`, `managing-agent-environments`
- Agent definition: `defining-an-agent`
- Org hierarchy: `governing-chain-of-command`
- Delegation/report routing: `defining-delegations-and-reports-with-lash`
- MCP auth/grants: `installing-mcp-servers`
- Plugin grants: `installing-plugins`
- Memory: `managing-shared-memory`
- Schedules: `setting-agent-schedules`
- Pulse: `understanding-pulse`
- Webhooks: `creating-work-with-webhooks`
- Usage telemetry: `token-accounting`
- Performance review: `evaluating-agent-performance`

## Human docs vs agent skills

Use the human docs when you want the conceptual map.

Use skills when you want an AI agent to make changes safely:

- create or validate a fleet plan
- inspect a profile
- scope an MCP server
- debug delegation
- review runtime state
- add schedules or pulse
- audit events and usage

The skills live in `skills/<skill>/SKILL.md`. Their examples and reference YAML
files are deliberately repo-local, so agents operate against the same contracts
the code and tests use.
