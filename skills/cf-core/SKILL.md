---
name: cf-core
description: Foundation for every Cloudflare task in claudeflare. Account and zone discovery, plan tier, which channel to use for reads and writes, the exact MCP execute code form the guard accepts (async wrapper, GET or GraphQL, return .result), and the full change protocol (plan, user approval, apply, verify, rollback) for zone plans and for account plans with wrangler ops (Workers, Pages, R2, D1, KV, Queues, secrets). Load this before any other cf-* skill and before any Cloudflare read or change.
---

# cf-core: discovery, channels and the change protocol

Every other cf-* skill assumes you follow this one. Reads are free; writes happen only through the change protocol below.

## 1. First use

Run `claudeflare init` once per project before the first plan or report. It creates `.claudeflare/` (plans, approvals, snapshots, reports) and adds `.claudeflare/` to `.gitignore`. It is safe to run again.

If the shell cannot find `claudeflare` (exit code 127), run the same commands as `node <plugin root>/bin/claudeflare ...`; the plugin root is two folders above this skill's base directory. Never stop the protocol because the command is missing.

## 2. Channels

| Concern | Channel |
|---|---|
| Discovery, reads, analytics, docs | Cloudflare MCP: `search` (find endpoints), `execute` (GET or GraphQL only), `docs` |
| Every write | `claudeflare plan new`, then user approval, then `claudeflare apply <id>` |
| Reads when MCP is unavailable, or bulk reads | `claudeflare get <path> [--query k=v ...]` (needs `CLOUDFLARE_API_TOKEN`) |
| Live behavior from outside | `curl -sI https://<host>/<path>` (headers such as `cf-ray`, `cf-cache-status`, `server`, `location`) |
| Developer platform reads | Read-only wrangler in the project: `wrangler deployments list --name <w> --json`, `wrangler versions list --name <w> --json`, `wrangler d1 migrations list <db> --remote`, `wrangler kv namespace list`, `wrangler secret list` and the other reads in cf-workers and cf-storage |
| Live Worker logs | `claudeflare tail --worker <name> --seconds <1..60> [--status error]` (JSON summary: `events`, `outcomes`, `top_exceptions`, `samples`, secrets redacted) |
| Developer platform writes | Account plan with `wrangler` ops (5.2.2), `claudeflare preflight`, then the same protocol |

Never send a write any other way: no MCP write, no `curl` with a non-GET method to `api.cloudflare.com`, no direct `wrangler` write (`deploy`, `delete`, `secret put` and so on, also through `npx`, `pnpm`, `yarn`, `bunx` or a `package.json` script). The guard hook denies all of them. Never hand the user ready-to-run write commands either (curl, wget or API snippets with a non-GET method), and never suggest bypassing the protocol. If a change cannot be completed through the protocol, say why and stop; give dashboard steps only when the user explicitly asks to make the change manually. Never run commands on the origin server; give origin-side fixes as step-by-step instructions for the user.

## 3. MCP `execute` code form (the guard denies anything else)

Write every `execute` call in this exact form, the official Code Mode wrapper:

```js
async () => {
  const zones = await cloudflare.request({ method: "GET", path: "/zones", query: { name: "example.com" } });
  return zones.result;
}
```

Rules inside the wrapper:

- One request per statement: optional `const name =` or `let name =`, then `await cloudflare.request({ ... })`, optional `;`.
- Keys in the request object: `method`, `path`, `query`, `body`, each at most once.
- `method` and `path` are string literals. `method` is exactly `"GET"` or `"POST"`. Always write `method: "GET"` for reads. `"POST"` is allowed only with `path: "/client/v4/graphql"` (GraphQL analytics).
- `query` and `body` contain only literals: strings, non-negative numbers, `true`, `false`, `null`, and objects or arrays of those.
- Optional last line: `return` a declared name or a property chain of it (`return r.result;`), an array of chains (`return [a.result, b.result];`) or an object (`return { ssl: a.result, hsts: b.result };`). Return `.result` to drop the response envelope and save tokens.
- ASCII only. No loops, other functions, conditionals, variables inside values, string concatenation, template `${}`, backslashes or negative numbers. Put real ids into the path as literal text.

