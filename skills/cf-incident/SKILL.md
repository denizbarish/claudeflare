---
name: cf-incident
description: Live attack response on a Cloudflare zone. Detect traffic and security event spikes with GraphQL analytics, contain with Under Attack mode or temporary block, challenge and rate limit rules (each through the change protocol, slug prefix incident-), return to normal by rolling back every incident plan, and report. Load it when a site is under attack, flooded, scraped or brute forced, or a spike needs explaining. Load cf-core first.
---

# cf-incident: detect, contain, return to normal

Load `cf-core` first. An incident does not suspend the change protocol: every containment is a plan the user approves with `/claudeflare:approve <plan-id>`. Keep each plan small (one setting or one rule) so it is quick to review and easy to roll back. Never run commands on the origin server; origin-side steps go to the user as instructions.

In the examples, replace `ZONE_ID` (the zone id, which GraphQL calls `zoneTag`) and the timestamps (ISO 8601 UTC) with real values. Keep windows short (1 to 6 hours); adaptive datasets keep at least 31 days of data on every plan.

## Detect

1. Confirm the spike: requests per five minutes by status code over the last hours.

```js
async () => {
  const spike = await cloudflare.request({ method: "POST", path: "/client/v4/graphql", body: { query: `query ($zoneTag: string, $since: Time, $until: Time) {
  viewer { zones(filter: { zoneTag: $zoneTag }) {
    httpRequestsAdaptiveGroups(limit: 500, filter: { datetime_geq: $since, datetime_leq: $until }, orderBy: [datetimeFiveMinutes_ASC]) {
      count dimensions { datetimeFiveMinutes edgeResponseStatus }
    }
  } }
}`, variables: { zoneTag: "ZONE_ID", since: "2026-10-24T06:00:00Z", until: "2026-10-24T12:00:00Z" } } });
  return spike;
}
```

2. Find who and what: top source IPs, ASNs, countries and paths during the spike window.

```js
async () => {
  const top = await cloudflare.request({ method: "POST", path: "/client/v4/graphql", body: { query: `query ($zoneTag: string, $since: Time, $until: Time) {
  viewer { zones(filter: { zoneTag: $zoneTag }) {
    httpRequestsAdaptiveGroups(limit: 20, filter: { datetime_geq: $since, datetime_leq: $until }, orderBy: [count_DESC]) {
      count dimensions { clientIP clientAsn clientCountryName clientRequestPath }
    }
  } }
}`, variables: { zoneTag: "ZONE_ID", since: "2026-10-24T11:00:00Z", until: "2026-10-24T12:00:00Z" } } });
  return top;
}
```

3. See what Cloudflare already mitigates: security events by action, source (which product or rule) and origin of traffic.

```js
async () => {
  const events = await cloudflare.request({ method: "POST", path: "/client/v4/graphql", body: { query: `query ($zoneTag: string, $since: Time, $until: Time) {
  viewer { zones(filter: { zoneTag: $zoneTag }) {
    firewallEventsAdaptiveGroups(limit: 20, filter: { datetime_geq: $since, datetime_leq: $until }, orderBy: [count_DESC]) {
      count dimensions { action source clientAsn clientCountryName clientIP clientRequestPath }
    }
  } }
}`, variables: { zoneTag: "ZONE_ID", since: "2026-10-24T11:00:00Z", until: "2026-10-24T12:00:00Z" } } });
  return events;
}
```

Fallback without MCP: `claudeflare get` covers REST reads only; GraphQL needs MCP, so ask the user to check Security Analytics in the dashboard.

Read the evidence before acting:

- A few IPs or one ASN with most of the traffic: targeted rule by IP or ASN.
- One path (login, search, an expensive API) hammered from many sources: rate limit or challenge on that path.
- Traffic from countries the site does not serve: challenge by country (prefer `managed_challenge` over `block`).
- Broad L7 flood from everywhere, origin failing (rising 5xx, 52x): Under Attack mode.
- If a GraphQL dimension is rejected, check the schema with the MCP `docs` or `search` tool instead of guessing.

Also read the current state that containment will touch: `/zones/ZONE_ID/settings/security_level` and the `http_request_firewall_custom` and `http_ratelimit` entrypoints (see cf-waf and cf-bots-ratelimit).

## Contain

Every step is its own plan with a slug that starts with `incident-`, so the plans are easy to find and roll back later. Start with the narrowest action the evidence supports.

Under Attack mode (reversible, `zone_setting`; challenges every visitor and breaks API and mobile clients):

```json
{
  "zone_id": "023e105f4ecef8ad9ca31a8372d0c353",
  "zone_name": "example.com",
  "summary": "Incident: turn on Under Attack mode",
  "risk": "Every visitor gets a challenge page; API clients, webhooks and monitors fail until it is turned off.",
  "slug": "incident-under-attack",
  "ops": [
    { "method": "PATCH", "path": "/zones/{zone_id}/settings/security_level", "body": { "value": "under_attack" } }
  ]
}
```

