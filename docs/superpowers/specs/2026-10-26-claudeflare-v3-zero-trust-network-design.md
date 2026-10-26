# claudeflare v3 (0.3.0): Zero Trust and Network Design Spec

- Date: 2026-10-26
- Status: Draft, awaiting review
- Builds on: `2026-10-24-claudeflare-design.md` (v1) and `2026-10-25-claudeflare-v2-devplatform-design.md` (v2). Everything in v1 and v2 stays binding unless this spec changes it.

## 1. Intent

claudeflare is a public, open-source plugin. v3 is built for the people who will install it, not for the owner's own setup. Teams that put internal tools behind Cloudflare Access, expose services through Tunnel, filter traffic with Gateway, roll out WARP, or run Load Balancing and Spectrum should get the same senior-engineer help they already get for zones and Workers: a scored audit, a diagnosis that reaches a root cause, and changes made through plan, approval, apply and rollback.

These products have the largest blast radius claudeflare has touched so far. A wrong Access policy, Gateway rule or WARP setting can lock every user, including the admin, out of their tools. The design therefore puts product knowledge (what a change can break, how to undo it, how to check it worked) next to a shared, small write engine.

### Owner decisions (from the brainstorm)

1. **Audience:** a general product that is useful to many people, not tuned to the owner's scenario.
2. **Same depth for all six products:** Access, Tunnel, Gateway, WARP (devices), Load Balancing, Spectrum. Each gets audit, diagnosis, change and rollback.
3. **Lockout risk is warned, not refused.** A change that can lock users or admins out gets an explicit lockout line in the plan risk. The plan is still created; the decision stays with the user at approval. No extra override flag.
4. **Steps outside the Cloudflare API** (installing `cloudflared`, deploying WARP to devices): explained step by step by default. When the user asks, the agent writes the files (Compose service, systemd unit, MDM file) into their project.
5. **Post-change verification reports, it does not roll back automatically.** A failed verification is reported with a ready rollback plan; the user decides whether to approve it. v2's automatic rollback for Worker deploys (`on_failed_check: "rollback"`) stays as it is.
6. **Approach C (hybrid):** one shared REST engine plus a small rule module per product (section 4).

### Success criteria

1. `/claudeflare:audit` covers six new domains (`access`, `tunnel`, `gateway`, `devices`, `load_balancing`, `spectrum`) when the account or zone uses them, with the v1 finding format and scoring.
2. For every product, at least one create, one update and one delete go through plan, approval, apply and `claudeflare rollback`, with a snapshot and a working inverse (or an explicit "not reversible" line).
3. Every lockout case listed in section 6 produces a lockout risk line at `plan new`, covered by unit tests.
4. After apply, product verification runs and its result is recorded per op; on failure the plan status is `applied_verify_failed` and a rollback draft is created and named in the output.
5. Tunnel tokens, service token client secrets and similar credentials never appear in plans, snapshots, apply results, logs, chat or evals.
6. `/claudeflare:diagnose` reaches a root cause for: Access redirect loops and 403s, invalid Access JWT at the origin, Tunnel errors 1016 / 1033 / 502, Gateway over-blocking, WARP clients that cannot reach private routes, Load Balancing with no healthy pool, Spectrum apps that do not connect.
7. Unit tests run without a Cloudflare account using recorded API responses; new eval cases pass; Access, Tunnel, Gateway and WARP are live-tested on the owner's account.

### Non-goals (v3)

- Installing or running `cloudflared` or WARP on any machine. claudeflare's apply never touches hosts or devices.
- Dashboard SSO (SSO connectors), account members and roles, billing. These are not on the allowlist at all, because a mistake there removes the user's way back in.
- Zone-scoped Access applications and policies as write targets. They are audited and diagnosed, but writes are only accepted on the account-scoped Access paths (owner can revisit; section 12).
- Magic WAN / Magic Transit, CASB, DLP, Browser Isolation, Email Security, Digital Experience Monitoring.
- Gateway list items in bulk above the documented limits; lists are managed whole (section 5.3).

### Anti-goals

- A change that leaves the user unable to undo it through claudeflare without saying so in the plan.
- A secret that becomes readable in the transcript because the agent fetched or generated it.
- A verification that claims success it did not observe (for example reporting a Gateway rule "works" when only the API read-back was checked).

## 2. Verified platform facts (2026-10-26)

Sources in section 14. "Unverified" items are spiked before implementation (section 11).

**Global**
- Rate limit 1200 requests per 5 minutes per user, shared with the dashboard; 429 blocks all calls for 5 minutes. Gateway Lists: 600 per minute, 120 s block.
- List endpoints page with `page`/`per_page` and `result_info`. `devices/physical-devices` pages by `cursor`. Spectrum returns `result_info` only when `page` is sent.
- Permission names exist in an "Edit" form (permissions page) and a "Write" form (API reference).