Two settings in one call:

```js
async () => {
  const ssl = await cloudflare.request({ method: "GET", path: "/zones/023e105f4ecef8ad9ca31a8372d0c353/settings/ssl" });
  const hsts = await cloudflare.request({ method: "GET", path: "/zones/023e105f4ecef8ad9ca31a8372d0c353/settings/security_header" });
  return { ssl: ssl.result, hsts: hsts.result };
}
```

GraphQL analytics: pass every value through `variables`, so the query string needs no quotes or escapes. Use a backtick string for a multi-line query. GraphQL responses have no `.result`; return the whole response.

```js
async () => {
  const traffic = await cloudflare.request({ method: "POST", path: "/client/v4/graphql", body: { query: `query ($zoneTag: string, $since: Time, $until: Time) {
  viewer { zones(filter: { zoneTag: $zoneTag }) {
    httpRequestsAdaptiveGroups(limit: 10, filter: { datetime_geq: $since, datetime_leq: $until }) {
      count dimensions { edgeResponseStatus }
    }
  } }
}`, variables: { zoneTag: "023e105f4ecef8ad9ca31a8372d0c353", since: "2026-10-24T00:00:00Z", until: "2026-10-24T06:00:00Z" } } });
  return traffic;
}
```

Results are truncated at about 6k tokens. Read narrow paths (a single setting, a single phase entrypoint), pass `per_page`, and filter with `query` instead of listing everything. If a call is denied, rewrite it to fit this form; do not try to work around the guard.

## 4. Discovery

1. Accounts: `GET /accounts` with `query: { per_page: 50 }`.
2. Zones: `GET /zones` with `query: { name: "example.com" }` for a known domain, or `query: { per_page: 50 }` to list. If several zones match or none is given, ask the user which zone to work on.
3. From the zone object record: `id` (zone_id), `name` (zone_name), `account.id`, `status`, `name_servers`, and `plan.legacy_id` (`free`, `pro`, `business`, `enterprise`).
4. State the plan tier when it limits a recommendation: say plainly that a feature needs a higher plan and offer the best option on the current plan.

Fallback without MCP: `claudeflare get /zones --query name=example.com`.

For account plans also record the account `id` (32 hex characters) and `name`, and the absolute path of the project directory that holds the wrangler config (`wrangler.jsonc`, `wrangler.json` or `wrangler.toml`). wrangler 4 must be a dependency of that project (`npm i -D wrangler@4`); claudeflare runs that local copy, never a global one or `npx`.

## 5. Change protocol (every write)

Never skip or reorder these steps. Plans cannot be edited; to change one, create a new plan.

### 5.1 Read the current state

Read every resource the change touches (setting, DNS record, ruleset or phase entrypoint) so you can show before and after values and use real ids in the paths.

### 5.2 Write the draft

#### 5.2.1 Zone plans

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

#### 5.2.2 Account plans (developer platform)

```json
{
  "scope": "account",
  "account_id": "0123456789abcdef0123456789abcdef",
  "account_name": "Acme",
  "project_dir": "/Users/me/projects/api",
  "summary": "Deploy api",
  "risk": "The new version takes 100% of traffic; bindings and data are not rolled back.",
  "slug": "deploy-api",
  "ops": [
    {
      "kind": "wrangler",
      "args": ["deploy", "--name", "api"],
      "health_check": { "url": "https://api.example.com/health", "expect_status": 200 },
      "on_failed_check": "rollback"
    }
  ]
}
```

