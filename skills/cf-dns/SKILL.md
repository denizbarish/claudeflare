---
name: cf-dns
description: Cloudflare DNS checklist for one zone. Proxy status and origin IP exposure, DNSSEC, CAA records, dangling CNAMEs and mail hosts behind the proxy. Load it when auditing DNS, changing or adding DNS records, toggling proxy status, or enabling DNSSEC. Load cf-core first.
---

# cf-dns: records, proxy status, DNSSEC, CAA

Load `cf-core` first. Findings use the `cf-audit` finding format and severity scale. In the MCP examples below, replace `ZONE_ID` with the real zone id (32 hex characters) from cf-core discovery; the guard needs literal paths.

## Read current state

| What | GET path |
|---|---|
| All records (page through with `page`; keep `per_page` small, results truncate at about 6k tokens) | `/zones/{zone_id}/dns_records` with `per_page: 100` |
| Records of one type | `/zones/{zone_id}/dns_records` with `type: "CAA"` (or `MX`, `CNAME`) |
| DNSSEC status | `/zones/{zone_id}/dnssec` |
| Edge certificates and the hostnames they cover (`hosts` per pack) | `/zones/{zone_id}/ssl/certificate_packs` |

Each record has `id`, `type`, `name`, `content`, `proxied`, `proxiable`, `ttl`. CAA records carry `data: { flags, tag, value }`. DNSSEC `status` is one of `active`, `pending`, `disabled`, `pending-disabled`, `error`.

MCP `execute`:

```js
async () => {
  const records = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/dns_records", query: { per_page: 100 } });
  const dnssec = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/dnssec" });
  return { records: records.result, dnssec: dnssec.result };
}
```

Fallback: `claudeflare get /zones/ZONE_ID/dns_records --query per_page=100` and `claudeflare get /zones/ZONE_ID/dnssec`.

Live checks (read-only): `curl -sI https://<record name>/` for a proxied host (a `cf-ray` header proves the proxy), and `curl -sI https://<cname target>/` for a DNS-only CNAME target (curl exit code 6, "Could not resolve host", means the target does not resolve).

## Checks

| finding id | condition | severity | recommended | plan tier |
|---|---|---|---|---|
| `dns.proxy.origin_exposed` | An A, AAAA or CNAME record that serves web traffic (apex, `www`, app and API hosts) has `proxied: false` while `proxiable: true`. Skip records that must stay DNS-only: mail hosts, `_domainkey` and other verification CNAMEs, SaaS targets that require DNS-only, non-HTTP services (SSH, game, VPN). Prerequisite: an edge certificate covers the host (see notes). | high | `proxied: true` | free |
| `dns.dnssec.off` | `status` is `disabled`, or `pending` (DS record never added at the registrar). | medium | `active`, with the DS record at the registrar | free |
| `dns.caa.missing` | No CAA record at the zone apex. | low | CAA `issue` records for every CA the user needs (for example the CA of the origin certificate) | free |
| `dns.records.dangling` | A CNAME points at a target that no longer resolves: DNS-only target fails with curl exit code 6, or the proxied host answers HTTP 530 (Cloudflare error 1016, origin DNS error, in the body). Typical for deleted cloud or SaaS resources; this is a subdomain takeover risk. | high | Delete the record, or point it at a live target | free |
| `dns.mx.proxied` | MX records cannot be proxied, but the A, AAAA or CNAME record of an MX target host inside this zone is proxied. Cloudflare proxies only HTTP and HTTPS, so mail to that host fails. | critical | Target host record `proxied: false` | free |

Notes for findings:

- `dns.proxy.origin_exposed`: if the same origin IP also appears in a DNS-only record (for example `mail` or `ftp` on the web server), proxying the web host does not hide the IP. Say so in `reason` and recommend moving that service or rotating the origin IP.
- `dns.proxy.origin_exposed` prerequisite: the hostname must be covered by an edge certificate, or HTTPS breaks as soon as it is proxied. In a full setup zone, Universal SSL covers only the apex and first-level subdomains (`www.example.com`), not deeper ones (`api.v2.example.com`). Check the `hosts` of the certificate packs (a wildcard `*.example.com` covers one level only). For a deeper host with no covering certificate, keep the finding but set `fix: []` and tell the user to add a certificate first: Advanced Certificate Manager (with Total TLS for all proxied subdomains), an advanced certificate listing the host, or a custom certificate with the host as SAN. Then plan the proxy change. In a CNAME (partial) setup zone every proxied subdomain gets its own Universal certificate.
- `dns.dnssec.off` with `pending`: the fix is a registrar step only; use `fix: []` and give the DS record values from the DNSSEC read.
- `dns.caa.missing`: when Universal SSL is active and any CAA record exists, Cloudflare automatically adds CAA records for its own CAs (not shown in the dashboard). Advanced certificates get no automatic CAA records, so add their CA explicitly.

