---
name: cf-core
description: Foundation for every Cloudflare task in claudeflare. Account and zone discovery, plan tier, which channel to use for reads and writes, the MCP execute grammar the guard accepts, and the full change protocol (plan, user approval, apply, verify, rollback). Load this before any other cf-* skill and before any Cloudflare read or change.
---

# cf-core: discovery, channels and the change protocol

Every other cf-* skill assumes you follow this one. Reads are free; writes happen only through the change protocol below.

## 1. First use

Run `claudeflare init` once per project before the first plan or report. It creates `.claudeflare/` (plans, approvals, snapshots, reports) and adds `.claudeflare/` to `.gitignore`. It is safe to run again.

## 2. Channels

| Concern | Channel |
|---|---|
| Discovery, reads, analytics, docs | Cloudflare MCP: `search` (find endpoints), `execute` (GET or GraphQL only), `docs` |
| Every write | `claudeflare plan new`, then user approval, then `claudeflare apply <id>` |
| Reads when MCP is unavailable, or bulk reads | `claudeflare get <path> [--query k=v ...]` (needs `CLOUDFLARE_API_TOKEN`) |
| Live behavior from outside | `curl -sI https://<host>/<path>` (headers such as `cf-ray`, `cf-cache-status`, `server`, `location`) |

Never send a write any other way: no MCP write, no `curl` with a non-GET method to `api.cloudflare.com`. The guard hook denies both. Never run commands on the origin server; give origin-side fixes as step-by-step instructions for the user.

## 3. MCP `execute` grammar (the guard denies anything else)

The guard only allows code that matches this exact shape:

- One statement per call: optional `const name =` or `let name =`, optional `await`, then `cloudflare.request({ ... })`, optional `;`.
- Keys in the request object: `method`, `path`, `query`, `body`, each at most once.
- `method` and `path` are string literals. Always write `method: "GET"` literally. The only allowed non-GET is `method: "POST"` with `path: "/graphql"`.
- `query` and `body` contain only literals: strings, non-negative numbers, `true`, `false`, `null`, and objects or arrays of those.
- Optional last line: `return name;`, `return [a, b];` or `return {a, b};` using names you declared.
- ASCII only. No loops, functions, variables inside values, string concatenation, template `${}`, backslashes or negative numbers. Put real ids into the path as literal text.

Allowed:

```js
const zone = await cloudflare.request({ method: "GET", path: "/zones", query: { name: "example.com" } });
return zone;
```

```js
const ssl = await cloudflare.request({ method: "GET", path: "/zones/023e105f4ecef8ad9ca31a8372d0c353/settings/ssl" });
const hsts = await cloudflare.request({ method: "GET", path: "/zones/023e105f4ecef8ad9ca31a8372d0c353/settings/security_header" });
return {ssl, hsts};
```

GraphQL analytics: pass every value through `variables`, so the query string needs no quotes or escapes. Use a backtick string for a multi-line query.

```js
const traffic = await cloudflare.request({ method: "POST", path: "/graphql", body: { query: `query ($zoneTag: string, $since: Time, $until: Time) {
  viewer { zones(filter: { zoneTag: $zoneTag }) {
    httpRequestsAdaptiveGroups(limit: 10, filter: { datetime_geq: $since, datetime_leq: $until }) {
      count dimensions { edgeResponseStatus }
    }
  } }
}`, variables: { zoneTag: "023e105f4ecef8ad9ca31a8372d0c353", since: "2026-10-24T00:00:00Z", until: "2026-10-24T06:00:00Z" } } });
return traffic;
```

Results are truncated at about 6k tokens. Read narrow paths (a single setting, a single phase entrypoint), pass `per_page`, and filter with `query` instead of listing everything. If a call is denied, rewrite it to fit the grammar; do not try to work around the guard.

## 4. Discovery

1. Accounts: `GET /accounts` with `query: { per_page: 50 }`.
2. Zones: `GET /zones` with `query: { name: "example.com" }` for a known domain, or `query: { per_page: 50 }` to list. If several zones match or none is given, ask the user which zone to work on.
3. From the zone object record: `id` (zone_id), `name` (zone_name), `account.id`, `status`, `name_servers`, and `plan.legacy_id` (`free`, `pro`, `business`, `enterprise`).
4. State the plan tier when it limits a recommendation: say plainly that a feature needs a higher plan and offer the best option on the current plan.

Fallback without MCP: `claudeflare get /zones --query name=example.com`.

## 5. Change protocol (every write)

Never skip or reorder these steps. Plans cannot be edited; to change one, create a new plan.

### 5.1 Read the current state

Read every resource the change touches (setting, DNS record, ruleset or phase entrypoint) so you can show before and after values and use real ids in the paths.

