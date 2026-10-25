# claudeflare v2 (0.2.0): Developer Platform Design Spec

- Date: 2026-10-25
- Status: Draft, awaiting review
- Builds on: `docs/superpowers/specs/2026-10-24-claudeflare-design.md` (v1). Everything in v1 stays binding unless this spec changes it.

## 1. Goal

Extend claudeflare from zone management to the full lifecycle of the Cloudflare developer platform: Workers, Pages, R2, D1, KV, Queues (and Durable Objects as Worker bindings). The agent audits and troubleshoots these resources, and performs deploys, rollbacks and resource changes through the same plan, approval and apply protocol as v1.

### Success criteria

1. `/claudeflare:audit` covers developer platform domains (workers, pages, storage) when the project or account has them.
2. A Worker deploy goes through plan, approval and `claudeflare apply`, records the previous version, verifies a health check, and can be rolled back with `/claudeflare:rollback`.
3. A D1 migration records a Time Travel bookmark first and can be reverted to it.
4. Secret values never appear in plans, snapshots, logs, chat or evals.
5. `/claudeflare:diagnose` reaches a root cause for Worker errors 1101, 1102, 1042, missing bindings, memory limits and Pages build failures.
6. Unit tests use a fake wrangler and pass in CI without a Cloudflare account; three new eval cases pass.

### Non-goals (v2)

- Zero Trust and network products (v3).
- Writing or refactoring the user's application code. The agent may suggest code fixes in chat; claudeflare's write path covers deploys and Cloudflare resources only.
- Running `wrangler dev` or local emulation.
- Workers for Platforms, Containers, Workflows management (may come later).

## 2. Verified platform facts (2026-10-25)

Sources in section 12.

- Latest wrangler is 4.152.0. Recommended invocation is a project-local `npx wrangler`. Non-interactive auth: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Telemetry off: `WRANGLER_SEND_METRICS=false`.
- In non-interactive mode wrangler's confirmation prompts take their fallback answer, which defaults to **yes**. claudeflare must therefore never let wrangler decide: every destructive intent is explicit in the approved plan.
- `wrangler deploy --dry-run --outdir <dir>` builds without uploading and prints the upload size. Byte-for-byte determinism of the output is not documented.
- `wrangler deploy` has no `--json`, but `WRANGLER_OUTPUT_FILE_PATH` writes ND-JSON entries (`deploy` with `version_id`, `targets`, `worker_name`; `version-upload`; `version-deploy`).
- `wrangler deployments list --json`, `versions list --json` exist.
- `wrangler rollback [version-id] --message <m> --yes` creates a new deployment at 100% traffic. Bindings (D1, KV, R2 contents) are not rolled back.
- Pages: `wrangler pages deployment list --json`; no CLI rollback; API `POST /accounts/{account_id}/pages/projects/{project}/deployments/{deployment_id}/rollback` (only successful production deployments are targets).
- D1 Time Travel: `d1 time-travel info <db> --json` returns the current bookmark; `d1 time-travel restore <db> --bookmark <b> --json`; retention 30 days Paid, 7 days Free. `d1 migrations apply <db> --remote` takes its own backup and skips confirmation in non-interactive mode.
- `wrangler secret put <name>` reads the value from stdin when stdin is not a TTY. `secret list --format json`.
- Create: `r2 bucket create`, `kv namespace create`, `queues create`, `d1 create` (no JSON output on create). Delete: `r2 bucket delete`, `kv namespace delete --namespace-id <id> -y`, `queues delete`, `d1 delete <name> -y`. KV, Queue and D1 delete appear to remove contents without refusing.
- `wrangler tail --format json [--status error] [--sampling-rate n]` streams until killed.
- Limits: Worker size 64 MiB uncompressed (Free and Paid); CPU 10 ms Free, 30 s default Paid (up to 5 min). Errors: 1101 uncaught exception, 1102 CPU limit exceeded, 1042 same-zone Worker fetch without `global_fetch_strictly_public`.
- GraphQL `workersInvocationsAdaptive` under `viewer.accounts(filter: {accountTag})`, filters `scriptName`, `datetime_geq/leq`; fields `sum {requests errors subrequests}`, `quantiles {cpuTimeP50 cpuTimeP99}`, `dimensions {datetime scriptName status}`.

## 3. Architecture changes

### 3.1 Plan scope: zone or account

v1 plans are bound to one zone (`zone_id`, op paths under `/zones/<zone_id>/`). Developer platform resources are account-scoped. Plans gain a scope:

