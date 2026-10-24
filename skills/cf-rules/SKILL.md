---
name: cf-rules
description: Cloudflare Rules checklist for one zone. Page Rules migration to modern rules (Redirect, Cache, Configuration, Origin, Transform), redirect chains and redirect loops with Flexible SSL. Load it when auditing rules, migrating Page Rules, or creating or changing redirects, Configuration Rules, Origin Rules or Transform Rules through the Rulesets API. Load cf-core first.
---

# cf-rules: modern Rules, redirects and Page Rules migration

Load `cf-core` first. Findings use the `cf-audit` finding format and severity scale. Never create Page Rules; every new rule goes through the Rulesets API. In the MCP examples, replace `ZONE_ID` (and `ACCOUNT_ID`) with real ids; the guard needs literal paths.

## Read current state

Each rule type lives in a ruleset phase. Read the zone entrypoint with GET `/zones/{zone_id}/rulesets/phases/<phase>/entrypoint`; a 404 means no rules in that phase.

| Rule type | Phase |
|---|---|
| Single Redirects | `http_request_dynamic_redirect` |
| Bulk Redirects (account level: GET `/accounts/{account_id}/rulesets/phases/http_request_redirect/entrypoint`) | `http_request_redirect` |
| URL Rewrite (Transform) | `http_request_transform` |
| Request Header Transform | `http_request_late_transform` |
| Response Header Transform | `http_response_headers_transform` |
| Origin Rules | `http_request_origin` |
| Configuration Rules | `http_config_settings` |
| Cache Rules (see cf-cache) | `http_request_cache_settings` |
| Compression Rules | `http_response_compression` |

Page Rules (legacy): GET `/zones/{zone_id}/pagerules`. For loop checks also read the zone settings `ssl` and `always_use_https`.

MCP `execute` (one phase per call, because a 404 fails the whole call):

```js
async () => {
  const redirects = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/rulesets/phases/http_request_dynamic_redirect/entrypoint" });
  return redirects.result;
}
```

```js
async () => {
  const pageRules = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/pagerules" });
  const ssl = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/settings/ssl" });
  const https = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/settings/always_use_https" });
  return { pageRules: pageRules.result, ssl: ssl.result, https: https.result };
}
```

Fallback: `claudeflare get /zones/ZONE_ID/pagerules` and `claudeflare get /zones/ZONE_ID/rulesets/phases/http_request_dynamic_redirect/entrypoint`.

Live checks: follow redirects by hand with `curl -sI` and read `location` at each hop, starting from `http://example.com/`, `http://www.example.com/` and `https://example.com/`. Count the hops to the final 200, and stop after 10 (a loop).

## Checks

| finding id | condition | severity | recommended | plan tier |
|---|---|---|---|---|
| `rules.page_rules.present` | GET `/pagerules` returns one or more rules. Page Rules are deprecated and Cloudflare plans to migrate them automatically. | medium | Migrate each Page Rule to the modern rule type for its setting (table below), verify, then disable the Page Rule | free |
| `rules.redirect.chain` | A start URL needs two or more redirect hops to reach the final URL (for example `http://example.com` to `https://example.com` to `https://www.example.com`). | low | One Single Redirect that sends every variant straight to the final URL | free |
| `rules.redirect.loop_risk` | `ssl` is `flexible` and an HTTP to HTTPS redirect is issued for requests that already arrive over HTTPS: `curl -sI https://<host>/` returns 301 or 302 to the same `https://` URL (typically the origin forcing HTTPS), or a redirect rule or Page Rule redirects to `https://` without a scheme condition. | critical | Encryption mode `strict` (origin certificate first), and HTTPS enforcement at the edge only (Always Use HTTPS) | free |

Page Rules setting to modern rule (from the migration guide):

| Page Rule setting | Replace with |
|---|---|
| Forwarding URL, Always Use HTTPS | Single Redirects (`http_request_dynamic_redirect`) |
| Cache Level, Edge Cache TTL, Browser Cache TTL, Bypass Cache on Cookie, Custom Cache Key, Origin Cache Control, Cache Deception Armor | Cache Rules (`http_request_cache_settings`) |
| SSL, Security Level, Rocket Loader, Polish, Browser Integrity Check, Email Obfuscation, Automatic HTTPS Rewrites, Opportunistic Encryption, Disable Apps, Disable Zaraz | Configuration Rules (`http_config_settings`) |
| Host Header Override, Resolve Override | Origin Rules (`http_request_origin`) |
| IP Geolocation Header, True Client IP Header | Managed Transforms |
| Disable Security, Disable Performance, Web Application Firewall, Response Buffering | Deprecated: no direct replacement; use skip rules (cf-waf) or Configuration Rules |

Severity of `rules.redirect.loop_risk` is critical because the condition describes a live redirect loop. If only a risk exists (Flexible, but no HTTPS redirect observed), report `ssl.mode.flexible` from cf-ssl instead.

## Applying changes

