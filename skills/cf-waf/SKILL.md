---
name: cf-waf
description: Cloudflare WAF checklist for one zone. Managed rulesets (Free Managed, Cloudflare Managed, OWASP Core), custom rules protecting admin paths, overly broad skip rules and Security Level. Load it when auditing application security, deploying managed rules, writing WAF custom or skip rules, or handling WAF false positives. Load cf-core first.
---

# cf-waf: managed rules, custom rules, skip rules

Load `cf-core` first. Findings use the `cf-audit` finding format and severity scale. In the MCP examples, replace `ZONE_ID` with the real zone id; the guard needs literal paths.

## Read current state

| What | GET path |
|---|---|
| Managed rules deployed (`execute` rules) | `/zones/{zone_id}/rulesets/phases/http_request_firewall_managed/entrypoint` (404 means nothing deployed) |
| Custom rules and skip rules | `/zones/{zone_id}/rulesets/phases/http_request_firewall_custom/entrypoint` (404 means none) |
| Managed rulesets available to the zone (ids and names) | `/zones/{zone_id}/rulesets` |
| Security Level | `/zones/{zone_id}/settings/security_level` |

Managed ruleset ids: Cloudflare Managed Ruleset `efb7b8c949ac4650a09736fc376e9aee`, Cloudflare OWASP Core Ruleset `4814384a9e5d4991b9815dcfc25d2f1f`. Take the Cloudflare Free Managed Ruleset id from the `/rulesets` list (`kind: "managed"`, name "Cloudflare Free Managed Ruleset") instead of hardcoding it.

MCP `execute` (one phase per call, because a 404 fails the whole call):

```js
async () => {
  const managed = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/rulesets/phases/http_request_firewall_managed/entrypoint" });
  return managed.result;
}
```

```js
async () => {
  const custom = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/rulesets/phases/http_request_firewall_custom/entrypoint" });
  const level = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/settings/security_level" });
  return { custom: custom.result, level: level.result };
}
```

Fallback: `claudeflare get /zones/ZONE_ID/rulesets/phases/http_request_firewall_managed/entrypoint`.

Live checks: `curl -sI https://<host>/wp-admin/`, `curl -sI https://<host>/wp-login.php` and `curl -sI https://<host>/admin` (only paths the site actually has). A `cf-mitigated: challenge` header or a 403 means the path is protected; 200 or a login redirect without it means it is open to everyone.

## Checks

