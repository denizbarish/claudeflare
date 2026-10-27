# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A 403 on a product write at apply now stops with `missing_permission` and names the edit permission the token lacks. Preflight probes reads only, so a read-only token passed preflight and failed with a bare "Authentication error". Found in the v0.3.0 live test.
- Rolling back the first ingress config of a tunnel now puts a catch-all-only config (`http_status:404`). It sent `{ "config": null }`, which the API refuses, so the rollback stopped as `partially_applied`. Found in the v0.3.0 live test.
- `/claudeflare:approve <id>` with anything after the id (a trailing colon or period) now says the approval was not recorded instead of staying silent. Found in the v0.3.0 live test.

### Verified

- Live test on a real Zero Trust organization (Free plan): tunnel create, `tunnel-token` into an env file and a running connector (4 connections), CNAME, ingress config (`tunnel_serving` 200, status `healthy`), Access app with a reusable policy (unauthenticated GET answered 302 to the team domain), Gateway DNS rule and WARP custom profile create (readback), then rollback of every plan. The account ended in its prior state. Load Balancing and Spectrum were not live-tested (no add-on, Free zone plan).

## [0.3.0] - 2026-10-26

### Added

- Zero Trust and network products: Access, Tunnel, Gateway, WARP devices, Load Balancing and Spectrum, each with a skill (`cf-access`, `cf-tunnel`, `cf-gateway`, `cf-devices`, `cf-load-balancing`, `cf-spectrum`), an audit domain, ops with snapshots and inverses, and rollback.
- Shared REST engine with one rule module per product: kind registry and allowlist, default inverses (`delete_created`, `put_before`, `patch_before`, `recreate`, `none`), conflict rules, redaction by field path.
- Account plans without `project_dir` when they hold no `wrangler` op. A plan never mixes product ops with `wrangler` ops or account with zone ops.
- Op fields `confirm_name` (every delete), `verify` (`access_login`, `status:<code>`, `tunnel_serving`, `pool_healthy`, `tcp_open`) and `secret_fields_from_env` (credentials from the environment, never stored).
- Preflight for product ops: entitlement (`not_entitled`), permission probe (`missing_permission`), dependency scans (`resource_in_use`), `confirm_name` against the live name, and lockout analysis. Lists are read page by page; more than 200 pages or a Gateway list above 1000 items is `too_large`.
- `Lockout risk:` lines in the plan risk for changes that can lock users or admins out. They never refuse a plan. Apply analyzes again on fresh reads and stops with `risk_changed` before any write when a new line appears; Load Balancing preview lines are advisory (`advisory_lockout`, printed after apply).
- Report-only verification after apply, retried for up to 60 seconds per op: a failed check sets `applied_verify_failed` and creates a rollback draft that needs approval. A `partially_applied` plan keeps its status. Rollback plans are verified but get no rollback draft.
- Drift precheck on product rollbacks: an inverse whose resource changed after the original apply is skipped with `rollback_drift` (with its dependency group), and the rollback ends `partially_applied`.
- `claudeflare tunnel-token --account <id> --tunnel <uuid> --env-path <path> [--var TUNNEL_TOKEN]`: writes the tunnel token into an env file (mode 0600 when new, other lines kept), prints only the path, refuses a path inside a git work tree that git does not ignore, and warns outside a repo.
- Service token secrets go to `.claudeflare/secrets/<plan id>-<op index>.json` (mode 0600, ignored by git); if that file cannot be written, apply stops `partially_applied` and says the one-time secret is lost.
- Guard: denies reads of tunnel and WARP connector tokens (MCP, `claudeflare get`, `curl`, `cloudflared tunnel token`), reads of claudeflare's secret files and recorded env files (Read, Grep and Bash, deny by default with exact consumer shapes) and `cloudflared` with a literal token. `plan new` refuses zone-scoped Access paths and points to the account form.
- Skill `cf-zt-troubleshoot` with trees for Access redirect loops, Access 403, invalid Access JWT, Tunnel 1016, 1033 and 502, Gateway over-blocking, WARP private routes, Load Balancing without a healthy pool and Spectrum apps that do not connect.
- Evals: an Access plan with its lockout line, a tunnel setup that never exposes the token, a Gateway over-blocking diagnosis and a tunnel delete with its 1016 risk (eleven cases in total).
- Docs: Zero Trust and network section, threat model notes on lockout and the secret file guard, and the Zero Trust and network token sets.

### Changed

- The approval hash also binds a plan's `lockout_risks` and, on a rollback plan, `rollback_of`; apply rebuilds a rollback plan's ops from its source and refuses any difference (`rollback_stale`). An unapplied plan approved before this change needs a new approval.
- `cf-core` documents product plans, the new statuses and error codes, and `tunnel-token`; `cf-audit` covers the six new domains.

## [0.2.1] - 2026-10-26

### Added

- `versions upload` op: upload a Worker version without traffic (preflight builds and hashes it; the apply result carries `version_id` and `preview_url`), for gradual rollouts with a later `versions deploy`.
- `r2 bucket dev-url enable` and `disable` ops, snapshotted and reversible; `r2.bucket.public_dev_url` now has a fix.
- Preflight checks Workers behind service and Durable Object bindings, Vectorize indexes and Hyperdrive configs.
- Preflight reports `upload_sizes` per Worker when a plan builds several.

### Changed

