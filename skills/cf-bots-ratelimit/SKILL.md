---
name: cf-bots-ratelimit
description: Cloudflare bot and abuse checklist for one zone. Bot Fight Mode and Super Bot Fight Mode, rate limiting rules for login and API endpoints, and Turnstile on forms. Load it when auditing bot protection, credential stuffing or scraping defenses, writing rate limiting rules, or adding Turnstile. Load cf-core first.
---

# cf-bots-ratelimit: bots, rate limiting, Turnstile

Load `cf-core` first. Findings use the `cf-audit` finding format and severity scale. In the MCP examples, replace `ZONE_ID` and `ACCOUNT_ID` with real ids; the guard needs literal paths.

## Read current state

| What | GET path |
|---|---|
| Bot Fight Mode and Super Bot Fight Mode config (`fight_mode`, `sbfm_definitely_automated`, `sbfm_likely_automated`, `sbfm_verified_bots`, `sbfm_static_resource_protection`, `enable_js`, `ai_bots_protection`) | `/zones/{zone_id}/bot_management` |
| Rate limiting rules | `/zones/{zone_id}/rulesets/phases/http_ratelimit/entrypoint` (404 means none) |
| Turnstile widgets (account level; `domains`, `mode`, `name`) | `/accounts/{account_id}/challenges/widgets` |

MCP `execute`:

```js
async () => {
  const bots = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/bot_management" });
  const widgets = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/challenges/widgets", query: { per_page: 50 } });
  return { bots: bots.result, widgets: widgets.result };
}
```

Read the rate limiting entrypoint in its own call (a 404 fails the whole call):

```js
async () => {
  const limits = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/rulesets/phases/http_ratelimit/entrypoint" });
  return limits.result;
}
```

Fallback: `claudeflare get /zones/ZONE_ID/bot_management` and `claudeflare get /zones/ZONE_ID/rulesets/phases/http_ratelimit/entrypoint`.

Live checks: find which login, signup and API paths exist with `curl -sI https://<host>/<path>` (for example `/wp-login.php`, `/login`, `/register`, `/api/`, `/wp-json/`, `/graphql`, `/xmlrpc.php`). A 404 means the path is not there; leave it out.

## Checks

| finding id | condition | severity | recommended | plan tier |
|---|---|---|---|---|
| `bots.fight_mode.off` | Free: `fight_mode` is `false`. Pro and above: `fight_mode` is `false` and Super Bot Fight Mode is not configured (`sbfm_definitely_automated` is `allow` or missing). Skip this finding when the site's main traffic is an API or mobile app that cannot pass challenges. | medium | Free: `fight_mode: true`. Pro and above: Super Bot Fight Mode with `sbfm_definitely_automated: "managed_challenge"` (or `"block"`) and `sbfm_verified_bots: "allow"` | free |
| `ratelimit.login.missing` | A login path exists and no rate limiting rule matches it. Credential stuffing and brute force run unthrottled. | high | Rate limiting rule on the login path, counting by `ip.src` per data center, `block` | free |
| `ratelimit.api.missing` | API paths exist (`/api/`, `/wp-json/`, `/graphql`) and no rate limiting rule matches them. | medium | Rate limiting rule on the API prefix with a limit above normal client use | free (Pro for longer periods) |
| `turnstile.forms.missing` | Login, signup, contact or checkout forms exist and no Turnstile widget lists this zone's hostname in `domains`. | medium | Turnstile widget (managed mode) on each public form, with server-side token validation | free |

Plan limits for rate limiting (from the docs):

| | Free | Pro | Business |
|---|---|---|---|
| Rules | 1 | 2 | 5 |
| Expression fields | path, verified bot | host, URI, path, full URI, query, verified bot | adds method, source IP, user agent |
| Counting period | 10 s | up to 1 min | up to 10 min |
| Mitigation timeout | 10 s | up to 1 h | up to 1 day |
| Counting by | IP | IP | IP, IP with NAT support |

On Free there is a single rule: when both login and API need one, recommend the login rule and report `ratelimit.api.missing` with the plan limit in `reason`. `turnstile.forms.missing` always has `fix: []`: it needs a code change (widget on the page plus server-side validation); give the user step-by-step instructions instead.

