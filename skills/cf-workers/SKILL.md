---
name: cf-workers
description: Cloudflare Workers checklist for one account. Compatibility date and flags, observability, placement, routes vs custom domains vs workers.dev, global_fetch_strictly_public and error 1042, CPU limits, versions and gradual deployments, and deploy, versions deploy and rollback plans with health checks. Load it when auditing Workers, reviewing a wrangler config, or deploying or rolling back a Worker. Load cf-core first.
---

# cf-workers: config, routing, limits, versions, deploys

Load `cf-core` first. Findings use the `cf-audit` finding format and severity scale. Workers are account resources: plans use `"scope": "account"`. In the MCP examples below, replace `ACCOUNT_ID` with the real account id (32 hex characters) from cf-core discovery and `WORKER_NAME` with the script name; the guard needs literal paths.

## Read current state

| What | Source |
|---|---|
| All Workers in the account | GET `/accounts/{account_id}/workers/scripts` |
| Settings of one Worker: `compatibility_date`, `compatibility_flags`, `limits.cpu_ms`, `observability`, `placement.mode`, `logpush`, `tail_consumers`, `usage_model` | GET `/accounts/{account_id}/workers/scripts/{script_name}/settings` |
| workers.dev and Preview URL status (`enabled`, `previews_enabled`) | GET `/accounts/{account_id}/workers/scripts/{script_name}/subdomain` |
| Custom Domains (`hostname`, `service`, `zone_name`, `enabled`, `previews_enabled`) | GET `/accounts/{account_id}/workers/domains` |
| Routes of one zone (`pattern`, `script`) | GET `/zones/{zone_id}/workers/routes` |
| Deployment history (`strategy`, `versions[].version_id`, `versions[].percentage`, `annotations`) | GET `/accounts/{account_id}/workers/scripts/{script_name}/deployments`, or `wrangler deployments list --name <w> --json` |
| Versions | `wrangler versions list --name <w> --json`, `wrangler versions view <version-id> --name <w>` |
| Active deployment | `wrangler deployments status --name <w>` |
| Access apps that may protect workers.dev or Preview URLs (`domain`) | GET `/accounts/{account_id}/access/apps` |
| The project's own config | `wrangler.jsonc`, `wrangler.json` or `wrangler.toml` in `project_dir` (local file read) |

MCP `execute`:

```js
async () => {
  const scripts = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/workers/scripts" });
  const settings = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/workers/scripts/WORKER_NAME/settings" });
  const subdomain = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/workers/scripts/WORKER_NAME/subdomain" });
  const domains = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/workers/domains" });
  const deployments = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/workers/scripts/WORKER_NAME/deployments" });
  return { scripts: scripts.result, settings: settings.result, subdomain: subdomain.result, domains: domains.result, deployments: deployments.result };
}
```

Fallback: `claudeflare get /accounts/ACCOUNT_ID/workers/scripts/WORKER_NAME/settings` (same paths). Live logs: `claudeflare tail --worker <name> --seconds 30 --status error` (outcome `exceededCpu` means the CPU limit was hit, error 1102).

Invocation metrics (GraphQL, dataset `workersInvocationsAdaptive`):

```js
async () => {
  const metrics = await cloudflare.request({ method: "POST", path: "/client/v4/graphql", body: { query: `query ($accountTag: string, $scriptName: string, $since: Time, $until: Time) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    workersInvocationsAdaptive(limit: 100, filter: { scriptName: $scriptName, datetime_geq: $since, datetime_leq: $until }) {
      sum { requests errors subrequests }
      quantiles { cpuTimeP50 cpuTimeP99 }
      dimensions { datetime scriptName status }
    }
  } }
}`, variables: { accountTag: "ACCOUNT_ID", scriptName: "WORKER_NAME", since: "2026-10-25T00:00:00Z", until: "2026-10-26T00:00:00Z" } } });
  return metrics;
}
```

## Checks