Use the change protocol from cf-core. Read the phase entrypoint first; its `id` is `RULESET_ID`, each rule's `id` is `RULE_ID`.

Add a Single Redirect when the entrypoint exists (reversible, `rule_create`). Example: apex to `www`, keeping path and query, one hop:

```json
{ "method": "POST", "path": "/zones/{zone_id}/rulesets/RULESET_ID/rules", "body": {
  "description": "Apex to www",
  "expression": "(http.host eq \"example.com\")",
  "action": "redirect",
  "action_parameters": { "from_value": { "status_code": 301, "target_url": { "expression": "concat(\"https://www.example.com\", http.request.uri.path)" }, "preserve_query_string": true } }
} }
```

When the phase has no entrypoint yet (404), create it with the rules (reversible, `phase_entrypoint_put`). A PUT replaces all rules in the phase, so on an existing entrypoint use rule ops instead:

```json
{ "method": "PUT", "path": "/zones/{zone_id}/rulesets/phases/http_request_dynamic_redirect/entrypoint", "body": { "rules": [ { "description": "Apex to www", "expression": "(http.host eq \"example.com\")", "action": "redirect", "action_parameters": { "from_value": { "status_code": 301, "target_url": { "expression": "concat(\"https://www.example.com\", http.request.uri.path)" }, "preserve_query_string": true } } } ] } }
```

Configuration Rule replacing a Page Rule that set Security Level or SSL for a path (reversible, `rule_create` on the `http_config_settings` entrypoint):

```json
{ "method": "POST", "path": "/zones/{zone_id}/rulesets/RULESET_ID/rules", "body": {
  "description": "Migrated from Page Rule: example.com/admin/*",
  "expression": "(http.host eq \"example.com\" and starts_with(http.request.uri.path, \"/admin/\"))",
  "action": "set_config",
  "action_parameters": { "security_level": "high" }
} }
```

Update or delete a rule (reversible, `rule_update` / `rule_delete`; a PATCH replaces the rule definition, so repeat every field you keep):

```json
{ "method": "DELETE", "path": "/zones/{zone_id}/rulesets/RULESET_ID/rules/RULE_ID" }
```

Page Rules migration takes two plans per rule: first create the modern rule and verify the behavior with `curl -sI` (modern rules already take precedence over Page Rules), then disable the Page Rule. Disabling is not reversible through `claudeflare rollback` (the risk note says so; re-enabling is a new plan with `"status": "active"`):

```json
{ "method": "PATCH", "path": "/zones/{zone_id}/pagerules/PAGERULE_ID", "body": { "status": "disabled" } }
```

Plan limits: one plan may not touch the same rule twice, delete more than one rule in the same ruleset, or PUT the same phase entrypoint twice. Split larger migrations into several plans.

## Traps

- **Never create Page Rules**, even when a user asks for "a page rule": build the equivalent modern rule and say why.
- **Flexible SSL plus a redirect to HTTPS loops.** Edge redirects (Always Use HTTPS, a Single Redirect matching `not ssl`) are safe; a redirect at the origin, or a rule that redirects HTTPS requests to HTTPS, loops under Flexible. Fix the encryption mode, not the redirect.
- **Evaluation differs from Page Rules.** Page Rules apply the first match; modern rules are stackable and the last matching rule wins for the same setting. Order matters when migrating several Page Rules for overlapping URLs.
- **URL matching differs.** Page Rule URLs ignore the scheme and query string unless written in; `http.request.full_uri` includes both. Prefer `http.host` plus `http.request.uri.path` expressions.
- **Cache Rules "Eligible for cache" equals Cache Everything**; when migrating a Page Rule that only set Edge Cache TTL, check whether HTML becomes cacheable (see cf-cache).
- **Workers suppress Page Rules but not modern rules**; migration can change behavior on Worker routes.
- **PUT on an entrypoint replaces every rule in the phase.** Only use it to create a missing entrypoint or with a body that repeats all existing rules.
- **Redirect status codes**: 301 and 308 are cached by browsers; use 302 or 307 while testing, then switch.
- **Regex** (`matches`) in rule expressions needs Business or Enterprise; use `starts_with`, `ends_with`, `contains` and `in` on Free and Pro.

## Sources

- https://developers.cloudflare.com/rules/reference/page-rules-migration/
- https://developers.cloudflare.com/rules/url-forwarding/single-redirects/
- https://developers.cloudflare.com/rules/url-forwarding/single-redirects/create-api/
- https://developers.cloudflare.com/rules/url-forwarding/
- https://developers.cloudflare.com/rules/configuration-rules/settings/
- https://developers.cloudflare.com/ruleset-engine/reference/phases-list/
- https://developers.cloudflare.com/ruleset-engine/rulesets-api/view/
- https://developers.cloudflare.com/ruleset-engine/rulesets-api/update-rule/
- https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/flexible/
- https://developers.cloudflare.com/api/resources/page_rules/methods/list/
