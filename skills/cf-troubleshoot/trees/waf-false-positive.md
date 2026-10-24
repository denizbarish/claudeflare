# WAF false positive: legitimate traffic blocked or challenged

Symptom: real users, an API client, a webhook sender or an admin action gets a Cloudflare block page ("Sorry, you have been blocked", HTTP 403), a challenge, or a 429, while the request is legitimate. Requests blocked by WAF custom or managed rules show the WAF block page, not error 1020; for a 1020 page start with [1xxx.md](1xxx.md).

## Evidence

1. Collect from the user or the affected client: the Ray ID on the block page (or the `cf-ray` response header), the time (UTC), the client IP, the URL and method. Reproduce if safe:
   ```
   curl -s -o /dev/null -D - https://example.com/the/blocked/path
   ```
   Note the status, `server: cloudflare`, `cf-ray` and `cf-mitigated: challenge` (present on challenge pages). A reproduction from your machine may not trigger the rule if it depends on the body, IP or headers; do not replay `POST` bodies against the live site.
2. The security event: run the Ray ID query from [1xxx.md](1xxx.md) (filter by `rayName`, or by `clientIP` for a client without a Ray ID). The event's `source` names the product (for example managed rules, custom rules, rate limiting, bot management, security level), `ruleId` and `rulesetId` the exact rule, `action` what happened.
3. Pattern over time, to see how many legitimate requests the rule hits: run the security events query from cf-incident (Detect, step 3) for the window and look at rows with the same source and path.
4. The rule definitions (each read separately, 404 means none):
   ```js
   async () => {
     const managed = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/rulesets/phases/http_request_firewall_managed/entrypoint" });
     return managed.result;
   }
   ```
   Also `/zones/ZONE_ID/rulesets/phases/http_request_firewall_custom/entrypoint`, `/zones/ZONE_ID/rulesets/phases/http_ratelimit/entrypoint` and the setting `/zones/ZONE_ID/settings/security_level`. Take the `id` of the entrypoint (`RULESET_ID`) and of the `execute` rule that deploys the managed ruleset (`EXECUTE_RULE_ID`).
5. What changed: audit log from SKILL.md. A newly deployed managed ruleset, OWASP sensitivity change or new custom rule just before the reports is a strong signal.

## Hypotheses

1. **A managed rule matches legitimate content** (rich text or HTML in a form, code snippets, JSON with SQL-like strings, file uploads, admin save actions, webhooks). Confirm: event `source` is managed rules with a specific `ruleId` from the Cloudflare Managed Ruleset (`efb7b8c949ac4650a09736fc376e9aee`). Reject: source is another product.
2. **OWASP anomaly score exceeded.** Confirm: the event's rule is `949110: Inbound Anomaly Score Exceeded` in the Cloudflare OWASP Core Ruleset (`4814384a9e5d4991b9815dcfc25d2f1f`). Reject: another rule.
3. **A custom rule is broader than intended** (country, ASN, user agent, path prefix or missing method condition). Confirm: source is custom rules and the matched rule's expression covers the legitimate request. Reject: expression clearly targets other traffic.
4. **Rate limiting threshold too low for real usage** (single-page apps, shared office or mobile carrier IPs). Confirm: status 429 or a rate limiting event; many legitimate users behind one IP. Reject: no rate limiting event.
5. **Bot protection or Security Level challenges an automated but legitimate client** (monitoring, payment webhooks, partner API). Confirm: source is bot fight mode, bot management or security level; client is a server. Reject: source is a WAF rule.

## Fix

Prefer the narrowest change that lets the legitimate request through; never disable a whole ruleset to fix one path.

- Hypotheses 1 and 2: add a managed rules exception in the managed entrypoint, placed before the `execute` rule (a skip rule only affects rules listed after it). Skip only the matching rule ids for the exact host, path and method (reversible, `rule_create`):
  ```json
  { "method": "POST", "path": "/zones/{zone_id}/rulesets/RULESET_ID/rules", "body": {
    "description": "Skip rule RULE_ID for the CMS editor save",
    "expression": "(http.host eq \"example.com\" and http.request.uri.path eq \"/admin/api/save\" and http.request.method eq \"POST\")",
    "action": "skip",
    "action_parameters": { "rules": { "efb7b8c949ac4650a09736fc376e9aee": ["RULE_ID"] } },
    "position": { "before": "EXECUTE_RULE_ID" },
    "logging": { "enabled": true }
  } }
  ```
  If the managed entrypoint has no `execute` rule to place the exception before (possible on Free, see `waf.managed.off` in cf-waf), do not guess a position; give the user the dashboard steps (Security, WAF, Managed rules, Add exception).
  For OWASP, lower the sensitivity or raise the score threshold on that path instead of skipping the ruleset (see cf-waf, OWASP override). If one managed rule causes false positives everywhere, disable that one rule with an override (`rule_update` of the execute rule, keeping every existing field). For file uploads, Cloudflare recommends malicious uploads detection over managed rules for that traffic.
- Hypothesis 3: narrow the custom rule's expression (reversible `rule_update`, cf-waf; a PATCH replaces the rule, so send every field you keep), or add a narrow skip rule before it. Do not skip on spoofable data alone (user agent, referer, header without a secret); see `waf.skip.too_broad`.
- Hypothesis 4: raise the threshold or narrow the rule to the endpoint it protects (reversible `rule_update`, cf-bots-ratelimit).
- Hypothesis 5: for a known server client, a narrow skip rule for its IP list and path; or, for Security Level, adjust the setting with a reversible `zone_setting` (cf-waf, `waf.security_level.essentially_off` explains the safe range).
- Verify: ask the user to repeat the legitimate action; the security events query shows the skip rule matching (logged) and no new block for that path and client.

## Sources

- https://developers.cloudflare.com/waf/managed-rules/troubleshooting/
- https://developers.cloudflare.com/waf/managed-rules/waf-exceptions/define-api/
- https://developers.cloudflare.com/waf/custom-rules/skip/
- https://developers.cloudflare.com/waf/analytics/security-events/
- https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/
- https://developers.cloudflare.com/ruleset-engine/rulesets-api/add-rule/
