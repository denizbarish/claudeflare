# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - unreleased

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

[Unreleased]: https://github.com/denizbarish/claudeflare/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/denizbarish/claudeflare/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/denizbarish/claudeflare/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/denizbarish/claudeflare/releases/tag/v0.1.0
[0.1.0]: https://github.com/denizbarish/claudeflare/releases/tag/v0.1.0
