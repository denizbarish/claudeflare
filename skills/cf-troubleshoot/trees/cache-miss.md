# Cache miss: content not served from cache

Symptom: a URL the user expects to be cached keeps going to the origin: `cf-cache-status` is `DYNAMIC`, `BYPASS`, or `MISS` on every request, or the cache hit ratio is low.

## Evidence

1. Request the same URL twice from the same machine and compare:
   ```
   curl -s -o /dev/null -D - https://example.com/assets/app.css
   curl -s -o /dev/null -D - https://example.com/assets/app.css
   ```
   Read `cf-cache-status`, `age`, `cache-control`, `cdn-cache-control`, `cloudflare-cdn-cache-control`, `set-cookie`, `vary` and the `cf-ray` suffix (data center). These are `GET` requests that print only the headers (`curl -sI` sends `HEAD`).
2. Zone cache settings and Cache Rules:
   ```js
   async () => {
     const dev = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/settings/development_mode" });
     const level = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/settings/cache_level" });
     const pagerules = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/pagerules" });
     return { dev: dev.result, level: level.result, pagerules: pagerules.result };
   }
   ```
   Read separately (404 means no rules): `/zones/ZONE_ID/rulesets/phases/http_request_cache_settings/entrypoint` (Cache Rules) and `/zones/ZONE_ID/rulesets/phases/http_config_settings/entrypoint`.
3. Which paths miss, by cache status:
   ```js
   async () => {
     const cache = await cloudflare.request({ method: "POST", path: "/client/v4/graphql", body: { query: `query ($zoneTag: string, $host: string, $since: Time, $until: Time) {
     viewer { zones(filter: { zoneTag: $zoneTag }) {
       httpRequestsAdaptiveGroups(limit: 50, filter: { clientRequestHTTPHost: $host, datetime_geq: $since, datetime_leq: $until }, orderBy: [count_DESC]) {
         count dimensions { cacheStatus clientRequestPath }
       }
     } }
   }`, variables: { zoneTag: "ZONE_ID", host: "example.com", since: "2026-10-24T06:00:00Z", until: "2026-10-24T12:00:00Z" } } });
     return cache;
   }
   ```
4. Recent purges or cache changes: audit log from SKILL.md. A purge makes the next request in each data center a `MISS`.

## Hypotheses

Start from the observed `cf-cache-status`.

`DYNAMIC` (not eligible for cache at request time):
1. **File type not cached by default and no rule enables it** (HTML, JSON, extensionless API paths). Confirm: the path has no default cached extension and no Cache Rule with `cache: true` matches. Reject: a matching rule exists. This is expected behavior, not a fault.
2. **A rule bypasses cache.** Confirm: a Cache Rule with `cache: false`, `cache_level` `bypass` (cf-cache, finding `cache.level.bypass`), or a Page Rule or Configuration Rule with Cache Level Bypass matches. Reject: none matches.
3. **Development Mode is on** (suspends cache for three hours). Confirm: `development_mode` value `on`. Reject: `off`.
4. **Method is not `GET` or `HEAD`.** Confirm: the missing requests are `POST` or others.

`BYPASS` (eligible, but the origin response was not cacheable):
1. **Origin sends `Set-Cookie`.** Confirm: `set-cookie` in the response. Reject: absent. Fix choice depends on whether the content is per-user (cf-cache, finding `cache.html.cached_with_cookies`).
2. **Origin sends `Cache-Control: no-store` or `private`**, or `no-store` or `private` in `CDN-Cache-Control` or `Cloudflare-CDN-Cache-Control` (these take precedence over `Cache-Control`). Confirm: header present. Reject: absent.
3. **`no-cache`, `max-age=0` or `s-maxage=0` with Origin Cache Control disabled** (the Enterprise default; Free, Pro and Business revalidate instead and show `REVALIDATED` or `EXPIRED`).
4. **`Vary: *`**, an `Authorization` request header without `public`, `s-maxage` or `must-revalidate`, or a file above the plan's cacheable size limit. Confirm from headers and file size.

`MISS` on every request:
1. **Cache key varies per request** (changing query strings such as `utm_*` or timestamps, a custom cache key with a per-user cookie or header, Vary in Cache Rules on a high-cardinality header). Confirm: the GraphQL breakdown shows many distinct paths or query variants; real client requests differ in query string. Reject: identical URLs still miss from the same data center.
2. **Different data centers or eviction of low-traffic content.** Confirm: the two `cf-ray` suffixes differ, or the asset is rarely requested. Reject: same data center, steady traffic. Tiered Cache helps (cf-cache, finding `cache.tiered.off`).
3. **Recent purge.** Confirm: the audit log shows a purge just before.

## Fix

- Cloudflare side, through cf-cache (each as a plan, reversible kinds): a Cache Rule that makes static paths eligible (`cache.rules.none_for_static`); remove the bypass rule or setting (`cache.level.bypass`); enable Tiered Cache (`cache.tiered.off`); turn off Development Mode with a reversible `zone_setting`:
  ```json
  { "method": "PATCH", "path": "/zones/{zone_id}/settings/development_mode", "body": { "value": "off" } }
  ```
  To ignore per-request query strings, set the Cache Rule's cache key to exclude them (cf-cache). Only cache HTML when it is the same for every visitor (`cache.html.cached_with_cookies`).
- Origin side, steps for the user: stop sending `Set-Cookie` on public static responses; send `Cache-Control: public, max-age=<seconds>` for cacheable content; remove `Vary: *` and stray `no-store` or `private` on public content.
- Verify: two consecutive header requests (step 1) from the same machine show `MISS` then `HIT` with a growing `age`; the GraphQL breakdown shows more `hit` for the path.

## Sources

- https://developers.cloudflare.com/cache/concepts/cache-responses/
- https://developers.cloudflare.com/cache/troubleshooting/investigating-uncached-responses/
- https://developers.cloudflare.com/cache/concepts/default-cache-behavior/
- https://developers.cloudflare.com/cache/concepts/cache-behavior/
- https://developers.cloudflare.com/cache/how-to/cache-rules/settings/
