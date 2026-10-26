---
name: cf-storage
description: Cloudflare storage checklist for one account. R2 buckets, KV namespaces, D1 databases, Queues and Durable Objects, and the Worker bindings that use them. D1 migrations and Time Travel, create and delete plans, public r2.dev access, missing dead letter queues and data-loss traps. Load it when auditing storage, creating or deleting a bucket, namespace, database or queue, applying D1 migrations, restoring a D1 database, or wiring a binding. Load cf-core first.
---

# cf-storage: R2, KV, D1, Queues, Durable Objects

Load `cf-core` first. Findings use the `cf-audit` finding format and severity scale. Storage resources are account-scoped: every write is an account plan with `wrangler` ops (cf-core 5.2.2). In the MCP examples below, replace `ACCOUNT_ID` with the real account id (32 hex characters) and `DATABASE_ID`, `BUCKET_NAME`, `SCRIPT_NAME` with real values from the reads; the guard needs literal paths.

## Read current state

| What | GET path or read-only command |
|---|---|
| D1 databases (`uuid`, `name`, `version`, `created_at`) | `/accounts/{account_id}/d1/database`, or `wrangler d1 list --json` |
| One D1 database (`version: production` supports Time Travel, `alpha` does not) | `wrangler d1 info <db> --json` |
| Current Time Travel bookmark | `/accounts/{account_id}/d1/database/{database_id}/time_travel/bookmark`, or `wrangler d1 time-travel info <db> --json` |
| Unapplied D1 migrations (run in the project) | `wrangler d1 migrations list <db> --remote` |
| R2 buckets | `/accounts/{account_id}/r2/buckets`, or `wrangler r2 bucket list` |
| r2.dev public access of one bucket (`bucketId`, `domain`, `enabled`) | `/accounts/{account_id}/r2/buckets/{bucket_name}/domains/managed` |
| Custom domains of one bucket | `/accounts/{account_id}/r2/buckets/{bucket_name}/domains/custom` |
| KV namespaces (`id`, `title`) | `/accounts/{account_id}/storage/kv/namespaces`, or `wrangler kv namespace list` |
| Queues with producers and consumers | `/accounts/{account_id}/queues`, or `wrangler queues list` |
| Consumers of one queue (`dead_letter_queue`, `settings.max_retries`) | `/accounts/{account_id}/queues/{queue_id}/consumers` |
| Durable Object namespaces (`class`, `script`, `use_sqlite`) | `/accounts/{account_id}/workers/durable_objects/namespaces` |
| Worker scripts | `/accounts/{account_id}/workers/scripts` |
| Bindings of one Worker (`type`: `d1`, `kv_namespace` with `namespace_id`, `r2_bucket` with `bucket_name`, `queue` with `queue_name`, `durable_object_namespace` with `class_name`) | `/accounts/{account_id}/workers/scripts/{script_name}/settings` |
| Pages Functions bindings (`deployment_configs.production` and `.preview`: `kv_namespaces`, `d1_databases`, `r2_buckets`, `queue_producers`) | `/accounts/{account_id}/pages/projects/{project_name}` |

MCP `execute`:

```js
async () => {
  const d1 = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/d1/database" });
  const r2 = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/r2/buckets" });
  const kv = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/storage/kv/namespaces", query: { per_page: 100 } });
  const queues = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/queues" });
  return { d1: d1.result, r2: r2.result, kv: kv.result, queues: queues.result };
}
```

Per resource, one call each:

```js
async () => {
  const devUrl = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/r2/buckets/BUCKET_NAME/domains/managed" });
  const bookmark = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/d1/database/DATABASE_ID/time_travel/bookmark" });
  const settings = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/workers/scripts/SCRIPT_NAME/settings" });
  return { devUrl: devUrl.result, bookmark: bookmark.result, bindings: settings.result.bindings };
}
```

Fallback: `claudeflare get /accounts/ACCOUNT_ID/d1/database` and the same for the other paths. Read the wrangler config of the project (`wrangler.jsonc`, `wrangler.json` or `wrangler.toml`) for the declared bindings, `migrations_dir` (default `migrations/`) and `migrations_table` (default `d1_migrations`).

## Checks

