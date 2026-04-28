# runtime-aws

AWS runtime provider for cloud-hosted agents. Intended shape: ECS/Fargate or EC2 compute, S3/EFS workspace storage, and ALB/API Gateway ingress for MCP, Lash, webhooks, and control traffic.

Contract outputs: `compute_endpoint`, `storage_mount`, `ingress_url`, `control_url`.
