# runtime-vercel

Vercel runtime provider for edge-friendly agent endpoints and lightweight workers. Intended shape: function compute, Vercel Blob/KV for workspace state, and public HTTPS ingress for MCP, Lash, webhooks, and control traffic.

Contract outputs: `compute_endpoint`, `storage_mount`, `ingress_url`, `control_url`.