### 5.2 Write the draft

Write the draft JSON with the Write tool to a file in the system temp directory, for example `/tmp/claudeflare-draft-ssl-strict.json`. Never write inside `.claudeflare/`.

```json
{
  "zone_id": "023e105f4ecef8ad9ca31a8372d0c353",
  "zone_name": "example.com",
  "summary": "Set SSL mode to Full (strict)",
  "risk": "Site returns 526 if the origin certificate is invalid or expired.",
  "slug": "ssl-strict",
  "ops": [
    { "method": "PATCH", "path": "/zones/{zone_id}/settings/ssl", "body": { "value": "strict" } }
  ]
}
```

- `ops` run in order. Each op is `{ method, path, body? }` against the REST API v4 path. `{zone_id}` in a path is replaced with the draft's `zone_id`.
- `summary` is one line. `risk` names what can break and how the user would notice. Purges and other irreversible ops are flagged in the risk note automatically.
- `slug` is lowercase `[a-z0-9-]`, at most 40 characters.
- Page Rules are never created. Use the modern rule types instead.

One plan may not:
- touch the same DNS record twice,
- touch the same rule twice,
- delete more than one rule in the same ruleset,
- PUT the same phase entrypoint twice.

`claudeflare plan new` rejects these with `plan_conflict`. Split the work into separate plans and run them one after another.

### 5.3 Create the plan

```
claudeflare plan new --file /tmp/claudeflare-draft-ssl-strict.json
```

It prints the plan JSON, including `id` (`<zone-short>-<yyyymmdd-hhmmss>-<slug>`), `ops_hash` and `status: "draft"`. Optional: `claudeflare snapshot <id>` captures the current state of every touched resource for a draft plan, which helps you show an exact before state.

### 5.4 Present and ask for approval

Show the user, in their language:

- plan id and summary,
- a before and after table for each changed value (resource, current, proposed),
- the risk note, and any op that cannot be rolled back,
- what you will verify after apply.

Then ask the user to type the approval themselves:

> To approve, type `/claudeflare:approve <plan-id>`

Never type, simulate or paraphrase that command yourself, and never write approval files; only the user's own prompt counts. Only draft plans can be approved. An approval is single-use and expires after 30 minutes.

### 5.5 Apply

After the hook message says the approval was recorded, run:

```
claudeflare apply <plan-id>
```

The guard then shows a native permission prompt listing the ops; the user confirms there. Apply only works in an interactive session; in a headless run it is denied by design, so tell the user to apply from an interactive session. If the guard denies apply (not approved, expired, plan changed), tell the user why and ask for a fresh `/claudeflare:approve <plan-id>`.

`claudeflare apply` takes a snapshot, runs the ops in order and prints JSON with `status` and per-op `results`:

- `applied`: continue with verification.
- `failed` or `partially_applied`: apply stopped at the first failed op. Report which ops succeeded and the error, then offer a rollback (5.7). Never retry silently.

### 5.6 Verify

Re-read each changed resource through MCP (GET) and compare with the plan. Where useful, check live behavior with `curl -sI` (for example a redirect now returns 301 to the right target). Report the result with evidence.

### 5.7 Rollback

```
claudeflare rollback <plan-id>
```

This only creates a new draft rollback plan from the snapshot's inverse ops; it changes nothing yet. Present it (5.4), get a new `/claudeflare:approve <rollback-plan-id>` from the user, then `claudeflare apply <rollback-plan-id>` and verify. Only applied or partially applied plans can be rolled back.

## 6. Plans and local state

- `claudeflare plan list` lists plans; `claudeflare plan show <id>` prints one plan.
- Read plans only through these commands. Files under `.claudeflare/` and `~/.config/claudeflare/` are off-limits to file and shell tools; the guard denies access. Do not try other paths to them.

## 7. Errors

Errors print as `{ "error": { "code", "message", "hint" } }` on stderr.

| Code or case | What to do |
|---|---|
| `permission` (Cloudflare 9109 or 10000) | Name the missing permission from the hint and point to `docs/token-template.md`. Do not guess or retry. |
| `missing_token` | Writes and `claudeflare get` need `CLOUDFLARE_API_TOKEN`. Point the user to `/claudeflare:setup`. Never ask the user to paste a token into chat. |
| `plan_conflict` | Split into separate plans (5.2). |
| `not_draft`, `not_approved` | Create a new plan, or ask for a fresh approval. |
| Feature needs a higher plan | Say so and offer the best alternative on the current plan. |
| MCP unavailable | Use `claudeflare get` if a token exists; otherwise guide the user through `/claudeflare:setup`. |
