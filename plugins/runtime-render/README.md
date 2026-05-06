# runtime-render

Render runtime provider for hosted agent services and worker sandboxes. Intended
shape: Render service or worker compute, persistent disk where available, and
HTTPS ingress for MCP, Lash, webhooks, and control traffic.

Agents can opt in from `agent.yaml`:

```yaml
runtime:
  environment: render/container
  provider: render
  plugin: runtime-render
  compute: render
  storage: render-disk
  workspace: /workspace
  region: oregon
  image: ghcr.io/unionstreet/agent-runtime:latest
```
