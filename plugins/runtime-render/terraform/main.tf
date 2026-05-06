terraform {
  required_version = ">= 1.5.0"
}

locals {
  labels = merge(var.labels, {
    "unionstreet.plugin" = "runtime-render"
    "unionstreet.agent"  = var.agent
  })
}

output "compute_endpoint" {
  value = var.service_url
}

output "storage_mount" {
  value = var.workspace_mount
}

output "ingress_url" {
  value = var.service_url
}

output "control_url" {
  value = var.control_url
}