- `project_dir` is absolute; path arguments (`--config`, `--assets`, a Pages directory) must stay inside it.
- Allowed `args` (anything else is `invalid_op`): `deploy`, `versions upload`, `versions deploy`, `rollback`, `delete`, `pages deploy`, `d1 migrations apply <db> --remote`, `d1 time-travel restore`, `d1 create|delete`, `r2 bucket create|delete`, `r2 bucket dev-url enable|disable`, `kv namespace create|delete`, `queues create|delete`, `secret put|delete`. `--name` is required for Worker deploys, uploads, rollbacks, deletes and secrets. Never put `--yes`, `-y`, `--message`, `--dry-run` or `--outdir` in a draft; claudeflare adds what it needs.
- Every delete op carries `"confirm_name": "<resource name>"`. R2 bucket deletes are refused unless the bucket is empty (`resource_not_empty`); KV, Queue and D1 deletes get a data-loss risk line.
- `health_check` (optional, only on `deploy`, `versions deploy`, `rollback` and `pages deploy`): `url` must be `https`, `expect_status` (an integer, 100 to 599) defaults to 200. Redirects are not followed; a failure names the redirect target. Apply tries it 3 times, 5 seconds apart. `"on_failed_check": "rollback"` reverts that op right away when the check fails.
- The only account REST op is a Pages rollback: `{ "method": "POST", "path": "/accounts/<account_id>/pages/projects/<project>/deployments/<deployment_id>/rollback" }`.
- `source_hash`, `source_paths` and `pending_migrations` are computed by claudeflare; any value in the draft is replaced.

Secrets: never ask the user to paste a secret into chat, a draft, a plan or a command line. A secret op names its source with `value_from_env`, which must equal the secret name:

```json
{ "kind": "wrangler", "args": ["secret", "put", "STRIPE_KEY", "--name", "api"], "value_from_env": "STRIPE_KEY" }
```

Ask the user to export `STRIPE_KEY` in the shell that runs `claudeflare apply`. Apply passes the value to wrangler on stdin and redacts it from all output. The secret name must match `^[A-Z_][A-Z0-9_]*$` (it is also the environment variable name), so `api_key` is refused. Names starting with `CLOUDFLARE_`, `WRANGLER_`, `CLAUDEFLARE_` or `ANTHROPIC_` are refused.

#### 5.2.3 Preflight (account plans)

```
claudeflare preflight --file /tmp/claudeflare-draft-deploy-api.json
```

It prints `{ "ok", "checks": [{ "name", "ok", "detail" }], "upload_size"? (one build) or "upload_sizes"? (`[{ worker, size }]`, several), "source_hash"?, "pending_migrations"? }` and exits 1 when a check fails. Checks: ops, wrangler 4 present, the token can read the account, wrangler config (the op's `--config` and `--env`; found as wrangler finds it, and refused when it lies outside `project_dir`; for `deploy` and `versions upload` a redirected `.wrangler/deploy/config.json` is refused too, and the error names the `--config` to add), bindings exist (KV, R2, D1, Queues, Workers behind service and Durable Object bindings, Vectorize, Hyperdrive), a dry-run build (`deploy --dry-run`, which runs the project's own build locally), pending D1 migrations with their SQL, and the source hash. On a failed check, report it and stop; fix the cause before planning. Preflight writes nothing to Cloudflare.

### 5.3 Create the plan

```
claudeflare plan new --file /tmp/claudeflare-draft-ssl-strict.json
```

It prints the plan JSON, including `id` (`<zone-short>-<yyyymmdd-hhmmss>-<slug>`, or `<account-short>-...` for account plans), `ops_hash` and `status: "draft"`. For account plans it runs preflight first and refuses with `preflight_failed`; on success it embeds `source_hash` and `source_paths` into ops that upload files (deploy, Pages deploy, D1 migrations) and `pending_migrations` (names and SQL) into D1 migration ops, and names the pending migrations in the risk. The approval then binds to that exact code: if the project changes before apply, apply refuses with `source_changed`. Optional: `claudeflare snapshot <id>` captures the current state of every touched resource for a draft plan, which helps you show an exact before state.

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

