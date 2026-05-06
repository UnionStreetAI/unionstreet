---
name: managing-agent-environments
description: Configure Union Street agent runtime environments, local host mode, workspace scope, secrets, and future Docker/Kubernetes/cloud sandbox targets. Use when changing where agents run.
license: MIT
compatibility: V1 supports local Mac/Linux host runtime; Docker/Kubernetes/cloud sandboxes are v2 unless explicitly requested.
---

# Managing Agent Environments

For v1, keep agents local on Mac/Linux host runtime.

## V1 Runtime Shape

- `runtime.environment: local/host`
- `runtime.compute: local`
- `runtime.storage: local`
- `runtime.workspace: .`
- `runtime.secrets`: profile-scoped grants

## Commands

```sh
bun run us runtime status <agent>
bun run us runtime ensure <agent>
bun run us runtime serve
```

Docker, Kubernetes, Vercel, Daytona, Modal, AWS, and other cloud/sandbox providers are v2 hardening surfaces unless the user asks for them.