**Access** (account-scoped paths used for writes)
- Apps `/accounts/{a}/access/apps[/{id}]`; reusable policies `/accounts/{a}/access/policies[/{id}]`; app-scoped legacy policies `/access/apps/{id}/policies[/{pid}]`; identity providers `/access/identity_providers[/{id}]`; groups `/access/groups[/{id}]`; service tokens `/access/service_tokens[/{id}]` plus `refresh` and `rotate`; organization `GET/POST/PUT /access/organizations`.
- No PATCH anywhere: every update is a full PUT. Strip `id`, `aud`, `created_at`, `updated_at` before a restore PUT (full read-only list unverified).
- Re-creating an app gives a new id and a **new AUD**; origins validating the Access JWT break until updated. Ids cannot be chosen on create.
- Service token client secret is returned only once, on create (and on rotate).
- Removing a legacy app-scoped policy from an app deletes the policy.
- A reusable policy must be detached from all apps before delete (API behavior unverified).
- Lockout: deleting the auto-generated allow policy locks admins out of the dashboard when Dashboard SSO is on; an IdP placed behind Access with the same IdP loops; removing the only login method leaves no way in.
- Verification: protected URL should answer 302 to `<team>.cloudflareaccess.com` without a session (unverified, spike).

**Tunnel** (account-scoped)
- `cfd_tunnel[/{id}]` (PATCH only renames or rotates the secret), `/{id}/configurations` GET/PUT (whole config), `/{id}/connections` GET/DELETE, `/{id}/token` GET (needs Write permission), `teamnet/routes[/{id}]`, `teamnet/virtual_networks[/{id}]`.
- Hostname routing is a DNS CNAME to `<uuid>.cfargotunnel.com` in a zone of the same account.
- Create returns `token` and `credentials_file`. Re-creating gives a new UUID, new CNAME target and new token; every connector must be reinstalled.
- Delete requires no active connections (`DELETE /connections` first; connections linger for minutes). A virtual network with routes cannot be deleted.
- Status values: `inactive`, `degraded`, `healthy`, `down`. 1016 / 1033 at the edge mean the tunnel is not serving.

**Gateway** (account-scoped)
- `gateway/rules[/{id}]` (PUT only), `gateway/lists[/{id}]` (PUT replaces items when `items` is non-empty; PATCH `append`/`remove`), `gateway/locations[/{id}]`, `gateway/configuration` (PUT whole, PATCH one subcollection).
- Rule read-only fields: `id`, `created_at`, `updated_at`, `deleted_at`, `version`, `read_only`, `source_account`, `warning_status`.
- `precedence`: lower runs first inside a phase; first Allow or Block match ends the phase. The API reformats `traffic` expressions; diffs compare against the returned value.
- Limits: 500 rules per type, 100 lists, 1000 entries per list (Standard).

**WARP / devices** (account-scoped)
- Default profile `devices/policy` GET/PATCH; custom profiles `devices/policies` (list), `devices/policy` POST, `devices/policy/{id}` GET/PATCH/DELETE; split tunnel `.../exclude`, `.../include`, `.../fallback_domains` GET/PUT (whole list); posture `devices/posture[/{id}]` (PUT); global `devices/settings`.
- Switching split tunnel mode resets the entries to defaults. Include mode needs the Zero Trust domains added by hand. "Lock device client switch" without admin override codes leaves users unable to turn WARP off.

**Load Balancing**
- Monitors and pools (account): `load_balancers/monitors[/{id}]`, `load_balancers/pools[/{id}]`, both with `references` and `preview`; `pools/{id}/health`. Load balancers: `/zones/{z}/load_balancers[/{id}]` (v3 writes the zone form). PUT replaces, PATCH overwrites supplied properties.
- A pool cannot be deleted while it is a default, region, pop, country or fallback pool; `references` lists users. Paid add-on.

**Spectrum** (zone-scoped)
- `/zones/{z}/spectrum/apps[/{id}]`, PUT only. Not on Free; limited protocols on Pro and Business; generic TCP/UDP on Enterprise.

## 3. Product scope per domain

| Domain | Scope | Write targets in v3 |
|---|---|---|
| `access` | account | apps, reusable policies, legacy app policies (update and delete only), groups, identity providers, service tokens (create, update, delete), organization (update only) |
| `tunnel` | account | tunnels (create, rename, delete), remote config, private routes, virtual networks, connection cleanup |
| `gateway` | account | rules, lists, locations, account configuration |
| `devices` | account | default and custom profiles, split tunnel include/exclude, fallback domains, posture rules |
| `load_balancing` | account (monitors, pools) and zone (load balancers) | monitors, pools, load balancers |
| `spectrum` | zone | apps |

