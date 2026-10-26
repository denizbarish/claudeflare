---
name: cf-access
description: Cloudflare Access checklist for one account. Self-hosted and SaaS applications, reusable and app-scoped policies, groups, identity providers and their client secrets, service tokens and the Zero Trust organization. Load it when putting a site behind Access, auditing Access, changing a policy or identity provider, or creating a service token. Load cf-core first.
---

# cf-access: applications, policies, identity providers, service tokens

Load `cf-core` first. Findings use the `cf-audit` finding format and severity scale. Access lives on the account: plans use `"scope": "account"`, hold only REST ops (no `project_dir` needed) and use `/accounts/{account_id}/access/...`. The zone form `/zones/{zone_id}/access/...` is refused. In the MCP examples below, replace `ACCOUNT_ID` (32 hex characters), `APP_ID`, `POLICY_ID`, `GROUP_ID`, `IDP_ID` and `TOKEN_ID` (UUIDs) with real values from cf-core discovery and the reads; the guard needs literal paths.

Access needs a Zero Trust organization. The API cannot create one: if GET `/accounts/{account_id}/access/organizations` fails, preflight reports `not_entitled` and the user creates the organization in the Zero Trust dashboard (the Free plan is enough).

## Read current state

| What | Source |
|---|---|
| Organization (`auth_domain` is the team domain `<team>.cloudflareaccess.com`, `session_duration`) | GET `/accounts/{account_id}/access/organizations` |
| Applications (`type`, `domain`, `self_hosted_domains`, `destinations`, `allowed_idps`, `session_duration`, `policies`, `aud`) | GET `/accounts/{account_id}/access/apps` |
| Reusable policies (`decision`, `include`, `exclude`, `require`, `session_duration`, `app_count`) | GET `/accounts/{account_id}/access/policies` |
| App-scoped (legacy) policies of one app | GET `/accounts/{account_id}/access/apps/{app_id}/policies` |
| Groups | GET `/accounts/{account_id}/access/groups` |
| Identity providers (`type`, `config` without secrets) | GET `/accounts/{account_id}/access/identity_providers` |
| Service tokens (`name`, `client_id`, `duration`, `expires_at`, `last_seen_at`) | GET `/accounts/{account_id}/access/service_tokens` |

Policy decisions: `allow`, `deny`, `bypass` (no login at all), `non_identity` (service tokens and other non-user rules). Rules in `include` are OR, rules in `require` are AND, `exclude` wins over both. A group is a named rule set that policies reference as `{ "group": { "id": "..." } }`; a service token is referenced as `{ "service_token": { "token_id": "..." } }`.

MCP `execute`:

```js
async () => {
  const org = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/access/organizations" });
  const apps = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/access/apps", query: { per_page: 100 } });
  const policies = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/access/policies", query: { per_page: 100 } });
  const idps = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/access/identity_providers" });
  return { team: org.result.auth_domain, apps: apps.result, policies: policies.result, idps: idps.result };
}
```

Fallback: `claudeflare get /accounts/ACCOUNT_ID/access/apps`. Lists page with `page` and `per_page`; read every page before concluding that a policy, group or token is unused.

Never print an identity provider's `config.client_secret` or a service token's `client_secret`. The API returns a service token secret only once, on create; claudeflare writes it to a 0600 file and the guard blocks reads of that file.

## Checks

| finding id | condition | severity | recommended | plan tier |
|---|---|---|---|---|
| `access.policy.everyone_allow` | An `allow` policy used by an app has an `include` rule `{ "everyone": {} }` and no `require`. Anyone who can sign in to any configured identity provider (including one-time PIN) gets in. | high | Include an email domain, a group or an identity provider group; add `require` rules for sensitive apps | free |
| `access.app.no_mfa` | A self-hosted app protecting an admin or internal tool has no policy with a `require` rule for MFA (`auth_method` `mfa`) and its identity providers do not enforce MFA themselves. | medium | A `require` rule `{ "auth_method": { "auth_method": "mfa" } }`, or MFA enforced in the identity provider | free |
| `access.session.long` | An app's `session_duration` (or the organization's when the app has none) is longer than `24h`. A stolen cookie stays valid that long. | low | `24h` or shorter; shorter for admin tools | free |
| `access.service_token.expiring` | A service token's `expires_at` is less than 30 days away (or past). Clients that send it start getting 403. | medium | Create a new token, update the clients, then delete the old one | free |
| `access.group.unused` | A group is referenced by no reusable policy and no app-scoped policy. | low | Delete it, or use it in a policy | free |
| `access.idp.single_login_method` | The organization has exactly one identity provider, or an app's `allowed_idps` lists only one. If that provider fails, nobody can sign in. | medium | A second login method (for example one-time PIN for a break-glass group) | free |

