# Union Street Fleet Management Skill Graph

`managing-union-street` is the root skill. It routes work to focused skills:

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

## Task Ownership

- Initial machine setup: `managing-union-street`, then `managing-agent-environments`.
- Fleet/org creation: `managing-union-street`, `defining-an-agent`, `governing-chain-of-command`.
- Department hierarchy: `governing-chain-of-command`.
- Agent identity/SOUL/model/toolkit: `defining-an-agent`.
- Memory design: `managing-shared-memory`.
- Delegation/report routing: `defining-delegations-and-reports-with-lash`.
- Head-agent prompts and live org tests: `agents-prompting-agents`.
- Plugin bundle grants: `installing-plugins`.
- MCP server auth/grants: `installing-mcp-servers`.
- Scheduled work: `setting-agent-schedules`.
- Heartbeats/self-checks: `understanding-pulse`.
- External work ingress: `creating-work-with-webhooks`.
- Messaging channels: `configuring-messaging-gateways`.
- Usage and token telemetry: `token-accounting`.
- Behavioral quality review: `evaluating-agent-performance`.

## Canonical Paths

- Canonical repo path: `skills/<skill>/SKILL.md`
- References live under `skills/<skill>/references/`
- These skills are repo documentation and operating playbooks, not local Claude or Codex adapter state.
