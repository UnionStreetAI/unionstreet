# Contributing

Thanks for helping harden Union Street.

Before opening a pull request, run:

```sh
bun install
bun run check:full
bun audit
```

If your change affects published `@unionstreet/*` packages, add a changeset:

```sh
bun run changeset
```

Keep changes focused, add regression tests for boundary changes, and avoid
checking in credentials, local `.us` state, generated coverage, or build output.

Maintainers: see [docs/release.md](docs/release.md) for npm and GitHub release setup.
