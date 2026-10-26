---
name: cf-load-balancing
description: Cloudflare Load Balancing checklist. Account monitors and pools, zone load balancers, pool health and the pool preview. Load it when creating or changing a monitor, pool or load balancer, disabling origins, auditing Load Balancing, or diagnosing a load balancer with no healthy pool. Load cf-core first.
---

# cf-load-balancing: monitors, pools, load balancers

Load `cf-core` first. Findings use the `cf-audit` finding format and severity scale. Load Balancing spans two scopes, and a plan never mixes them:

- Monitors and pools live on the account: plans use `"scope": "account"`, hold only REST ops (no `project_dir` needed) and use `/accounts/{account_id}/load_balancers/monitors` and `/accounts/{account_id}/load_balancers/pools`.
- Load balancers live on a zone: plans use the zone form (`zone_id`, `zone_name`) and `/zones/{zone_id}/load_balancers`. claudeflare writes only this zone form, never the user-level `/user/load_balancers/...` paths.

A change that needs both (a new pool and a load balancer that uses it) is two plans: the account plan first, then the zone plan with the new pool id. In the MCP examples below, replace `ACCOUNT_ID` and `ZONE_ID` (32 hex characters) and `POOL_ID` (32 hex characters) with real values from cf-core discovery and the reads; the guard needs literal paths.

Load Balancing is a paid add-on. Preflight checks it first: the pools list must be readable and, for a zone plan, the zone's load balancer list reachable. Otherwise it reports `not_entitled` and the user enables the add-on in the dashboard (Traffic, Load Balancing). A 403 is `missing_permission` and names `Load Balancing: Monitors and Pools` (account) or `Load Balancers` (zone).

## Read current state

| What | Source |
|---|---|
| Monitors (`type`, `description`, `path`, `interval`, `timeout`, `retries`, `expected_codes`) | GET `/accounts/{account_id}/load_balancers/monitors` |
| Pools (`name`, `enabled`, `monitor`, `origins` with `address` and `enabled`, `minimum_origins`, `check_regions`) | GET `/accounts/{account_id}/load_balancers/pools` |
| What uses a pool or monitor (`reference_type` `referrer` entries are users; a `referral` is what the pool itself uses) | GET `/accounts/{account_id}/load_balancers/pools/{pool_id}/references`, `.../monitors/{monitor_id}/references` |
| Pool health per region (`pop_health`) | GET `/accounts/{account_id}/load_balancers/pools/{pool_id}/health` |
| Load balancers of a zone (`name` is the hostname, `default_pools`, `fallback_pool`, `region_pools`, `pop_pools`, `country_pools`, `steering_policy`, `enabled`, `proxied`) | GET `/zones/{zone_id}/load_balancers` |

MCP `execute`:

```js
async () => {
  const monitors = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/load_balancers/monitors" });
  const pools = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/load_balancers/pools" });
  const health = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/load_balancers/pools/POOL_ID/health" });
  const lbs = await cloudflare.request({ method: "GET", path: "/zones/ZONE_ID/load_balancers" });
  return { monitors: monitors.result, pools: pools.result, health: health.result, lbs: lbs.result };
}
```

Fallback: `claudeflare get /accounts/ACCOUNT_ID/load_balancers/pools`. Collections page with `page` and `per_page`; read every page before concluding that a pool or monitor is unused.

The pool preview (POST `.../pools/{pool_id}/preview`) is not available through MCP `execute` or `claudeflare get`: only preflight sends it (see Applying changes).

## Checks