| finding id | condition | severity | recommended | plan tier |
|---|---|---|---|---|
| `d1.time_travel.unused_before_migration` | Remote D1 migrations are about to run (or ran) without a recorded Time Travel bookmark from just before them: the user applies migrations outside claudeflare (CI step or a manual `d1 migrations apply --remote`) and no bookmark is noted, or the database reports `version: alpha` (no Time Travel at all). | high | Apply remote migrations only through a claudeflare plan (the snapshot records the bookmark); give the user the bookmark | free |
| `d1.migrations.pending` | `wrangler d1 migrations list <db> --remote` lists unapplied migrations while the deployed Worker code already expects them (or the user does not know why they are pending). | medium | No pending migrations; apply them in a plan before or with the deploy that needs them | free |
| `r2.bucket.public_dev_url` | `domains/managed` returns `enabled: true`. Every object is public at `https://<domain>/<key>`, rate-limited, and bypasses WAF, Access and cache rules on custom domains. | medium (high when the bucket holds private data) | `enabled: false`; serve public content through a custom domain | free |
| `kv.namespace.unused` | A KV namespace `id` appears in no Worker binding (`kv_namespace` `namespace_id`) and no Pages project `kv_namespaces` (production or preview), and the user confirms nothing else uses it (for example REST clients). | low | Delete it after the user confirms, or document its owner | free |
| `queues.dlq.missing` | A consumer has no `dead_letter_queue`. Messages that still fail after `max_retries` (default 3) are deleted permanently. | medium | `dead_letter_queue` set on every consumer, with a consumer or alert on the DLQ | free |

Notes for findings:

- `d1.time_travel.unused_before_migration`: Time Travel is always on for `version: production` databases; the gap is the missing bookmark, not a setting. Retention is 30 days on Workers Paid and 7 days on Workers Free. `wrangler d1 migrations apply` also captures its own backup, but only a bookmark taken right before gives a known restore point. For `version: alpha` databases, say the database uses the legacy snapshot backups and set `fix: []`.
- `d1.migrations.pending`: include the pending file names and their SQL in `reason`. The fix is a plan with a `d1 migrations apply` op (Applying changes); preflight lists the pending migrations again and claudeflare embeds them in the plan.
- `r2.bucket.public_dev_url`: claudeflare has no op for it, so `fix: []`. Tell the user: R2, select the bucket, Settings, Public Development URL, Disable, type `disallow` to confirm. Connected custom domains keep working. Ask first whether something depends on the `r2.dev` URL.
- `kv.namespace.unused`: never delete on this finding alone. A preview namespace (`--preview`) or a namespace used only through the REST API looks unused. The fix is a delete op with `confirm_name` and a data-loss risk line.
- `queues.dlq.missing`: the fix is a config edit in the consumer Worker's wrangler file (the user's file, with consent) plus a deploy plan for that Worker (cf-workers). If the named DLQ does not exist, Cloudflare creates it automatically.

## Applying changes

Use the change protocol from cf-core (account scope): draft, `claudeflare preflight --file draft.json`, `claudeflare plan new --file draft.json`, user approval, `claudeflare apply <id>`. Ops below go into the `ops` array of an account draft.

Apply D1 migrations (reversible through the Time Travel bookmark the snapshot records; claudeflare adds `source_hash` and `pending_migrations`):

```json
{ "kind": "wrangler", "args": ["d1", "migrations", "apply", "prod-db", "--remote"] }
```

Before planning: run `wrangler d1 migrations list prod-db --remote` and `wrangler d1 time-travel info prod-db --json`, show the user the pending SQL and the current bookmark. The risk says: rolling back restores the bookmark and discards every write made after it, including real user data written between apply and rollback. If a migration fails, D1 rolls back that migration and the earlier ones in the run stay applied; read `migrations list` again before anything else.

Restore a D1 database to a bookmark (reversible: the snapshot records the current bookmark):

```json
{ "kind": "wrangler", "args": ["d1", "time-travel", "restore", "prod-db", "--bookmark", "00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683"] }
```

The restore overwrites the database in place, cancels in-flight queries and discards all writes after the bookmark. Bookmarks older than the retention window cannot be used. Put both facts in the risk.

Create resources (`resource_create`; the rollback deletes a created KV namespace or R2 bucket only while it is still empty, else `rollback_not_empty`; Queue and D1 creates are never auto-deleted):

```json
{ "kind": "wrangler", "args": ["d1", "create", "prod-db", "--location", "weur"] }
{ "kind": "wrangler", "args": ["r2", "bucket", "create", "media"] }
{ "kind": "wrangler", "args": ["kv", "namespace", "create", "CACHE"] }
{ "kind": "wrangler", "args": ["queues", "create", "jobs"] }
```