| finding id | condition | severity | recommended | plan tier |
|---|---|---|---|---|
| `workers.compat_date.stale` | `compatibility_date` is more than 12 months before today (claudeflare threshold, not a Cloudflare rule), or is `2021-11-02` (the default when an API upload sets no date). | low | A recent date, tested locally and on a Preview or gradual deployment first | free |
| `workers.observability.off` | `observability.enabled` is `false` or missing, or `head_sampling_rate` is `0`, and the Worker has no Logpush (`logpush: true`) and no `tail_consumers`. Errors then leave no persisted logs. | medium | `"observability": { "enabled": true }`, with `head_sampling_rate` below `1` for high-traffic Workers | free |
| `workers.global_fetch.missing` | The Worker's code calls `fetch()` on a hostname in its own zone (or a tail sample shows error 1042) and `compatibility_flags` has no `global_fetch_strictly_public`. Without the flag a same-zone fetch to another Worker fails with 1042, and other same-zone fetches go straight to the origin, skipping Workers and Cloudflare security settings. | medium; high when 1042 is observed | Service binding for Worker-to-Worker calls; otherwise add `global_fetch_strictly_public` | free |
| `workers.cpu_limit.near` | `claudeflare tail` or analytics show `exceededCpu` outcomes (error 1102), or the dashboard p99 CPU time is at least 80% of the limit: `limits.cpu_ms` if set, else 10 ms on Workers Free, 30 s on Workers Paid. | high when 1102 is observed, else medium | Optimize the hot path; on Workers Paid raise `limits.cpu_ms` (maximum 300000) | free (Workers Paid to raise the limit) |
| `workers.routes.unprotected_workers_dev` | The Worker serves production on a route or Custom Domain, and the subdomain read shows `enabled: true` (or `previews_enabled: true`) with no Access app covering the `workers.dev` host. The `workers.dev` URL skips the zone's WAF, rate limiting and other zone settings. | medium | `"workers_dev": false` (and `"preview_urls": false` if Preview URLs are unused) in the wrangler config, then a deploy plan; or an Access policy on `workers.dev` | free |
| `workers.versions.no_gradual` | A Worker with a production route or Custom Domain whose last 10 deployments each put one version at 100% (no split in `versions[]`), and deploy plans have no `health_check`. | low | Upload versions without deploying, then `versions deploy` with a small first split; always add `health_check` and `on_failed_check: "rollback"` | free |

Notes for findings:

- `workers.compat_date.stale`: moving the date turns on every flag whose default date has passed, which can change runtime behavior. Read the flags between the old and the new date on the compatibility flags page and list the ones that apply in `risk`.
- `workers.observability.off`: `observability.enabled` defaults to `true` for new Workers, so older Workers may have it off. Judge from the settings read, not from the config file alone.
- `workers.global_fetch.missing`: with the flag on, a same-zone fetch enters Cloudflare like an Internet request and can loop back to the same Worker. Check the route patterns before recommending it. Custom Domains can be fetched from the same zone; Routes cannot be the target of a same-zone `fetch()`.
- `workers.cpu_limit.near`: CPU time excludes time spent waiting on `fetch()`, KV, D1 and other I/O. Confirm the unit of `cpuTimeP50` and `cpuTimeP99` against the dashboard Metrics tab before comparing to the limit; the GraphQL tutorial does not state it.
- `workers.routes.unprotected_workers_dev`: if the config has `routes` and no `workers_dev`, wrangler infers `false` on the next deploy. Disabling `workers.dev` does not disable Version URLs or Preview URLs.
- `workers.versions.no_gradual`: the change protocol cannot upload a version without deploying it (`versions upload` is not an allowlisted op). New versions for a split come from the user's CI (`wrangler versions upload`) or the dashboard; claudeflare then plans the `versions deploy`. Say so in `fix`.
- Placement: `placement.mode: "smart"` helps a Worker that makes several round trips to one backend far from users; it is available on all plans and needs up to 15 minutes of analysis after deploy. Recommend it only with evidence of backend-bound latency; it is not a finding.

## Applying changes

