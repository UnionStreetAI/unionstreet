# Security Policy

Union Street is pre-alpha. Please do not run untrusted agents, prompts, tools,
or runtime plugins against sensitive workspaces without an external sandbox.

## Reporting

Report vulnerabilities privately to the maintainers. Include:

- affected package or runtime path
- reproduction steps
- expected impact
- any logs with secrets redacted

## Current Boundaries

- Runtime `/api/*` routes support bearer auth and should use
  `US_RUNTIME_BEARER_TOKEN` outside trusted local development.
- Browser runtime access is CORS allowlisted to loopback origins by default.
- Starter filesystem tools are confined to the agent workspace.
- Starter process tools run with a minimal environment by default.
