# Access 403: "You don't have permission"

Symptom: after login, Access shows "That account does not have access" or "You don't have permission to view this app", or the app answers 403 with an Access page. A 403 with "Sorry, you have been blocked" comes from the WAF instead: use `cf-troubleshoot` ([waf-false-positive](../../cf-troubleshoot/trees/waf-false-positive.md)).

## Evidence

1. Who and where: the user's email, the exact URL, the identity provider they chose, and whether WARP was on.
2. The Access request log (SKILL.md, Shared evidence) for that user: `allowed`, `app_domain`, `app_uid` and `connection`. No entry means the login never completed (see access-redirect-loop or the identity provider).
3. The app and every policy it uses:
   ```js
   async () => {
     const app = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/access/apps/APP_ID" });
     const policies = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/access/policies" });
     const groups = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/access/groups" });
     return { app: app.result, policies: policies.result, groups: groups.result };
   }
   ```
   For each policy note `decision`, `precedence`, `include`, `exclude` and `require` (email, email domain, group, identity provider group, country, device posture, service token).
4. If a policy requires device posture: the posture rules (GET `/accounts/ACCOUNT_ID/devices/posture`) and the user's `warp-cli status`.

## Hypotheses

1. **No allow policy includes the user.** Confirm: the user's email or domain matches no `include` of an `allow` policy (for example `email_domain` is `example.com` and the user signs in as `user@example.org`, or the group lists other addresses). Reject: an allow policy includes them.
2. **A `require` rule fails.** Confirm: the including policy also requires a country, an identity provider group, an authentication method (MFA) or device posture the user does not meet; the log shows `allowed: false` with the expected identity. Reject: the user meets every `require`.
3. **A deny policy or an `exclude` matches first.** Confirm: a `deny` policy with lower `precedence` includes the user, or the allow policy's `exclude` matches them. Reject: no deny or exclude matches.
4. **The wrong identity provider.** Confirm: `allowed_idps` lists one identity provider and the user signed in with another (the log's `connection`), or the identity provider does not send the group claim the policy checks. Reject: the identity provider matches and sends the claim.
5. **Device posture missing.** Confirm: a policy requires a posture rule (WARP connected, Gateway, OS version) and the user is off WARP or enrolled under another organization. Reject: `warp-cli status` connected to this team and posture rules pass.
6. **A stale session.** Confirm: the policy changed after the user's login and their token still carries the old identity; a new login in a private window works. Reject: a new login fails too.

## Fix

- Hypotheses 1 to 4: an account plan PUT of the policy (reusable policies at `/accounts/ACCOUNT_ID/access/policies/POLICY_ID`, app-scoped ones under the app) with the corrected `include`, `require` or `exclude`, or of the app with the right `allowed_idps` (cf-access, Applying changes). Read the whole resource first; Access has no PATCH. A deny policy that includes everyone or an app left without a working allow policy gets a `Lockout risk:` line at `plan new`.
- Hypothesis 5: the user installs or connects WARP and enrolls in the team (cf-devices); or the posture requirement moves to a separate policy for the devices that can meet it.
- Hypothesis 6: the user signs out at `https://<team>.cloudflareaccess.com/cdn-cgi/access/logout` and logs in again. Revoking sessions for everyone is not an op; give dashboard steps only if the user asks.
- Verify: the Access request log shows `allowed: true` for the user after the fix; a policy update re-reads every app that uses it after apply.

## Sources

- https://developers.cloudflare.com/cloudflare-one/policies/access/
- https://developers.cloudflare.com/cloudflare-one/troubleshooting/access/
- https://developers.cloudflare.com/cloudflare-one/insights/logs/audit-logs/
- https://developers.cloudflare.com/cloudflare-one/identity/devices/
