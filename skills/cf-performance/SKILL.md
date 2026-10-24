---
name: cf-performance
description: Cloudflare speed checklist for one zone. HTTP/3, Brotli and compression, Early Hints, Polish image optimization and Rocket Loader risk. Load it when auditing or tuning site speed settings on Cloudflare, or when JavaScript breaks after a speed setting was turned on. Load cf-core first; caching is covered by cf-cache.
---

# cf-performance: protocol, compression and content optimization

Load `cf-core` first. Findings use the `cf-audit` finding format and severity scale. Caching findings belong to `cf-cache`, not here. In the MCP examples, replace `ZONE_ID` with the real zone id; the guard needs literal paths.

## Read current state

Zone settings, GET `/zones/{zone_id}/settings/<id>`:

| Setting id | Values | Plans |
|---|---|---|
| `http3` | `on`, `off` | all (needs an edge certificate) |
| `brotli` | `on`, `off` | all |
| `early_hints` | `on`, `off` | all |
| `polish` | `off`, `lossless`, `lossy` | Pro and above |
| `rocket_loader` | `on`, `off` | all |

Each setting result also has `editable`; a setting with `editable: false` cannot be changed on this plan, so do not raise a fixable finding for it.

Configuration Rules can turn Rocket Loader and Polish on or off per path: read GET `/zones/{zone_id}/rulesets/phases/http_config_settings/entrypoint` (404 means none). Compression Rules live in `http_response_compression`.

MCP `execute`:

```js
async () => {
  const http3 = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/settings/http3" });
  const brotli = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/settings/brotli" });
  const hints = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/settings/early_hints" });
  const polish = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/settings/polish" });
  const rocket = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/settings/rocket_loader" });
  return { http3: http3.result, brotli: brotli.result, hints: hints.result, polish: polish.result, rocket: rocket.result };
}
```

Fallback: `claudeflare get /zones/ZONE_ID/settings/http3` (one line per setting id).

Live checks: `curl -sI https://<host>/` shows `alt-svc: h3=...` when HTTP/3 is on; `curl -sI -H "Accept-Encoding: br" https://<host>/<asset.css>` shows `content-encoding: br` (or `zstd`/`gzip`) for compressed text; a `link` header with `rel=preload` or `rel=preconnect` on HTML means Early Hints has something to send.

## Checks

| finding id | condition | severity | recommended | plan tier |
|---|---|---|---|---|
| `perf.http3.off` | `http3` is `off`. | low | `on` | free |
| `perf.brotli.off` | `brotli` is `off` and `editable` is `true`. | low | `on` | free |
| `perf.early_hints.off` | `early_hints` is `off`. Highest value when HTML responses send `Link` preload or preconnect headers. | low | `on` | free |
| `perf.polish.off` | `polish` is `off` on a Pro or higher zone with image-heavy pages. On Free, report it with `plan_tier: "pro"` and `fix: []`, and offer the free alternative of serving optimized images from the origin. | low | `lossless` (or `lossy` if the user accepts quality loss) | pro |
| `perf.rocket_loader.risky` | `rocket_loader` is `on` (zone-wide or through a Configuration Rule). It defers and rewrites every script; inline handlers, scripts that depend on load order, SPA frameworks, consent managers, payment and analytics tags often break, and a strict Content Security Policy blocks it. | medium | `off`, unless the user confirms the site was tested with it; keep specific scripts out with `data-cfasync="false"` | free |

## Applying changes

Use the change protocol from cf-core. All zone setting ops are reversible (`zone_setting`).

```json
[
  { "method": "PATCH", "path": "/zones/{zone_id}/settings/http3", "body": { "value": "on" } },
  { "method": "PATCH", "path": "/zones/{zone_id}/settings/brotli", "body": { "value": "on" } },
  { "method": "PATCH", "path": "/zones/{zone_id}/settings/early_hints", "body": { "value": "on" } }
]
```

Polish (Pro and above):

```json
{ "method": "PATCH", "path": "/zones/{zone_id}/settings/polish", "body": { "value": "lossless" } }
```

Turn Rocket Loader off zone-wide:

```json
{ "method": "PATCH", "path": "/zones/{zone_id}/settings/rocket_loader", "body": { "value": "off" } }
```

To keep Rocket Loader but exclude a broken section, add a Configuration Rule instead (reversible, `rule_create` on the `http_config_settings` entrypoint, or `phase_entrypoint_put` when it does not exist yet; see cf-rules):

```json
{ "method": "POST", "path": "/zones/{zone_id}/rulesets/RULESET_ID/rules", "body": {
  "description": "Rocket Loader off for checkout",
  "expression": "(starts_with(http.request.uri.path, \"/checkout\"))",
  "action": "set_config",
  "action_parameters": { "rocket_loader": false }
} }
```

Verify with the live checks above, and for Rocket Loader ask the user to load the affected pages and check the browser console.

## Traps

- **Rocket Loader breaks JavaScript** more often than any other speed setting: changed execution order, broken `document.write`, inline `onclick` handlers, hydration errors. When a user reports broken scripts, check `rocket_loader` first. A `data-cfasync="false"` attribute must come before `src`, and the script's dependencies need it too.
- **Rocket Loader and CSP**: a strict `script-src` blocks it unless the policy allows `ajax.cloudflare.com`.
- **Compression defaults by plan**: Cloudflare compresses text by default (Zstandard on Free, Brotli on Pro and Business, Gzip on Enterprise, depending on what the browser accepts). Compression Rules override the defaults. A `cache-control: no-transform` header from the origin disables recompression.
- **Early Hints** can send cached `Link` headers to visitors who are not yet authenticated; do not put private asset URLs in `Link` headers. Benign `504` entries with `ClientRequestSource: earlyHintsCache` may appear in logs.
- **Polish** only works on images Cloudflare caches; images behind `no-transform` or a cache bypass are not optimized. Development Mode suspends Polish.
- **HTTP/3** needs UDP 443 on the client path; clients fall back to HTTP/2 automatically, so turning it on is low risk.
- Auto Minify is deprecated (since 2024-08-05); do not recommend it. If `/zones/{zone_id}/settings/minify` still shows it on, suggest turning it off and minifying at build time.

## Sources

- https://developers.cloudflare.com/speed/optimization/protocol/http3/
- https://developers.cloudflare.com/speed/optimization/content/compression/
- https://developers.cloudflare.com/rules/compression-rules/
- https://developers.cloudflare.com/cache/advanced-configuration/early-hints/
- https://developers.cloudflare.com/images/polish/
- https://developers.cloudflare.com/speed/optimization/content/rocket-loader/
- https://developers.cloudflare.com/speed/optimization/content/rocket-loader/ignore-javascripts/
- https://developers.cloudflare.com/fundamentals/reference/policies-compliances/content-security-policies/
- https://developers.cloudflare.com/speed/optimization/content/troubleshooting/disable-auto-minify/
- https://developers.cloudflare.com/rules/configuration-rules/settings/
- https://developers.cloudflare.com/api/resources/zones/subresources/settings/methods/edit/
