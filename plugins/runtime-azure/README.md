# runtime-azure

Azure runtime provider for cloud-hosted agents. Intended shape: Container Apps, AKS, or VM compute, Blob/File workspace storage, and Application Gateway ingress for MCP, Lash, webhooks, and control traffic.

Contract outputs: `compute_endpoint`, `storage_mount`, `ingress_url`, `control_url`.
