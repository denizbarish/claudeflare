---
name: cf-zt-troubleshoot
description: Evidence-first diagnosis of Cloudflare Zero Trust and network problems with one decision tree per symptom. Access redirect loops, Access 403 or "You don't have permission", invalid Access JWT at the origin, Tunnel errors 1016, 1033 and 502, Gateway blocking too much, WARP clients that cannot reach private networks, Load Balancing with no healthy pool, and Spectrum apps that do not connect. Load it when one of these shows up. Load cf-core first.
---

# cf-zt-troubleshoot: Zero Trust and network diagnosis

Load `cf-core` first. This skill finds the root cause; the changes live in the product skills (`cf-access`, `cf-tunnel`, `cf-gateway`, `cf-devices`, `cf-load-balancing`, `cf-spectrum`), and the trees point to their recipes and finding ids instead of repeating them. Zone symptoms without a Zero Trust or network product (520 to 526, plain 1xxx, cache, WAF) belong to `cf-troubleshoot`.

## Method

The same five steps as `cf-troubleshoot`, in order:

1. **Symptom.** The exact error page or code, the URL or private address, who is affected (one user, a group, everyone, only WARP users, only one office), since when, and what changed. Ask the user only for what you cannot read yourself.
2. **Outside evidence.** `curl -sI` the public hostname (status, `location`, `cf-ray`, `server`), `dig` the hostname, and for WARP and Gateway the commands the user runs on an affected device (below).
3. **Inside evidence.** The product reads the tree lists, the Access request log, Gateway activity through GraphQL, tunnel connectors, pool health, and the audit log around the start time (`cf-troubleshoot`, Shared evidence).
4. **Hypotheses.** Work through the tree's hypotheses in order and confirm or reject each with the evidence it names. When one is confirmed, still check the cheap remaining ones: a wrong policy and an expired session, or a down connector and a stale CNAME, often stack.
5. **Result.** Root cause, the evidence for it, the fix, and how you will verify it.

## Rules

- **Every conclusion cites evidence**: the read or command and the value it returned. A hypothesis without evidence is reported as unconfirmed.
- **Read only while diagnosing.** Every Cloudflare change goes through the cf-core change protocol. Do not disable an Access app, a Gateway rule or a WARP setting "to test" outside a plan.
- **Never touch hosts or devices.** claudeflare does not run `cloudflared`, WARP or anything on the origin or a user's device. Steps there are instructions for the user, run in their own terminal.
- **No secrets in chat.** Never read `/accounts/{account_id}/cfd_tunnel/{tunnel_id}/token` (the guard blocks it; `claudeflare tunnel-token` writes the token to an env file), never open a file under `.claudeflare/secrets/` or an env file `claudeflare tunnel-token` wrote, and never ask for a token, a service token secret, a client secret or a `CF_Authorization` cookie value.
- **Lockout first.** A fix that touches who can sign in (Access policies, identity providers, Gateway block rules, WARP split tunnels) shows its `Lockout risk:` lines from `claudeflare plan new` before approval, and the user keeps the terminal open until the fix is verified.
- **Honest verification.** Gateway filtering and WARP routing are verified only from a device behind them; an API read-back proves the setting, not the behavior. Say which one you checked.

## Pick a tree

| Symptom | Tree |
|---|---|
| Endless redirects between the app and `<team>.cloudflareaccess.com` or the identity provider, `ERR_TOO_MANY_REDIRECTS` behind Access | [trees/access-redirect-loop.md](trees/access-redirect-loop.md) |
| Access shows "You don't have permission to view this app", or 403 after login | [trees/access-403.md](trees/access-403.md) |
| The origin rejects requests that passed Access ("invalid token", "audience mismatch", 401 from the app) | [trees/access-jwt-invalid.md](trees/access-jwt-invalid.md) |
| Error 1016 (Origin DNS error) on a tunnel hostname | [trees/tunnel-1016.md](trees/tunnel-1016.md) |
| Error 1033 (Argo Tunnel error) | [trees/tunnel-1033.md](trees/tunnel-1033.md) |
| 502 Bad Gateway on a tunnel hostname | [trees/tunnel-502.md](trees/tunnel-502.md) |
| Gateway blocks sites that should work, "everything is blocked", block page for allowed domains | [trees/gateway-overblocking.md](trees/gateway-overblocking.md) |
| WARP is connected but a private IP or internal hostname does not answer | [trees/warp-private-route.md](trees/warp-private-route.md) |
| Load balancer serves errors, "no healthy pools", traffic on the fallback pool | [trees/lb-no-healthy-pool.md](trees/lb-no-healthy-pool.md) |
| A Spectrum app (SSH, RDP, Minecraft, TCP or UDP) does not connect or times out | [trees/spectrum-no-connect.md](trees/spectrum-no-connect.md) |

