---
name: cf-cache
description: Cloudflare cache checklist for one zone. Cache Rules for static assets, Browser Cache TTL, Tiered Cache, HTML caching with session cookies, zone-wide cache bypass and Development Mode. Load it when auditing caching, improving cache hit ratio, writing Cache Rules, or investigating stale or personalized content served from cache. Load cf-core first.
---

# cf-cache: Cache Rules, TTLs, Tiered Cache

Load `cf-core` first. Findings use the `cf-audit` finding format and severity scale. In the MCP examples, replace `ZONE_ID` with the real zone id; the guard needs literal paths.

Default behavior to keep in mind: Cloudflare caches by file extension (not MIME type), does not cache HTML or JSON by default, honors origin `Cache-Control` and `Expires`, and does not cache a default-cacheable response that carries `Set-Cookie` when origin cache control is on.

## Read current state

| What | GET path |
|---|---|
| Cache Rules | `/zones/{zone_id}/rulesets/phases/http_request_cache_settings/entrypoint` (404 means no Cache Rules) |
| Browser Cache TTL (seconds, `0` = Respect Existing Headers) | `/zones/{zone_id}/settings/browser_cache_ttl` |
| Caching level (`aggressive` = Standard, `basic` = No Query String, `simplified` = Ignore Query String) | `/zones/{zone_id}/settings/cache_level` |
| Development Mode (bypasses cache while `on`) | `/zones/{zone_id}/settings/development_mode` |
| Tiered Cache | `/zones/{zone_id}/argo/tiered_caching` |
| Smart Tiered Cache topology | `/zones/{zone_id}/cache/tiered_cache_smart_topology_enable` |
| Page Rules with cache actions (legacy) | `/zones/{zone_id}/pagerules` |

MCP `execute`:

```js
async () => {
  const rules = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/rulesets/phases/http_request_cache_settings/entrypoint" });
  return rules.result;
}
```

If the entrypoint returns 404 (no Cache Rules), the call fails, so read the settings in a separate call:

```js
async () => {
  const browserTtl = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/settings/browser_cache_ttl" });
  const devMode = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/settings/development_mode" });
  const tiered = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/argo/tiered_caching" });
  return { browserTtl: browserTtl.result, devMode: devMode.result, tiered: tiered.result };
}
```

Fallback: `claudeflare get /zones/ZONE_ID/rulesets/phases/http_request_cache_settings/entrypoint`.

Live checks: request the same URL twice with `curl -sI https://<host>/<path>` and read `cf-cache-status` (`HIT`, `MISS`, `EXPIRED`, `BYPASS`, `DYNAMIC`), `cache-control`, `age` and `set-cookie`. Check one static asset (CSS, JS or image from the home page) and the home page HTML.

## Checks

| finding id | condition | severity | recommended | plan tier |
|---|---|---|---|---|
| `cache.rules.none_for_static` | No Cache Rule (and no Page Rule) sets cache behavior for static assets, and a repeated request for a static asset is not a `HIT` (origin sends `no-cache`, a very short `max-age`, or nothing useful). | medium | Cache Rule for static extensions: `cache: true`, `edge_ttl` `override_origin` (for example 30 days for fingerprinted assets), or `respect_origin` when origin headers are already good | free |
| `cache.browser_ttl.too_low` | `browser_cache_ttl` is not `0` and is below `3600` (default is 14400, 4 hours). Repeat visitors refetch assets. | low | `14400` or more, or `0` (Respect Existing Headers) when the origin sends good `Cache-Control` | free |
| `cache.tiered.off` | `argo/tiered_caching` value is `off`. Each data center fetches misses from the origin directly. | medium | `on` with Smart topology | free |
| `cache.html.cached_with_cookies` | A Cache Rule (or Page Rule Cache Everything) makes HTML eligible for cache (`cache: true` on all paths or on HTML paths) with no bypass for session cookies, on a site with logins, carts or personalization (cookies such as `wordpress_logged_in_`, `PHPSESSID`, `session`, `cart`). Personalized pages can be served to other visitors. | high | Exclude requests with session cookies from the rule, or add a bypass rule for them; never cache logged-in HTML | free |
| `cache.level.bypass` | Caching is off zone-wide: a Cache Rule with `cache: false` whose expression matches everything (`true` or the whole hostname), a Page Rule with Cache Level Bypass on `*example.com/*`, or `development_mode` left `on`. The `cache_level` setting has no bypass value; check rules and Development Mode. | high | Remove or narrow the bypass rule; `development_mode` `off` | free |

Plan notes: Cache Rules per zone are 10 (Free), 25 (Pro), 50 (Business), 300 (Enterprise). Minimum Edge Cache TTL is 2 hours on Free, 1 hour on Pro, 1 second on Business and Enterprise. Tiered Cache with Smart topology is available on all plans.

## Applying changes