```json
{ "scope": "zone", "zone_id": "...", "zone_name": "example.com" }
{ "scope": "account", "account_id": "...", "account_name": "Acme", "project_dir": "/abs/path" }
```

- `scope` defaults to `zone` for v1 plans (backward compatible).
- Account plans may contain `wrangler` ops and REST ops under `/accounts/<account_id>/` limited to an allowlist (section 3.3). A plan never mixes scopes.
- Plan id prefix for account plans: account name normalized like zone-short (`acme-20261025-101500-deploy-api`). State paths use the account name in place of the zone name.

### 3.2 New op kind: `wrangler`

```json
{
  "kind": "wrangler",
  "args": ["deploy", "--env", "production"],
  "worker": "api",
  "health_check": { "url": "https://api.example.com/health", "expect_status": 200 },
  "on_failed_check": "rollback"
}
```

- `apply` runs `npx wrangler <args>` with `execFile` (argument array, no shell), cwd = plan `project_dir`, env: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `WRANGLER_SEND_METRICS=false`, `CI=1`, `WRANGLER_OUTPUT_FILE_PATH=<tmp>`, stdin closed (or the secret value, section 3.5).
- **Allowlisted subcommands** (first one or two args): `deploy`, `versions deploy`, `rollback`, `pages deploy`, `d1 migrations apply`, `d1 time-travel restore`, `d1 create`, `d1 delete`, `r2 bucket create`, `r2 bucket delete`, `kv namespace create`, `kv namespace delete`, `queues create`, `queues delete`, `secret put`, `secret delete`, `delete` (Worker). Anything else: `invalid_op` at plan creation.
- **Forbidden flags**: `--config` pointing outside `project_dir`, `--outdir`, `--dry-run` (preflight owns those), shell metacharacters are irrelevant because no shell is used, but args must be ASCII printable without control characters.
- `on_failed_check: "rollback"` is part of the ops hash, so the user approves automatic rollback up front.

### 3.3 REST allowlist for account plans

Only these account paths are accepted in `method`/`path` ops on account plans:
- `POST /accounts/<account_id>/pages/projects/<project>/deployments/<deployment_id>/rollback`

Everything else on accounts stays rejected (`invalid_op`), as in v1.

### 3.4 Source hash binds approval to code

Bundle determinism is undocumented, so the approval binds to the **source**, not the bundle:
- `source_hash` = SHA-256 over the sorted list of `<relative path>\0<sha256 of content>` for every file `git ls-files` reports in `project_dir` plus untracked non-ignored files, excluding `.claudeflare/`, `node_modules/` and `.wrangler/`. If `project_dir` is not a git work tree: all files under it with the same exclusions, max 20k files (else `project_too_large`).
- Deploy inputs (pages directory, assets directory, main, config) are passed as `extraPaths` (relative, inside `project_dir`, else `invalid_input`) and hashed even when gitignored; secret files (basename `.dev.vars`, `.dev.vars.*`, `.env`, `.env.*`) are never hashed in any mode; an empty file list is `empty_project`.
- Stored in the plan for `deploy`, `versions deploy`, `pages deploy` and `d1 migrations apply` ops; part of the ops hash.
- `apply` recomputes it before running wrangler; mismatch: `source_changed`, nothing runs, approval kept.
- `claudeflare preflight` still runs `wrangler deploy --dry-run --outdir <tmp>` to catch build errors and record the upload size; the size is informational.

### 3.5 Secrets

```json
{ "kind": "wrangler", "args": ["secret", "put", "STRIPE_KEY"], "worker": "api", "value_from_env": "STRIPE_KEY" }
```
- The plan holds only the env var name. `apply` reads `process.env[value_from_env]`; missing: `secret_env_missing`, nothing runs. The value is written to wrangler's stdin and never logged, stored, hashed into the plan or printed. Errors are redacted for the value as for the token.
- Snapshot records only whether the secret existed (`secret list --format json`). Secret ops are not reversible.
- Guard denies Bash commands that run `wrangler secret put` directly, and any command line that pipes a literal into `wrangler secret`.

### 3.6 Snapshots and inverses

| Op | Snapshot (before) | Inverse |
|---|---|---|
| `deploy` / `versions deploy` | active deployment and version ids (`deployments list --json`) | `wrangler rollback <previous version> --message "claudeflare rollback <plan id>" --yes` |
| `rollback` | active version id | `wrangler rollback <that version> ... --yes` |
| `pages deploy` | current production deployment id (`pages deployment list --json`) | REST Pages rollback to that deployment |
| `d1 migrations apply` | `d1 time-travel info <db> --json` bookmark; pending migrations with SQL text | `wrangler d1 time-travel restore <db> --bookmark <b> --json` (risk: discards all writes after the bookmark) |
| `d1 time-travel restore` | current bookmark | restore to that bookmark |
| `* create` | none | matching delete, only if the resource is still empty at rollback time (checked; else `rollback_not_empty`) |
| `* delete`, `secret put/delete`, Worker `delete` | none | not reversible |