Notes for findings:

- `access.policy.everyone_allow`: `fix` is a PUT of the policy with a narrower `include` (Applying changes). Ask who should get in first; do not guess an email domain.
- `access.app.no_mfa`: `fix` adds a `require` rule to the app's allow policy. Confirm the identity provider supports MFA, or users are locked out.
- `access.session.long`: `fix` is a PUT of the app with `session_duration` changed and every other field kept.
- `access.service_token.expiring`: `fix: []` until the user has a new token in place; then a delete plan for the old one.
- `access.group.unused`: `fix` is a DELETE of the group with `confirm_name`.
- `access.idp.single_login_method`: `fix: []`; adding an identity provider needs credentials from the user (Applying changes).

## Applying changes

Use the change protocol from cf-core: draft, `claudeflare preflight --file draft.json`, `claudeflare plan new --file draft.json`, user approval, `claudeflare apply <id>`. Show the plan's `Lockout risk:` lines and notes to the user before approval; they are part of what the user approves. Access has no PATCH: every update is a full PUT, so read the resource first and send every field that should stay.

| Op | Path (under `/accounts/ACCOUNT_ID`) | Rollback |
|---|---|---|
| App create, update, delete | POST `/access/apps`, PUT or DELETE `/access/apps/APP_ID` (delete takes `confirm_name` = `name`) | Delete, restore without SCIM secrets (not reversible when the update sends one), re-create (new id and new AUD, no SCIM secrets) |
| Reusable policy create, update, delete | POST `/access/policies`, PUT or DELETE `/access/policies/POLICY_ID` (`confirm_name` = `name`) | Delete, restore, re-create (new id) |
| App-scoped policy update, delete | PUT or DELETE `/access/apps/APP_ID/policies/POLICY_ID` (`confirm_name` = `name`) | Restore, re-create (new id) |
| Group create, update, delete | POST `/access/groups`, PUT or DELETE `/access/groups/GROUP_ID` (`confirm_name` = `name`) | Delete, restore, re-create (new id) |
| Identity provider create, update, delete | POST `/access/identity_providers`, PUT or DELETE `/access/identity_providers/IDP_ID` (`confirm_name` = `name`) | Delete; restore without secrets (not reversible when the update sends a secret); not reversible |
| Service token create, update, delete | POST `/access/service_tokens`, PUT or DELETE `/access/service_tokens/TOKEN_ID` (`confirm_name` = `name`) | Delete, restore, not reversible |
| Organization update | PUT `/access/organizations` with the whole organization (`name`, `auth_domain`, ...) | Restores the previous organization |

Refused at `plan new` (`invalid_op`): a literal `config.client_secret` in an identity provider body (map it with `secret_fields_from_env`), a `*` path in `secret_fields_from_env` (name one field), `client_id`, `client_secret` or `client_secret_version` in a service token body (rotation is not an op), `saas_app.client_secret` in an app body, a self-hosted app without `domain`, a policy without `name`, a valid `decision` or an `include` array, an organization PUT without `name` and `auth_domain`. Refused at preflight (`resource_in_use`): a reusable policy delete while an app uses it, a group delete while a policy references it, a service token delete while a policy includes it, unless an earlier op in the same plan removes the use. An app-scoped policy op and an update or delete of the same app never share a plan (`plan_conflict`). Not available as ops: `revoke_tokens`, `revoke_user`, service token `refresh` and `rotate`, Dashboard SSO.

### Put a site behind Access (the usual request)

The site must already be proxied through Cloudflare. One account plan with a reusable policy and the app that uses it, or the app alone when a fitting policy exists:

