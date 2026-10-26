---
name: cf-devices
description: Cloudflare WARP device settings checklist for one account. The default and custom device profiles, split tunnel include and exclude lists, local domain fallback, device posture rules, and how to roll WARP out with an MDM file. Load it when changing split tunnels or a device profile, locking the WARP switch, adding or deleting a posture rule, auditing WARP, diagnosing WARP clients that cannot reach private routes, or deploying WARP. Load cf-core first.
---

# cf-devices: device profiles, split tunnels, posture

Load `cf-core` first. Findings use the `cf-audit` finding format and severity scale. Device settings live on the account: plans use `"scope": "account"`, hold only REST ops (no `project_dir` needed) and use `/accounts/{account_id}/devices/...`. In the MCP examples below, replace `ACCOUNT_ID` (32 hex characters) and `PROFILE_ID` and `POSTURE_ID` (UUIDs) with real values from cf-core discovery and the reads; the guard needs literal paths.

WARP settings need a Zero Trust organization. The API cannot create one: if GET `/accounts/{account_id}/access/organizations` fails, preflight reports `not_entitled` and the user creates the organization in the Zero Trust dashboard (the Free plan is enough).

claudeflare never touches devices: it changes the account's device settings, and the WARP clients pick them up. Installing and enrolling WARP is a step outside the API (Deploying WARP to devices).

## Read current state

| What | Source |
|---|---|
| Default profile (`switch_locked`, `allowed_to_leave`, `allow_mode_switch`, `auto_connect`, `service_mode_v2`, `include` or `exclude`, `fallback_domains`) | GET `/accounts/{account_id}/devices/policy` |
| Custom profiles (`policy_id`, `name`, `match`, `precedence`, `enabled`, the same settings) | GET `/accounts/{account_id}/devices/policies` |
| Split tunnel and fallback lists of one profile | GET `/accounts/{account_id}/devices/policy/{policy_id}/include`, `.../exclude`, `.../fallback_domains` (the default profile: `/devices/policy/include` and so on) |
| Posture rules (`id`, `name`, `type`, `match`, `input`) | GET `/accounts/{account_id}/devices/posture` |
| Global device settings (`disable_for_time`: admin override codes are on when it is above 0) | GET `/accounts/{account_id}/devices/settings` |
| Access policies that require posture (`device_posture.integration_uid` in `include`, `require` or `exclude`) | GET `/accounts/{account_id}/access/policies` and the `policies` of each app in GET `/accounts/{account_id}/access/apps` |
| Team domain (`auth_domain`) and identity providers (their login hosts) | GET `/accounts/{account_id}/access/organizations`, GET `/accounts/{account_id}/access/identity_providers` |

Split tunnel mode: a profile in exclude mode (the default) sends everything through WARP except its `exclude` entries; a profile in include mode sends only its `include` entries. Each entry is `{ "address": "<cidr>" }` or `{ "host": "<domain>" }` with an optional `description`. Custom profiles apply to devices whose user or device matches `match`, lowest `precedence` first; every other device uses the default profile.

MCP `execute`:

```js
async () => {
  const profile = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/devices/policy" });
  const profiles = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/devices/policies" });
  const posture = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/devices/posture" });
  const settings = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/devices/settings" });
  return { profile: profile.result, profiles: profiles.result, posture: posture.result, settings: settings.result };
}
```

Fallback: `claudeflare get /accounts/ACCOUNT_ID/devices/policies`. Collections page with `page` and `per_page`; read every page of Access policies before concluding that a posture rule is unused.

## Checks

| finding id | condition | severity | recommended | plan tier |
|---|---|---|---|---|
| `devices.switch.unlocked_with_posture` | A profile has `switch_locked: false` while Access policies require device posture: users can turn WARP off and then fail the posture check, or reach apps that only Gateway filtering protects. | medium | Lock the switch, with admin override codes on (`disable_for_time` above 0) | free |
| `devices.exclude.no_local_networks` | A profile in exclude mode whose `exclude` list lacks the private ranges `10.0.0.0/8`, `172.16.0.0/12` and `192.168.0.0/16`: local printers, NAS and the home router become unreachable while WARP is on. | low | Add the private ranges back (keep any that hold private routes behind a tunnel out) | free |
| `devices.profile.unused` | A custom profile with `enabled: false`, or whose `match` equals the `match` of a profile with a lower `precedence`, so it never applies. | low | Delete it, or fix its `match` | free |
| `devices.posture.unused` | A posture rule whose id no Access policy (`device_posture.integration_uid`) and no Gateway rule (`device_posture`) mentions. | low | Delete it, or use it in a policy | free |

Notes for findings:

- `devices.switch.unlocked_with_posture`: `fix` is a PATCH of the profile with `{ "switch_locked": true }`. Without admin override codes the plan gets a `Lockout risk:` line; tell the user to turn the codes on first (dashboard: Settings, WARP Client, Admin override).
- `devices.exclude.no_local_networks`: `fix` is a PUT of the whole `exclude` list: the current entries plus the missing ranges. Do not add a range that a private route (cf-tunnel) uses.
- `devices.profile.unused`: `fix` is a DELETE of the profile with `confirm_name` = `name`.
- `devices.posture.unused`: `fix` is a DELETE with `confirm_name` = `name`. Gateway rules are not scanned by preflight; read them (cf-gateway) before proposing the delete.

