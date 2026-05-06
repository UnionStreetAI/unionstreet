---
name: cloudflare-wrangler
description: Use Cloudflare Wrangler for Workers, Pages, D1, KV, R2, secrets, local dev, deployments, and diagnostics.
---

# Cloudflare Wrangler

Use `wrangler` for Cloudflare developer platform work. Start by confirming account and project config.

## Docs

- https://developers.cloudflare.com/workers/wrangler/
- https://developers.cloudflare.com/workers/wrangler/install-and-update/

## Checks

```sh
npx wrangler --version
npx wrangler whoami
test -f wrangler.toml || test -f wrangler.jsonc
```

## Common Commands

```sh
npx wrangler login
npx wrangler dev
npx wrangler deploy
npx wrangler pages deploy <directory>
npx wrangler secret list
npx wrangler d1 list
npx wrangler kv namespace list
npx wrangler r2 bucket list
```

## Rules

- Inspect `wrangler.toml` or `wrangler.jsonc` before deploying.
- Ask before production deploys, secret writes, D1 migrations, or destructive storage changes.
- Never print API tokens or secret values.
- Prefer `npx wrangler` unless the repo pins a package script.
