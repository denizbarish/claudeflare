# Gateway blocks too much

Symptom: users behind Gateway (WARP or a DNS location) cannot reach sites that should work, see the Gateway block page, or `dig` returns `0.0.0.0` or `::`. Sometimes "everything is blocked", including login pages.

## Evidence

1. From an affected device (user runs it):
   ```
   warp-cli status
   dig +short crm.example.net
   dig +short crm.example.net @1.1.1.1
   ```
   `0.0.0.0` or the block page address through Gateway, and a real address through 1.1.1.1, proves the DNS phase blocks it. A real address in both points to an HTTP or network rule (or not to Gateway at all).
2. Gateway activity for the window (SKILL.md, Shared evidence): the blocked `queryName` values, their `resolverDecision` and the `policyId` that decided.
3. Rules, lists and configuration:
   ```js
   async () => {
     const rules = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/gateway/rules" });
     const lists = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/gateway/lists" });
     const config = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/gateway/configuration" });
     return { rules: rules.result, lists: lists.result, settings: config.result.settings };
   }
   ```
   For the rule named by `policyId`: `action`, `enabled`, `filters` (phase), `precedence` and `traffic`. For every list it references (`$<list id>` in `traffic`), read its items: GET `/accounts/ACCOUNT_ID/gateway/lists/LIST_ID/items`.
4. The audit log around the start time: a rule create or update, a list update, a precedence change.

## Hypotheses

1. **A list entry is broader than meant.** Confirm: a blocking rule uses `any(dns.domains[*] in $LIST_ID)`, and the list holds a parent domain (`example.net`) where a host was meant (`ads.example.net`). `dns.domains` holds the queried name and its parents, so a parent entry blocks every subdomain. The blocked names in the activity share that parent; the audit log shows the list update. Reject: every list entry is an exact host that should be blocked.
2. **A block rule matches far more than its name says.** Confirm: `traffic` is empty, a regex `matches` that catches everything (`".*"`), a content or security category that covers business sites, or a selector on the wrong field. Reject: the expression is narrow.
3. **A block rule runs before an allow rule.** Confirm: the allow rule for the site has a higher `precedence` (runs later) in the same phase than the block that matches; the audit log shows a precedence change. Reject: the allow runs first.
4. **Identity or device conditions do not match.** Confirm: the allow rule has an `identity` or `device_posture` condition the user's device does not meet (not logged in to WARP with an identity, posture failing), so the general block wins. Reject: the user's identity matches.
5. **Cloudflare or identity provider domains are blocked.** Confirm: blocked names include `cloudflareaccess.com`, `cloudflareclient.com`, `cloudflare.com` or the identity provider's login host; then logins and WARP itself fail and "everything" looks blocked. Reject: none of those are blocked.
6. **Not Gateway at all.** Confirm: no blocked queries in the activity for the names, `dig` returns real addresses, and the error comes from the site (a 403 from its WAF, an Access page). Reject: the activity shows the block.

## Fix

- Hypothesis 1: an account plan PUT of the list with the full corrected item set (whole list; `items` must not be empty) and the same `name` (cf-gateway, Applying changes). Read the items first and send every entry that should stay.
- Hypotheses 2 and 5: PUT the rule with a narrower `traffic`, or with `enabled: false` while a narrower rule is prepared. `claudeflare plan new` adds a `Lockout risk:` line when a block rule still matches all traffic or Cloudflare and identity provider domains; a plan without it confirms the fix.
- Hypothesis 3: PUT the rules with a new `precedence` so the allow rule runs first; precedence changes of one phase go in one plan in ascending order (`plan_conflict` otherwise). Moving a block above an allow gets a `Lockout risk:` line.
- Hypothesis 4: fix the identity or posture condition, or the user's enrollment (cf-devices).
- Hypothesis 6: diagnose the site itself (`cf-troubleshoot`, cf-access).
- Verify: read-back after apply proves only the rule or list; filtering itself is only verified from a device behind Gateway, so the user repeats `dig +short crm.example.net` on an affected device and gets a real address.

## Sources

- https://developers.cloudflare.com/cloudflare-one/policies/gateway/order-of-enforcement/
- https://developers.cloudflare.com/cloudflare-one/policies/gateway/dns-policies/test-dns-filtering/
- https://developers.cloudflare.com/cloudflare-one/policies/gateway/dns-policies/
- https://developers.cloudflare.com/cloudflare-one/reusable-components/lists/
- https://developers.cloudflare.com/cloudflare-one/insights/logs/gateway-logs/