Never add `--update-config`, `--binding` or `--use-remote` to a create op (not allowlisted; claudeflare does not edit the user's config). After apply, read the new id (`resource_id` in the KV op result, `wrangler d1 info prod-db --json` for the D1 `uuid`), then propose the binding diff in chat, for example for `wrangler.jsonc`:

```jsonc
"kv_namespaces": [{ "binding": "CACHE", "id": "<resource_id>" }],
"d1_databases": [{ "binding": "DB", "database_name": "prod-db", "database_id": "<uuid>" }],
"r2_buckets": [{ "binding": "MEDIA", "bucket_name": "media" }],
"queues": { "producers": [{ "binding": "JOBS", "queue": "jobs" }], "consumers": [{ "queue": "jobs", "max_retries": 3, "dead_letter_queue": "jobs-dlq" }] }
```

Editing the user's wrangler file is a normal file edit with the user's consent, outside `claudeflare apply`. The binding takes effect with the next Worker deploy plan (cf-workers). If `kv_id_unknown` appears in `risk_notes`, read `wrangler kv namespace list` and match the title.

Delete resources (`resource_delete`, not reversible; each op needs `confirm_name` equal to the resource name, for KV the namespace id):

```json
{ "kind": "wrangler", "args": ["r2", "bucket", "delete", "media"], "confirm_name": "media" }
{ "kind": "wrangler", "args": ["kv", "namespace", "delete", "--namespace-id", "0f2ac74b498b48028cb68387c421e279"], "confirm_name": "0f2ac74b498b48028cb68387c421e279" }
{ "kind": "wrangler", "args": ["queues", "delete", "jobs"], "confirm_name": "jobs" }
{ "kind": "wrangler", "args": ["d1", "delete", "prod-db"], "confirm_name": "prod-db" }
```

- R2: plan creation refuses a bucket that still has objects (`resource_not_empty`). The user empties it first; claudeflare has no object delete op.
- KV, Queue, D1: the delete removes all keys, pending messages or rows. claudeflare adds a `Not reversible:` line; add a risk line naming what is lost (key count, queue backlog, table names and row counts you read). For D1, Time Travel cannot bring back a deleted database; suggest `wrangler d1 export` by the user first.
- Before any delete, list the Workers and Pages projects that bind the resource (Read current state) and remove those bindings with a deploy first, or the next deploy of the Worker fails and rollbacks to versions with that binding are refused.

Durable Objects: there is no create or delete op. A class is created, renamed, transferred or deleted by a Worker deploy, through `exports` (current) or the legacy `migrations` array in the wrangler config (one or the other, never both). Treat every deploy that changes them as data-relevant.

## Traps

- A Worker rollback never rolls back data or bindings: D1 rows, KV keys, R2 objects and Durable Object storage stay as they are. Rollback to a version is refused when a bound R2 bucket, KV namespace or queue no longer exists, or when a Durable Object lifecycle change happened in between.
- Rolling back a D1 migration means a Time Travel restore, which discards every write after the bookmark. If the app took writes since, say so in numbers (time since apply) and offer a forward fix migration instead.
- `wrangler d1 migrations apply` in a non-interactive shell skips its confirmation. Never let CI or a script apply remote migrations without a bookmark noted (`d1.time_travel.unused_before_migration`).
- Run migrations by database name, not binding name: binding names change between environments, database names do not.
- A Durable Object `deleted` tombstone in `exports` (or `deleted_classes` in legacy `migrations`) deletes the namespace and all its stored data permanently on deploy; there is no trash. A deploy plan with such a change gets a `Not reversible:` risk line written by you, and the user copies the data out first.
- Durable Object storage backend (`sqlite` or `legacy-kv`) cannot change in place. New namespaces should use `sqlite`.
- Bindings such as `kv_namespaces`, `r2_buckets`, `queues`, `durable_objects` and `services` are not inherited by `env.<name>` blocks in the wrangler config. A resource bound at the top level is missing in `--env production` unless declared there too.
- r2.dev URLs are rate-limited and meant for development only; WAF, Access and cache rules on a custom domain do not protect the r2.dev URL while it is enabled.
- Queue consumers without a DLQ lose messages silently after `max_retries`. Message retention defaults to 4 days (`--message-retention-period-secs`, 60 to 86400 seconds on the free tier, up to 1209600 on paid).
- KV writes are eventually consistent across locations; do not verify a KV change by reading it from another location right away.
- A delete op on a resource another Worker still binds breaks that Worker's next deploy. Check every binding reader, including Pages projects, before planning a delete.

## Sources

- https://developers.cloudflare.com/d1/reference/time-travel/
- https://developers.cloudflare.com/d1/reference/migrations/
- https://developers.cloudflare.com/workers/wrangler/commands/d1/
- https://developers.cloudflare.com/workers/wrangler/commands/r2/
- https://developers.cloudflare.com/workers/wrangler/commands/kv/
- https://developers.cloudflare.com/workers/wrangler/commands/queues/
- https://developers.cloudflare.com/r2/buckets/public-buckets/
- https://developers.cloudflare.com/r2/buckets/create-buckets/
- https://developers.cloudflare.com/queues/configuration/dead-letter-queues/
- https://developers.cloudflare.com/queues/configuration/configure-queues/
- https://developers.cloudflare.com/kv/concepts/kv-namespaces/
- https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/
- https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/list/
- https://developers.cloudflare.com/api/resources/d1/subresources/database/subresources/time_travel/methods/get_bookmark/
- https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/list/
- https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/domains/subresources/managed/methods/list/
- https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/list/
- https://developers.cloudflare.com/api/resources/queues/methods/list/
- https://developers.cloudflare.com/api/resources/queues/subresources/consumers/methods/list/
- https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/methods/list/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/
- https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/get/
