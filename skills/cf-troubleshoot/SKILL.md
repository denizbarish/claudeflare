---
name: cf-troubleshoot
description: Evidence-first diagnosis of Cloudflare problems with one decision tree per symptom. Errors 520, 521, 522, 523, 524, 525, 526, 1xxx (1000, 1001, 1003, 1014, 1016, 1020), redirect loops (ERR_TOO_MANY_REDIRECTS), cache misses, CORS failures and WAF false positives. Load it when a site behind Cloudflare shows an error, loops, does not cache, fails CORS or blocks legitimate users. Load cf-core first.
---

# cf-troubleshoot: evidence-first diagnosis

Load `cf-core` first. This skill finds the root cause; the fixes for Cloudflare settings live in the domain skills (cf-ssl, cf-cache, cf-rules, cf-waf, cf-dns), and the trees point to their finding ids instead of repeating them.

## Method

Follow these five steps for every symptom, in order.

1. **Symptom.** Collect the error code (and the text on the error page), the exact URL, when it started, and the scope: all users or some, all paths or some, all hostnames or one. Ask the user only for what you cannot read yourself.
2. **Outside evidence.** Headers and body from the public URL, DNS resolution and the TLS handshake (commands below). Request the origin directly only with an origin IP the user gives you.
3. **Inside evidence.** Zone settings and rules for the symptom (each tree lists them), audit log entries around the start time, HTTP and security analytics through GraphQL.
4. **Hypotheses.** Open the tree for the symptom. Work through its hypotheses in order of likelihood and confirm or reject each with the evidence the tree names. Do not stop at the first plausible one: when one is confirmed, still check the cheap remaining ones, because two causes often stack (for example a firewall block plus a wrong DNS record).
5. **Result.** Root cause, the evidence for it, the fix, and how you will verify the fix.

## Rules

- **Every conclusion cites evidence**: the command or API read and the exact value or header line it returned. A hypothesis without evidence is reported as unconfirmed, never as the cause.
- **Never touch the origin.** Do not run commands on the origin server (no SSH, no remote shell, no control panel). Origin-side fixes are step-by-step instructions for the user or their host. You may only send ordinary read-only requests to the origin from the local machine, and only with an origin IP the user provides.
- **Read only while diagnosing.** All Cloudflare changes go through the cf-core change protocol (plan, user approval, apply, verify). Do not change the proxy status, pause Cloudflare or turn settings off "to test" outside a plan.
- **No secrets in chat.** Never ask the user to paste a token, a private key or a cookie value.
- Cloudflare-side fixes are plan draft ops (prefer reversible kinds: zone settings, rule create or update) or a pointer to a domain skill finding, for example "fix via cf-ssl, finding `ssl.mode.flexible`".

## Pick a tree

| Symptom | Tree |
|---|---|
| 520 Web server returns an unknown error | [trees/520.md](trees/520.md) |
| 521 Web server is down | [trees/521.md](trees/521.md) |
| 522 Connection timed out | [trees/522.md](trees/522.md) |
| 523 Origin is unreachable | [trees/523.md](trees/523.md) |
| 524 A timeout occurred | [trees/524.md](trees/524.md) |
| 525 SSL handshake failed, 526 Invalid SSL certificate | [trees/525-526.md](trees/525-526.md) |
| 1000, 1001, 1003, 1014, 1016, 1020 | [trees/1xxx.md](trees/1xxx.md) |
| ERR_TOO_MANY_REDIRECTS, "page isn't redirecting properly" | [trees/redirect-loop.md](trees/redirect-loop.md) |
| Content not cached, low hit ratio, `cf-cache-status` MISS, BYPASS or DYNAMIC | [trees/cache-miss.md](trees/cache-miss.md) |
| Browser reports a CORS error | [trees/cors.md](trees/cors.md) |
| Legitimate users or API calls blocked or challenged ("Sorry, you have been blocked", 403) | [trees/waf-false-positive.md](trees/waf-false-positive.md) |