| finding id | condition | severity | recommended | plan tier |
|---|---|---|---|---|
| `lb.pool.no_monitor` | A pool with `monitor` empty or null: Cloudflare never health checks it, keeps sending traffic to dead origins and never fails over. | high | Attach a monitor | paid add-on |
| `lb.monitor.interval_short` | A monitor with `interval` below 60 seconds (the default): probes from every checked region hit the origins more often, and short outages flap the pool health. | low | Raise `interval` to 60 unless fast failover is required | paid add-on |
| `lb.fallback.missing` | A load balancer whose `fallback_pool` is also one of its `default_pools`, or a disabled pool: when the default pools fail there is no separate pool left to serve. | medium | Point `fallback_pool` at a separate, enabled pool | paid add-on |
| `lb.pool.single_origin` | A pool with one enabled origin: one origin failure makes the pool critical. | medium | Add a second origin, or a second pool to the load balancer | paid add-on |

Notes for findings:

- `lb.pool.no_monitor`: `fix` is a PUT of the whole pool with `monitor` set to an existing monitor id (create one first with an account plan if none fits).
- `lb.monitor.interval_short`: `fix` is a PUT of the whole monitor with the new `interval`.
- `lb.fallback.missing`: `fix` is a PUT of the whole load balancer (zone plan) with a different `fallback_pool`.
- `lb.pool.single_origin`: `fix` is a PUT of the whole pool with the added origin. Ask the user for the origin address; never invent one.

## Applying changes

Use the change protocol from cf-core: draft, `claudeflare preflight --file draft.json`, `claudeflare plan new --file draft.json`, user approval, `claudeflare apply <id>`. Show the plan's `Lockout risk:` lines and notes to the user before approval; they are part of what the user approves. Updates are PUT and replace the whole resource: read it first and send every field that should stay.

| Op | Path | Rollback |
|---|---|---|
| Monitor create, update, delete (account plan) | POST `/accounts/ACCOUNT_ID/load_balancers/monitors`, PUT or DELETE `.../monitors/MONITOR_ID` (delete takes `confirm_name` = `description`, or the monitor id when the description is empty) | Delete the new monitor; PUT the old monitor; re-create with a new id |
| Pool create, update, delete (account plan) | POST `/accounts/ACCOUNT_ID/load_balancers/pools`, PUT or DELETE `.../pools/POOL_ID` (delete takes `confirm_name` = `name`) | Delete the new pool; PUT the old pool; re-create with a new id |
| Load balancer create, update, delete (zone plan) | POST `/zones/ZONE_ID/load_balancers`, PUT or DELETE `.../load_balancers/LB_ID` (delete takes `confirm_name` = `name`, the hostname) | Delete the new load balancer; PUT the old one; re-create with a new id |

Every rollback first re-reads the resource and compares it with the state recorded after apply; a change made since then skips that inverse with `rollback_drift`.

Refused at `plan new` (`invalid_op`): a monitor body with an unknown `type` or a non-numeric `interval`, `timeout`, `retries` or `port`; a pool body without `name` or a non-empty `origins` list, an origin without `address`, a `weight` outside 0 to 1, a non-boolean `enabled`, `minimum_origins` below 1, a `monitor` that is not a monitor id; a load balancer body without `name`, a non-empty `default_pools` list of pool ids or a `fallback_pool`; Cloudflare-set fields (`id`, `created_on`, `modified_on`, `disabled_at`); PATCH on monitors and pools; PATCH on a load balancer (zone plans refuse any write under `/zones/{zone_id}/load_balancers` that is not exactly one of the POST, PUT or DELETE paths above, with lowercase ids and no trailing slash or percent-encoding: use PUT with the whole load balancer); an account plan with a zone path or a zone plan with an account path. Refused at preflight (`resource_in_use`): deleting a monitor or pool whose `references` list a `referrer` (a pool using the monitor, a load balancer using the pool). Pools the same plan deletes or moves to another monitor before the monitor delete do not count. A pool still used by a load balancer needs a zone plan that removes it from the load balancer first.

### Attach a monitor to a pool (the usual request)

