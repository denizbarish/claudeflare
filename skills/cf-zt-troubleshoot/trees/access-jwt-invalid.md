# Invalid Access JWT at the origin

Symptom: users pass Access, but the origin rejects the request (401 or 403 from the app, "invalid token", "audience mismatch", "unable to verify signature"). The origin validates the `Cf-Access-Jwt-Assertion` header (or the `CF_Authorization` cookie) against the team's public keys and the app's AUD.

## Evidence

1. The app's AUD and the team domain:
   ```js
   async () => {
     const org = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/access/organizations" });
     const app = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/access/apps/APP_ID" });
     return { auth_domain: org.result.auth_domain, aud: app.result.aud, domain: app.result.domain, created_at: app.result.created_at };
   }
   ```
2. Ask the user for the origin's Access settings (never the token or the cookie value): the AUD it expects, the issuer and the certs URL (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), and how it reads the token (header or cookie). The error text from the origin log helps: audience, signature, expiry or missing token.
3. The audit log (SKILL.md, Shared evidence) for Access app deletes and creates: a re-created app has a new id and a new AUD.
4. Whether requests can reach the origin without Access: another hostname, a direct IP, a tunnel ingress rule for a hostname that has no app.

## Hypotheses

1. **The app was re-created, so the AUD changed.** Confirm: the AUD from the read differs from the one in the origin config, and the audit log shows a delete and create (or a claudeflare rollback that re-created the app). Reject: the AUDs match.
2. **Wrong team domain or certs URL.** Confirm: the origin fetches keys from another team domain, an old `auth_domain` after a rename, or the zone hostname instead of `<team>.cloudflareaccess.com`. Reject: issuer and certs URL use the current `auth_domain`.
3. **Cached signing keys.** Confirm: Access rotates its signing keys; the origin cached the certs once and never refreshes, and the failures started at a rotation while nothing else changed. Reject: the origin refreshes keys per `kid`.
4. **The token is missing.** Confirm: the failing requests reach the origin without passing Access (a hostname or path no app covers, a `bypass` policy, direct origin access), so no header is set; or the client calls an API that reads the cookie while only the header is sent. Reject: every failing request carries the header (origin log).
5. **Clock skew or expiry.** Confirm: the origin's clock is off by minutes, or long-running clients reuse a token past the app's `session_duration`. Reject: the origin clock is in sync and the token is fresh.

## Fix

- Hypothesis 1: the user updates the AUD in the origin config to the new value from the read. Do not re-create the app again: that changes the AUD once more. Tell the user that any later app delete and rollback re-creates it with yet another AUD.
- Hypothesis 2: the user points the origin at `https://<auth_domain>/cdn-cgi/access/certs` and the matching issuer.
- Hypothesis 3: the user makes the validator refresh keys when it sees an unknown `kid` (most Access JWT libraries do this).
- Hypothesis 4: cover the hostname or path with an Access app (cf-access, account plan), remove the `bypass` policy, or close the direct path (Tunnel, or an origin firewall that allows only Cloudflare). Origin steps are for the user.
- Hypothesis 5: the user syncs the origin clock (NTP) and lets clients log in again.
- Verify: the origin accepts a request made through Access in a fresh browser session; its log shows a valid token.

## Sources

- https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
- https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/application-token/
- https://developers.cloudflare.com/cloudflare-one/troubleshooting/access/
