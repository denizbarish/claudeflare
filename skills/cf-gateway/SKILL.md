---
name: cf-gateway
description: Cloudflare Gateway checklist for one account. DNS, HTTP and network rules and their order, lists, DNS locations and the account configuration (TLS decryption, block page). Load it when blocking or allowing domains for a team, auditing Gateway, diagnosing over-blocking, or changing rule order, a list or a location. Load cf-core first.
---

# cf-gateway: rules, lists, locations, configuration

Load `cf-core` first. Findings use the `cf-audit` finding format and severity scale. Gateway lives on the account: plans use `"scope": "account"`, hold only REST ops (no `project_dir` needed) and use `/accounts/{account_id}/gateway/...`. In the MCP examples below, replace `ACCOUNT_ID` (32 hex characters), `RULE_ID` and `LIST_ID` (UUIDs) and `LOCATION_ID` (32 hex characters) with real values from cf-core discovery and the reads; the guard needs literal paths.

Gateway needs a Zero Trust organization. The API cannot create one: if GET `/accounts/{account_id}/access/organizations` fails, preflight reports `not_entitled` and the user creates the organization in the Zero Trust dashboard (the Free plan is enough).

## Read current state

| What | Source |
|---|---|
| Rules (`action`, `enabled`, `filters` = phase `dns`, `http`, `l4`, `egress`, `traffic`, `identity`, `device_posture`, `precedence`, `rule_settings`) | GET `/accounts/{account_id}/gateway/rules` |
| Lists (`name`, `type`, `count`) | GET `/accounts/{account_id}/gateway/lists` |
| Items of one list | GET `/accounts/{account_id}/gateway/lists/{list_id}/items` |
| DNS locations (`networks`, `doh_subdomain`, `ip`, `ipv4_destination`, `client_default`) | GET `/accounts/{account_id}/gateway/locations` |
| Account configuration (`settings.tls_decrypt`, `settings.block_page`, `settings.antivirus`, `settings.activity_log`) | GET `/accounts/{account_id}/gateway/configuration` |
| Identity providers (their login hosts must never be blocked) | GET `/accounts/{account_id}/access/identity_providers` |

Rule order: inside one phase (`filters[0]`) a lower `precedence` runs first, and the first Allow or Block match ends the phase. DNS rules run before HTTP rules. A rule references a list as `$<list id>` inside `traffic`, for example `any(dns.domains[*] in $LIST_ID)`.

MCP `execute`:

```js
async () => {
  const rules = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/gateway/rules" });
  const lists = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/gateway/lists" });
  const locations = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/gateway/locations" });
  const config = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/gateway/configuration" });
  return { rules: rules.result, lists: lists.result, locations: locations.result, settings: config.result.settings };
}
```

Fallback: `claudeflare get /accounts/ACCOUNT_ID/gateway/rules`. Lists page with `page` and `per_page`; read every page before concluding that a list is unused.

## Checks

| finding id | condition | severity | recommended | plan tier |
|---|---|---|---|---|
| `gateway.dns.no_security_baseline` | No enabled DNS rule with action `block` whose `traffic` uses `dns.security_category` and covers at least the malware and phishing categories. | high | One DNS block rule for the security threat categories, high in the order | free |
| `gateway.rule.shadowed` | An enabled rule can never match: an earlier rule (lower `precedence`) in the same phase with action `allow` or `block` matches everything it matches (same or broader domains or hosts, empty `traffic`). | medium | Move the rule above the broader one, or delete it | free |
| `gateway.tls.decrypt_off_with_http_rules` | `settings.tls_decrypt.enabled` is `false` while enabled HTTP rules use selectors that need the decrypted request (`http.request.uri`, `http.request.method`, file types, `http.request.body`). Those rules only see the host name and do not work as written. | medium | Turn on TLS decryption with Do Not Inspect rules for pinned apps, or rewrite the rules on the host name | free |
| `gateway.list.unused` | A list whose id no rule mentions in `traffic`, `identity` or `device_posture`. | low | Delete it, or use it in a rule | free |
| `gateway.location.none` | DNS rules exist but the account has no DNS location and no WARP enrollment, so no traffic reaches them. | medium | Add a location for the office network or roll out WARP | free |