## Applying changes

Use the change protocol from cf-core: draft, `claudeflare preflight --file draft.json`, `claudeflare plan new --file draft.json`, user approval, `claudeflare apply <id>`. Show the plan's `Lockout risk:` lines and notes to the user before approval; they are part of what the user approves. Lists are written whole with PUT: read the list first and send every entry that should stay.

| Op | Path (under `/accounts/ACCOUNT_ID`) | Rollback |
|---|---|---|
| Default profile | PATCH `/devices/policy` | PATCHes back the keys the op set; a mode change switches back with the saved list |
| Custom profile create, update, delete | POST `/devices/policy`, PATCH or DELETE `/devices/policy/PROFILE_ID` (delete takes `confirm_name` = `name`) | Delete by `policy_id`; PATCH back; re-create with a new id, then PUT its saved include, exclude and fallback lists to the new id |
| Split tunnel include or exclude | PUT `/devices/policy/include` or `/devices/policy/exclude` (default profile), `/devices/policy/PROFILE_ID/include` or `.../exclude` | PUT of the saved list |
| Local domain fallback | PUT `/devices/policy/fallback_domains` or `/devices/policy/PROFILE_ID/fallback_domains`, entries `{ "suffix": "corp.example.com", "dns_server": ["192.0.2.53"] }` | PUT of the saved list |
| Posture rule create, update, delete | POST `/devices/posture`, PUT or DELETE `/devices/posture/POSTURE_ID` (`confirm_name` = `name`) | Delete; PUT the old rule; re-create with a new id |

The split tunnel mode changes with a profile PATCH whose body holds `include` (switch to include mode) or `exclude` (switch to exclude mode) with the full list. The profile delete rollback runs as one group (`profile:<old id>`): its list PUTs name the new profile as `{created_id}` and get the id from the re-create at apply time; if the profile changed after apply, the whole group is skipped with `rollback_drift`.

Refused at `plan new` (`invalid_op`): a profile body with both `include` and `exclude`, split tunnel entries without exactly one of `address` or `host`, fallback entries without `suffix`, `fallback_domains` inside a profile body (use the PUT), Cloudflare-set fields (`policy_id`, `default`, `gateway_unique_id`), a non-boolean `switch_locked`, a profile create without `name`, `match` or an integer `precedence`, a list PUT whose body is not an array, a posture rule without `name` or `type`. Refused at `plan new` (`plan_conflict`): a mode change after a PUT of the same profile's include or exclude list (the switch resets the lists, so put the mode change first), and a profile delete together with any write to that profile's lists. Refused at preflight (`resource_in_use`): a posture rule delete while an Access policy references it; preflight checks this itself and does not rely on the API. Not available as ops: device unenroll and revoke, registration deletes, and `devices/settings` writes.

### Add a private network to split tunnels (the usual request)

```json
{
  "scope": "account",
  "account_id": "0123456789abcdef0123456789abcdef",
  "account_name": "Acme",
  "summary": "Route 198.51.100.0/24 through WARP for the default profile",
  "risk": "Devices on the default profile send 198.51.100.0/24 through WARP instead of the local network.",
  "slug": "devices-split-tunnel",
  "ops": [
    {
      "method": "PUT",
      "path": "/accounts/0123456789abcdef0123456789abcdef/devices/policy/exclude",
      "body": [
        { "address": "10.0.0.0/8", "description": "Local network" },
        { "address": "172.16.0.0/12", "description": "Local network" },
        { "address": "192.168.0.0/16", "description": "Local network" }
      ]
    }
  ]
}
```

In exclude mode a private range reaches WARP by leaving it out of `exclude`: read the current list and send it back without the range (here `198.51.100.0/24` was removed). In include mode, PUT `include` with the range added.

### Lockout risk lines

These never refuse a plan; they are shown at `plan new` and checked again at apply (a new line stops apply with `risk_changed`):

1. A split tunnel mode switch. Switching resets the old mode's list to its defaults, and devices route by the new list at once. The line suggests adding the list PUT after the mode change when the PATCH does not hold every entry.
2. Include mode whose include list lacks the Zero Trust hosts: the team domain (`<team>.cloudflareaccess.com`) and the identity provider login hosts. A PUT of the include list of a profile in exclude mode is checked too, because the API may switch the mode with it.
3. `switch_locked: true` while admin override codes are off (`disable_for_time` is 0 in `devices/settings`): users cannot turn WARP off when it breaks their connection.
4. An exclude list that takes the team domain, `cloudflareaccess.com` or an identity provider host out of WARP while Access policies require device posture: logins bypass WARP, the posture check fails and users are denied.

When a line appears, run the rollback from a machine that does not use the changed profile, so a broken WARP connection cannot keep you from the API.

### Verification