```json
{
  "scope": "account",
  "account_id": "0123456789abcdef0123456789abcdef",
  "account_name": "Acme",
  "summary": "Health check pool web-backup with the login page monitor",
  "risk": "Cloudflare starts probing 198.51.100.20 every 60 seconds; if the probe fails, www.example.com stops sending traffic to this pool.",
  "slug": "lb-pool-monitor",
  "ops": [
    {
      "method": "PUT",
      "path": "/accounts/0123456789abcdef0123456789abcdef/load_balancers/pools/b0000000000000000000000000000002",
      "body": {
        "name": "web-backup",
        "enabled": true,
        "minimum_origins": 1,
        "monitor": "a0000000000000000000000000000001",
        "origins": [
          { "name": "backup-1", "address": "198.51.100.20", "enabled": true, "weight": 1 }
        ]
      }
    }
  ]
}
```

### Pool preview

For every pool a plan changes (account plan) and every pool a load balancer write adds (zone plan, plus the single pool of a one-pool load balancer), preflight sends POST `.../pools/{pool_id}/preview` with the pool's monitor settings and reads the result once from GET `/accounts/{account_id}/load_balancers/preview/{preview_id}`. The result becomes a plan note: healthy, critical with the failure reasons, or `preview skipped: <reason>` (no monitor, a new pool without an id yet, a token without `Load Balancing: Monitors and Pools Edit`, or no result yet because the preview runs asynchronously). The preview probes the origins the pool has now, not the ones the PUT sends. It is advisory and never blocks a plan. It is the only non-GET call a preflight makes, and the agent never sends it itself.

### Lockout risk lines

These never refuse a plan; they are shown at `plan new` and checked again at apply (a new line stops apply with `risk_changed`):

1. A pool update that leaves no enabled origin, or sets `minimum_origins` above the enabled origins: the pool goes critical. The line names the load balancers that use it.
2. A pool update that disables the last usable pool of a load balancer (every other pool of it is disabled or critical too): visitors get errors.
3. A load balancer create or update whose pools are all disabled or without enough enabled origins.
4. A load balancer with one pool that the preview found critical. The failure reasons are in the preview note, not in the line. Because the preview runs asynchronously, this line is advisory: if it first appears at apply, apply shows it but does not stop with `risk_changed`.

### Notes on deletes

- Deleting a load balancer: its hostname stops resolving through the load balancer and answers only from a DNS record of the same name, if one exists. A rollback re-creates it with a new id.
- Re-creating a pool or monitor gives it a new id; resources written later must use the new id.

### Verification

After apply claudeflare reads each changed monitor, pool and load balancer back and compares it with the sent body. For a created or updated pool it also waits, within the verification timeout, until the pool health endpoint reports every region healthy. That wait is skipped (and reported as skipped) when it could only fail: the pool has no monitor, the pool is disabled, every origin is disabled, `minimum_origins` is above the enabled origins, or the preview already found the pool critical. A failed check sets `applied_verify_failed` and drafts a rollback plan that still needs approval.

## Traps

- PUT replaces the whole pool or load balancer: an origin or pool left out of the body is removed.
- A pool without a monitor is always treated as healthy, so a dead origin keeps getting traffic.
- `minimum_origins` above the number of enabled origins makes the pool critical even when every origin is up.
- A pool used by a load balancer cannot be deleted; remove it from the load balancer first (zone plan), then delete it (account plan).
- The fallback pool serves when every default pool is critical; if it is one of the default pools, there is no fallback.
- Re-creating a pool, monitor or load balancer gives it a new id.
- Monitors and pools are account resources and load balancers are zone resources: two plans, never one.

## Sources

- Load Balancing API: developers.cloudflare.com/api/resources/load_balancers/
- Pool health: developers.cloudflare.com/api/resources/load_balancers/subresources/pools/subresources/health/
- Pool references: developers.cloudflare.com/api/resources/load_balancers/subresources/pools/subresources/references/
- Previews: developers.cloudflare.com/api/resources/load_balancers/subresources/previews/
- Create a pool: developers.cloudflare.com/load-balancing/pools/create-pool/
- Health details: developers.cloudflare.com/load-balancing/understand-basics/health-details/
- Load Balancing FAQ: developers.cloudflare.com/load-balancing/troubleshooting/load-balancing-faq/
