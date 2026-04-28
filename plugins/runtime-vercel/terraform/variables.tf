variable "agent_id" {
  type = string
}

variable "team_id" {
  type    = string
  default = ""
}

variable "storage_mount" {
  type    = string
  default = "/workspace"
}

variable "ingress_url" {
  type = string
}