Run it with a Bash timeout of 600000 ms: a wrangler op may take up to 5 minutes plus the health check, and a killed apply leaves the plan half run (see the recovery note below). The guard then shows a native permission prompt listing the ops; the user confirms there. Apply only works in an interactive session; in a headless run it is denied by design, so tell the user to apply from an interactive session. If the guard denies apply (not approved, expired, plan changed), tell the user why and ask for a fresh `/claudeflare:approve <plan-id>`.

`claudeflare apply` takes a snapshot, runs the ops in order and prints JSON with `status` and per-op `results`:

- `applied`: continue with verification.
- `failed`: the first op failed, so no write was made. Report the error. Never retry silently.
- `partially_applied`: apply stopped at the first failed op. Report which ops succeeded and the error, then offer a rollback (5.7). Never retry silently.
- `applied_check_failed`: the ops ran but a health check failed and nothing was reverted. Show the check result and offer a rollback plan.
- `rolled_back_auto`: a health check failed and that op was reverted automatically (`on_failed_check`). Verify the revert; offer a rollback plan for earlier ops in the same plan.

Wrangler op results carry `version_id` (deploys) or `resource_id` (KV namespace creates). A failed wrangler op is `wrangler_failed`; a timed-out deploy or a failed `d1 migrations apply` may have partly applied, so read the current state before anything else. Risk notes added during apply (`rollback_not_empty`, `rollback_ambiguous`, `kv_id_unknown`) appear in the plan's `risk_notes`; tell the user each one.

After apply, show the user every `advisory_lockout` line of the printed result: a `Lockout risk:` line first found at apply that did not stop it (`claudeflare apply` also prints each one on stderr, before any error JSON).

### 5.6 Verify

Re-read each changed resource through MCP (GET) and compare with the plan. Where useful, check live behavior with `curl -sI` (for example a redirect now returns 301 to the right target). Report the result with evidence.

### 5.7 Rollback

```
claudeflare rollback <plan-id>
```

This only creates a new draft rollback plan from the snapshot's inverse ops; it changes nothing yet. Present it (5.4), get a new `/claudeflare:approve <rollback-plan-id>` from the user, then `claudeflare apply <rollback-plan-id>` and verify. Only applied or partially applied plans can be rolled back.