Temporary custom rule (reversible, `rule_create` on the `http_request_firewall_custom` entrypoint, `RULESET_ID` from the read; `phase_entrypoint_put` if it does not exist). Put "incident" and the date in `description`. Expressions by evidence:

| Target | Expression | Action |
|---|---|---|
| IPs or ranges | `(ip.src in {203.0.113.7 198.51.100.0/24})` | `block` |
| ASN | `(ip.src.asnum in {64496})` | `managed_challenge` or `block` |
| Countries | `(ip.src.country in {"XX" "YY"})` | `managed_challenge` |
| Path | `(http.request.uri.path eq "/search")` | `managed_challenge` |

```json
{
  "zone_id": "023e105f4ecef8ad9ca31a8372d0c353",
  "zone_name": "example.com",
  "summary": "Incident: challenge traffic from AS64496",
  "risk": "Real users on AS64496 see a challenge; API clients from that network fail.",
  "slug": "incident-challenge-as64496",
  "ops": [
    { "method": "POST", "path": "/zones/{zone_id}/rulesets/RULESET_ID/rules", "body": { "description": "incident 2026-10-24: challenge AS64496", "expression": "(ip.src.asnum in {64496})", "action": "managed_challenge", "position": { "index": 1 } } }
  ]
}
```

`position: { "index": 1 }` puts the rule first so earlier skip or allow rules do not let the attack through; check the existing rules before choosing a position. Use `block` only for sources with no legitimate traffic.

Emergency rate limit on a hammered path: add a rule to the `http_ratelimit` entrypoint as in cf-bots-ratelimit, slug `incident-ratelimit-<path>`. Respect the plan limits (Free: one rule, 10 second period); if the slot is taken, use a custom rule challenge on the path instead.

After each apply, verify within minutes: rerun the Detect queries for the last 15 minutes and check that the incident rule shows up in `firewallEventsAdaptiveGroups` and that origin errors fall. If the origin IP is the target (traffic bypasses Cloudflare), tell the user that Cloudflare rules cannot help; the origin firewall must accept only Cloudflare IP ranges (an origin-side step for them), and see `dns.proxy.origin_exposed` in cf-dns.

## Return to normal

Criteria before removing containment (all must hold):

- Request rate and status codes back to the pre-incident baseline (Detect query 1) for at least 30 minutes, or longer for recurring attacks.
- The incident rules' event counts in `firewallEventsAdaptiveGroups` dropped to near zero.
- No origin errors (5xx, 52x) above baseline.
- The user agrees.

Steps:

1. `claudeflare plan list` and pick the applied plans whose id contains `-incident-`.
2. Roll back the broadest measure first (Under Attack mode), then the targeted rules one at a time, newest first: `claudeflare rollback <plan-id>` creates a draft rollback plan for each.
3. Present each rollback plan, get `/claudeflare:approve <rollback-plan-id>` from the user, run `claudeflare apply <rollback-plan-id>`, and verify (read the setting or entrypoint again).
4. After each step, rerun Detect for 15 minutes; if the attack returns, re-apply containment with a new `incident-` plan instead of reusing the old one.
5. Keep a containment rule permanently only if the user wants it; then move it into a normal (non-incident) plan in cf-waf terms so it is not rolled back by mistake.

## Report

Give the user, in their language:

- Timeline (UTC): first signal, detection, each containment apply, each rollback, all-clear.
- Evidence: peak request rate, top sources (IP, ASN, country) and paths, status code shift, with the query windows used.
- Containment: plan ids, what each did, applied and rolled back times, events matched by each rule.
- Impact: errors or challenges real users saw, false positives found.
- Follow-ups: permanent hardening as findings in cf-waf and cf-bots-ratelimit terms (for example `ratelimit.login.missing`, `waf.custom.admin_unprotected`, `dns.proxy.origin_exposed`), each a normal plan if the user wants it.

## Sources

- https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-firewall-events/
- https://developers.cloudflare.com/analytics/graphql-api/features/data-sets/
- https://developers.cloudflare.com/analytics/graphql-api/limits/
- https://developers.cloudflare.com/analytics/graphql-api/migration-guides/zone-analytics/
- https://developers.cloudflare.com/fundamentals/reference/under-attack-mode/
- https://developers.cloudflare.com/waf/tools/security-level/
- https://developers.cloudflare.com/waf/custom-rules/
- https://developers.cloudflare.com/waf/rate-limiting-rules/
- https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/ip.src.asnum/
- https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/ip.src.country/
- https://developers.cloudflare.com/ruleset-engine/rulesets-api/update-rule/