Not written: Access `revoke_tokens` and `revoke_user` (session ends are not reversible and are better done by the user in the dashboard; diagnose may recommend them), service token `refresh` / `rotate` (section 7), device unenroll and revoke.

## 4. Architecture

### 4.1 Approach (picked: C)

| | Approach | Trade-off |
|---|---|---|
| A | One generic REST engine, path allowlist, generic snapshot and inverse | Cheap to extend, but blind to the product: cannot warn about lockouts or rule order, misses re-create traps (new AUD, new tunnel UUID). |
| B | Typed ops per product (`access_app_set`, ...) with their own schema, snapshot, inverse, risk and verify | Most precise, but the snapshot, conflict and inverse machinery is written six times and every new API field needs code. |
| **C** | **Shared REST engine + one rule module per product** | **Engine owns allowlist, snapshot, conflict check, default inverse and secret redaction; modules add risk analysis, inverse overrides and verification. Mirrors v2, where `wrangler-ops` holds one allowlist and executor with per-kind snapshot and inverse rules.** |

Owner picked C. Reason given: lockout warnings need product knowledge, which A cannot give, and B multiplies the safety-critical code.

### 4.2 Op format

Ops stay the v1 shape: `{ "method", "path", "body" }`. No new `kind`. Account-scope plans may now omit `project_dir` when they hold only REST ops (v2 required it for wrangler ops; it stays required whenever a `wrangler` op is present).

Optional per-op fields, all part of the ops hash:
- `confirm_name`: required on every delete in section 5 (as v2 section 3.7). Must equal the resource's `name` (or `hostname` / `domain` where the product has no name) read at preflight.
- `verify`: overrides or extends the module's default verification (section 8). Example: `{ "url": "https://wiki.example.com/", "expect": "access_login" }`.
- `secret_fields_from_env`: REST counterpart of v2 `value_from_env`, for bodies that must carry a credential (IdP `config.client_secret`, for example). Map of body field path to env var name: `{ "config.client_secret": "OKTA_CLIENT_SECRET" }`. The stored body leaves those fields out; the ops hash covers the body as stored plus the map. Apply reads each env var (missing: `secret_env_missing`, nothing runs), injects the value into the request it sends and never writes it anywhere. The module's `secretFields` list names which fields must come this way; a literal value in one of them is `invalid_op` at `plan new`. (Builder check; my call, mirrors v2.)

### 4.3 Kind registry

`scripts/lib/resources.mjs` keeps zone kinds. New file per product under `scripts/lib/products/` (`access.mjs`, `tunnel.mjs`, `gateway.mjs`, `devices.mjs`, `load-balancing.mjs`, `spectrum.mjs`), each exporting a list of kind entries:

```js
{
  kind: 'access_app_update',
  scope: 'account',            // or 'zone'
  methods: ['PUT'],
  pattern: /^\/access\/apps\/([0-9a-f-]{36})$/,  // relative to /accounts/<id> or /zones/<id>
  resource: (m) => ({ type: 'access_app', id: m[1] }),   // conflict key
  read: (m, base) => `${base}/access/apps/${m[1]}`,       // before-read
  readOnlyFields: ['id', 'aud', 'created_at', 'updated_at'],
  inverse: 'put_before',       // or a function, or 'delete_created', 'recreate', 'none'
  destructive: false,
  risk: (ctx) => [...lines],   // ctx: op, before, account reads done at preflight
  verify: (ctx) => [...checks],
}
```

- `ACCOUNT_REST_ALLOWLIST` is replaced by the union of account kinds plus the existing Pages rollback entry. Unknown account write paths stay `invalid_op`.
- Zone plans keep the v1 policy (any write under `/zones/<zone_id>/` is accepted; unknown kinds are not reversible). v3 adds zone kinds from the product modules (load balancers, Spectrum) so they get snapshots and inverses, and an explicit deny for zone-scoped Zero Trust paths (`/zones/<z>/access/...`) with a message pointing to the account form. (Builder check; my call, keeps v1 binding.)
- `classify(op, plan)` resolves the kind from scope, method and path.
- Path validation (normal path, no placeholders, unsafe characters) is unchanged.

### 4.4 Default inverses (engine)

| Inverse | Snapshot | Rollback op |
|---|---|---|
| `delete_created` | none | `DELETE <path>/<id from apply result>` |
| `put_before` | GET resource | `PUT <path>` with `before` minus `readOnlyFields` |
| `patch_before` | GET resource | `PATCH <path>` with the before values of the top-level keys the op body set; a key absent before makes the inverse `rollback_ambiguous` unless the kind also has a PUT path, then `put_before` is used |
| `recreate` | GET resource (and dependents the module names) | `POST <collection>` with `before` minus `readOnlyFields`; the module adds a risk line naming what changes (new id, new AUD, ...) |
| `none` | optional | not reversible; plan risk gets the v2 `Not reversible:` line |

