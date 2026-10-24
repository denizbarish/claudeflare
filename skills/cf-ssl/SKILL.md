---
name: cf-ssl
description: Cloudflare SSL/TLS checklist for one zone. Encryption mode (Flexible, Full, Full strict, Automatic SSL/TLS), Always Use HTTPS, minimum TLS version, HSTS, TLS 1.3 and Automatic HTTPS Rewrites. Load it when auditing SSL/TLS, fixing 525/526 or redirect loops, or changing any HTTPS setting. Load cf-core first.
---

# cf-ssl: encryption mode, HTTPS enforcement, TLS versions, HSTS

Load `cf-core` first. Findings use the `cf-audit` finding format and severity scale. In the MCP examples, replace `ZONE_ID` with the real zone id (32 hex characters); the guard needs literal paths.

## Read current state

All are zone settings, read one by one with GET `/zones/{zone_id}/settings/<id>`:

| Setting id | Values |
|---|---|
| `ssl` | `off`, `flexible`, `full`, `strict` (dashboard also offers Strict (SSL-Only Origin Pull), API value `origin_pull`) |
| `ssl_automatic_mode` | `auto` (Automatic SSL/TLS) or `custom`; missing on zones not yet migrated to Automatic SSL/TLS |
| `always_use_https` | `on`, `off` |
| `min_tls_version` | `1.0`, `1.1`, `1.2`, `1.3` |
| `security_header` | `{ strict_transport_security: { enabled, max_age, include_subdomains, preload, nosniff } }` (HSTS) |
| `tls_1_3` | `on`, `off`, `zrt` (on plus 0-RTT) |
| `automatic_https_rewrites` | `on`, `off` |

Configuration Rules can override `ssl` and `automatic_https_rewrites` per request: also read GET `/zones/{zone_id}/rulesets/phases/http_config_settings/entrypoint` (404 means no rules) and report rules with `action_parameters.ssl` set.

MCP `execute`:

```js
async () => {
  const ssl = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/settings/ssl" });
  const auto = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/settings/ssl_automatic_mode" });
  const https = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/settings/always_use_https" });
  const minTls = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/settings/min_tls_version" });
  const hsts = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/settings/security_header" });
  const tls13 = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/settings/tls_1_3" });
  const rewrites = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/settings/automatic_https_rewrites" });
  return { ssl: ssl.result, auto: auto.result, https: https.result, minTls: minTls.result, hsts: hsts.result, tls13: tls13.result, rewrites: rewrites.result };
}
```

If one read fails (for example `ssl_automatic_mode` on a zone that has not been migrated), the whole call fails; retry without it. Fallback: `claudeflare get /zones/ZONE_ID/settings/ssl` (one line per setting id).

Live checks: `curl -sI http://<host>/` (expect a 301 to `https://` when Always Use HTTPS is on) and `curl -sI https://<host>/` (a `strict-transport-security` header when HSTS is on; 525 or 526 means origin TLS problems).

## Checks

| finding id | condition | severity | recommended | plan tier |
|---|---|---|---|---|
| `ssl.mode.flexible` | `ssl` is `flexible`: Cloudflare talks to the origin over plain HTTP. | critical | `strict` once the origin serves a valid certificate; switching without one returns 526 (invalid certificate) or 525 (no TLS on the origin) | free |
| `ssl.mode.full_not_strict` | `ssl` is `full`: origin certificate is not validated, so a self-signed or expired certificate is accepted. | high | `strict` | free |
| `ssl.always_https.off` | `always_use_https` is `off` and the site has no Redirect Rule doing the same. | medium | `on` | free |
| `ssl.min_tls.below_1_2` | `min_tls_version` is `1.0` or `1.1`. | medium | `1.2` | free |
| `ssl.hsts.off` | `strict_transport_security.enabled` is `false` or `max_age` is `0`. Recommend only after `ssl` is `strict` and Always Use HTTPS is on. Never set `preload` unless the user explicitly asks and accepts the lock-in (see Traps). | medium | `enabled: true`, `max_age: 15552000` (6 months), `include_subdomains` only if every subdomain serves HTTPS, `preload: false` | free |
| `ssl.tls13.off` | `tls_1_3` is `off`. | low | `on` (choose `zrt` only on user request, see Traps) | free |
| `ssl.auto_rewrites.off` | `automatic_https_rewrites` is `off`. | low | `on` | free |

Prerequisites to list in findings:

- `ssl.mode.flexible` and `ssl.mode.full_not_strict`: the origin serves a certificate on port 443 that is valid for the hostname and not expired, issued by a public CA or by Cloudflare Origin CA. The agent cannot check the origin itself; ask the user, or look for 526 errors in HTTP analytics after a change.
- `ssl.hsts.off`: `ssl` is `strict`, Always Use HTTPS is on, and (with `include_subdomains`) every subdomain serves valid HTTPS.

## Applying changes

Use the change protocol from cf-core. All ops below are zone settings (`zone_setting`), so every one is reversible with `claudeflare rollback`.

Full (strict). If `ssl_automatic_mode` is `auto`, switch it to `custom` first in the same plan so the manual choice is kept:

```json
[
  { "method": "PATCH", "path": "/zones/{zone_id}/settings/ssl_automatic_mode", "body": { "value": "custom" } },
  { "method": "PATCH", "path": "/zones/{zone_id}/settings/ssl", "body": { "value": "strict" } }
]
```

HTTPS enforcement and TLS versions:

```json
[
  { "method": "PATCH", "path": "/zones/{zone_id}/settings/always_use_https", "body": { "value": "on" } },
  { "method": "PATCH", "path": "/zones/{zone_id}/settings/min_tls_version", "body": { "value": "1.2" } },
  { "method": "PATCH", "path": "/zones/{zone_id}/settings/tls_1_3", "body": { "value": "on" } },
  { "method": "PATCH", "path": "/zones/{zone_id}/settings/automatic_https_rewrites", "body": { "value": "on" } }
]
```

HSTS, in its own plan after the steps above are verified. Copy `nosniff` from the current value so the plan changes only HSTS:

```json
{ "method": "PATCH", "path": "/zones/{zone_id}/settings/security_header", "body": { "value": { "strict_transport_security": { "enabled": true, "max_age": 15552000, "include_subdomains": false, "preload": false, "nosniff": false } } } }
```

Order matters: fix the encryption mode first, verify the site loads (no 525/526), then enable Always Use HTTPS, and only then HSTS. Rolling back HSTS removes the header, but browsers that already saw it keep enforcing HTTPS until `max_age` runs out.

## Traps

- **Flexible plus an origin HTTPS redirect is a redirect loop.** Under Flexible, Cloudflare reaches the origin over HTTP; if the origin redirects HTTP to HTTPS, the visitor bounces forever (`ERR_TOO_MANY_REDIRECTS`). Fix the mode (Full strict) instead of adding redirects; see `rules.redirect.loop_risk` in cf-rules.
- **Full (strict) with a bad origin certificate returns 526** for every request. A Cloudflare Origin CA certificate is trusted only by Cloudflare: fine for Full (strict), but browsers reject it if the record is ever set to DNS-only.
- **Automatic SSL/TLS never downgrades.** If the origin certificate expires under Full (strict), it does not fall back to Full; the site returns 526 until the certificate is renewed.
- **HSTS preload is a lock-in.** Preload lists are compiled into browsers; removal takes months and in the meantime every subdomain must serve HTTPS or becomes unreachable. Preload also needs `max_age` of at least 12 months and `include_subdomains`. Only on explicit user request.
- **HSTS and dropping HTTPS.** Removing HTTPS (or setting `ssl` to `off`) while HSTS is active makes the site inaccessible for the length of `max_age`. Disable HSTS (`max_age: 0`) and wait out the old `max_age` first.
- **`include_subdomains`** breaks any subdomain without HTTPS (internal tools, DNS-only hosts with no certificate).
- **Minimum TLS 1.3** blocks clients that only speak TLS 1.2; recommend `1.2` unless the user knows all clients.
- **0-RTT (`zrt`)** allows replay of early data; only safe when the application treats early-data requests as replayable (GET only).
- **Configuration Rules override the zone mode.** A rule with `ssl: "flexible"` for some paths keeps those paths on Flexible even after the zone is set to strict. Read `http_config_settings` before reporting the effective mode.

## Sources

- https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/
- https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/flexible/
- https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/
- https://developers.cloudflare.com/ssl/edge-certificates/additional-options/minimum-tls/
- https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/
- https://developers.cloudflare.com/ssl/edge-certificates/additional-options/tls-13/
- https://developers.cloudflare.com/ssl/edge-certificates/additional-options/automatic-https-rewrites/
- https://developers.cloudflare.com/api/resources/zones/subresources/settings/methods/edit/
- https://developers.cloudflare.com/rules/configuration-rules/settings/