## Shared evidence

Replace `ACCOUNT_ID`, `ZONE_ID`, `APP_ID`, `TUNNEL_ID` and `POOL_ID` with real ids from cf-core discovery and the product reads, and `wiki.example.com` with the affected hostname. Timestamps are a window around the start time (ISO 8601 UTC).

Outside, from the local machine:

```
curl -sI https://wiki.example.com/
dig +short wiki.example.com
dig +short CNAME wiki.example.com
```

A `302` to `https://<team>.cloudflareaccess.com/cdn-cgi/access/login/...` means Access protects the hostname. An HTTP status of `530` with error 1016 or 1033 in the body comes from a tunnel hostname. Proxied records resolve to Cloudflare IPs, so `dig` shows the CNAME only through the DNS read below.

Access request log (who was allowed or denied, by which app, with which identity provider):

```js
async () => {
  const logs = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/access/logs/access_requests", query: { since: "2026-10-26T06:00:00Z", until: "2026-10-26T12:00:00Z", limit: 50, direction: "desc" } });
  return logs.result;
}
```

Each entry has `user_email`, `app_domain`, `app_uid`, `action` (for example `login`), `allowed` and `connection` (the identity provider type). `allowed: false` on the right app is the evidence for a policy problem; no entry at all means the request never reached Access login.

Gateway DNS activity (needs Gateway logging on, `settings.activity_log.enabled` in the Gateway configuration). The dataset and field names come from the GraphQL schema and were not checked against a live account for this skill; if one is rejected, look it up with the MCP `docs` or `search` tool instead of guessing:

```js
async () => {
  const dns = await cloudflare.request({ method: "POST", path: "/client/v4/graphql", body: { query: `query ($accountTag: string, $since: Time, $until: Time) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    gatewayResolverQueriesAdaptiveGroups(limit: 50, filter: { datetime_geq: $since, datetime_leq: $until }, orderBy: [count_DESC]) {
      count dimensions { queryName resolverDecision policyId }
    }
  } }
}`, variables: { accountTag: "ACCOUNT_ID", since: "2026-10-26T06:00:00Z", until: "2026-10-26T12:00:00Z" } } });
  return dns;
}
```

`policyId` is the Gateway rule that decided; compare it with the rule ids from GET `/accounts/ACCOUNT_ID/gateway/rules`. HTTP and network activity use `gatewayL7RequestsAdaptiveGroups` and `gatewayL4SessionsAdaptiveGroups` the same way.

Tunnel and pool state:

```js
async () => {
  const tunnel = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/cfd_tunnel/TUNNEL_ID" });
  const connectors = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/cfd_tunnel/TUNNEL_ID/connections" });
  const config = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/cfd_tunnel/TUNNEL_ID/configurations" });
  const health = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/load_balancers/pools/POOL_ID/health" });
  return { tunnel: tunnel.result, connectors: connectors.result, config: config.result, health: health.result };
}
```

What changed: the audit log around the start time (`cf-troubleshoot`, Shared evidence). Access, Gateway, tunnel and device changes appear there with the actor; a change on a connector host or a device does not, so ask the user about it.

On an affected device (the user runs these and pastes the output):

```
warp-cli status
warp-cli settings
dig +short crm.example.net
curl -sI https://crm.example.net/
```

`warp-cli settings` shows the profile, the split tunnel mode and its entries, and the fallback domains the device actually received.

## Result format

Report in the user's language:

- **Root cause**: one sentence.
- **Evidence**: each supporting read or command with the value it returned; rejected hypotheses with the evidence that rejected them.
- **Fix**: Cloudflare side as a plan through the cf-core change protocol (account plans for Access, Tunnel, Gateway, Devices, pools and monitors; zone plans for DNS, load balancers and Spectrum), with its `Lockout risk:` lines; connector, origin and device side as numbered steps for the user.
- **Verify**: the check that shows the fix worked, and who runs it (for example the plan's `"expect": "access_login"` verification, `curl -sI` without the error, or `dig` on a device behind Gateway).

## Sources

- https://developers.cloudflare.com/cloudflare-one/troubleshooting/access/
- https://developers.cloudflare.com/cloudflare-one/troubleshooting/tunnel/
- https://developers.cloudflare.com/cloudflare-one/insights/logs/
- https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/logs/subresources/access_requests/methods/list/
- https://developers.cloudflare.com/analytics/graphql-api/features/data-sets/
- https://developers.cloudflare.com/cloudflare-one/policies/gateway/dns-policies/test-dns-filtering/
