# Union Street Images

These Dockerfiles are intentionally OCI-image scaffolding, not the canonical
runtime API. Kubernetes remains the production orchestration target; images are
the artifacts Kubernetes runs.

The current workspace depends on a sibling checkout of `lash-ts` through a
`file:../../../lash-ts` package dependency. Build from this repo root and pass
that sibling as a named BuildKit context:

```sh
docker build --build-context lash-ts=../lash-ts -f docker/Dockerfile.runtime -t unionstreet/runtime:dev .
docker build --build-context lash-ts=../lash-ts -f docker/Dockerfile.agent -t unionstreet/agent-runtime:dev .
docker build --build-context lash-ts=../lash-ts -f docker/Dockerfile.dashboard -t unionstreet/dashboard:dev .
```

Runtime and agent images bind `0.0.0.0`, run as the non-root `bun` user, and
define a `/health` healthcheck. Set `US_RUNTIME_BEARER_TOKEN` when running these
images; `runtime serve` refuses non-loopback binding without bearer auth. The
dashboard image uses unprivileged nginx and listens on port `8080`.
