# Spectrum app does not connect

Symptom: a client cannot connect to a Spectrum hostname (SSH, RDP, Minecraft, or another TCP or UDP service): connection refused, timeout, or the session drops right after connecting.

## Evidence

1. The zone plan and the app:
   ```js
   async () => {
     const zone = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID" });
     const apps = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/spectrum/apps", query: { page: 1, per_page: 50 } });
     const records = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/dns_records", query: { name: "ssh.example.com" } });
     return { plan: zone.result.plan.legacy_id, apps: apps.result, records: records.result };
   }
   ```
   For the app: `dns.name`, `protocol` (`tcp/22`), `origin_direct` or `origin_dns` with `origin_port`, `ip_firewall`, `proxy_protocol`, `tls`, `edge_ips`, `traffic_type`.
2. From the local machine (user's client, or yours):
   ```
   dig +short ssh.example.com
   nc -vz -w 5 ssh.example.com 22
   ```
   The name should resolve to the app's edge IPs, not the origin.
3. With `ip_firewall: true`: IP Access Rules for the zone (GET `/zones/ZONE_ID/firewall/access_rules/rules`).
4. Direct origin check, only with an origin address the user provides: `nc -vz -w 5 192.0.2.20 22`.

## Hypotheses

1. **The hostname does not point at the app.** Confirm: `dig` returns the origin address or another record, a separate DNS record for `dns.name` overrides it, or the app uses `dns.type: "ADDRESS"` and nothing points at its edge IPs. Reject: the name resolves to the app's edge IPs.
2. **The origin firewall blocks Cloudflare.** Confirm: the edge accepts the connection and then it drops or times out; the origin allows only the clients' addresses, not Cloudflare ranges. Reject: the origin allows https://www.cloudflare.com/ips/ on the port.
3. **Proxy protocol mismatch.** Confirm: `proxy_protocol` is `v1`, `v2` or `simple` and the origin does not expect it (sessions drop or SSH reports a protocol error), or the origin requires it and it is `off`. Reject: both sides agree.
4. **Port or protocol mismatch.** Confirm: `protocol` or `origin_port` differs from where the service listens, or the client uses UDP while the app is TCP. Reject: they match.
5. **The client is blocked by IP Access Rules.** Confirm: `ip_firewall: true` and a rule blocks or does not allow the client's address. Reject: the client's address is allowed.
6. **The plan does not allow this protocol.** Confirm: a generic TCP or UDP port on a Pro or Business zone (only SSH 22, Minecraft 25565 and RDP 3389 there), or any app on Free. Reject: the plan allows it.

## Fix

- Hypothesis 1: a zone plan fixing the DNS record (cf-dns), or a Spectrum app PUT with the right `dns` (cf-spectrum, whole app).
- Hypothesis 2: steps for the user to allow Cloudflare ranges on the origin port.
- Hypotheses 3 and 4: a zone plan PUT of the app with the right `proxy_protocol`, `protocol` or `origin_port` (cf-spectrum, Applying changes); tell the user what the origin must accept.
- Hypothesis 5: an IP Access Rule change through a zone plan (cf-waf).
- Hypothesis 6: say plainly that the protocol needs Enterprise; offer a Tunnel with `cloudflared access` for SSH or RDP instead (cf-tunnel).
- Verify: `nc -vz -w 5 ssh.example.com 22` connects. After an app create or update, apply itself opens a TCP connection to `dns.name` on the edge port (skipped for UDP apps and port ranges); `"verify": { "expect": "tcp_open", "url": "https://ssh.example.com:2222" }` tests another host or port.

## Sources

- https://developers.cloudflare.com/spectrum/protocols-per-plan/
- https://developers.cloudflare.com/spectrum/reference/configuration-options/
- https://developers.cloudflare.com/spectrum/how-to/enable-proxy-protocol/
- https://developers.cloudflare.com/spectrum/reference/troubleshooting/
