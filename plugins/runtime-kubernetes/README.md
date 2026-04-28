# runtime-kubernetes

Kubernetes runtime provider for distributed Union Street agents. Intended shape: pod or deployment per agent pool, persistent volume claims for workspaces, and ingress/service endpoints for MCP, Lash, webhooks, and control traffic.

Contract outputs: `compute_endpoint`, `storage_mount`, `ingress_url`, `control_url`.
