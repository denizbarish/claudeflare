# CORS error

Symptom: the browser console shows a CORS error ("No 'Access-Control-Allow-Origin' header is present", "Response to preflight request doesn't pass access control check", or "multiple values") for a request from one origin (for example `https://app.example.com`) to a hostname behind Cloudflare (for example `https://api.example.com`). Cloudflare passes the origin's `Access-Control-Allow-Origin` through and includes the `Origin` request header when identifying cached assets; it does not add CORS headers on its own.

## Evidence

Ask the user for the page origin, the failing URL, the method, and the status shown in the browser's network tab (a CORS message often hides a 403, 503 or redirect).

1. The actual request, with the page's `Origin`:
   ```
   curl -s -o /dev/null -D - -H "Origin: https://app.example.com" https://api.example.com/v1/items
   ```
   Read the status, `access-control-allow-origin` (exactly one value, matching the `Origin` or `*`), `access-control-allow-credentials`, `vary`, `cf-cache-status`, `cf-mitigated`, `location` and `server`.
2. The preflight, for non-simple requests (custom headers, JSON body, `PUT`, `DELETE`). `OPTIONS` is a safe method and changes nothing:
   ```
   curl -sv -X OPTIONS -o /dev/null -H "Origin: https://app.example.com" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type, authorization" https://api.example.com/v1/items
   ```
   A preflight must return 2xx with `access-control-allow-methods` and `access-control-allow-headers`; a redirect or 403 fails it.
3. Direct origin comparison, only with an origin IP the user provides: repeat step 1 or 2 with `--resolve api.example.com:443:ORIGIN_IP`.
4. Cloudflare rules that touch these requests (each read separately, 404 means no rules): `/zones/ZONE_ID/rulesets/phases/http_response_headers_transform/entrypoint` (response header Transform Rules), `/zones/ZONE_ID/rulesets/phases/http_request_firewall_custom/entrypoint` and `/zones/ZONE_ID/rulesets/phases/http_request_dynamic_redirect/entrypoint`, plus `always_use_https`. Ask whether a Worker, Snippet or Cloudflare Access runs on the hostname.
5. Blocks or challenges on the API: run the security events query from cf-incident (Detect, step 3) and look for rows with the API path, or the Ray ID query from [1xxx.md](1xxx.md).

## Hypotheses

1. **Origin does not send CORS headers for this origin or method** (most common). Confirm: the direct origin response (or the Cloudflare response with `cf-cache-status` `DYNAMIC` or `MISS`) lacks `access-control-allow-origin` or lists another origin; preflight returns 404 or 405 from the origin. Reject: origin returns correct headers.
2. **A Cloudflare block or challenge replaces the response.** WAF blocks, managed challenges, rate limiting and Cloudflare error pages carry no CORS headers, and a browser `fetch` cannot solve a challenge. Confirm: status 403, 429 or 503 with `server: cloudflare`, a `cf-mitigated: challenge` header, or a matching security event for the path (often on `OPTIONS`). Reject: no event, origin status passes through. Continue in [waf-false-positive.md](waf-false-positive.md).
3. **Preflight or request is redirected.** Confirm: the preflight returns 301, 302, 307 or 308 (Always Use HTTPS for an `http://` URL, a Redirect Rule, a trailing slash redirect at the origin, or a Cloudflare Access login redirect). Reject: no `location` header.
4. **Cached response with old or missing CORS headers.** Confirm: `cf-cache-status` `HIT` without the header while the direct origin response has it, usually right after the origin's CORS configuration changed (a purge by URL does not refresh CORS headers). Reject: `DYNAMIC`, or the cached headers are correct.
5. **Headers duplicated or overwritten at the edge.** Confirm: two `access-control-allow-origin` values, or a Transform Rule, Worker or Snippet sets `Access-Control-*` headers that conflict with the origin's. Reject: no edge logic touches them.

## Fix

- Hypothesis 1 (origin side), steps for the user: return `Access-Control-Allow-Origin` with the exact requesting origin (or `*` when no credentials are used), add `Vary: Origin` when the value depends on the request, answer `OPTIONS` with 204 plus `Access-Control-Allow-Methods` and `Access-Control-Allow-Headers`, and never require authentication on the preflight. Alternatively a response header Transform Rule can set the header at the edge (reversible `rule_create` on the `http_response_headers_transform` entrypoint, or `phase_entrypoint_put` when it does not exist):
  ```json
  { "method": "POST", "path": "/zones/{zone_id}/rulesets/RULESET_ID/rules", "body": { "description": "CORS for app.example.com", "expression": "(http.host eq \"api.example.com\")", "action": "rewrite", "action_parameters": { "headers": { "Access-Control-Allow-Origin": { "operation": "set", "value": "https://app.example.com" } } } } }
  ```
  A Transform Rule cannot answer a preflight that the origin rejects; fix the origin for that.
- Hypothesis 2: fix the rule that blocks or challenges API or `OPTIONS` traffic with a narrow exception (see [waf-false-positive.md](waf-false-positive.md) and cf-waf); do not put challenges on endpoints called by `fetch`.
- Hypothesis 3: make the page call the final `https://` URL with the exact path; remove the redirect rule for the API host (reversible `rule_update`), or exempt the preflight from Access per its CORS settings.
- Hypothesis 4: after the origin is fixed, refresh the cached copies: change the asset URL, or purge (irreversible, flagged in the risk note): single-file purge with the CORS headers, or update the file's last-modified time at the origin and then purge everything.
- Hypothesis 5: remove the duplicate header from the Transform Rule (reversible `rule_update`), Worker or Snippet, or from the origin.
- Verify: steps 1 and 2 return exactly one matching `access-control-allow-origin` and a 2xx preflight; the browser console shows no CORS error.

## Sources

- https://developers.cloudflare.com/cache/cache-security/cors/
- https://developers.cloudflare.com/rules/transform/response-header-modification/
- https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/
- https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-single-file/