## Applying changes

Use the change protocol from cf-core. Ops below use `{zone_id}`; replace `RECORD_ID` with the record `id` from the read.

Proxy a web record (reversible, `dns_update`):

```json
{ "method": "PATCH", "path": "/zones/{zone_id}/dns_records/RECORD_ID", "body": { "proxied": true } }
```

Turn off the proxy on a mail target host (reversible, `dns_update`):

```json
{ "method": "PATCH", "path": "/zones/{zone_id}/dns_records/RECORD_ID", "body": { "proxied": false } }
```

Add CAA records (reversible, `dns_create`; one op per record, `ttl: 1` means automatic):

```json
{ "method": "POST", "path": "/zones/{zone_id}/dns_records", "body": { "type": "CAA", "name": "example.com", "ttl": 1, "data": { "flags": 0, "tag": "issue", "value": "letsencrypt.org" } } }
```

Delete a dangling record (reversible, `dns_delete`; the snapshot keeps the old record):

```json
{ "method": "DELETE", "path": "/zones/{zone_id}/dns_records/RECORD_ID" }
```

Enable DNSSEC (not reversible through `claudeflare rollback`; the risk note says so):

```json
{ "method": "PATCH", "path": "/zones/{zone_id}/dnssec", "body": { "status": "active" } }
```

After apply, read `/zones/{zone_id}/dnssec` again and give the user the DS record fields (`algorithm`, `digest_type`, `digest`, `key_tag`, or the full `ds` string) to add at their registrar. Cloudflare adds the DS record itself only for Cloudflare Registrar domains and some TLDs (`.ch`, `.cz`).

Plan limits: one plan may not touch the same DNS record twice. Several different records in one plan are fine.

## Traps

- Proxying a record that serves non-HTTP traffic (SSH, SMTP, IMAP, custom TCP ports) breaks that service. Check what the host serves before proxying.
- Proxying a second-level subdomain (for example `api.v2.example.com`) in a full setup zone with only Universal SSL breaks HTTPS for it: Universal SSL covers the apex and first-level subdomains only. Confirm certificate coverage in `/ssl/certificate_packs` before planning the change.
- Proxying an origin that was DNS-only for a long time does not hide its IP; it is in historical DNS data. Recommend restricting the origin firewall to Cloudflare IP ranges (origin-side step for the user) and, if attacks target the origin directly, rotating the origin IP.
- Turning the proxy off on a mail host exposes that IP. Keep mail on a different IP than the web origin.
- Proxied records always have TTL Auto (300 seconds), which cannot be changed; do not plan TTL edits on proxied records.
- Some CNAMEs must stay DNS-only: DKIM, domain verification, and SaaS platforms that terminate TLS themselves. Cloudflare may block proxying some of them.
- DNSSEC: if a DS record from a previous DNS provider is still at the registrar, the zone breaks when the nameservers change. Before turning DNSSEC off, remove the DS record at the registrar first and wait for its TTL to expire; disabling it with the DS record still present makes the domain unresolvable for validating resolvers.
- A CAA record that omits a CA you still use stops that CA from issuing or renewing certificates (for example the origin certificate). Ask the user which CAs they use before adding CAA.
- Deleting a dangling CNAME is the safe fix; repointing it at a new cloud resource name that someone else can claim recreates the takeover risk.

## Sources

- https://developers.cloudflare.com/dns/proxy-status/
- https://developers.cloudflare.com/dns/manage-dns-records/troubleshooting/exposed-ip-address/
- https://developers.cloudflare.com/dns/dnssec/
- https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/
- https://developers.cloudflare.com/api/resources/ssl/subresources/certificate_packs/methods/list/
- https://developers.cloudflare.com/ssl/edge-certificates/caa-records/
- https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/
- https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/
- https://developers.cloudflare.com/api/resources/dns/subresources/dnssec/methods/get/
