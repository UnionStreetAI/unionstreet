variable "agent_id" {
  type = string
}

variable "storage_mount" {
  type    = string
  default = "~/.us/workspaces"
}

variable "ingress_url" {
  type    = string
  default = "http://127.0.0.1:0"
}
