# Tunnel error 1016: Origin DNS error

Symptom: a tunnel hostname answers HTTP 530 with error 1016. Cloudflare could not resolve the origin: the hostname's CNAME points at `<uuid>.cfargotunnel.com` for a tunnel that does not exist in this account (deleted, re-created with a new id, or another account's).

## Evidence

1. Confirm the error and the record:
   ```
   curl -s https://app.example.com/ | grep -o "Error 1016"
   ```
   ```js
   async () => {
     const records = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/dns_records", query: { name: "app.example.com" } });
     const tunnels = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/cfd_tunnel", query: { is_deleted: false } });
     return { records: records.result, tunnels: tunnels.result };
   }
   ```
   Take the UUID from the CNAME `content` and look for it among the live tunnels.
2. If it is not there, read deleted tunnels: GET `/accounts/ACCOUNT_ID/cfd_tunnel` with `query: { is_deleted: true }`. A match with `deleted_at` set names when it went away.
3. The audit log around the start time (SKILL.md, Shared evidence): a tunnel delete, a tunnel create with a new id, or a DNS record change.
4. If the hostname is not a CNAME at all: an A or AAAA record pointing at an address that does not resolve or a CNAME to a hostname that does not exist gives 1016 too ([1xxx](../../cf-troubleshoot/trees/1xxx.md)).

## Hypotheses

1. **The tunnel was deleted.** Confirm: the UUID matches a tunnel with `deleted_at` set, or none at all, and the audit log shows the delete. Reject: a live tunnel has the UUID.
2. **The tunnel was re-created.** Confirm: a live tunnel with the same `name` exists under a new id (newer `created_at`), and the connectors run with the new token. Reject: no tunnel replaced it.
3. **The CNAME points at another account's tunnel.** Confirm: the UUID is not in this account at all (live or deleted), and the user ran `cloudflared tunnel route dns` from another account or copied the record. Reject: the UUID belongs to this account.
4. **A typo in the record.** Confirm: the content differs from a live tunnel id by a few characters, or lacks the `.cfargotunnel.com` suffix. Reject: the content is an exact live id.

## Fix

- Hypotheses 1 to 4: a zone plan that repoints the CNAME at the live tunnel or deletes the stale record (cf-dns, finding `tunnel.dns.stale_cname` in cf-tunnel):
  ```json
  { "method": "PATCH", "path": "/zones/{zone_id}/dns_records/RECORD_ID", "body": { "content": "11111111-2222-4333-8444-555555555551.cfargotunnel.com" } }
  ```
- If the hostname must move to a live tunnel, check that the tunnel's ingress config has a rule for it first; otherwise the next error is a 404 from the catch-all. A config PUT is an account plan (cf-tunnel); `plan new` shows a `Lockout risk:` line for a CNAME hostname without a rule.
- If the deleted tunnel should come back: create a tunnel (new UUID and token, every connector reinstalled with `claudeflare tunnel-token`), then repoint the CNAMEs.
- Verify: `curl -sI https://app.example.com/` returns the app's status with `cf-ray` and no 530; a config PUT can carry `"verify": { "expect": "tunnel_serving", "url": "https://app.example.com/" }`.

## Sources

- https://developers.cloudflare.com/cloudflare-one/troubleshooting/tunnel/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/routing-to-tunnel/dns/
- https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1016/
