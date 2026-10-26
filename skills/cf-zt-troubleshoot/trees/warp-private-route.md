# WARP cannot reach a private network

Symptom: WARP shows Connected, the internet works, but a private IP (`10.0.5.20`) or an internal hostname (`wiki.corp.internal`) times out or does not resolve.

## Evidence

1. On the affected device (user runs it):
   ```
   warp-cli status
   warp-cli settings
   ping -c 3 10.0.5.20
   dig +short wiki.corp.internal
   ```
   `warp-cli settings` shows the profile in use, the split tunnel mode (Exclude or Include) with its entries, and the fallback domains.
2. Routes, virtual networks and the tunnel behind them:
   ```js
   async () => {
     const routes = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/teamnet/routes", query: { is_deleted: false } });
     const vnets = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/teamnet/virtual_networks", query: { is_deleted: false } });
     return { routes: routes.result, vnets: vnets.result };
   }
   ```
   Find the route whose `network` contains the address, its `tunnel_id` and `virtual_network_id`. Then read that tunnel's status and config (SKILL.md, Shared evidence): `config["warp-routing"].enabled`.
3. Device profiles and their lists (cf-devices, Read current state): which profile matches the user, its `exclude` or `include` entries, and `fallback_domains`.
4. Gateway network and DNS rules that could block the address or the name (gateway-overblocking).

## Hypotheses

1. **The address is excluded from WARP.** Confirm: Exclude mode and an entry covers the address; the default exclude list holds the RFC 1918 ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), so private routes never enter WARP until that range is removed. Reject: no exclude entry covers it (or Include mode lists it).
2. **No route, or a route in another virtual network.** Confirm: no route `network` contains the address, or it sits in a virtual network the device is not on (the default network unless the user switched). Reject: a route in the device's virtual network contains it.
3. **The tunnel behind the route is down or not routing WARP traffic.** Confirm: the route's tunnel is `down` or `inactive`, or `warp-routing.enabled` is `false` in its remote config. Reject: `healthy` and enabled.
4. **Internal names resolve through public DNS.** Confirm: the IP works but the name does not; `wiki.corp.internal` is not a fallback domain (or a Gateway resolver policy) pointing at the internal DNS server. Reject: the domain is in the fallback list with the internal resolver.
5. **Gateway blocks it.** Confirm: a network or DNS rule blocks the address or name (Gateway activity, `policyId`). Reject: no block.
6. **The device is on the wrong profile or organization.** Confirm: `warp-cli settings` shows another team or a profile whose lists differ from the one you read. Reject: the profile matches.

## Fix

- Hypothesis 1: an account plan PUT of the profile's exclude list without the covering entry (whole list; cf-devices, Applying changes). A split tunnel change that removes Access or identity provider domains while posture is required gets a `Lockout risk:` line; switching Exclude and Include mode resets the entries and always gets one.
- Hypothesis 2: an account plan POST of a route `{ "network": "10.0.5.0/24", "tunnel_id": "...", "virtual_network_id": "..." }` (cf-tunnel), or the user switches virtual network in the WARP client.
- Hypothesis 3: start the connector (tunnel-1033), or a config PUT with `"warp-routing": { "enabled": true }` (cf-tunnel).
- Hypothesis 4: PUT the profile's `fallback_domains` with the internal suffix and its DNS server (cf-devices).
- Hypothesis 5: see gateway-overblocking.
- Hypothesis 6: the user re-enrolls in the right team; profile matching rules are fixed with a profile PATCH (cf-devices).
- Verify: device behavior is only verified on a device, so the user repeats `ping` and `dig` on an affected device; the plan's read-back proves the setting only.

## Sources

- https://developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/configure-warp/route-traffic/split-tunnels/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/private-net/cloudflared/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/private-net/cloudflared/tunnel-virtual-networks/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/configure-warp/route-traffic/local-domains/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/troubleshooting/
