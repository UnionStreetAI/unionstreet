# runtime-docker

Docker runtime provider for agent workspaces. Intended shape: one container per agent or session, mounted persistent volume, and a host-routed HTTP endpoint for MCP, Lash, webhooks, and control traffic.

Contract outputs: `compute_endpoint`, `storage_mount`, `ingress_url`, `control_url`.
