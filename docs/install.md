# Install script (`unionstreet.ai/install`)

Union Street ships a **thin installer** that does not compile a native binary. It:

1. Ensures **Bun 1.3+** is installed (via [bun.sh](https://bun.sh) if missing).
2. Installs **`@unionstreet/us`** from npm (`bun install -g` by default).
3. Adds `~/.bun/bin` to your shell `PATH` when needed.

The `us` CLI still runs on Bun; the install script is onboarding, not a separate binary distribution.

## End-user commands

```sh
curl -fsSL https://unionstreet.ai/install.sh | bash
```

Alias path (same script content):

```sh
curl -fsSL https://unionstreet.ai/install | bash
```

Pin a version after the first npm release:

```sh
US_VERSION=0.1.0 curl -fsSL https://unionstreet.ai/install.sh | bash
```

Dry-run:

```sh
curl -fsSL https://unionstreet.ai/install.sh | bash -s -- --dry-run
```

## Hosting on unionstreet.ai

The marketing site ([unionstreet-web](https://github.com/UnionStreetAI/unionstreet-web)) serves the installer at:

| URL | Behavior |
|-----|----------|
| `https://unionstreet.ai/install.sh` | Installer script (`text/plain`) |
| `https://unionstreet.ai/install` | Same script (rewrite to `/install.sh`) |

On each Vercel build, the site syncs `install.sh` from the **latest GitHub Release** (`releases/latest/download/install.sh`), with fallbacks to `main` and a cached copy in `public/`.

When a runtime release is **published**, `release-assets.yml` uploads `install.sh` to the GitHub Release and triggers a Vercel redeploy (repo variable `VERCEL_DEPLOY_HOOK_URL`) so `unionstreet.ai/install` updates without a manual site deploy.

Until the first npm/GitHub release exists, use a sibling `unionstreet` checkout or GitHub `main`:

```sh
curl -fsSL https://raw.githubusercontent.com/UnionStreetAI/unionstreet/main/scripts/install.sh | bash
```

## GitHub Releases

`.github/workflows/release-assets.yml` uploads `install.sh` when a GitHub Release is **published** (created by the Changesets flow in `release.yml`).

Maintainers can also run the workflow manually (**workflow_dispatch**) after editing the script.

## Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `US_VERSION` | `latest` | npm version tag for `@unionstreet/us` |
| `US_INSTALL_METHOD` | `global` | `global` (`bun install -g`) or `bunx` (wrapper script) |
| `BUN_INSTALL` | `~/.bun` | Bun install root |
| `US_WRAPPER_DIR` | `~/.local/bin` | Wrapper path when `US_INSTALL_METHOD=bunx` |

## After install

```sh
us doctor
us setup
us tui
```

Honcho memory (Postgres + pgvector + `uv`) is still required for full local runtime; `us doctor` explains gaps.

## Related

- [Release pipeline](release.md) — npm OIDC publish
- [README](../README.md) — development install from git
