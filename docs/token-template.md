# API token template

claudeflare reads through the official Cloudflare MCP server and writes only through `claudeflare apply`, which uses the API token in `CLOUDFLARE_API_TOKEN`. This page lists the token permissions for each job.

- **Read set:** for `claudeflare get` (the read fallback when MCP is unavailable). Audits and diagnosis through MCP need no token at all.
- **Write set:** for `claudeflare apply`. Create this token only when you want to apply changes.
- **Developer platform sets:** for Workers, Pages and storage. wrangler uses the same token for preflight, `claudeflare tail` and account plans.
- **Zero Trust and network sets:** for Access, Tunnel, Gateway, WARP devices, Load Balancing and Spectrum, including `claudeflare tunnel-token`.

Create the token in the Cloudflare dashboard under **My Profile > API Tokens > Create Token > Create Custom Token**. Scope zone permissions to the zones you want claudeflare to manage (**Zone Resources > Include > Specific zone**) and account permissions to the account that owns them.

Permission names below are the dashboard names. Where the API name (shown by the [List permission groups](https://developers.cloudflare.com/api/resources/user/subresources/tokens/subresources/permission_groups/methods/list/) endpoint) differs, it is in parentheses. All names were checked against [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) (last updated Oct 12, 2026) on 2026-10-24.

## Read set

Core permissions:

| Scope | Permission | Used for |
|---|---|---|
| Zone | Zone Read | Zone discovery, plan tier, Page Rules listing |
| Zone | Zone Settings Read | SSL mode, TLS, HSTS, cache and performance settings |
| Zone | DNS Read | DNS records, DNSSEC status |
| Zone | SSL and Certificates Read | Certificate packs and SSL configuration |
| Zone | Cache Rules Read (API: Cache Settings Read) | Cache Rules (`http_request_cache_settings`) |
| Zone | Firewall Services Read | Firewall resources |
| Zone | Analytics Read | GraphQL analytics (traffic, status codes, firewall events) |
| Account | Account Rulesets Read | Account-level rulesets |
| Account | Account Settings Read | Audit logs (`/accounts/{account_id}/logs/audit`) |

There is no separate "Zone Rulesets Read" permission. Each zone rules phase has its own permission. For a full audit (rules, WAF and bots domains), also add:

| Scope | Permission | Used for |
|---|---|---|
| Zone | Zone WAF Read | WAF managed and custom rules, rate limiting rules |
| Zone | Bot Management Read | Bot Fight Mode and Super Bot Fight Mode |
| Zone | Single Redirect Read (API: Dynamic URL Redirects Read) | Single Redirects (`http_request_dynamic_redirect`) |
| Zone | Config Rules Read (API: Config Settings Read) | Configuration Rules (`http_config_settings`) |
| Zone | Transform Rules Read (API: Zone Transform Rules Read) | URL rewrites and header transforms |
| Zone | Origin Rules Read (API: Origin Read) | Origin Rules (`http_request_origin`) |
| Zone | Page Rules Read | Page Rules (read only, for migration advice) |

## Write set

The read set, plus the matching edit permissions and Cache Purge:

| Scope | Permission | Used for |
|---|---|---|
| Zone | Zone Edit (API: Zone Write) | Optional. No v1 op needs it; leave it out for least privilege |
| Zone | Zone Settings Edit (API: Zone Settings Write) | Zone settings, Tiered Cache |
| Zone | DNS Write | DNS records, DNSSEC |
| Zone | SSL and Certificates Edit (API: SSL and Certificates Write) | Certificate and SSL configuration |
| Zone | Cache Rules Edit (API: Cache Settings Write) | Cache Rules |
| Zone | Cache Purge | Cache purge (not reversible) |
| Zone | Firewall Services Edit (API: Firewall Services Write) | Firewall resources |
| Zone | Zone WAF Edit (API: Zone WAF Write) | WAF custom and managed rules, rate limiting rules |
| Zone | Bot Management Edit (API: Bot Management Write) | Bot Fight Mode and Super Bot Fight Mode |
| Zone | Single Redirect Edit (API: Dynamic URL Redirects Write) | Single Redirects |
| Zone | Config Rules Edit (API: Config Settings Write) | Configuration Rules |
| Zone | Transform Rules Edit (API: Zone Transform Rules Write) | URL rewrites and header transforms |
| Zone | Origin Rules Edit (API: Origin Write) | Origin Rules |
| Account | Account Rulesets Edit (API: Account Rulesets Write) | Required with Cache Rules Edit |
| Account | Account Filter Lists Edit (API: Account Rule Lists Write) | Required with Cache Rules Edit |

Keep **Account Settings Read**, **Analytics Read** and **Page Rules Read** as read permissions. claudeflare never writes account settings and never creates Page Rules.

The [Cache Rules API docs](https://developers.cloudflare.com/cache/how-to/cache-rules/create-api/) require Cache Rules Edit, Account Rulesets Edit and Account Filter Lists Edit together. The [Tiered Cache docs](https://developers.cloudflare.com/cache/how-to/tiered-cache/) list Zone Settings Write or Zone Write.

## Use the token

Export the token in your shell profile, then restart Claude Code:

```sh
export CLOUDFLARE_API_TOKEN="<your token>"
```

Never paste the token into the chat. claudeflare reads it only from the environment and never writes it to disk or prints it.

If a call fails with a `permission` error, the hint includes Cloudflare's error message, which usually names the missing permission. Add it to the token and run the step again.

Check the token with `/claudeflare:setup`. It calls `GET /user/tokens/verify`, which works for user tokens. An account-owned token verifies with `GET /accounts/<account_id>/tokens/verify` instead.

## Developer platform sets

Account permissions, scoped to the account that owns the Workers, Pages projects and storage. Add only the products you use.

Read (preflight, `claudeflare get`, `claudeflare tail`, audits through the CLI):

| Scope | Permission | Used for |
|---|---|---|
| Account | Workers Scripts Read | Workers, deployments, versions, settings, `wrangler secret list` |
| Account | Workers Tail Read | `claudeflare tail` |
| Account | Cloudflare Pages Read (API: Pages Read) | Pages projects and deployments |
| Account | D1 Read | D1 databases, `d1 migrations list --remote`, Time Travel bookmarks |
| Account | Workers KV Storage Read | KV namespaces |
| Account | Workers R2 Storage Read | R2 buckets, the empty check before a bucket delete |
| Account | Queues Read | Queues |
| Account | Account Analytics Read | Workers invocation analytics (GraphQL) |
| Account | Vectorize Read | Optional: preflight checks Vectorize bindings |
| Account | Hyperdrive Read | Optional: preflight checks Hyperdrive bindings |
| Zone | Workers Routes Read | Worker routes on your zones |

Write (account plans), the read rows plus:

| Scope | Permission | Used for |
|---|---|---|
| Account | Workers Scripts Edit (API: Workers Scripts Write) | `deploy`, `versions deploy`, `rollback`, `delete`, `secret put`, `secret delete`. `delete` also needs Workers KV Storage Read (wrangler then looks for Workers Sites namespaces) |
| Account | Cloudflare Pages Edit (API: Pages Write) | `pages deploy`, Pages rollback |
| Account | D1 Edit (API: D1 Write) | `d1 create`, `d1 delete`, `d1 migrations apply --remote`, `d1 time-travel restore` |
| Account | Workers KV Storage Edit (API: Workers KV Storage Write) | `kv namespace create`, `kv namespace delete` |
| Account | Workers R2 Storage Edit (API: Workers R2 Storage Write) | `r2 bucket create`, `r2 bucket delete`, `r2 bucket dev-url enable` and `disable` |
| Account | Queues Edit (API: Queues Write) | `queues create`, `queues delete` |
| Zone | Workers Routes Edit (API: Workers Routes Write) | Deploys that change `routes` in the wrangler config |

claudeflare passes the account id to wrangler (`CLOUDFLARE_ACCOUNT_ID`), so the token needs no Memberships permission.

## Zero Trust and network sets

For Access, Tunnel, Gateway, WARP devices, Load Balancing and Spectrum. Add only the products you use. Put the Read form on the read token and the Edit form on the write token (the API reference calls the edit forms "Write"). Preflight probes one read per product a plan touches; a 403 stops with `missing_permission` and names the permission from this table. The probe reads only: a token without the Edit form passes preflight and stops at apply with `missing_permission` naming the Edit permission. These names follow the [permissions page](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) as read on 2026-10-26; they were not yet checked against a live token.

| Scope | Read token | Write token | Used for |
|---|---|---|---|
| Account | Access: Apps and Policies Read | Access: Apps and Policies Edit | Access applications, reusable and app-scoped policies; Devices reads Access apps and policies for posture checks |
| Account | Access: Organizations, Identity Providers, and Groups Read | Access: Organizations, Identity Providers, and Groups Edit | Zero Trust organization (team domain), identity providers, groups; Gateway and Devices read identity providers for lockout checks |
| Account | Access: Service Tokens Read | Access: Service Tokens Edit | Service tokens |
| Account | Cloudflare Tunnel Read | Cloudflare Tunnel Edit | Tunnels, ingress configurations, connections, and `claudeflare tunnel-token` (the token endpoint needs Edit). Newer accounts may show it as Cloudflare One Connectors |
| Account | Cloudflare One Networks Read | Cloudflare One Networks Edit | Private network routes and virtual networks (`/teamnet/...`). claudeflare's permission hint for route ops names Cloudflare Tunnel; add both |
| Account | Zero Trust Read | Zero Trust Edit | Gateway rules, lists, locations and configuration; WARP device profiles, split tunnel lists, posture rules and device settings |
| Account | Load Balancing: Monitors and Pools Read | Load Balancing: Monitors and Pools Edit | Monitors, pools, pool health, `references` and `preview` |
| Zone | Load Balancers Read | Load Balancers Edit | Load balancers of a zone (zone plans) |
| Zone | Zone Settings Read | Zone Settings Edit | Spectrum apps (zone plans) |
| Zone | Zone Read | Zone Read | Zone plan tier for the Spectrum protocol check, zone list for tunnel CNAME scans |
| Zone | DNS Read | DNS Write | Tunnel CNAMEs to `<uuid>.cfargotunnel.com` (reads in Tunnel preflight, writes in separate zone plans) |

The Zero Trust organization itself cannot be created through the API. If preflight reports `not_entitled` for Access, Gateway or Devices, create the organization in the Zero Trust dashboard first (the Free plan is enough). Load Balancing is a paid add-on and Spectrum needs a paid zone plan; preflight reports `not_entitled` without them.

Not needed and never used: Dashboard SSO, account members and roles, billing.

## Sources

- [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Audit logs](https://developers.cloudflare.com/fundamentals/account/account-security/audit-logs/) (Account Settings Read)
- [Create Cache Rules via API](https://developers.cloudflare.com/cache/how-to/cache-rules/create-api/)
- [Tiered Cache](https://developers.cloudflare.com/cache/how-to/tiered-cache/)
- [Wrangler system environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/) (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`)
- API reference "Accepted Permissions": [zone setting edit](https://developers.cloudflare.com/api/resources/zones/subresources/settings/methods/edit/), [DNS record create](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/), [DNSSEC edit](https://developers.cloudflare.com/api/resources/dns/subresources/dnssec/methods/edit/), [bot management update](https://developers.cloudflare.com/api/resources/bot_management/methods/update/), [cache purge](https://developers.cloudflare.com/api/resources/cache/methods/purge/)
