# Release pipeline

Union Street publishes **one npm package** — [`@unionstreet/us`](https://www.npmjs.com/package/@unionstreet/us) — from this monorepo. Runtime, SDK, auth, and Codex code stay in separate workspace folders for development; `prepack` stages them into the tarball without moving source.

## What ships on npm

| npm | Workspace folder | Subpath export |
|-----|------------------|----------------|
| `@unionstreet/us` (CLI + all libs) | `packages/npm` (publish root) | `.` / `./cli` |
| — | `packages/server` | `@unionstreet/us/server` |
| — | `packages/sdk` | `@unionstreet/us/sdk` |
| — | `packages/us-auth` | `@unionstreet/us/auth`, `./auth/oauth` |
| — | `packages/ai-codex` | `@unionstreet/us/codex` |
| — | `packages/us-cli` | (staged as CLI; workspace name `@unionstreet/us-cli`) |

`@unionstreet/us-dashboard` is not published (local Vite app).

Inside the tarball, staged code still imports `@unionstreet/server` etc.; the published `package.json` `imports` map resolves those to `.pack/*` paths.

Consumers need **Bun 1.3+**:

```sh
bunx @unionstreet/us doctor
bunx @unionstreet/us init coder
```

Programmatic imports:

```ts
import { UnionStreetClient } from "@unionstreet/us/sdk";
import * as server from "@unionstreet/us/server";
```

## One-time setup (maintainers)

### 1. npm org

Create the `@unionstreet` org on [npmjs.com](https://www.npmjs.com/) if needed.

### 2. First publish (manual, once)

Trusted publishing requires the package to exist on the registry first:

```sh
bun install
bun run pack:verify   # optional dry-run
cd packages/npm
npm publish --access public --provenance=false
```

Use `npm login` locally (or `npm publish --otp=…` if 2FA is enabled). Provenance stays on in `publishConfig` for CI; the first laptop publish cannot sign attestations until **Trusted Publisher** is configured (step 3). Revoke any one-time token after bootstrap if you used one.

### 3. Trusted publisher (single package)

On **@unionstreet/us** → **Settings** → **Trusted Publisher** → **GitHub Actions**:

| Field | Value |
|-------|--------|
| Organization or user | `UnionStreetAI` (case-sensitive — must match github.com/UnionStreetAI) |
| Repository | `unionstreet` |
| Workflow filename | `release.yml` |
| Environment | *(leave blank)* |

Leave **Environment** empty on npm unless you also add `environment: …` to the release job in `.github/workflows/release.yml` (not required by default).

## Day-to-day flow

**Trusted publishing** replaces an `NPM_TOKEN` — it does not mean “every merge to `main` ships npm.” **Changesets** decides *when* to bump and publish.

1. Contributor runs `bun run changeset` (targets `@unionstreet/us` only).
2. Merge feature PR to `main` → `release.yml` opens **chore(release): version packages** (version + changelog only).
3. Merge that version PR → `release.yml` runs `changeset publish` (OIDC + provenance). `ci.yml` already ran `check:full` on the commit.

If `main` has a version bump and no pending changesets (e.g. maintainer versioned locally), the same workflow attempts publish on push — still via OIDC, not your laptop token. `prepack` stages sources; `npm publish` ships the tarball with provenance.

## Local commands

```sh
bun run changeset
bun run version-packages
bun run pack:verify          # stage + npm pack --dry-run
bun run release              # changeset publish (same as CI; run check:full locally first)
```

## CI gates

| Workflow | Gate |
|----------|------|
| `ci.yml` | `check:full`, audit (non-blocking) |
| `release.yml` | Changesets version PR or publish via OIDC (no duplicate `check:full`) |

## Troubleshooting

| Symptom | Cause |
|---------|--------|
| `404` on publish | Package missing, wrong trusted-publisher fields, or environment mismatch (npm vs workflow) |
| Empty / broken install | `prepack` did not run — publish only from `packages/npm` via changesets |
| `workspace:*` in tarball | Never publish workspace packages directly; only `packages/npm` is public |

## Pre-release checklist

- [ ] `bun run check:full`
- [ ] `bun run pack:verify`
- [ ] `bash -n scripts/install.sh` and `bash scripts/install.sh --help`
- [ ] Trusted publisher on `@unionstreet/us` only
- [ ] Trusted publisher **Environment** blank (or matches workflow job `environment:` if you add one)
- [ ] Changeset on `main`
- [ ] After release: `install.sh` attached to GitHub Release; `unionstreet.ai/install` serves or redirects to it ([install.md](install.md))

## Install script (curl)

```sh
curl -fsSL https://unionstreet.ai/install.sh | bash
```

`release-assets.yml` uploads `scripts/install.sh` when a GitHub Release is published. See [install.md](install.md) for website hosting.