```json
{
  "scope": "account",
  "account_id": "0123456789abcdef0123456789abcdef",
  "account_name": "Acme",
  "summary": "Put wiki.example.com behind Access",
  "risk": "Only example.com accounts can open the wiki after login.",
  "slug": "access-wiki",
  "ops": [
    {
      "method": "POST",
      "path": "/accounts/0123456789abcdef0123456789abcdef/access/apps",
      "body": {
        "name": "wiki",
        "type": "self_hosted",
        "domain": "wiki.example.com",
        "session_duration": "24h",
        "policies": ["bbbbbbbb-0000-4000-8000-000000000001"]
      },
      "verify": { "expect": "access_login", "url": "https://wiki.example.com/" }
    }
  ]
}
```

A new reusable policy goes in its own earlier plan (its id is known only after apply):

```json
{ "method": "POST", "path": "/accounts/0123456789abcdef0123456789abcdef/access/policies", "body": { "name": "Employees", "decision": "allow", "include": [{ "email_domain": { "domain": "example.com" } }] } }
```

### Add an identity provider

The client secret comes from the user's environment, never from the chat or the plan file. Ask the user to export it in the shell that runs `claudeflare apply` (for example `export GITHUB_CLIENT_SECRET=...` in their own terminal), then:

```json
{
  "method": "POST",
  "path": "/accounts/0123456789abcdef0123456789abcdef/access/identity_providers",
  "body": { "name": "GitHub", "type": "github", "config": { "client_id": "<client id>" } },
  "secret_fields_from_env": { "config.client_secret": "GITHUB_CLIENT_SECRET" }
}
```

Apply reads the variable, sends it and stores it nowhere; results show `[redacted]`. An update that sends a new secret is not reversible. An update without `secret_fields_from_env` leaves the secret out of the body.

### Create a service token

```json
{ "method": "POST", "path": "/accounts/0123456789abcdef0123456789abcdef/access/service_tokens", "body": { "name": "deploy-bot", "duration": "8760h" } }
```

The secret is shown only once. Apply writes `{ "client_id", "client_secret" }` to `.claudeflare/secrets/<plan id>-<op index>.json` (mode 0600, ignored by git) and prints only the path; results hold `[redacted]`. Tell the user to move the values into their secret store in their own terminal; never open, print or copy the file. Then reference the token in a `non_identity` policy: `{ "service_token": { "token_id": "<id>" } }`.

### Lockout risk lines

These never refuse a plan; they are shown at `plan new` and checked again at apply (a new line stops apply with `risk_changed`):

1. An app loses its last `allow` policy with a non-empty `include`, or gets a `deny` policy whose `include` is empty or `everyone`.
2. An app domain covers an identity provider's login host or the team domain.
3. Deleting or changing the only identity provider allowed by an app (`allowed_idps`) or the organization's only login method; an app limited to identity providers that are not configured.
4. Removing the allow policy of the Zero Trust dashboard app (`dash_sso`, Dashboard SSO).

When one appears, keep this terminal open: the API token still works when the dashboard login does not, so `claudeflare rollback` can restore access.

### Verification

After apply claudeflare reads each changed resource back (app policies compared by id), and for a self-hosted app with a public `domain` sends an unauthenticated GET to `https://<host>/` for each public hostname (`domain`, `self_hosted_domains`, public `destinations`) that must answer 302 to the team domain `<team>.cloudflareaccess.com` (a wildcard domain shows `skipped: wildcard domain`). A policy update re-reads every app using it. A failed check sets `applied_verify_failed` and drafts a rollback plan that still needs approval.

## Traps

- Deleting an app removes protection from its domains at once. Re-creating it gives a new id and a new AUD; origins that validate the `Cf-Access-Jwt-Assertion` JWT must get the new AUD. App-scoped policies are deleted with the app.
- Removing an app-scoped policy from an app's `policies` list deletes that policy.
- `bypass` skips login entirely; it is not a softer `allow`.
- An identity provider placed behind an Access app on its own login host loops forever. Keep the team domain and every identity provider host out of app domains.
- `allowed_idps` empty means every identity provider of the organization; one entry means only that one.
- Changing `auth_domain` ends every session and breaks login links and bookmarks to the old team domain.
- Service token secrets cannot be read again; a lost secret means a new token.

## Sources

- Access applications API: developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/
- Access policies: developers.cloudflare.com/cloudflare-one/policies/access/
- Identity providers API: developers.cloudflare.com/api/resources/zero_trust/subresources/identity_providers/
- Service tokens: developers.cloudflare.com/cloudflare-one/identity/service-tokens/
- Application token and AUD validation: developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
