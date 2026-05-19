# Server SDK

`@unionstreet/sdk` is the typed client boundary for the Union Street server/runtime API.

## Ownership

- `@unionstreet/server` owns runtime behavior, persistence, auth checks, scheduling, Lash, memory, events, usage, plugins, and HTTP routes.
- `docs/openapi.json` is the checked-in public API contract artifact.
- `@unionstreet/sdk` owns typed client access to those HTTP routes and must stay aligned with the OpenAPI contract.
- Apps, dashboards, CLIs, plugins, and external integrations should consume the server through the SDK when they are not running inside the server package.

The SDK should not import server internals. OpenAPI over HTTP is the contract boundary.

## Contract Source Of Truth

The server route manifest and schema definitions live in `packages/server/src/http/openapi.ts`.
That module generates the OpenAPI document served by `GET /openapi.json`.

The checked-in artifact is generated with:

```bash
bun run openapi:export
bun run openapi:types
```

`scripts/sdk-contract.test.ts` enforces three drift checks:

- SDK route coverage must match server routes marked `sdk: "covered"`.
- OpenAPI paths and methods must match the server route manifest.
- `docs/openapi.json` must byte-for-byte match the generated server OpenAPI document.
- `packages/sdk/src/generated/openapi-types.ts` must match `docs/openapi.json`.

The SDK keeps a hand-written ergonomic client in `packages/sdk/src/index.ts`, but its request and response generics are anchored to generated `OpenApiOperations` types. The generated file is intentionally checked in so consumers, reviewers, and future SDK/CLI generators can inspect the contract without running codegen first.

## Current Surface

The initial SDK covers:

- health and runtime info
- agents and model discovery
- prompt execution
- peer wake
- runtime contracts and workspace ensure
- events and event streaming
- usage
- memory
- sessions
- scheduler jobs, due work, ticks, and runs
- fleet plan, validate, and apply

## Client Shape

```ts
import { UnionStreetClient } from "@unionstreet/sdk"; // workspace dev
// import { UnionStreetClient } from "@unionstreet/us/sdk"; // npm install

const client = new UnionStreetClient({
  baseUrl: "http://127.0.0.1:8787",
  token: process.env.US_RUNTIME_BEARER_TOKEN,
});

const snapshot = await client.snapshot();
const result = await client.sendAgentPrompt("coo", {
  prompt: "Run the release readiness check.",
});
```

## Dashboard Usage

The dashboard keeps a small environment adapter in `packages/us-dashboard/src/runtime-client.ts`.
That file reads Vite/localStorage settings, creates a `UnionStreetClient`, and re-exports SDK types for UI code.

## Next Hardening Step

The SDK client is hand-written for now. The next hardening step is using
`docs/openapi.json` as the input to a generated SDK/CLI pipeline, then keeping
this hand-written SDK only if it remains useful as an internal convenience
wrapper.