## Applying changes

Use the change protocol from cf-core. Read the `http_ratelimit` entrypoint first; its `id` is `RULESET_ID`.

Login rate limit on Free (path only, 10 second period and timeout; reversible, `rule_create`):

```json
{ "method": "POST", "path": "/zones/{zone_id}/rulesets/RULESET_ID/rules", "body": {
  "description": "Rate limit login",
  "expression": "(http.request.uri.path eq \"/wp-login.php\")",
  "action": "block",
  "ratelimit": { "characteristics": ["cf.colo.id", "ip.src"], "period": 10, "requests_per_period": 5, "mitigation_timeout": 10 }
} }
```

When the phase has no entrypoint (404), create it with the rule (reversible, `phase_entrypoint_put`; never PUT over an existing entrypoint unless the body repeats every current rule):

```json
{ "method": "PUT", "path": "/zones/{zone_id}/rulesets/phases/http_ratelimit/entrypoint", "body": { "rules": [
  { "description": "Rate limit API", "expression": "(starts_with(http.request.uri.path, \"/api/\"))", "action": "block", "ratelimit": { "characteristics": ["cf.colo.id", "ip.src"], "period": 60, "requests_per_period": 300, "mitigation_timeout": 600 } }
] } }
```

The API example uses a 60 second period and 600 second timeout, which need Pro or above; on Free use `period: 10` and `mitigation_timeout: 10`. Always include `cf.colo.id` in `characteristics`. Pick `requests_per_period` from real traffic: query `httpRequestsAdaptiveGroups` for the path (see cf-incident, Detect) and set the limit well above the busiest legitimate client.

Bot Fight Mode (not reversible through `claudeflare rollback`: `bot_management` is not a snapshot kind; the risk note says so, and the inverse is the same PUT with `false`):

```json
{ "method": "PUT", "path": "/zones/{zone_id}/bot_management", "body": { "fight_mode": true } }
```

Super Bot Fight Mode on Pro and above (also not reversible through rollback):

```json
{ "method": "PUT", "path": "/zones/{zone_id}/bot_management", "body": { "sbfm_definitely_automated": "managed_challenge", "sbfm_verified_bots": "allow" } }
```

Verify by reading `/zones/{zone_id}/bot_management` and the entrypoint again.

## Traps

- **Bot Fight Mode cannot be skipped.** It does not run on the Ruleset Engine, so WAF skip rules, Page Rules and allow rules do not exempt anything. If API clients, mobile apps, webhooks or monitoring get challenged, the only fixes are turning it off or moving to Super Bot Fight Mode (Pro and above), which skip rules can bypass.
- **Bot protection challenges non-browser clients**: payment webhooks, mobile apps, RSS readers and partner integrations. Ask what non-browser traffic the zone serves before enabling it.
- **Rate limits too low lock out real users** behind shared IPs (offices, mobile carriers, CGNAT). Base the limit on observed traffic; `managed_challenge` instead of `block` lets real users through when unsure.
- **Free rate limiting matches only the path**, so a login rule also counts GET page views of the login form. Set the limit with that in mind.
- **`cf.colo.id` is mandatory** in `characteristics` (never use it in the expression); counting is per data center, so the effective global limit is higher than `requests_per_period`.
- **Turnstile without server-side validation does nothing**: the token must be verified by the origin with the secret key. Never put the secret key in page code.
- **XML-RPC** (`/xmlrpc.php`) on WordPress is a common brute force target; include it in the login rule expression when it exists and is not needed.

## Sources

- https://developers.cloudflare.com/bots/get-started/bot-fight-mode/
- https://developers.cloudflare.com/bots/get-started/super-bot-fight-mode/
- https://developers.cloudflare.com/api/resources/bot_management/methods/get/
- https://developers.cloudflare.com/api/resources/bot_management/methods/update/
- https://developers.cloudflare.com/waf/rate-limiting-rules/
- https://developers.cloudflare.com/waf/rate-limiting-rules/create-api/
- https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/
- https://developers.cloudflare.com/turnstile/get-started/
- https://developers.cloudflare.com/api/resources/turnstile/subresources/widgets/methods/list/
