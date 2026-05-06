variable "agent" {
  type = string
}

variable "image" {
  type    = string
  default = "ghcr.io/unionstreet/agent-runtime:latest"
}

variable "region" {
  type    = string
  default = "oregon"
}

variable "service_url" {
  type    = string
  default = ""
}

variable "control_url" {
  type    = string
  default = ""
}

variable "workspace_mount" {
  type    = string
  default = "/workspace"
}

variable "labels" {
  type    = map(string)
  default = {}
}
