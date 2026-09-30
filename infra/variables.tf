variable "zone_name" {
  description = "Public Route 53 hosted zone that holds the record, e.g. example.com."
  type        = string
}

variable "fqdn" {
  description = "Hostname the app is served at, inside zone_name, e.g. porcupine.example.com."
  type        = string
}

variable "host_ipv4" {
  description = "Private IPv4 of the host running the hub (Tailscale, WireGuard or LAN). scripts/tf.sh passes it."
  type        = string

  validation {
    condition     = can(cidrhost("${var.host_ipv4}/32", 0))
    error_message = "host_ipv4 must be an IPv4 address."
  }
}