Notes for findings:

- `gateway.dns.no_security_baseline`: `fix` is a POST of a DNS block rule (Applying changes) with a `precedence` lower than every allow rule that would otherwise let the threats through. Ask before adding a block page.
- `gateway.rule.shadowed`: `fix` is a PUT of the shadowed rule with a new `precedence`. Check the Lockout risk lines: moving a block rule above an allow rule changes who is blocked.
- `gateway.tls.decrypt_off_with_http_rules`: `fix` is a PATCH of `/gateway/configuration` with `{ "settings": { "tls_decrypt": { "enabled": true } } }`. Tell the user about certificate pinning first (Traps).
- `gateway.list.unused`: `fix` is a DELETE of the list with `confirm_name`.
- `gateway.location.none`: `fix: []`; a location needs the office's public IPs or a router setup from the user.

## Applying changes

Use the change protocol from cf-core: draft, `claudeflare preflight --file draft.json`, `claudeflare plan new --file draft.json`, user approval, `claudeflare apply <id>`. Show the plan's `Lockout risk:` lines and notes to the user before approval; they are part of what the user approves. Rules, lists and locations are written whole with PUT: read the resource first and send every field that should stay.

| Op | Path (under `/accounts/ACCOUNT_ID`) | Rollback |
|---|---|---|
| Rule create, update, delete | POST `/gateway/rules`, PUT or DELETE `/gateway/rules/RULE_ID` (delete takes `confirm_name` = `name`) | Delete the new rule; restore the rule with its old `precedence`; re-create at its old `precedence` with a new id. Create and update also put back other rules of the phase that the API renumbered during apply; a rule someone moved after apply is skipped with `rollback_drift` |
| List create, update, delete | POST `/gateway/lists`, PUT or DELETE `/gateway/lists/LIST_ID` (`confirm_name` = `name`) | Delete; restore with the old items; re-create with its items and a new id |
| Location create, update, delete | POST `/gateway/locations`, PUT or DELETE `/gateway/locations/LOCATION_ID` (`confirm_name` = `name`) | Delete; restore; re-create with a new DoH subdomain and new IPs |
| Configuration | PATCH `/gateway/configuration` with only the `settings` subcollections to change | PATCHes back only the subcollections the op set, with their previous values; one the account did not have is turned off where an off value is documented (`tls_decrypt`, `protocol_detection`, `block_page`, `antivirus`, `fips`), otherwise the plan says `Not reversible:` |

Refused at `plan new` (`invalid_op`): a rule without `name`, `action` or a `filters` array, a non-integer `precedence`, a list without `name` (or without `type` on create), list items that are not `{ "value": "..." }` objects, a list update with an empty `items` array (a PUT with empty items leaves the list unchanged), a configuration PATCH with keys other than `settings`. A list with more than 1000 items is refused with `too_large`. Two rule ops that set `precedence` in the same phase must be in ascending order (`plan_conflict` otherwise). Refused at preflight (`resource_in_use`): a list delete while a rule mentions the list id, unless an earlier op in the same plan removes that use. Not available as ops: configuration PUT (too broad) and list PATCH (`append` and `remove`); lists are written whole so rollback stays exact.

### Block a domain for the team (the usual request)

```json
{
  "scope": "account",
  "account_id": "0123456789abcdef0123456789abcdef",
  "account_name": "Acme",
  "summary": "Block ads.example.net for everyone behind Gateway",
  "risk": "DNS queries for ads.example.net and its subdomains answer 0.0.0.0.",
  "slug": "gateway-block-ads",
  "ops": [
    {
      "method": "POST",
      "path": "/accounts/0123456789abcdef0123456789abcdef/gateway/rules",
      "body": {
        "name": "Block ads",
        "action": "block",
        "enabled": true,
        "filters": ["dns"],
        "traffic": "any(dns.domains[*] == \"ads.example.net\")",
        "precedence": 5000
      }
    }
  ]
}
```