Use the change protocol from cf-core: draft, `claudeflare preflight --file draft.json`, `claudeflare plan new --file draft.json`, user approval, `claudeflare apply <id>`. Config changes (compatibility date and flags, observability, `workers_dev`, `limits`, `placement`) are file edits in the user's wrangler config, made with the user's consent, followed by a deploy plan. Never put `--yes`, `-y`, `--message`, `--dry-run` or `--outdir` in ops; the executor and preflight add them.

Deploy (reversible: the snapshot keeps the previous active version and rollback redeploys it):

```json
{
  "kind": "wrangler",
  "args": ["deploy", "--name", "api"],
  "health_check": { "url": "https://api.example.com/health", "expect_status": 200 },
  "on_failed_check": "rollback"
}
```

Add `"--env", "production"` when the config uses environments. Preflight runs a dry-run build, checks bindings and embeds `source_hash`; changing code after approval fails apply with `source_changed`.

Gradual deployment of an uploaded version (reversible). Shorthand `<version-id>@<percentage>`; omitted percentages share the rest. Take version ids from `wrangler versions list --name <w> --json`:

```json
{
  "kind": "wrangler",
  "args": ["versions", "deploy", "--name", "api", "NEW_VERSION_ID@10%", "CURRENT_VERSION_ID@90%"],
  "health_check": { "url": "https://api.example.com/health", "expect_status": 200 },
  "on_failed_check": "rollback"
}
```

Then one plan per step (for example 50%, then `NEW_VERSION_ID@100%`), each after reading errors with `claudeflare tail` and the GraphQL query above.

Rollback to a known version (reversible; it creates a new deployment at 100%):

```json
{ "kind": "wrangler", "args": ["rollback", "PREVIOUS_VERSION_ID", "--name", "api"] }
```

`claudeflare rollback <plan id>` undoes a deploy, versions deploy or rollback plan by redeploying the version recorded in its snapshot.

Health check and `on_failed_check`: apply sends GET to `health_check.url` (https only) up to 3 times, 5 seconds apart, without following redirects, and expects `expect_status` (default 200). On failure with `"on_failed_check": "rollback"` it runs the inverse at once (status `rolled_back_auto`); without it the status is `applied_check_failed` and you propose a rollback plan. `on_failed_check` is part of the approved ops, so the user approves automatic rollback up front.

After apply, verify with `wrangler deployments status --name <w>`: the expected version and percentage.

## Traps

- A Worker rollback restores code only. Bindings, secrets, D1 rows, KV entries and R2 objects stay as they are; a version that expects a newer schema can break after rollback.
- Rollback targets are limited to the 100 most recent versions.
- During a split, the health check URL hits either version at random, so a 200 does not prove the new version is healthy. Judge each step on tail and GraphQL error rates as well.
- Disabling `workers.dev` in the dashboard is undone by the next wrangler deploy unless the config has `"workers_dev": false`.
- Without a `compatibility_date` on API upload, the Worker runs with the 2021-11-02 behavior.
- `global_fetch_strictly_public` can create a loop: the fetch re-enters the zone and can match the same Worker's route again.
- Raising `limits.cpu_ms` above 10 ms needs Workers Paid; on Workers Free the limit is 10 ms per HTTP request and per Cron Trigger.
- Other per-invocation limits to keep in mind: memory 128 MB, subrequests 50 (Free) or 10,000 (Paid) per request, Worker size 64 MiB, startup time 1 second.
- Direct `wrangler deploy`, `versions deploy` and `rollback` are denied by the guard; always plan them.

## Sources

- https://developers.cloudflare.com/workers/configuration/compatibility-dates/
- https://developers.cloudflare.com/workers/configuration/compatibility-flags/
- https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- https://developers.cloudflare.com/workers/observability/errors/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/configuration/placement/
- https://developers.cloudflare.com/workers/configuration/routing/
- https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/workers/wrangler/commands/workers/
- https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/
- https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/
- https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/get/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
- https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/
- https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/list/
- https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/list/
