output "fqdn" {
  value = aws_route53_record.porcupine.fqdn
}

output "caddy_iam_user" {
  value = aws_iam_user.caddy_dns01.name
}

output "hosted_zone_id" {
  value = data.aws_route53_zone.root.zone_id
}
