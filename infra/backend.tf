# Partial backend config: the bucket (and optionally region) come from a local,
# untracked backend.hcl. See backend.hcl.example.
terraform {
  backend "s3" {
    key          = "porcupine/infra.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}
