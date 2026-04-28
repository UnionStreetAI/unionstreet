terraform {
  required_version = ">= 1.6.0"
}

locals {
  name          = "us-${var.agent_id}"
  storage_mount = var.storage_mount
  ingress_url   = var.ingress_url
}