- Rollback restores the values in the snapshot taken before the original plan ran, even if later plans changed the same resource since. Read the current state first and tell the user which later changes it would undo.
- If a rollback plan ends `partially_applied`, do not roll back the rollback or retry it. Read the current state of every touched resource and draft a fresh plan for what still differs.
- Account plans: a Worker deploy is reverted by redeploying the previous version (or deleting a Worker the plan created, only while it holds just the plan's versions), a Pages deploy by rolling back to the previous production deployment, a D1 migration by a Time Travel restore to the bookmark taken before it (writes after the bookmark are lost; say so). Creates are reverted only when the resource is verifiably empty; otherwise the rollback skips it with `rollback_not_empty`. Queue and D1 creates are never auto-deleted. Deletes and secret changes cannot be rolled back. Bindings and data are never rolled back by a Worker rollback.

## 6. Plans and local state

- `claudeflare plan list` lists plans; `claudeflare plan show <id>` prints one plan.
- `claudeflare report --file <audit.json> --zone <zone>` writes the audit report and prints `{ "file", "overall", "domains" }` (cf-audit section 7).
- Read plans only through these commands. Files under `.claudeflare/` and `~/.config/claudeflare/` are off-limits to file and shell tools; the guard denies access. Do not try other paths to them.

## 7. Errors

Errors print as `{ "error": { "code", "message", "hint" } }` on stderr.

| Code or case | What to do |
|---|---|
| `permission` (Cloudflare 9109 or 10000) | Name the missing permission from the hint and point to `docs/token-template.md`. Do not guess or retry. |
| `missing_token` | Writes and `claudeflare get` need `CLOUDFLARE_API_TOKEN`. Point the user to `/claudeflare:setup`. Never ask the user to paste a token into chat. |
| `plan_conflict` | Two ops in one plan touch the same resource; split into separate plans (5.2). |
| `not_draft` | The plan already ran or was rolled back; create a new plan for further changes. |
| `not_approved` | Ask the user for a fresh `/claudeflare:approve <plan-id>`. |
| `apply_failed` | Report the status and failed op. `partially_applied`: offer `claudeflare rollback <id>`. `failed`: no write was made; fix the cause and create a new plan. |
| `rollback_ambiguous` | The snapshot cannot identify what to restore; read the current state and draft a fresh plan by hand. |
| `nothing_to_rollback` | No applied op of that plan can be reversed; tell the user and stop. |
| `not_applied` | Only applied or partially applied plans can be rolled back; check `claudeflare plan show <id>`. |
| `snapshot_exists` | Apply already started for this plan once; do not retry (see the recovery note below). |
| `invalid_zone` | Fix `zone_id` (32 hex chars) or `zone_name` from discovery and create the plan again. |
| `invalid_op` | An op leaves the plan's zone, creates a Page Rule, keeps a placeholder or uses an odd method; fix the draft with real ids under `/zones/{zone_id}/`. |
| `rollback_stale` | The source plan was already rolled back; read the current state and draft a fresh plan if a change is still needed. |
| `bad_key` | The approval key file is damaged; tell the user to delete the file named in the hint, then approve again. |
| `rate_limit` | Cloudflare kept returning 429 after retries; wait a minute, then retry the read. Never retry an apply; check the plan status first. |
| `invalid_account` | Fix `account_id` (32 hex chars), `account_name` or `project_dir` (absolute path to an existing directory) and create the plan again. |
| `preflight_failed` | Run `claudeflare preflight --file <draft>` for the full report; fix each failed check before planning again. |
| `source_changed` | The project changed after approval. Create and approve a new plan for the current code. |
| `source_hash_missing` | A deploy, Pages deploy or migration op has no source hash; create the plan with `claudeflare plan new`, never by hand. |
| `secret_env_missing` | Ask the user to export the named variable in the shell that runs `claudeflare apply`. Never ask for the value. |
| `account_mismatch` | The token cannot read the plan's account; use a token for that account. |
| `wrangler_missing` / `wrangler_version` | Ask the user to add wrangler 4 to the project (`npm i -D wrangler@4`). |
| `wrangler_failed` | Report the wrangler error from the message. Read the current state before planning again; never retry an apply. |
| `snapshot_failed` | A read before the first write failed (for example `pages deploy` without `--project-name`, or no D1 bookmark); nothing was written and the approval is kept. Fix the cause and apply again; if the op itself is wrong, create and approve a new plan. |
| `empty_project` / `project_too_large` | The source hash found no files, or more than the file limit; check `project_dir` points at the project root. |
| `resource_not_empty` | The R2 bucket still has objects; the user must empty it first. |
| `invalid_config` | The wrangler config could not be read (or lacks the `--env` section); fix the config or the op. |
| `rollback_not_empty` (risk note) | A created resource was not deleted because it is not verifiably empty; tell the user to delete it by hand if it should go. |
| `rollback_ambiguous` (risk note) | A created Worker was not deleted because it has versions this plan did not create. |
| Feature needs a higher plan | Say so and offer the best alternative on the current plan. |
| MCP unavailable | Use `claudeflare get` if a token exists; otherwise guide the user through `/claudeflare:setup`. |

Recovery: if an apply was interrupted after it started (the plan is still `draft` but `claudeflare apply` reports `snapshot_exists`), do not retry. Some ops may have run. Tell the user, read the current state of every touched resource, and draft a fresh plan for what still differs.
