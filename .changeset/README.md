# Changesets

Union Street publishes a **single npm package**, `@unionstreet/us` (from `packages/npm`). Workspace folders (`server`, `sdk`, `us-cli`, …) stay separate in git; only the release tarball bundles them.

When your PR changes behavior users see, add a changeset:

```sh
bun run changeset
```

Select **`@unionstreet/us`**. See [docs/release.md](../docs/release.md).
