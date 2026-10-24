Cloudflare REST API v4 endpoints for this test zone (call them with `cloudflare.request` inside `execute`):

- GET /zones?name=<domain>: zone lookup (id, plan, status)
- GET /zones/{zone_id}/dns_records?name=<host>: DNS records
- GET /zones/{zone_id}/settings/<setting_id>: one zone setting, for example ssl, ssl_automatic_mode, always_use_https, min_tls_version, tls_1_3, automatic_https_rewrites, security_header
- GET /zones/{zone_id}/rulesets/phases/<phase>/entrypoint: phase entrypoint ruleset, for example http_request_origin
- GET /accounts/{account_id}/audit_logs?since=<iso time>: audit log
- POST /client/v4/graphql: GraphQL analytics, for example httpRequestsAdaptiveGroups