A 5xx that is not 520 to 526 (for example 500, 502, 503, 504 without the Cloudflare error page) usually comes from the origin itself: confirm with `originResponseStatus` in the status query below (origin status equals edge status).

## Shared evidence

In the commands, replace `example.com` with the affected hostname, `ZONE_ID` and `ACCOUNT_ID` with real ids (cf-core discovery), and timestamps with a window around the start time (ISO 8601 UTC).

Outside, from the local machine:

```
curl -sI https://example.com/
curl -s https://example.com/cdn-cgi/trace
dig +short example.com A
dig +short example.com AAAA
dig +short NS example.com
openssl s_client -connect example.com:443 -servername example.com </dev/null 2>/dev/null | grep -E "subject=|issuer=|Verify return code"
```

`server: cloudflare` and a `cf-ray` header prove the request went through Cloudflare; the last three letters of `cf-ray` are the data center. A proxied record resolves to Cloudflare IPs (compare with `claudeflare get /ips`).

What changed: read the audit log around the start time. Audit Logs v2 first (`since` and `before` are required):

```js
async () => {
  const logs = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/logs/audit", query: { since: "2026-10-24T06:00:00Z", before: "2026-10-24T12:00:00Z", limit: 50 } });
  return logs.result;
}
```

If v2 fails or the window is older than v2 holds, fall back to v1, which can filter by zone:

```js
async () => {
  const logs = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/audit_logs", query: { since: "2026-10-24T06:00:00Z", before: "2026-10-24T12:00:00Z", "zone.name": "example.com", per_page: 50 } });
  return logs.result;
}
```

Fallback without MCP: `claudeflare get /accounts/ACCOUNT_ID/logs/audit --query since=2026-10-24T06:00:00Z --query before=2026-10-24T12:00:00Z`. Look for DNS, SSL, rules and WAF changes just before the start time; an origin change (new server, new IP, firewall update) will not appear here, so ask the user about it.

Edge status versus origin status, per five minutes, for one hostname. `originResponseStatus` 0 means no HTTP response from the origin (or no origin contact for a cache hit); a 5xx at the edge with origin status 200 points to a malformed response:

```js
async () => {
  const status = await cloudflare.request({ method: "POST", path: "/client/v4/graphql", body: { query: `query ($zoneTag: string, $host: string, $since: Time, $until: Time) {
  viewer { zones(filter: { zoneTag: $zoneTag }) {
    httpRequestsAdaptiveGroups(limit: 500, filter: { clientRequestHTTPHost: $host, datetime_geq: $since, datetime_leq: $until, edgeResponseStatus_geq: 500 }, orderBy: [datetimeFiveMinutes_ASC]) {
      count dimensions { datetimeFiveMinutes edgeResponseStatus originResponseStatus clientRequestPath }
    }
  } }
}`, variables: { zoneTag: "ZONE_ID", host: "example.com", since: "2026-10-24T06:00:00Z", until: "2026-10-24T12:00:00Z" } } });
  return status;
}
```

The first bucket with errors is the start time to search the audit log for. If a GraphQL field or filter is rejected, check the schema with the MCP `docs` or `search` tool instead of guessing. GraphQL needs MCP; without it, ask the user for the dashboard Analytics view.

## Result format

Report in the user's language:

- **Root cause**: one sentence.
- **Evidence**: each supporting command or read, with the value it returned. List rejected hypotheses with the evidence that rejected them.
- **Fix**: Cloudflare side as a plan through the cf-core change protocol (or the domain skill finding to apply); origin side as numbered steps for the user or their host.
- **Verify**: the exact command or read that will show the fix worked (for example `curl -sI` returns 200 with `cf-ray`, or the 5xx count in the status query drops to zero).

## Sources

- https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/
- https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/
- https://developers.cloudflare.com/fundamentals/account/account-security/audit-logs/
- https://developers.cloudflare.com/api/resources/accounts/subresources/logs/subresources/audit/methods/list/
- https://developers.cloudflare.com/api/resources/audit_logs/methods/list/
- https://developers.cloudflare.com/analytics/graphql-api/features/data-sets/
- https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/