New version ids come from the `WRANGLER_OUTPUT_FILE_PATH` ND-JSON (`deploy.version_id`), not from parsing console text.

### 3.7 Destructive ops

`delete` ops (Worker, R2, KV, Queue, D1) require a field `confirm_name` equal to the resource name; it is shown in the approval message and the native prompt. Plan risk gets a `Not reversible:` line automatically. For R2, preflight lists objects (`r2 object` via API `GET /accounts/<id>/r2/buckets/<b>/objects?per_page=1`) and refuses non-empty buckets at plan creation (`resource_not_empty`). KV, Queue and D1 deletes are allowed only with `confirm_name` and an extra risk line naming what is lost.

### 3.8 New CLI commands

- `claudeflare preflight --file <draft.json>`: validates a draft (scope, allowlist, wrangler present and version 4.x, `wrangler whoami` account matches, bindings referenced in wrangler config exist, dry-run build passes, source hash), prints a report, and writes nothing to Cloudflare. `plan new` calls the same checks.
- `claudeflare tail --worker <name> --seconds <n> [--status error]`: runs `wrangler tail --format json` for at most 60 seconds, returns a summarized JSON (counts by outcome, top exceptions, sample logs with secrets-looking values redacted). Read-only.

### 3.9 Guard additions

- Deny direct Bash `wrangler` (or `npx wrangler`, `pnpm wrangler`, `yarn wrangler`, `bunx wrangler`) with write subcommands: `deploy`, `versions deploy`, `rollback`, `delete`, `publish`, `secret put|delete|bulk`, `d1 execute --remote`, `d1 migrations apply --remote`, `d1 time-travel restore`, `r2 bucket create|delete`, `r2 object put|delete`, `kv namespace create|delete`, `kv key put|delete`, `kv bulk put|delete`, `queues create|delete`, `pages deploy`, `pages project delete`. Reason: use the change protocol.
- Allow read subcommands: `whoami`, `deployments list|status`, `versions list|view`, `tail`, `d1 list|info`, `d1 migrations list`, `d1 time-travel info`, `r2 bucket list|info`, `kv namespace list`, `queues list`, `pages project list`, `pages deployment list`, `secret list`.
- Same limits as v1: string checks catch mistakes, not deliberate evasion. README threat model is updated accordingly.

## 4. Skills and agents

- `cf-workers`: config review (compatibility date, flags, observability, placement, routes vs custom domains, `global_fetch_strictly_public`), versions and gradual deployments, limits, deploy plans with health checks.
- `cf-pages`: projects, build config, preview vs production, deploy and rollback plans.
- `cf-storage`: R2, KV, D1, Queues, Durable Objects bindings; D1 migrations and Time Travel; create/delete plans; data-loss traps.
- `cf-dev-troubleshoot`: trees for 1101, 1102, 1042, missing binding, memory limit, deploy failures (build, auth, size), Pages build failures; evidence via `claudeflare tail`, GraphQL `workersInvocationsAdaptive`, deployments history.
- `cf-audit` gains domains `workers`, `pages`, `storage`; `cf-core` gains account-scope plans, the wrangler op format, secrets rules, and the new error codes.
- Same section structure and finding format as v1 domain skills; all MCP examples in canonical wrapper form (covered by the existing skill-examples test).

## 5. Data flow

### 5.1 Worker deploy
1. Read: wrangler config, `deployments list --json`, `versions list --json`, `whoami`.
2. `claudeflare preflight --file draft.json`; on errors, report and stop.
3. `claudeflare plan new` (account scope) with the deploy op, health check, optional `on_failed_check`, `source_hash`.
4. User approves with `/claudeflare:approve <id>`.
5. `claudeflare apply`: approval check, source hash check, snapshot (active version), run wrangler, read `version_id` from ND-JSON, health check (up to 3 tries, 5 s apart). On failure with `on_failed_check: "rollback"`: run the inverse immediately and set status `rolled_back_auto`; else status `applied_check_failed` and suggest a rollback plan.
6. Verify: `deployments status --json` shows the new version at 100%.

