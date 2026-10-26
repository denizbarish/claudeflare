---
name: cf-spectrum
description: Cloudflare Spectrum checklist. Zone Spectrum apps (TCP and UDP proxying for SSH, RDP, Minecraft and generic ports), protocols per plan, IP Access Rules, Proxy Protocol and TLS. Load it when creating, changing or deleting a Spectrum app, auditing Spectrum, or diagnosing a Spectrum app that does not connect. Load cf-core first.
---

# cf-spectrum: Spectrum apps

Load `cf-core` first. Findings use the `cf-audit` finding format and severity scale. Spectrum apps live on a zone: plans use the zone form (`zone_id`, `zone_name`) and `/zones/{zone_id}/spectrum/apps`. In the MCP examples below, replace `ZONE_ID` (32 hex characters) and `APP_ID` (32 hex characters) with real values from cf-core discovery and the reads; the guard needs literal paths.

## Protocols per plan

Preflight reads the zone plan (GET `/zones/{zone_id}`, field `plan.legacy_id`) and checks every app a plan creates or updates against this table. A mismatch is `not_entitled`, and nothing is written.

| Zone plan | Apps it allows |
|---|---|
| Free | none (Spectrum is not available) |
| Pro | `ssh`, `minecraft` (paid add-on) |
| Business | `ssh`, `minecraft`, `rdp` (paid add-on) |
| Enterprise | all: any TCP or UDP port or port range, HTTP and HTTPS |

The API has no protocol name. claudeflare reads a body as a named app when its `protocol` is `tcp/22` (ssh), `tcp/25565` (minecraft) or `tcp/3389` (rdp) and it sets only `dns`, `protocol` and `origin_direct` (the pay-as-you-go app shape); other fields may appear only with their defaults (`traffic_type` `direct`, `proxy_protocol` `off`, `tls` `off`, `ip_firewall` false, `argo_smart_routing` false, `edge_ips` dynamic on all connectivity), as in a body read back from the API. Any other body is a generic app and needs Enterprise: a `tcp/22` app with `ip_firewall: true`, `proxy_protocol` `v1`, `origin_dns` or static `edge_ips` is generic. Pro and Business also allow one app per named protocol; the API refuses a second one at apply. A 403 is `missing_permission` and names `Zone Settings` (the token template permission for Spectrum) or `Zone Read` for the zone read.

## Read current state

| What | Source |
|---|---|
| Zone plan (`plan.legacy_id`: `free`, `pro`, `business`, `enterprise`) | GET `/zones/{zone_id}` |
| Apps (`dns.name`, `protocol`, `origin_direct` or `origin_dns` with `origin_port`, `traffic_type`, `ip_firewall`, `proxy_protocol`, `tls`, `edge_ips`, `argo_smart_routing`) | GET `/zones/{zone_id}/spectrum/apps?page=1&per_page=50` |
| One app | GET `/zones/{zone_id}/spectrum/apps/{app_id}` |
| IP Access Rules (what `ip_firewall: true` enforces) | GET `/zones/{zone_id}/firewall/access_rules/rules` |

MCP `execute`:

```js
async () => {
  const zone = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID" });
  const apps = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/spectrum/apps", query: { page: 1, per_page: 50 } });
  const rules = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/firewall/access_rules/rules" });
  return { plan: zone.result.plan, apps: apps.result, info: apps.result_info, rules: rules.result };
}
```

Fallback: `claudeflare get /zones/ZONE_ID/spectrum/apps --query page=1`. Spectrum returns `result_info` only when the request sends `page`, so always send `page=1` and read every page until `total_pages`.

## Checks

| finding id | condition | severity | recommended | plan tier |
|---|---|---|---|---|
| `spectrum.app.no_ip_access_rules` | An app with `ip_firewall` false (or missing) that exposes an admin protocol (SSH, RDP, a database port) or that the zone's IP Access Rules are meant to protect: anyone on the internet reaches the origin through Cloudflare. | high for SSH, RDP and database ports, else medium | Set `ip_firewall: true` and add IP Access Rules for the allowed networks | Enterprise (generic apps) |
| `spectrum.app.proxy_protocol_off` | An app with `proxy_protocol` `off` whose origin needs the client IP (logs, rate limits, allowlists on the origin): the origin sees only Cloudflare IPs. | medium | Set `proxy_protocol` to `v1` or `v2` (TCP) or `simple` (UDP) after the origin is configured to read it | Enterprise (generic apps) |
| `spectrum.app.tls_off` | A TCP app with `tls` `off` that carries plaintext the client expects to be encrypted at the edge (no TLS of its own, such as a plain TCP service published to the internet). | medium | Set `tls` to `full` or `strict` when the origin speaks TLS, or `flexible` when it does not | Enterprise (generic apps) |

Notes for findings:

- Ask the user which origins need client IPs before raising `spectrum.app.proxy_protocol_off`; turning Proxy Protocol on before the origin parses it breaks every connection. Its `fix` is a PUT of the whole app with the new `proxy_protocol`, and the risk names that the origin must accept the header first.
- `spectrum.app.no_ip_access_rules`: `fix` is a PUT of the whole app with `ip_firewall: true`. The IP Access Rules themselves are a separate zone plan; never invent the allowed IP ranges, ask the user.
- `spectrum.app.tls_off`: SSH, RDP and most game protocols encrypt end to end; do not raise this finding for them.
- Named apps on Pro and Business carry only `dns`, `protocol` and `origin_direct`; the three checks apply to Enterprise apps. On a Pro or Business zone report what the plan cannot change instead of a finding.