Rollback plans carry a drift precheck, reusing the v2 precheck idea: before running an inverse, apply re-reads the resource and compares it with the post-apply state recorded at apply time (minus read-only fields, Gateway `traffic` compared as returned). A mismatch skips that inverse with `rollback_drift` and a note, so a rollback never silently overwrites a change made after the original apply.

Drift details (builder check; my calls):
- Only v3 kinds record a post-apply state (an extra GET after each successful op, stored in a separate `post` file next to the snapshot, since the snapshot is written once). v1 and v2 rollbacks are unchanged.
- After a skip, the remaining inverses still run, except inverses in the same dependency group, which are skipped together: Gateway precedence restores of one phase, a device profile mode change and its list PUTs, a tunnel's connection cleanup and delete.
- A rollback with any skip ends `partially_applied` and lists the skipped inverses; the source plan is marked `rolled_back` only when every inverse ran.

### 4.5 Conflict rules

As v1 `EXCLUSIVE_TARGET`: two ops on the same resource key in one plan are `plan_conflict`, and so is a delete together with any other op on the same key. Product-specific extras:
- Gateway: two ops that change `precedence` in the same phase must be in one plan in ascending order; otherwise `plan_conflict` (the snapshot captures every rule's precedence in that phase, section 5.3).
- Devices: when a profile PATCH changing split tunnel mode and a PUT on that profile's include/exclude list are in the same plan, the mode change must come first (`plan_conflict` otherwise). A mode change without a list PUT is allowed and gets a lockout line (section 6 item 7), per owner decision 3. (Builder check; my call.)
- Tunnel: config PUT and tunnel delete on the same tunnel conflict.

### 4.6 Secrets in responses

Some write responses carry credentials: tunnel create (`token`, `credentials_file`, and the `tunnel_secret` sent in the body), service token create (`client_secret`).
- The engine runs a per-kind `redact` list over request bodies and apply results before anything is written to `.claudeflare/` or printed. Redaction is by field path, not by value guessing.
- Tunnel create: the op body must not contain `tunnel_secret` (Cloudflare generates one); `config_src` must be `cloudflare` (remote-managed, so claudeflare can snapshot and roll back the config).
- Service token create: apply writes `{ client_id, client_secret }` to `.claudeflare/secrets/<plan id>-<op index>.json` with mode 0600, prints only the path, and adds the file to `.claudeflare/.gitignore`. The plan risk says the secret is shown only once.

### 4.7 New CLI command: `claudeflare tunnel-token`

`claudeflare tunnel-token --tunnel <id> --env-file <path> [--var TUNNEL_TOKEN]` reads `GET /cfd_tunnel/{id}/token` and writes `TUNNEL_TOKEN=<value>` into the env file (created with mode 0600, existing line replaced, other lines kept). It prints only the file path and whether the file is covered by `.gitignore` (warning when it is not). The value is never printed. It is not a Cloudflare write, so it needs no plan; it runs with the write token because the endpoint requires Tunnel Write.

### 4.8 Guard additions

- MCP execute code that reads `cfd_tunnel/<id>/token` is denied with a reason pointing to `claudeflare tunnel-token`. Same for any `service_tokens/<id>/rotate|refresh` and `access/apps/<id>/revoke_tokens`.
- Bash: deny `cloudflared ... --token <literal>` and `cloudflared service install <literal>` (a literal token on a command line ends up in the transcript and shell history). Allowed: `cloudflared` with `TUNNEL_TOKEN` from the environment or `--token-file` (flag availability per `cloudflared` version unverified, spike). Read-only `cloudflared` commands (`--version`, `tunnel list`, `tunnel info`, `access` subcommands for testing) are allowed.
- Secret files claudeflare writes are not read back by the agent. Guard denies Read, Grep and Bash reads (`cat`, `head`, `tail`, `less`, `grep`, `sed`, `awk`, `cp`, `base64`, ... on the path) of `.claudeflare/secrets/**` and of every env file `tunnel-token` wrote, which it records in `.claudeflare/secret-files.json`. Other `.env` files stay readable as today (a blanket deny would block normal development). (Builder check; my call.)
- Same threat model as v1/v2: string checks catch model mistakes, not deliberate evasion.

## 5. Products

Each product section lists the kinds, their inverse, and product rules. Risk lines marked **Lockout** use the exact prefix `Lockout risk:` so the approval message and native prompt show them first.

### 5.1 Access

| Op | Inverse | Notes |
|---|---|---|
| app create | `delete_created` | |
| app update (PUT) | `put_before` | |
| app delete | `recreate` | Risk: new AUD; origins validating the JWT need the new AUD; lists the app's domains. Re-creating restores protection, which matters more than the AUD. |
| reusable policy create / update / delete | `delete_created` / `put_before` / `recreate` | Delete preflight lists apps still using it (from all apps' `policies`); non-empty: refuse with `resource_in_use` |
| legacy app policy update / delete | `put_before` / `recreate` | |
| group create / update / delete | same pattern | Delete preflight lists policies referencing the group; refuse when in use |
| IdP create / update / delete | `delete_created` / `put_before` / `none` | IdP config holds client secrets; snapshot stores only non-secret fields, so update and delete inverses are `none` when the body touches secret fields. Risk names the apps that allow only this IdP. |
| service token create / update / delete | `delete_created` / `put_before` / `none` | Delete is not reversible (a new token has a new secret); risk lists policies that include it |
| organization update | `put_before` | `auth_domain` change: risk that existing sessions and bookmarks break |

**Lockout risk lines** (section 6 has the full list): last allow policy removed from an app; a policy whose include becomes empty or `everyone` with decision deny; app domain covering the IdP's own login host; removing an IdP that is the only login method for any app; changing `allowed_idps` of an app to an IdP not configured; a session duration of `0s` style values (unverified meaning, spike).

### 5.2 Tunnel

| Op | Inverse | Notes |
|---|---|---|
| tunnel create | `delete_created` (with connection cleanup op first) | Body: `name`, `config_src: "cloudflare"` only |
| tunnel rename (PATCH `name`) | `patch_before` | PATCH with `tunnel_secret` refused (`invalid_op`) |
| tunnel delete | `none` | Preflight: lists active connections and DNS CNAMEs in the account's zones pointing to `<uuid>.cfargotunnel.com`; risk names each hostname that will return 1016. The plan must include `DELETE /connections` before the delete. |
| config PUT | `put_before` | Preflight validates ingress: last rule is a catch-all with no hostname; every hostname rule has a service; hostnames with a matching CNAME but no rule get a risk line (they will 404). New hostnames without a CNAME get a note suggesting the DNS op (a zone plan; v3 does not mix scopes). |
| connections DELETE | `none` | Risk: connectors reconnect unless stopped; used before tunnel delete or after a token rotation |
| route create / update / delete | `delete_created` / `patch_before` / `recreate` | |
| virtual network create / update / delete | same | Delete refused when routes reference it (`resource_in_use`); `default` network delete refused |

### 5.3 Gateway

| Op | Inverse | Notes |
|---|---|---|
| rule create | `delete_created` | |
| rule update (PUT) | `put_before` | Snapshot also stores every rule's `precedence` in the same phase so rollback can restore order |
| rule delete | `recreate` | New id; precedence restored from snapshot |
| list create / update / delete | `delete_created` / `put_before` (with items) / `recreate` | Lists above 1000 items: refused (`too_large`). Delete preflight lists rules whose `traffic` mentions the list id; in use: refuse. List PATCH is not on the allowlist in v3 (whole-list PUT keeps inverses exact). |
| location create / update / delete | `delete_created` / `put_before` / `recreate` | Delete risk: new DoH subdomain and IPs after re-create; devices and routers configured with the old ones stop filtering |
| configuration PATCH | `patch_before` | Configuration PUT not on the allowlist (too broad) |

**Lockout risk lines:** a block rule whose `traffic` matches all traffic (empty or `any(...)` wildcards) or matches Cloudflare and IdP domains (`cloudflareaccess.com`, `cloudflare.com`, `cloudflareclient.com`, the configured IdP hosts); a block rule placed above an existing allow rule that covers the same selector; TLS decryption turned on (breaks certificate-pinned apps, risk only).

### 5.4 Devices (WARP)

| Op | Inverse | Notes |
|---|---|---|
| default profile PATCH | `patch_before` | |
| custom profile create / PATCH / delete | `delete_created` / `patch_before` / `recreate` | Delete snapshot includes its include/exclude and fallback lists so re-create restores them; risk: new id, devices fall back to the default profile meanwhile |
| include / exclude / fallback PUT | `put_before` (whole list) | |
| posture rule create / PUT / delete | `delete_created` / `put_before` / `recreate` | Delete preflight lists Access policies referencing the posture rule; in use: refuse |

**Lockout risk lines:** split tunnel mode switch (entries reset to defaults; the line suggests adding the list PUT to the plan); include mode without the Zero Trust domains (`<team>.cloudflareaccess.com`, the IdP hosts); `switch_locked: true` while admin override is off; excluding the IdP or Access domains from WARP when Access policies require WARP posture.

### 5.5 Load Balancing

| Op | Inverse | Notes |
|---|---|---|
| monitor create / update / delete | `delete_created` / `put_before` / `recreate` | Delete refused when `references` is non-empty |
| pool create / update / delete | same | Delete refused when `references` is non-empty; update that disables every origin or sets `minimum_origins` above enabled origins: risk "pool goes critical" |
| load balancer create / update / delete (zone plan) | `delete_created` / `put_before` / `recreate` | Preflight runs the pool `preview` for new or changed pools and records the result; delete risk names the hostname that stops resolving through the LB |

Preflight checks the add-on is enabled (a read of `load_balancers/pools` succeeds and the zone LB list is reachable); otherwise `not_entitled` with a plain message.

### 5.6 Spectrum

| Op | Inverse | Notes |
|---|---|---|
| app create / update / delete | `delete_created` / `put_before` / `recreate` | Preflight checks the zone plan allows the protocol (section 2); otherwise `not_entitled`. Delete risk: new id and possibly new anycast IPs after re-create unless `edge_ips` is static (unverified, spike). |

## 6. Lockout risk catalogue

Owner decision: these never refuse a plan; they add a `Lockout risk:` line at `plan new`. Each item is a unit test.

At apply time the analysis runs again on fresh reads. If it finds a lockout line the plan did not show, apply stops before any write with `risk_changed`, prints the new line and keeps the approval unused; the agent makes a new plan so the user approves with the line in view. Reason: owner decision 3 puts the decision with the user at approval, and approval binds only to the ops hash, so a line the user never saw was never decided. Lines that disappeared do not stop apply. (Builder check; my call.)

1. Access app loses its last allow policy, or every allow policy has an empty include.
2. Access app domain covers the host of a configured IdP or the team domain.
3. Removing or changing the only IdP allowed by any app (`allowed_idps`), or the org's only login method.
4. Deleting the auto-generated allow policy of the Zero Trust dashboard app when present.
5. Gateway block rule matching all traffic, or matching Cloudflare / IdP domains.
6. Gateway block rule moved above an allow rule with an overlapping selector.
7. WARP split tunnel mode switch; include mode missing Zero Trust domains.
8. WARP `switch_locked` without admin override codes.
9. WARP exclusions that remove Access or IdP domains while device posture is required.
10. Tunnel config PUT that drops a hostname still served (has a CNAME) or the catch-all rule.
11. Pool update leaving zero enabled origins; LB with its only pool critical in preview.

Each line names the users or hosts affected and one sentence of what to do if it happens (for example: "keep this terminal open; the rollback plan is `<id>`").

## 7. Steps outside the Cloudflare API

Owner decision: explain by default; write files when the user asks.

- **Explain (default):** the product skill gives the exact steps for the user's platform: Docker Compose, systemd, Kubernetes, macOS/Windows service for `cloudflared`; MDM file and rollout steps for WARP.
- **Write (on request):** normal file edits in the user's project, with the user's consent, outside `claudeflare apply` (they change no Cloudflare state, so no plan or approval). Templates live in the skills:
  - Compose service `cloudflare/cloudflared:<pinned tag>` with `command: tunnel --no-autoupdate run`, `TUNNEL_TOKEN` from the environment, `restart: unless-stopped`, two replicas suggested for zero-downtime rotation.
  - systemd unit with `EnvironmentFile=` pointing at a 0600 file.
  - WARP MDM (`mdm.xml` / `.plist` / `.json` per OS) with organization name and profile settings. Fields that hold secrets (service token auto-enrollment) are left as a clearly marked placeholder; the skill explains where the user pastes the value.
- **Tokens never go into generated files.** The token reaches the env file only through `claudeflare tunnel-token` (section 4.7). If `.env` is not ignored by git, the agent warns before writing.
- **Token rotation:** documented as a sequence: rotate via dashboard or a future op (not in v3), run `tunnel-token`, restart connectors, then an approved plan with `DELETE /connections` for stale ones.

## 8. Post-change verification

Owner decision: report only. v2 auto rollback for deploys is unchanged.

- After all ops run, apply runs each op's checks (module defaults plus the op's `verify`) and records `results[i].verify = { ok, checks: [{ name, ok, detail }] }`.
- Any failed check: plan status `applied_verify_failed`, apply creates a rollback draft (status `draft`, needs a new approval as always) and prints its id together with the failed checks. Nothing is undone without approval.
- Rollback plans are verified too (restoring access right after a lockout is exactly when confirmation matters). A failed check on a rollback plan is reported with status `applied_verify_failed`, but no further rollback draft is created; there is no rollback-of-a-rollback chain. `ROLLBACK_SOURCE_STATUSES` gains `applied_verify_failed` for normal plans only. (Builder check; my call.)
- Checks run with a timeout (default 60 s per op, retries every 5 s) because Cloudflare propagation is not instant.
- Default checks per product:
  - **Access:** read-back equals sent body (minus read-only fields); for apps with a public `domain`, an unauthenticated GET (no redirect follow) answers 302 with a `Location` host of `<team>.cloudflareaccess.com` (spike confirms the exact behavior). Policy changes re-read every app using the policy.
  - **Tunnel:** read-back; tunnel `status` is `healthy` or `degraded` when it had connections before; for each hostname in a changed config, GET returns neither 1016 nor 1033 (`cf-ray` present, body code check).
  - **Gateway:** read-back (compared against the reformatted `traffic`). The report says plainly that filtering itself is only verified from a device behind Gateway, and gives the `dig` test command for the user.
  - **Devices:** read-back of the profile and its lists. Same honesty note: device behavior is verified on a device.
  - **Load Balancing:** pool health endpoint reaches `Healthy` (or the state preview predicted) within the timeout; LB read-back.
  - **Spectrum:** read-back; optional TCP connect to `hostname:port` from the apply machine when the protocol is TCP (my call; skipped for UDP).
- `verify.expect` values accepted on ops: `access_login`, `status:<code>`, `tunnel_serving`, `pool_healthy`, `tcp_open`.

## 9. Preflight additions

`claudeflare preflight` (and `plan new`) for v3 kinds:
- **Entitlement:** Zero Trust org exists (`GET /access/organizations`) for Access, Gateway and Devices kinds; LB add-on; Spectrum protocol on the zone plan. Failure: `not_entitled`.
- **Permission probe:** one read per product the plan touches; 403 gives `missing_permission` naming the permission from the token template (no write is attempted).
- **Dependencies:** `references` (LB), app and policy scans (Access), rule `traffic` scans (Gateway lists, Access posture), tunnel connections and CNAMEs, virtual network routes. In use: `resource_in_use` refusal, except where section 5 says risk only.
- **Validation:** tunnel ingress shape, Gateway list size, `confirm_name` matches.
- **Lockout analysis:** section 6, using the reads above.
- Preflight output gains `lockout_risks: [...]` and `dependencies: {...}`.

## 10. Skills, agents, audit

- New skills: `cf-access`, `cf-tunnel`, `cf-gateway`, `cf-devices`, `cf-load-balancing`, `cf-spectrum`, each with the v1 domain skill structure (checklist with finding ids, change recipes as plan drafts, risk notes) and the section 7 templates where relevant.
- New troubleshooting skill `cf-zt-troubleshoot` with the trees in success criterion 6; evidence via MCP reads, Access and Gateway logs where the plan allows (`access/logs/access_requests`, Gateway activity via GraphQL; exact datasets confirmed in the spike), tunnel connections, pool health.
- `cf-audit` gains the six domains. `access`, `tunnel`, `gateway`, `devices` audit an account; `load_balancing` audits account pools and monitors plus the zone's load balancers; `spectrum` audits a zone. A full zone audit includes `load_balancing` and `spectrum` when they exist; a full account audit includes the four Zero Trust domains when an org exists.
- `cf-core` gains the v3 kinds, `confirm_name`, `verify`, `secret_fields_from_env`, lockout risk lines, `tunnel-token`, secrets handling, and error codes `not_entitled`, `missing_permission`, `resource_in_use`, `rollback_drift`, `risk_changed`, `too_large`.
- Example audit checks (not exhaustive): Access apps without session duration limits, `everyone` includes, apps without MFA where the IdP supports it, service tokens near expiry, unused groups; tunnels `down` or with one connector, configs without catch-all, stale CNAMEs to deleted tunnels; Gateway with no DNS block baseline (malware, phishing categories), rules shadowed by an earlier rule, TLS decryption off with HTTP rules that need it; WARP default profile allowing switch-off where posture is required, empty exclude for local networks; LB pools without monitors, monitors with very short intervals, no fallback pool; Spectrum apps without IP access rules or proxy protocol where the origin needs client IPs.

## 11. Testing

- **Spike first** (results recorded in the plan, may adjust sections 5 and 8): Access unauthenticated 302 behavior and header; Access read-only field list on GET vs PUT; whether reusable policy delete is rejected while in use; Gateway list delete while referenced; `cloudflared --token-file` availability; Spectrum `edge_ips` behavior on re-create; Access and Gateway log datasets. Spike runs on the owner's account where possible; API reference pages saved during research are in the session scratchpad.
- **Unit tests:** kind classification and allowlist per product; conflict rules; each default inverse and every module override; drift precheck; redaction (tunnel create, service token create) asserting secrets never reach plan, snapshot, results or stdout; `tunnel-token` file writing (mode, replace line, gitignore warning, never prints the value); every lockout line in section 6; preflight dependency refusals; verification pass, fail and timeout paths; guard denials in section 4.8.
- **Recorded responses:** `test/fixtures/api/<product>/` holds sanitized real responses (ids replaced, no secrets) used by a fake client. Load Balancing and Spectrum are tested only this way (paid add-ons on the owner's account).
- **Evals (new cases):** "put my wiki behind Access" produces a plan with the lockout lines and a verify; "expose localhost:3000 with a tunnel" explains the steps and never prints the token; "Gateway is blocking everything" diagnosis from recorded data; a request to delete a tunnel with live hostnames shows the 1016 risk.
- **Live test** on the owner's account `denizbarish`, throwaway hostnames under `denizbarish.com`, run from a host allowed by the token IP filter, as in v2. A Zero Trust org cannot be created through the API; whether one exists is checked with a read before the test, and if not, the owner creates it in the dashboard (Free plan is enough). Permissions from section 12 are added by the owner before the test. Steps: create a tunnel, put a config with a throwaway hostname, Access app with a policy and verify the login redirect, Gateway DNS rule create and rollback, WARP custom profile create and rollback, then delete everything. Token template permissions are added by the owner before the test.

## 12. Delivery and release

- One release, `0.3.0`, built in this order, each step complete (kinds, module, skill, audit domain, tests) before the next: engine changes (4.2 to 4.8) → Tunnel → Access → Gateway → Devices → Load Balancing → Spectrum → troubleshoot skill, evals, docs.
- README: Zero Trust and network section, threat model note on lockout, `tunnel-token`. Token template: `Access: Apps and Policies`, `Access: Organizations, Identity Providers, and Groups`, `Access: Service Tokens`, `Cloudflare Tunnel` (or `Cloudflare One Connectors`), `Cloudflare One Networks`, `Zero Trust`, `Load Balancing: Monitors and Pools` (account), `Load Balancers` (zone), `Zone Settings` (Spectrum), each Read for the read token and Edit for the write token.
- CHANGELOG 0.3.0; push, tag and release only with owner approval.
- Owner can revisit later: zone-scoped Access writes, Gateway list PATCH for large lists, service token rotation as an op.

## 13. Left to the builder

- Exact module file layout and helper names inside `scripts/lib/products/`, as long as section 4.3's contract holds.
- How lockout analysis matches Gateway `traffic` expressions (a small matcher for the common selectors is enough; unknown expressions get a generic "could not analyze this expression" note, not silence).
- Retry and backoff details for verification within the stated timeout, and a client-side rate limiter that keeps a plan well under 1200 requests per 5 minutes.
- Fixture sanitization tooling.

## 14. Sources

- https://developers.cloudflare.com/api/ (resources: zero_trust/access, identity_providers, organizations, tunnels/cloudflared, networks/routes, networks/virtual_networks, gateway, devices, load_balancers, spectrum/apps)
- https://developers.cloudflare.com/fundamentals/api/reference/permissions/
- https://developers.cloudflare.com/fundamentals/api/reference/limits/
- https://developers.cloudflare.com/fundamentals/manage-members/dashboard-sso/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel-api/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/routing-to-tunnel/dns/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/remote-tunnel-permissions/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/private-net/cloudflared/tunnel-virtual-networks/
- https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
- https://developers.cloudflare.com/cloudflare-one/policies/access/
- https://developers.cloudflare.com/cloudflare-one/access-controls/policies/policy-management/
- https://developers.cloudflare.com/cloudflare-one/policies/gateway/order-of-enforcement/
- https://developers.cloudflare.com/cloudflare-one/policies/gateway/dns-policies/test-dns-filtering/
- https://developers.cloudflare.com/cloudflare-one/reusable-components/lists/
- https://developers.cloudflare.com/cloudflare-one/account-limits/
- https://developers.cloudflare.com/cloudflare-one/troubleshooting/access/
- https://developers.cloudflare.com/cloudflare-one/troubleshooting/tunnel/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/configure-warp/warp-settings/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/configure-warp/route-traffic/split-tunnels/
- https://developers.cloudflare.com/load-balancing/pools/create-pool/
- https://developers.cloudflare.com/load-balancing/understand-basics/health-details/
- https://developers.cloudflare.com/load-balancing/troubleshooting/load-balancing-faq/
- https://developers.cloudflare.com/spectrum/protocols-per-plan/
- https://developers.cloudflare.com/spectrum/reference/configuration-options/
