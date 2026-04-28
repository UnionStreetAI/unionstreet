# runtime-gcp

GCP runtime provider for cloud-hosted agents. Intended shape: Compute Engine or Cloud Run compute, GCS/workspace storage, and HTTPS load-balanced ingress for MCP, Lash, webhooks, and control traffic.

Contract outputs: `compute_endpoint`, `storage_mount`, `ingress_url`, `control_url`.