## Applying changes

Use the change protocol from cf-core: draft, `claudeflare preflight --file draft.json`, `claudeflare plan new --file draft.json`, user approval, `claudeflare apply <id>`. Show the plan's notes to the user before approval; they are part of what the user approves. Updates are PUT and replace the whole app: read it first and send every field that should stay.

| Op | Path | Rollback |
|---|---|---|
| App create | POST `/zones/ZONE_ID/spectrum/apps` | Delete the new app |
| App update | PUT `/zones/ZONE_ID/spectrum/apps/APP_ID` (the whole app) | PUT the old app |
| App delete | DELETE `/zones/ZONE_ID/spectrum/apps/APP_ID` with `confirm_name` = `dns.name` (the app hostname) | Re-create it with a new id |

Every rollback first re-reads the app and compares it with the state recorded after apply; a change made since then skips that inverse with `rollback_drift`.

Refused at `plan new` (`invalid_op`): a body without a `protocol` of `tcp/<port>`, `udp/<port>` or a port range such as `tcp/1000-2000` (ports 1 to 65535); a `dns` without a `name`, or a `dns.type` other than `CNAME` or `ADDRESS`; no origin (`origin_direct`, `origin_dns` with `origin_port`, or `origin_worker_id`); an unknown `proxy_protocol`, `tls`, `traffic_type` or `edge_ips.type`; a non-boolean `ip_firewall` or `argo_smart_routing`; Cloudflare-set fields (`id`, `created_on`, `modified_on`). Zone plans refuse every other write under `/zones/{zone_id}/spectrum` (PATCH, a trailing slash, an uppercase or percent-encoded segment, an extra subpath): use exactly the POST, PUT or DELETE paths above with lowercase ids. Refused at preflight (`not_entitled`): a protocol the zone plan does not allow (see Protocols per plan), or any Spectrum op on a Free zone.

### Restrict an SSH app to IP Access Rules (Enterprise)

```json
{
  "zone_id": "fedcba9876543210fedcba9876543210",
  "zone_name": "example.com",
  "summary": "Enforce IP Access Rules on ssh.example.com",
  "risk": "Clients outside the zone's allowed IP Access Rules can no longer connect to ssh.example.com:22.",
  "slug": "spectrum-ssh-ip-firewall",
  "ops": [
    {
      "method": "PUT",
      "path": "/zones/fedcba9876543210fedcba9876543210/spectrum/apps/d0000000000000000000000000000001",
      "body": {
        "dns": { "type": "CNAME", "name": "ssh.example.com" },
        "protocol": "tcp/22",
        "traffic_type": "direct",
        "origin_direct": ["tcp://192.0.2.10:22"],
        "ip_firewall": true,
        "proxy_protocol": "off",
        "tls": "off",
        "argo_smart_routing": false,
        "edge_ips": { "type": "dynamic", "connectivity": "all" }
      }
    }
  ]
}
```

### Notes on deletes

Deleting an app stops Cloudflare from proxying its protocol for its hostname. A rollback re-creates it with a new id. Unless `edge_ips.type` is `static`, the re-created app also gets new anycast IPs: clients, DNS records outside Cloudflare and firewall rules that use the old IPs must be updated. The plan note says which case applies. This IP behavior is not verified against a live account yet.

### Verification

After apply claudeflare reads each created or updated app back and compares it with the sent body. For a TCP app it also opens a TCP connection to `dns.name` on the edge port from the apply machine, retried within the verification timeout. The connect is skipped, with a note and without failing, for UDP apps, port ranges and an app without `dns.name`. To test another host or port, add `"verify": { "expect": "tcp_open", "url": "https://ssh.example.com:2222" }` to the op (`verify.url` must be an http or https URL; only its host and port are used). A failed check sets `applied_verify_failed` and drafts a rollback plan that still needs approval.

## Traps

- PUT replaces the whole app: a field left out of the body returns to its default (for example `ip_firewall` false or `edge_ips` dynamic).
- Proxy Protocol on an origin that does not parse it breaks every connection; configure the origin first.
- `ip_firewall: true` without IP Access Rules allowing the clients blocks nobody; with a block-all rule it blocks everyone, including the user.
- Re-creating an app gives it a new id and, unless `edge_ips` is static, new IPs.
- A port range at the edge must have the same number of ports as `origin_port` or the `origin_direct` range.
- A Spectrum app owns its DNS record (`dns.name`); a DNS record of the same name in the zone conflicts with it.

## Sources

- Spectrum apps API: developers.cloudflare.com/api/resources/spectrum/subresources/apps/
- Protocols per plan: developers.cloudflare.com/spectrum/protocols-per-plan/
- Configuration options: developers.cloudflare.com/spectrum/reference/configuration-options/
- Proxy Protocol: developers.cloudflare.com/spectrum/getting-started/proxy-protocol/