Use the change protocol from cf-core. Read the Cache Rules entrypoint first and take its `id` as `RULESET_ID`.

Add a static asset Cache Rule when the entrypoint exists (reversible, `rule_create`):

```json
{ "method": "POST", "path": "/zones/{zone_id}/rulesets/RULESET_ID/rules", "body": {
  "description": "Cache static assets",
  "expression": "(http.request.uri.path.extension in {\"css\" \"js\" \"mjs\" \"png\" \"jpg\" \"jpeg\" \"gif\" \"webp\" \"avif\" \"svg\" \"ico\" \"woff\" \"woff2\"})",
  "action": "set_cache_settings",
  "action_parameters": { "cache": true, "edge_ttl": { "mode": "override_origin", "default": 2592000 }, "browser_ttl": { "mode": "respect_origin" } }
} }
```

When the entrypoint does not exist (404), create it with the same rule (reversible, `phase_entrypoint_put`). A PUT replaces every rule in the phase, so never use it on an existing entrypoint unless the body repeats all current rules:

```json
{ "method": "PUT", "path": "/zones/{zone_id}/rulesets/phases/http_request_cache_settings/entrypoint", "body": { "rules": [ { "description": "Cache static assets", "expression": "...", "action": "set_cache_settings", "action_parameters": { "cache": true } } ] } }
```

Exclude session cookies from an HTML cache rule (reversible, `rule_update`; `RULE_ID` from the read). A rule PATCH replaces the rule definition, so repeat every field you keep (description, action, action_parameters, enabled):

```json
{ "method": "PATCH", "path": "/zones/{zone_id}/rulesets/RULESET_ID/rules/RULE_ID", "body": {
  "description": "Cache HTML for anonymous visitors",
  "expression": "(http.host eq \"example.com\" and not http.cookie contains \"wordpress_logged_in_\" and not http.cookie contains \"woocommerce_items_in_cart\")",
  "action": "set_cache_settings",
  "action_parameters": { "cache": true }
} }
```

Zone settings (reversible, `zone_setting`):

```json
[
  { "method": "PATCH", "path": "/zones/{zone_id}/settings/browser_cache_ttl", "body": { "value": 14400 } },
  { "method": "PATCH", "path": "/zones/{zone_id}/settings/development_mode", "body": { "value": "off" } }
]
```

Tiered Cache (not reversible through `claudeflare rollback`; the inverse is the same PATCH with `"off"`, which the user can approve as a new plan):

```json
[
  { "method": "PATCH", "path": "/zones/{zone_id}/argo/tiered_caching", "body": { "value": "on" } },
  { "method": "PATCH", "path": "/zones/{zone_id}/cache/tiered_cache_smart_topology_enable", "body": { "value": "on" } }
]
```

Purge (`POST /zones/{zone_id}/purge_cache`, for example `{ "files": ["https://example.com/app.css"] }`) is never reversible; put it in its own plan and only when the user asks for it.

## Traps

- `cache: true` in a Cache Rule ("Eligible for cache") equals Page Rules Cache Everything: HTML and JSON become cacheable for the matched paths. Scope these rules tightly.
- With Cache Everything or `cache: true`, a response that carries `Set-Cookie` is not cached (`MISS` every time), but a logged-in page without `Set-Cookie` is cached and served to everyone. Exclude session cookies in the expression.
- `override_origin` ignores origin `Cache-Control`, including `private` and `no-store` on personalized responses. Use `respect_origin` for paths the origin controls.
- Browser Cache TTL in a Cache Rule cannot make browsers cache for less than the origin `max-age`; only longer.
- Purge does not clear visitors' browser caches; long browser TTLs on non-fingerprinted files keep old versions on repeat visitors.
- Development Mode turns itself off after 3 hours, but a Cache Rule bypass stays until removed.
- Smart Tiered Cache picks upper tiers by origin latency; changing origin IPs or DNS records can move upper tiers and cause a burst of misses.
- Custom cache keys that include headers or cookies break single-file purge from the dashboard.
- Modern Cache Rules take precedence over Page Rules for the same request; read both before reporting the effective behavior.

## Sources

- https://developers.cloudflare.com/cache/how-to/cache-rules/
- https://developers.cloudflare.com/cache/how-to/cache-rules/settings/
- https://developers.cloudflare.com/cache/how-to/edge-browser-cache-ttl/
- https://developers.cloudflare.com/cache/how-to/edge-browser-cache-ttl/set-browser-ttl/
- https://developers.cloudflare.com/cache/how-to/set-caching-levels/
- https://developers.cloudflare.com/cache/how-to/tiered-cache/
- https://developers.cloudflare.com/cache/concepts/default-cache-behavior/
- https://developers.cloudflare.com/cache/concepts/cache-behavior/
- https://developers.cloudflare.com/rules/reference/page-rules-migration/
