variable "tailnet_ipv4" {
  description = "Tailnet IPv4 of the VM; scripts/tf.sh passes $(tailscale ip -4)."
  type        = string

  validation {
    condition     = can(cidrhost("${var.tailnet_ipv4}/32", 0)) && startswith(var.tailnet_ipv4, "100.")
    error_message = "tailnet_ipv4 must be a Tailscale CGNAT IPv4 address (100.x.y.z)."
  }
}