After apply claudeflare reads each changed profile, list and posture rule back and compares it with the sent body; profile lists are compared against the profile field or the list endpoints. The read-back detail ends with `check on one enrolled device of this profile with warp-cli settings` and the note that device behavior is only verified on a device: the API accepting a setting does not prove that a client has picked it up. A failed check sets `applied_verify_failed` and drafts a rollback plan that still needs approval.

## Deploying WARP to devices

Explain the steps by default. Write a file into the user's project only when the user asks; that is a normal file edit outside `claudeflare apply`, since it changes no Cloudflare state.

Steps:

1. Pick the enrollment: users log in with the identity provider (interactive), or a service token enrolls the device without a login (headless). A service token is created in cf-access; its `client_secret` is shown only once and claudeflare writes it to `.claudeflare/secrets/<plan id>-<op index>.json`, which the agent never reads.
2. Allow the devices to enroll: Zero Trust dashboard, Settings, WARP Client, Device enrollment permissions (an Access policy with the users, or with the service token and decision `non_identity`).
3. Write the MDM file for each OS from the templates below and fill `organization` with the team name (`<team>` in `<team>.cloudflareaccess.com`).
4. Distribute WARP and the file with the MDM tool, then check one device with `warp-cli status` and `warp-cli settings` before the whole fleet.

Secrets in MDM files: every secret field is the placeholder `REPLACE_WITH_SERVICE_TOKEN_CLIENT_SECRET`. Never put the real value into a file in the repository, a chat message or a command line. The user pastes it into the MDM tool's protected field for that key, or into the file on the device after distribution. The client id (`REPLACE_WITH_SERVICE_TOKEN_CLIENT_ID.access`) is not a secret, but it also comes from the user.

Windows (`C:\ProgramData\Cloudflare\mdm.xml`) and Linux (`/var/lib/cloudflare-warp/mdm.xml`):

```xml
<dict>
  <key>organization</key>
  <string>example-team</string>
  <key>auto_connect</key>
  <integer>1</integer>
  <key>switch_locked</key>
  <false/>
  <key>service_mode</key>
  <string>warp</string>
  <key>support_url</key>
  <string>https://help.example.com</string>
  <key>auth_client_id</key>
  <string>REPLACE_WITH_SERVICE_TOKEN_CLIENT_ID.access</string>
  <key>auth_client_secret</key>
  <string>REPLACE_WITH_SERVICE_TOKEN_CLIENT_SECRET</string>
</dict>
```

macOS (`com.cloudflare.warp.plist`, deployed by the MDM tool as managed preferences for `com.cloudflare.warp`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>organization</key>
  <string>example-team</string>
  <key>auto_connect</key>
  <integer>1</integer>
  <key>switch_locked</key>
  <false/>
  <key>service_mode</key>
  <string>warp</string>
  <key>auth_client_id</key>
  <string>REPLACE_WITH_SERVICE_TOKEN_CLIENT_ID.access</string>
  <key>auth_client_secret</key>
  <string>REPLACE_WITH_SERVICE_TOKEN_CLIENT_SECRET</string>
</dict>
</plist>
```

iOS, Android and ChromeOS (managed app configuration; the MDM tool takes the same keys, often as JSON):

```json
{
  "organization": "example-team",
  "auto_connect": 1,
  "switch_locked": false,
  "service_mode": "warp",
  "auth_client_id": "REPLACE_WITH_SERVICE_TOKEN_CLIENT_ID.access",
  "auth_client_secret": "REPLACE_WITH_SERVICE_TOKEN_CLIENT_SECRET"
}
```

For interactive enrollment leave out `auth_client_id` and `auth_client_secret`. Settings in the MDM file override the device profile on that device, so keep `switch_locked` in the file consistent with the profile; a locked switch without admin override codes leaves users unable to turn WARP off when it breaks their connection, until an admin changes the file.

## Traps

- Switching split tunnel mode resets the old mode's entries to the defaults; switching back later does not bring custom entries back.
- In include mode only the listed traffic uses WARP: without the team domain and the identity provider hosts in `include`, logins and posture checks through WARP fail.
- A private range in the default `exclude` list (for example `10.0.0.0/8`) keeps a private route behind a tunnel unreachable from WARP; remove only the range the route needs.
- Re-creating a profile gives it a new `policy_id`; until then its devices use the next matching profile or the default profile.
- Re-creating a posture rule gives it a new id; Access policies and Gateway rules that named the old id do not follow it.
- `switch_locked` without admin override codes leaves users without a way to turn WARP off when it breaks their connection.
- Device behavior is only verified on a device: the API read-back proves the setting, not that a client applied it.

## Sources

- Devices API: developers.cloudflare.com/api/resources/zero_trust/subresources/devices/
- Split Tunnels: developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/configure-warp/route-traffic/split-tunnels/
- WARP settings: developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/configure-warp/warp-settings/
- Local Domain Fallback: developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/configure-warp/route-traffic/local-domains/
- MDM deployment and parameters: developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/deployment/mdm-deployment/
- Device posture: developers.cloudflare.com/cloudflare-one/identity/devices/
