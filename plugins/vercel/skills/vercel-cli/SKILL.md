---
name: vercel-cli
description: Use the Vercel CLI for project linking, environment variables, deployments, previews, logs, domains, and local dev. This is guidance only, not a Union Street runtime provider.
---

# Vercel CLI

Use `vercel` for Vercel project operations. Do not treat this as a sandbox/runtime plugin.

## Docs

- https://vercel.com/docs/cli
- https://vercel.com/docs/cli/deploy

## Checks

```sh
vercel --version
vercel whoami
vercel project ls
```

## Common Commands

```sh
vercel login
vercel link
vercel pull
vercel env ls
vercel env pull .env.local
vercel dev
vercel deploy
vercel deploy --prebuilt
vercel inspect <deployment-url>
vercel logs <deployment-url>
```

## Rules

- Read project/env/deployment state before mutating.
- Prefer preview deploys before production promotes.
- Never print tokens or `.env*` contents.
- Use `--token "$VERCEL_TOKEN"` only in non-interactive automation.
