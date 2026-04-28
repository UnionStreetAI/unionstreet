output "compute_endpoint" {
  value = "${local.service_name}.${local.namespace}.svc.cluster.local"
}

output "storage_mount" {
  value = local.storage_mount
}

output "ingress_url" {
  value = local.ingress_url
}

output "control_url" {
  value = local.ingress_url
}