Pick a `precedence` after reading the rules: below (higher number than) every allow rule that must still win, above the rules it should override. Several domains belong in a list (`"type": "DOMAIN"`, `"items": [{ "value": "ads.example.net" }]`) created in an earlier plan; the rule then uses `any(dns.domains[*] in $LIST_ID)`.

### Lockout risk lines

These never refuse a plan; they are shown at `plan new` and checked again at apply (a new line stops apply with `risk_changed`):

1. A block rule whose `traffic` matches all traffic (empty `traffic`, or a `matches ".*"` wildcard), or matches Cloudflare and identity provider domains: `cloudflareaccess.com` (Access logins and the team domain), `cloudflare.com` (dashboard and API), `cloudflareclient.com` (WARP), and the login hosts of the configured identity providers. A list update that puts such a domain into a list a block rule uses counts too.
2. A block rule placed above an allow rule with an overlapping selector, an allow rule moved below such a block rule, an allow rule deleted while a block rule below it matches the same traffic, or a block rule without `precedence` (its place is unknown) that overlaps an allow rule.
3. A `traffic` expression claudeflare cannot analyze (anything beyond `dns.domains`, `dns.fqdn`, `http.request.host`, `net.dst.ip` and list references, joined with `or`) gives: `Lockout risk: could not analyze traffic expression of rule <name>; check it does not block Cloudflare or IdP domains`.

Turning TLS decryption on is a lockout line too (certificate-pinned apps and devices without the Cloudflare root certificate lose HTTPS). When a line appears, keep a terminal on a machine that is not behind Gateway: if Gateway blocks `api.cloudflare.com`, `claudeflare rollback` cannot reach the API from a filtered device.

### Verification

After apply claudeflare reads each changed resource back. `traffic`, `identity` and `device_posture` are compared without formatting, because the API rewrites spacing; drift checks before a rollback compare against the value the API returned. List items are compared by value, or by `count` when the list read holds no items. The same holds for the drift check before a list rollback: when the list GET has no items, only a change of `count` counts as drift, so an item swapped after apply is overwritten by the rollback. The read-back detail ends with a test command such as `dig ads.example.net +short` to run on a device behind Gateway (0.0.0.0 or the block page address means blocked) and the note that filtering itself is only verified from a device behind Gateway. A failed check sets `applied_verify_failed` and drafts a rollback plan that still needs approval.

## Traps

- A block rule with empty `traffic` blocks every query of its phase, including Cloudflare's own login and API hosts. Rollback then only works from a device outside Gateway.
- Order decides: a broad allow rule above a block rule disables the block for everything it matches, and the first Allow or Block match ends the phase.
- `dns.domains` matches the domain and every subdomain; `dns.fqdn` and `http.request.host` match one exact host.
- Re-creating a location gives a new DoH subdomain and new IPs; routers and devices configured with the old ones stop being filtered.
- TLS decryption breaks apps that pin certificates and devices without the Cloudflare root certificate; add Do Not Inspect rules first.
- HTTP rules on paths, methods or file types do nothing while TLS decryption is off.
- A list PUT with empty `items` keeps the old items; to empty a list, delete and re-create it.

## Sources

- Gateway rules API: developers.cloudflare.com/api/resources/zero_trust/subresources/gateway/subresources/rules/
- Gateway lists API: developers.cloudflare.com/api/resources/zero_trust/subresources/gateway/subresources/lists/
- Order of enforcement: developers.cloudflare.com/cloudflare-one/policies/gateway/order-of-enforcement/
- Test DNS filtering: developers.cloudflare.com/cloudflare-one/policies/gateway/dns-policies/test-dns-filtering/
- TLS decryption: developers.cloudflare.com/cloudflare-one/policies/gateway/http-policies/tls-decryption/
