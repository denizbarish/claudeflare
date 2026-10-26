# Access redirect loop

Symptom: the browser bounces between the app hostname, `<team>.cloudflareaccess.com` and often the identity provider until it shows `ERR_TOO_MANY_REDIRECTS` ("page isn't redirecting properly"). The login may even succeed once and then start over.

## Evidence

1. Follow the redirects without a session and look at each hop:
   ```
   curl -sIL --max-redirs 10 https://wiki.example.com/ | grep -iE "^(HTTP|location)"
   ```
   A loop shows the same two or three `location` values repeating. Note which hosts take part: the app, the team domain, the identity provider's login host.
2. Access state:
   ```js
   async () => {
     const org = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/access/organizations" });
     const apps = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/access/apps" });
     const idps = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/access/identity_providers" });
     return { org: org.result, apps: apps.result, idps: idps.result };
   }
   ```
   Record `auth_domain`, every app whose `domain`, `self_hosted_domains` or public `destinations` cover the looping hosts (wildcards included), each app's `allowed_idps`, `auto_redirect_to_identity`, `same_site_cookie_attribute`, `enable_binding_cookie`, and each identity provider's login host (`config.okta_account`, `config.auth_url`, `config.sso_target_url`).
3. The Access request log (SKILL.md, Shared evidence) for the user and window: repeated `login` entries with `allowed: true` mean the session is granted but not kept.
4. Zone side for the app hostname: SSL mode and redirect rules (`cf-troubleshoot`, [redirect-loop](../../cf-troubleshoot/trees/redirect-loop.md)), because an HTTPS loop at the origin looks the same in the browser.

## Hypotheses

1. **An Access app covers the identity provider's login host or the team domain.** The login page itself is behind Access, so every login attempt is sent back to login. Confirm: an app domain or wildcard (`*.example.com`) matches the host of an identity provider (for example `sso.example.com`) or `auth_domain`. Reject: no app domain matches those hosts. This is the lockout case 2 in cf-access.
2. **The session cookie is not kept.** Confirm: the log shows `allowed: true` again and again for the same user; the app sets `same_site_cookie_attribute: "strict"` while the identity provider posts back cross-site, or `enable_binding_cookie: true` with a client that drops cookies; the browser blocks third-party cookies for `cloudflareaccess.com` in an embedded frame. Reject: one `allowed: true` entry, then normal requests.
3. **The origin redirects to another hostname or scheme.** Confirm: after login, a hop leaves the app hostname (for example to `www.` or `http://`) that is a different Access app or not covered by the session; or the zone SSL mode is Flexible and the origin forces HTTPS. Reject: every hop after login stays on the same `https://` hostname.
4. **Two Access apps cover the same path with different identity providers or policies.** Confirm: a hostname app and a path app (`wiki.example.com` and `wiki.example.com/admin`) or a wildcard and an exact app overlap, and the loop starts on the path. Reject: one app per path.
5. **The identity provider rejects and returns to Access.** Confirm: the identity provider shows an error page in the hops (redirect URI mismatch, the `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback` URL missing in the identity provider app), or the user's identity provider session is in a loop of its own. Reject: the identity provider returns to the callback with a code.

## Fix

- Hypothesis 1: narrow the app domain so it no longer covers the identity provider or team host, as an account plan PUT of the app with the whole app body (cf-access, Applying changes). `claudeflare plan new` shows a `Lockout risk:` line while a domain still covers a login host; a plan without that line confirms the fix. If the identity provider must stay behind Cloudflare, put it on a hostname outside every app domain.
- Hypothesis 2: PUT the app with `same_site_cookie_attribute: "lax"` (or `none` for embedded use) or `enable_binding_cookie: false` (cf-access). Browser cookie settings are steps for the user.
- Hypothesis 3: fix the redirect at its source: zone SSL mode or a redirect rule through a zone plan (cf-ssl, cf-rules), or the origin's canonical host setting as steps for the user. Include the redirect target hostname in the same app when it must be protected.
- Hypothesis 4: merge the apps or give the path app the same `allowed_idps` and a compatible policy (account plan).
- Hypothesis 5: the user adds the callback URL from the identity provider page in the Zero Trust dashboard to the identity provider app.
- Verify: `curl -sIL --max-redirs 10 https://wiki.example.com/` ends at the login page without repeating, and the user logs in once in a private window. An app PUT can carry `"verify": { "expect": "access_login", "url": "https://wiki.example.com/" }`.

## Sources

- https://developers.cloudflare.com/cloudflare-one/troubleshooting/access/
- https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/
- https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/
- https://developers.cloudflare.com/cloudflare-one/identity/idp-integration/
