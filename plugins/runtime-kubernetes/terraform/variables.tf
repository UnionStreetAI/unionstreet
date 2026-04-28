variable "agent_id" {
  type = string
}

variable "namespace" {
  type    = string
  default = "union-street"
}

variable "image" {
  type    = string
  default = "ghcr.io/unionstreet/agent-runtime:latest"
}

variable "storage_mount" {
  type    = string
  default = "/workspace"
}

variable "ingress_url" {
  type = string
}