| finding id | condition | severity | recommended | plan tier |
|---|---|---|---|---|
| `waf.managed.off` | No enabled `execute` rule in `http_request_firewall_managed` for the Cloudflare Managed Ruleset (Pro and above) or, on Free, for the Cloudflare Free Managed Ruleset. Also raise it when the rule exists but is disabled or its expression covers only part of the traffic without a reason. | high | Deploy the Cloudflare Managed Ruleset with `expression: "true"` (Free: the Free Managed Ruleset) | free (Free Managed), pro (Cloudflare Managed) |
| `waf.owasp.off` | No enabled `execute` rule for the OWASP Core Ruleset on a Pro or higher zone. On Free, report it with `plan_tier: "pro"` and `fix: []`. | medium | Deploy OWASP Core with default paranoia level and score threshold, then watch Security Events for false positives before tightening | pro |
| `waf.custom.admin_unprotected` | Admin or login paths that exist on the site (`/wp-admin`, `/wp-login.php`, `/admin`, `/administrator`) have no custom rule with `block` or `managed_challenge`, and the live check shows them open. | high | Custom rule: `managed_challenge` (or `block` with an allowlist of the user's IPs) on those paths | free |
| `waf.skip.too_broad` | A `skip` rule in `http_request_firewall_custom` matches far more than one trusted client: expression `true`, a whole hostname, a country, a user agent alone, or a large path prefix such as `/`; or it skips `ruleset: "current"`, all managed rules (`phases` contains `http_request_firewall_managed`) or all products for such traffic. | high | Narrow the expression to the trusted source (IP list, specific path plus method, verified header) and skip only the rules that cause false positives | free |
| `waf.security_level.essentially_off` | `security_level` is `off` or `essentially_off`. Per current docs the threat score is no longer populated, so Security Level now mostly controls Under Attack mode; the real gap is usually missing managed and custom rules. | low | `medium` (the default), and rely on managed rules for protection | free |

Plan notes: custom rules per zone are 5 (Free), 20 (Pro), 100 (Business), 1,000 (Enterprise); the `log` action is Enterprise only and regex (`matches`) needs Business or Enterprise. Managed rulesets: Free Managed on all plans; Cloudflare Managed and OWASP Core on Pro and above.

## Applying changes

Use the change protocol from cf-core. Read the phase entrypoint first; its `id` is `RULESET_ID`.

Deploy the Cloudflare Managed Ruleset when the managed entrypoint exists (reversible, `rule_create`):

```json
{ "method": "POST", "path": "/zones/{zone_id}/rulesets/RULESET_ID/rules", "body": { "action": "execute", "action_parameters": { "id": "efb7b8c949ac4650a09736fc376e9aee" }, "expression": "true", "description": "Execute the Cloudflare Managed Ruleset" } }
```

When the managed phase has no entrypoint (404), create it (reversible, `phase_entrypoint_put`; a PUT replaces all rules in the phase, so never use it on an existing entrypoint unless the body repeats every current rule):

```json
{ "method": "PUT", "path": "/zones/{zone_id}/rulesets/phases/http_request_firewall_managed/entrypoint", "body": { "rules": [
  { "action": "execute", "action_parameters": { "id": "efb7b8c949ac4650a09736fc376e9aee" }, "expression": "true", "description": "Execute the Cloudflare Managed Ruleset" },
  { "action": "execute", "action_parameters": { "id": "4814384a9e5d4991b9815dcfc25d2f1f" }, "expression": "true", "description": "Execute the Cloudflare OWASP Core Ruleset" }
] } }
```

Protect admin paths (reversible, `rule_create` on the custom entrypoint; for WordPress keep `admin-ajax.php` reachable because public pages call it):

```json
{ "method": "POST", "path": "/zones/{zone_id}/rulesets/RULESET_ID/rules", "body": {
  "description": "Challenge admin and login paths",
  "expression": "((starts_with(http.request.uri.path, \"/wp-admin\") and http.request.uri.path ne \"/wp-admin/admin-ajax.php\") or http.request.uri.path eq \"/wp-login.php\" or starts_with(http.request.uri.path, \"/admin\"))",
  "action": "managed_challenge"
} }
```

Narrow a broad skip rule (reversible, `rule_update`; a rule PATCH replaces the definition, so send every field you keep):

```json
{ "method": "PATCH", "path": "/zones/{zone_id}/rulesets/RULESET_ID/rules/RULE_ID", "body": {
  "description": "Skip managed rules for the payment webhook only",
  "expression": "(http.request.uri.path eq \"/webhooks/payments\" and http.request.method eq \"POST\")",
  "action": "skip",
  "action_parameters": { "phases": ["http_request_firewall_managed"] },
  "logging": { "enabled": true }
} }
```

Security Level (reversible, `zone_setting`):

```json
{ "method": "PATCH", "path": "/zones/{zone_id}/settings/security_level", "body": { "value": "medium" } }
```

Verify with the live checks and by reading the entrypoint again. After deploying managed rules, query firewall events (see cf-incident, Detect) for `source` values from managed rules to spot false positives early.

## Traps

- **False positives after deploying managed rules or OWASP**: APIs, webhooks, rich text editors and admin save actions are typical victims. Fix with a narrow skip rule or a managed ruleset exception for the exact path, not by disabling the ruleset.
- **Skip rules run in order**: a skip rule only affects rules evaluated after it, and `ruleset: "current"` skips every remaining custom rule, including later block rules. Place skip rules deliberately and keep them narrow.
- **Do not skip on spoofable data alone**: a user agent, a `Referer` or a custom header without a secret is trivial to fake.
- **Challenging admin paths breaks automation**: uptime monitors, deploy hooks, mobile apps and XML-RPC clients cannot pass a challenge. Allowlist them by IP rather than removing the rule.
- **`/wp-admin/admin-ajax.php`** is called by public WordPress pages; challenging it breaks forms and carts.
- **Old Security Level advice is stale**: threat score is always 0 now; do not write rules on `cf.threat_score`.
- **Under Attack mode is set through `security_level: "under_attack"`** in the API; it challenges every visitor and breaks API clients. It belongs to cf-incident, not a permanent setting.
- **PUT on an entrypoint replaces every rule in the phase**; use rule ops on existing entrypoints.

## Sources

- https://developers.cloudflare.com/waf/managed-rules/
- https://developers.cloudflare.com/waf/managed-rules/deploy-api/
- https://developers.cloudflare.com/waf/managed-rules/reference/owasp-core-ruleset/
- https://developers.cloudflare.com/waf/managed-rules/reference/owasp-core-ruleset/configure-api/
- https://developers.cloudflare.com/waf/custom-rules/
- https://developers.cloudflare.com/waf/custom-rules/skip/
- https://developers.cloudflare.com/waf/custom-rules/skip/options/
- https://developers.cloudflare.com/waf/custom-rules/skip/api-examples/
- https://developers.cloudflare.com/waf/tools/security-level/
- https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/
- https://developers.cloudflare.com/ruleset-engine/reference/phases-list/