- wrangler config discovery matches wrangler 4: `wrangler.json`, then `wrangler.jsonc`, then `wrangler.toml`, each searched upward. A config outside `project_dir` fails preflight instead of being read wrongly; for `deploy` and `versions upload`, so does a redirected `.wrangler/deploy/config.json` (the error names the `--config` to add). The search starts in a positional script's folder, as in wrangler.
- Health checks are accepted only on ops that change what serves traffic; `on_failed_check` needs a `health_check`. A failed check names the redirect target.

### Fixed

- The guard now asks before `claudeflare apply` called by path (`node /x/bin/claudeflare apply`, `./bin/claudeflare apply`) or quoted, not only bare; a folder named claudeflare (`git -C ~/claudeflare apply x.patch`) is not mistaken for it.
- `claudeflare tail` bounds the output it keeps (4 MiB) and reports `truncated`.
- The skill example test also checks indented code blocks.

## [0.2.0] - 2026-10-26

### Added

- Developer platform: Workers, Pages, R2, D1, KV and Queues, through wrangler 4 from the project's own `node_modules`.
- Account plans (`"scope": "account"`) with wrangler ops from a fixed allowlist (deploy, versions deploy, rollback, delete, Pages deploy, D1 migrations and Time Travel restore, create and delete for D1, R2, KV and Queues, secret put and delete) and the Pages rollback REST op.
- `claudeflare preflight`: ops, wrangler version, account access, wrangler config and bindings, a dry-run build with upload size, pending D1 migrations and the source hash. `plan new` runs it and refuses a failing draft.
- Approvals bound to the code: the plan embeds a hash of the source and every deploy input; apply refuses with `source_changed` when it differs, and with `source_hash_missing` for a deploy op without one.
- Health checks on deploy ops with automatic rollback (`rolled_back_auto`) or `applied_check_failed`.
- Snapshots and rollback for Worker versions, Pages production deployments and D1 Time Travel bookmarks. Created resources are deleted on rollback only when verifiably empty; D1 and Queue creates never.
- Secrets from the user's environment (`value_from_env`), passed on stdin and redacted from all output.
- `claudeflare tail`: bounded `wrangler tail` (at most 60 seconds) with a redacted summary.
- Guard: direct wrangler writes are denied (allowlist of read and local subcommands), including behind runners and inside `package.json` scripts.
- Skills: `cf-workers`, `cf-pages`, `cf-storage`, `cf-dev-troubleshoot` (1101, 1102, 1042, missing binding, deploy failures, Pages build failures, D1 migration errors); account domains in `cf-audit`; account plans in `cf-core`.
- Evals: 1102 diagnosis, deploy through the protocol, and no secret leak (seven cases in total).
- Docs: developer platform token sets.
- Verified end to end against the live Cloudflare API with wrangler 4.152.0: preflight, first deploy, second deploy with health check, `claudeflare tail` with redaction, rollback to the snapshot version, and Worker delete.

## [0.1.0] - 2026-10-25

### Added

- Plugin and marketplace manifests; install with `/plugin marketplace add denizbarish/claudeflare` and `/plugin install claudeflare@claudeflare`.
- Official Cloudflare MCP server (`https://mcp.cloudflare.com/mcp`) declared for reads.
- Commands: `/claudeflare:setup`, `/claudeflare:audit`, `/claudeflare:diagnose`, `/claudeflare:optimize`, `/claudeflare:approve`, `/claudeflare:rollback`.
- Agents: `cloudflare` (senior Cloudflare engineer) and `cf-auditor` (read-only, one domain per run, dispatched in parallel).
- Skills: `cf-core` (discovery, channels, change protocol), `cf-audit` (scored audit and finding format), `cf-dns`, `cf-ssl`, `cf-cache`, `cf-performance`, `cf-rules`, `cf-waf`, `cf-bots-ratelimit`, `cf-incident`, and `cf-troubleshoot` with decision trees for 520 to 526, 1xxx, redirect loops, cache misses, CORS and WAF false positives.
- `claudeflare` CLI: `init`, `get`, `plan new|show|list`, `snapshot`, `apply`, `rollback` and `report`. API client with retry and error mapping; the token is read only from `CLOUDFLARE_API_TOKEN` and redacted from errors.
- Change protocol: draft plans bound to an ops hash, HMAC-signed single-use approvals with a 30 minute TTL, native confirmation prompt on apply, snapshot before apply, verification, and rollback plans built from the snapshot. Non-reversible ops are flagged in the risk note, and plan limits reject conflicting ops.
- Guard hook: allowlist for MCP `execute` code (at least one call, GET and GraphQL reads only), denial of `curl` writes to `api.cloudflare.com`, and protection of `.claudeflare/` state and the approval key directory.
- Approval hook for `/claudeflare:approve <plan-id>`.
- Audit reports with severity-weighted domain scores; `claudeflare report` prints `{ file, overall, domains }`.
- Auditors return `{ findings, unread }`; a domain with unread checks is re-run once, then marked not audited and left out of the scores.
- `claudeflare plan new` rejects ops outside the plan's zone (including account-level writes), Page Rule creation, leftover placeholders and non-standard methods with `invalid_op`; apply re-checks the same rules.
- `cf-dns` check `dns.proxy.non_http_service` for proxied FTP, SSH and mail hosts (found in a live test).
- Verified end to end against the live Cloudflare API: audit, plan, approval, apply, snapshot and rollback.
- Unit tests (`npm test`, no dependencies), four `claude plugin eval` behavior cases, and GitHub Actions CI.
- Docs: README, API token template, contributing guide and security policy.

[Unreleased]: https://github.com/denizbarish/claudeflare/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/denizbarish/claudeflare/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/denizbarish/claudeflare/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/denizbarish/claudeflare/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/denizbarish/claudeflare/releases/tag/v0.1.0
