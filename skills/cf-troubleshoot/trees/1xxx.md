# Errors 1000, 1001, 1003, 1014, 1016, 1020

Symptom: a Cloudflare error page with a four-digit code. Read the exact code and the Ray ID from the page, then go to its block below. Each block lists its hypotheses in order of likelihood.

| Code | Meaning |
|---|---|
| 1000 | DNS points to prohibited IP |
| 1001 | DNS resolution error |
| 1003 | Direct IP access not allowed |
| 1014 | CNAME cross-user banned |
| 1016 | Origin DNS error |
| 1020 | Access denied (HTTP 403) |

## Evidence

Outside, for every code:

```
curl -sI https://example.com/
dig +short example.com A
dig +short example.com CNAME
dig +short NS example.com
```

The hostname's records in Cloudflare (DNS codes 1000, 1001, 1014, 1016):

```js
async () => {
  const records = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/dns_records", query: { name: "example.com" } });
  const ips = await cloudflare.request({ method: "GET", path: "/ips" });
  return { records: records.result, ips: ips.result };
}
```

For a CNAME target, resolve it from outside: `dig +short target.example.net A`. Fallback: `claudeflare get /zones/ZONE_ID/dns_records --query name=example.com` and `claudeflare get /ips`.

Security event for a 1020, by the Ray ID from the error page (use the hex part, without any `-XXX` data center suffix, and a window around the visitor's UTC time):

```js
async () => {
  const events = await cloudflare.request({ method: "POST", path: "/client/v4/graphql", body: { query: `query ($zoneTag: string, $ray: string, $since: Time, $until: Time) {
  viewer { zones(filter: { zoneTag: $zoneTag }) {
    firewallEventsAdaptive(limit: 10, filter: { rayName: $ray, datetime_geq: $since, datetime_leq: $until }) {
      action source ruleId rulesetId description clientIP clientRequestPath datetime
    }
  } }
}`, variables: { zoneTag: "ZONE_ID", ray: "8f1c2d3e4a5b6c7d", since: "2026-10-24T10:00:00Z", until: "2026-10-24T11:00:00Z" } } });
  return events;
}
```

Without a Ray ID, filter by `clientIP` instead of `rayName`.

## Hypotheses

**1000 DNS points to prohibited IP.**
1. An A record points to a Cloudflare IP (inside a range from `/ips`), or a Load Balancer origin points to a proxied record. Confirm: record content within a Cloudflare range. Reject: content is the real origin.
2. The origin is a reverse proxy that sends the request back through Cloudflare (for example nginx `proxy_pass` to a proxied hostname). Confirm: the user's origin config proxies to a hostname on Cloudflare. Reject: no such proxy.
3. The request carries a `CF-Connecting-IP` header, two `X-Forwarded-For` headers, or an `X-Forwarded-For` longer than 100 characters (typically from a proxy in front of Cloudflare). Confirm: only traffic through that client or proxy fails. Reject: plain browser requests fail too.
4. The hostname points to a SaaS provider on Cloudflare for SaaS with BYOIP that has no custom hostname for it. Confirm: CNAME or A goes to the provider. Fix belongs to the provider.

**1001 DNS resolution error.**
1. The CNAME target in Cloudflare does not resolve, or its DNS provider is offline. Confirm: `dig +short` on the target returns nothing. Reject: target resolves.
2. A domain not on Cloudflare has a CNAME to a hostname on Cloudflare, or someone requests a `*.cdn.cloudflare.net` name directly. Confirm: the visited domain's NS are not Cloudflare and it CNAMEs into a Cloudflare zone. Reject: domain is on Cloudflare.
3. The zone is not active or the request hit a Cloudflare IP for a domain that does not exist on Cloudflare. Confirm: zone `status` is not `active`. Reject: active.

**1003 Direct IP access not allowed.** A client requested a Cloudflare IP directly instead of the hostname. Confirm: the request URL or `Host` header is an IP. Fix: use the hostname; nothing to change in Cloudflare.

**1014 CNAME cross-user banned.**
1. A CNAME points to a hostname in another Cloudflare account. Confirm: the target's zone is not in the user's account (`GET /zones` with `query: { name: "target.zone" }` returns nothing). Reject: same account.
2. An R2 custom domain or MCP portal custom domain whose zone has a zone hold or is banned. Confirm: the user sees a zone hold. Reject: no hold.

**1016 Origin DNS error.**
1. No A or AAAA record for the origin, or a CNAME to an external name that does not resolve. Confirm: no record for the hostname, or `dig` on the CNAME target returns nothing. Reject: record exists and resolves.
2. Load Balancer pools whose origin hostnames do not resolve, a Spectrum app with a CNAME origin and no matching DNS record, or a Worker `fetch` to a Partial (CNAME) setup zone without the hostname in Cloudflare. Confirm with the matching config.
3. Cloudflare for SaaS custom hostname not active, fallback origin not set, or a standalone zone overriding a wildcard custom hostname. Confirm: custom hostname `status` and `verification_errors`.

**1020 Access denied.** A security rule with a Block action matched and has no custom response (for example API Shield schema validation or JWT validation). WAF custom and managed rule blocks show the WAF block page instead (see [waf-false-positive.md](waf-false-positive.md)). Confirm: the security event shows `action: block`, the `source` (product) and `ruleId`. Reject: no event for the Ray ID (wrong window or zone).

## Fix

- 1000 (hypothesis 1): plan a reversible `dns_update` that sets the record content to the real origin IP the user confirms (cf-dns). Hypothesis 2: the user replaces the origin reverse proxy with an HTTP redirect, or points it at the origin directly. Hypothesis 3: the user stops the client or proxy from adding those headers. Hypothesis 4: the user contacts the SaaS provider.
- 1001: fix or replace the CNAME target (reversible `dns_update`), or add the external domain to Cloudflare; visitors must not use `*.cdn.cloudflare.net` names.
- 1014: the target owner must offer Cloudflare for SaaS, or point the record to an address in the user's own account; release the zone hold for R2 or MCP portal domains.
- 1016: create or fix the record (reversible `dns_create` or `dns_update`, cf-dns), or fix the Load Balancer, Spectrum or Cloudflare for SaaS configuration named in the confirmed hypothesis.
- 1020: narrow or fix the rule named by `ruleId` and `source` in that product (for a WAF rule, see cf-waf); if the block is correct, tell the user it works as designed. A custom error rule can change the 1020 page.
- Verify: `curl -sI https://example.com/` and the visitor's request succeed; for 1020, no new block events for that client.

## Sources

- https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1000/
- https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1001/
- https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1003/
- https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1014/
- https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1016/
- https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1020/
- https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-firewall-events/