### 5.2 D1 migration
1. Read `d1 migrations list <db> --remote`; include pending file names and SQL in the plan summary/risk.
2. Snapshot: Time Travel bookmark. Apply: `d1 migrations apply <db> --remote`. Verify: `d1 migrations list` shows none pending; optional user check query via `d1 execute --remote --command "<SELECT ...>"` run by apply as part of verification (SELECT only, validated).
3. Rollback plan: restore bookmark; risk states writes after the bookmark are lost.

### 5.3 Resource create
Apply records the new resource id (from wrangler output or a follow-up list call). The agent then proposes the `wrangler.jsonc` binding diff in chat; editing the user's project file is a normal file edit with the user's consent, outside claudeflare's apply.

### 5.4 Diagnose
Evidence first: recent deployments, `claudeflare tail` sample, GraphQL error and CPU quantiles; pick a tree; cite evidence; fixes are either a plan (rollback, config deploy) or code suggestions for the user.

## 6. Error handling

| Case | Code | Behavior |
|---|---|---|
| wrangler not installed / not runnable | `wrangler_missing` | Suggest `npm i -D wrangler@4`; nothing runs |
| wrangler major != 4 | `wrangler_version` | Refuse |
| `whoami` account differs from plan account | `account_mismatch` | Refuse |
| Source changed after approval | `source_changed` | Refuse, approval kept |
| Secret env var missing | `secret_env_missing` | Refuse before running |
| wrangler exits non-zero | `wrangler_failed` | Status `failed` or `partially_applied`; last 40 lines of output, token and secret redacted |
| Health check failed | `check_failed` | Auto rollback if approved, else suggest rollback plan |
| Rollback of a create on a non-empty resource | `rollback_not_empty` | Skip that inverse with a risk line |
| R2 delete on non-empty bucket | `resource_not_empty` | Refuse at plan creation |

## 7. Testing

- Fake wrangler: `test/fixtures/wrangler/fake-wrangler.mjs`, selected via `CLAUDEFLARE_WRANGLER` env (tests only). It records argv, stdin and env (minus secrets) to a log, replays canned outputs from real wrangler 4.152.0 samples, writes ND-JSON to `WRANGLER_OUTPUT_FILE_PATH`, and can be told to fail.
- Unit tests: allowlist and forbidden flags; account scope paths; source hash (change detection, exclusions); snapshot and inverse per op; health check with auto rollback; secret value never in plan/snapshot/log/stdout; delete `confirm_name`; R2 non-empty refusal; error codes in section 6.
- Guard tests for every write and read subcommand in section 3.9, including package-manager prefixes.
- Spike before implementation: run real `wrangler deploy --dry-run --outdir` twice on a sample Worker and record whether output is identical (informational only, since approval binds to source), confirm `WRANGLER_OUTPUT_FILE_PATH` fields, confirm `d1 time-travel restore` runs non-interactively with `CI=1`.
- Evals (3 new cases): diagnose a 1102 from mocked analytics and tail output; "deploy now" request follows plan protocol; secret request never puts the value into chat, plan or a command line.
- Live test on the owner's account: deploy a throwaway hello-world Worker, deploy a second version, roll back, delete it.

## 8. Release

- Version `0.2.0`; CHANGELOG, README (developer platform section, updated threat model, token template additions: Workers Scripts, Workers Routes, Pages, D1, Workers KV Storage, Workers R2 Storage, Queues edit/read, Account Analytics read).
- Push and tagging only with owner approval.

## 9. Open questions

None blocking. Spike results (section 7) may adjust details of 3.4 and 3.6, recorded in the plan.

## 10. Risks

- Wrangler output formats can change between minor versions; mitigated by relying on `--json` and ND-JSON outputs and pinning the major version check.
- Rollback does not restore data in bound resources; stated in every deploy plan's risk note.

## 11. Roadmap after v2

- v3 (0.3.0): Zero Trust and network (Access, Tunnel, Gateway, WARP, Load Balancing, Spectrum).
- Hardening: OS keychain for the approval key, separate write token at apply time.

## 12. Sources

- https://developers.cloudflare.com/workers/wrangler/commands/workers/
- https://developers.cloudflare.com/workers/wrangler/system-environment-variables/
- https://developers.cloudflare.com/workers/wrangler/commands/pages/
- https://developers.cloudflare.com/pages/configuration/rollbacks/
- https://developers.cloudflare.com/d1/reference/time-travel/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/observability/errors/
- https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/
- https://github.com/cloudflare/workers-sdk (packages/wrangler: dialogs.ts, versions/rollback, d1/migrations/apply.ts)
- https://registry.npmjs.org/wrangler/latest
