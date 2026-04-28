terraform {
  required_version = ">= 1.6.0"
}

locals {
  storage_mount = var.storage_mount
  ingress_url   = var.ingress_url
}
