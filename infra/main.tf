locals {
  fqdn           = "porcupine.example.com"
  acme_challenge = "_acme-challenge.${local.fqdn}"
}

data "aws_route53_zone" "root" {
  name         = "example.com"
  private_zone = false
}

resource "aws_route53_record" "porcupine" {
  zone_id = data.aws_route53_zone.root.zone_id
  name    = local.fqdn
  type    = "A"
  ttl     = 300
  records = [var.tailnet_ipv4]
}

# Caddy uses this user for Let's Encrypt DNS-01. Its access key is created
# out of band by scripts/caddy-keys.sh so the secret never lands in state.
resource "aws_iam_user" "caddy_dns01" {
  name = "porcupine-caddy-dns01"
  path = "/porcupine/"
}

data "aws_iam_policy_document" "caddy_dns01" {
  statement {
    sid       = "ChangeAcmeChallengeOnly"
    actions   = ["route53:ChangeResourceRecordSets"]
    resources = ["arn:aws:route53:::hostedzone/${data.aws_route53_zone.root.zone_id}"]

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "route53:ChangeResourceRecordSetsNormalizedRecordNames"
      values   = [local.acme_challenge]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "route53:ChangeResourceRecordSetsRecordTypes"
      values   = ["TXT"]
    }
  }

  statement {
    sid       = "ListZoneRecords"
    actions   = ["route53:ListResourceRecordSets"]
    resources = ["arn:aws:route53:::hostedzone/${data.aws_route53_zone.root.zone_id}"]
  }

  statement {
    sid       = "PollChanges"
    actions   = ["route53:GetChange"]
    resources = ["arn:aws:route53:::change/*"]
  }

  statement {
    sid       = "FindZone"
    actions   = ["route53:ListHostedZones", "route53:ListHostedZonesByName"]
    resources = ["*"]
  }
}

resource "aws_iam_user_policy" "caddy_dns01" {
  name   = "route53-dns01-example-com"
  user   = aws_iam_user.caddy_dns01.name
  policy = data.aws_iam_policy_document.caddy_dns01.json
}
