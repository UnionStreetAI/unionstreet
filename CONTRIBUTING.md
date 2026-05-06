# Contributing

Thanks for helping harden Union Street.

Before opening a pull request, run:

```sh
bun install
bun run check:parallel
bun run test:stress
bun audit
```

Keep changes focused, add regression tests for boundary changes, and avoid
checking in credentials, local `.us` state, generated coverage, or build output.
