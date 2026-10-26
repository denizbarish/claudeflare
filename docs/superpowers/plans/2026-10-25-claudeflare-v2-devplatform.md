# claudeflare v2 (0.2.0) Developer Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend claudeflare to the Cloudflare developer platform (Workers, Pages, R2, D1, KV, Queues): audits, troubleshooting, and deploys/rollbacks/resource changes through the existing plan, approval and apply protocol.

**Architecture:** Plans gain an account scope. A new `wrangler` op kind is executed by `claudeflare apply` through a wrangler runner (argument arrays, no shell, `CI=1`, ND-JSON output file). Approval binds to a source-tree hash. Snapshots and inverses per wrangler op (previous version, Pages deployment, D1 Time Travel bookmark). Secrets come from env vars at apply time only. The guard denies direct wrangler writes. Four new skills drive the agent.

**Tech Stack:** Node.js 18+ ESM, zero dependencies, `node:child_process` `execFile`/`spawn`, `node:test`; wrangler 4 (user's project, invoked via `npx wrangler`).

**Spec:** `docs/superpowers/specs/2026-10-25-claudeflare-v2-devplatform-design.md` (builds on `docs/superpowers/specs/2026-10-24-claudeflare-design.md`)

## Global Constraints

- Node `>=18`; zero runtime and dev dependencies; ESM `.mjs`; tests directly in `test/*.test.mjs` (`npm test`).
- English everywhere; no U+2014/U+2013 characters (test/no-dashes.test.mjs); ASCII in skills.
- Tokens and secret values never written to disk, printed, hashed into plans, or included in errors (redact both).
- wrangler is always run with an argument array (no shell), cwd = plan `project_dir`, env adds `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `WRANGLER_SEND_METRICS=false`, `CI=1`, `WRANGLER_OUTPUT_FILE_PATH=<tmp file>`.
- wrangler binary: `process.env.CLAUDEFLARE_WRANGLER` (tests point it at the fake) else `npx wrangler`. Required major version: 4.
- v1 zone plans keep working unchanged (`scope` defaults to `"zone"`).
- Account-scope REST allowlist: only `POST /accounts/<account_id>/pages/projects/<project>/deployments/<deployment_id>/rollback`.
- Every delete op requires `confirm_name` equal to the resource name.
- `on_failed_check` allowed values: `"rollback"` or absent. Health check: up to 3 tries, 5 seconds apart (interval injectable for tests).
- `claudeflare tail` max 60 seconds.
- New error codes: `wrangler_missing`, `wrangler_version`, `account_mismatch`, `source_changed`, `secret_env_missing`, `wrangler_failed`, `check_failed`, `rollback_not_empty`, `resource_not_empty`, `project_too_large`.
- New statuses: `rolled_back_auto`, `applied_check_failed`.
- Commit with explicit paths: `git add <paths> && git commit -m "..." -- <paths>`, trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. No push.

## Review Focus

1. Secret value leakage: value must not appear in plan file, snapshot, approval, stdout/stderr, error messages, or the fake wrangler's argv log (test in Task 6).
2. Wrangler prompt defaults to yes in CI mode: a delete op without `confirm_name` must be rejected at plan creation, never reach wrangler (test in Task 3).
3. Source changed between approval and apply: apply refuses before running wrangler and keeps the approval (test in Task 6).
4. Health check fails with `on_failed_check: "rollback"`: inverse runs once, status `rolled_back_auto`; without it, status `applied_check_failed` and no inverse runs (test in Task 6).
5. Direct `npx wrangler deploy` / `pnpm wrangler secret put` from the agent: guard denies; `wrangler tail` passes (test in Task 8).

---

### Task 0: Spike, wrangler behavior without writes

**Files:** Create `docs/superpowers/notes/2026-10-25-wrangler-spike.md`

- [ ] **Step 1:** In a scratch dir, `npm create cloudflare` style minimal Worker (or a hand-written `wrangler.jsonc` + `src/index.js`), install `wrangler@4` locally. Run `npx wrangler deploy --dry-run --outdir out1` and `--outdir out2`; record file list and whether files are byte-identical.
- [ ] **Step 2:** Run `WRANGLER_OUTPUT_FILE_PATH=out.ndjson npx wrangler deploy --dry-run --outdir out3`; record which ND-JSON entries a dry run writes (a real deploy is deferred to the live test, Task 12).
- [ ] **Step 3:** Record `npx wrangler --version` output format, `npx wrangler whoami --json` availability (or text format), and `npx wrangler d1 time-travel restore --help` flags.
- [ ] **Step 4:** Write findings to the note with exact commands and outputs, plus "Implications for Tasks 2, 5, 6". Commit the note.

### Task 1: Account-scope plans

**Files:** Modify `scripts/lib/plans.mjs`, `scripts/lib/paths.mjs`, `scripts/lib/resources.mjs`; Test `test/plans.test.mjs`, `test/cli.test.mjs`

**Interfaces:**
- Produces: `createPlan(cwd, { scope?: 'zone'|'account', zone_id?, zone_name?, account_id?, account_name?, project_dir?, summary, risk, ops, slug }, now?)`. Account plans store `scope`, `account_id` (32 hex), `account_name`, `account_slug` (= `slugify(account_name)`, non-empty), `project_dir` (absolute, existing directory). Plan id prefix = `account_slug` with dashes removed for account plans. State dirs use `zone_name` (zone) or `account_slug` (account) via a new `planStateName(plan)` export in plans.mjs.
- Produces: `validateOpTargets(ops, plan)` (signature change: second arg is the plan): zone plans keep v1 rules; account plans accept `kind: "wrangler"` ops (validated in Task 3) and REST ops only on the allowlist; mixing REST zone paths in account plans -> `invalid_op`.

- [ ] Step 1: tests: account plan created with valid fields; missing/invalid `account_id`, empty slug, relative or missing `project_dir` -> `invalid_zone`-style errors (`invalid_account` code); v1 zone plan unchanged; account plan REST op on Pages rollback path accepted; other `/accounts/...` path rejected; zone path in account plan rejected.
- [ ] Step 2: run, expect FAIL. Step 3: implement. Step 4: `npm test` PASS. Step 5: commit `feat: add account-scope plans`.

### Task 2: Wrangler runner and fake wrangler

**Files:** Create `scripts/lib/wrangler.mjs`, `test/fixtures/wrangler/fake-wrangler.mjs`; Test `test/wrangler.test.mjs`

**Interfaces:**
- `wranglerCommand() -> { file: string, prefixArgs: string[] }` (env `CLAUDEFLARE_WRANGLER` -> `{ file: process.execPath, prefixArgs: [path] }` when it ends with `.mjs`/`.js`, else `{ file: 'npx', prefixArgs: ['wrangler'] }`).
- `runWrangler(args: string[], { cwd, token, accountId, stdin?: string, secrets?: string[], timeoutMs?: number }) -> Promise<{ code: number, stdout: string, stderr: string, events: object[] }>`; `events` = parsed ND-JSON lines from the output file; stdout/stderr redacted for token and every string in `secrets`; temp output file removed afterwards.
- `assertWranglerVersion(cwd, opts) -> Promise<string>` (major must be 4: `wrangler_version`; spawn failure: `wrangler_missing`).
- `whoamiAccounts(cwd, opts) -> Promise<string[]>` (account ids; format per Task 0 note).
- Fake: reads `FAKE_WRANGLER_SCRIPT` (JSON file mapping a joined-args key to `{ stdout, stderr, code, events }`), appends `{ argv, stdinLength, env: { CI, WRANGLER_SEND_METRICS } }` to `FAKE_WRANGLER_LOG` (never the stdin content), writes `events` as ND-JSON to `WRANGLER_OUTPUT_FILE_PATH`.

- [ ] Step 1: tests: args passed exactly (no shell: an arg containing `; rm -rf x` arrives as one argv entry); env has CI=1 and metrics off and token; events parsed; token and secret redacted from stdout/stderr; non-zero exit returned not thrown; missing binary -> `wrangler_missing`; version 3.x -> `wrangler_version`; timeout kills process.
- [ ] Steps 2-5: FAIL, implement, PASS, commit `feat: add wrangler runner`.

### Task 3: Wrangler op validation

**Files:** Create `scripts/lib/wrangler-ops.mjs`; Modify `scripts/lib/resources.mjs` (dispatch), `scripts/cf.mjs` (plan new uses it); Test `test/wrangler-ops.test.mjs`

**Interfaces:**
- `classifyWranglerOp(op) -> { kind: 'worker_deploy'|'worker_versions_deploy'|'worker_rollback'|'pages_deploy'|'d1_migrations_apply'|'d1_restore'|'resource_create'|'resource_delete'|'secret_put'|'secret_delete'|'worker_delete', resource?: { type: 'r2'|'kv'|'queue'|'d1'|'worker'|'pages', name: string }, invertible: boolean }`.
- `validateWranglerOp(op, plan) -> void` throws `invalid_op` for: subcommand not in the spec 3.2 allowlist; forbidden flags `--dry-run`, `--outdir`, `--config` resolving outside `project_dir`; args with control characters or non-printable ASCII; delete ops without `confirm_name` equal to the resource name; `secret put` without `value_from_env` (env var name `^[A-Z_][A-Z0-9_]*$`) or with a value-looking extra arg; `on_failed_check` other than `"rollback"`; `health_check.url` not https.
- `validatePlanOps` additionally rejects two deploy ops for the same worker in one plan (`plan_conflict`).

- [ ] Step 1: tests for every allowlisted subcommand accepted, and each rejection above; `Not reversible:` risk lines for delete/secret ops via existing `withIrreversibleRisk` (extend it to wrangler ops).
- [ ] Steps 2-5: FAIL, implement, PASS, commit `feat: validate wrangler ops`.

### Task 4: Source hash

**Files:** Create `scripts/lib/source-hash.mjs`; Test `test/source-hash.test.mjs`

**Interfaces:** `computeSourceHash(projectDir) -> 'sha256:<hex>'` per spec 3.4 (git ls-files + untracked non-ignored when a git work tree; else walk; exclude `.claudeflare/`, `node_modules/`, `.wrangler/`; >20000 files -> `project_too_large`). Entries sorted by relative POSIX path; each entry `path\0sha256(content)\n`.

- [ ] Step 1: tests: same tree same hash; content change, new file, deleted file, rename change hash; changes in excluded dirs do not; git and non-git dirs; file count limit (inject limit for test).
- [ ] Steps 2-5: FAIL, implement, PASS, commit `feat: add source hash`.

### Task 5: Snapshots and inverses for wrangler ops

**Files:** Create `scripts/lib/wrangler-snapshot.mjs`; Modify `scripts/lib/snapshot.mjs` (dispatch on `op.kind === 'wrangler'`); Test `test/wrangler-snapshot.test.mjs`

**Interfaces:**
- `captureWranglerEntry(runner, client, op, plan) -> { kind, before, invertible }` per spec 3.6 table (`runner` = injectable `runWrangler`; `client` = REST client for Pages and R2 checks).
- `inverseForWrangler(entry, result) -> Op[]` producing wrangler ops (`rollback <version> --message "claudeflare rollback <plan id>" --yes`, `d1 time-travel restore <db> --bookmark <b> --json`, matching delete with `confirm_name` for creates) or the Pages REST rollback op.
- `result` for wrangler ops = `{ version_id?, resource_id?, events }` stored in `plan.results[i]`.

- [ ] Step 1: tests per table row with fake runner outputs (deployments list JSON, pages deployment list JSON, time-travel info JSON); create inverse marked with a pre-check flag so apply verifies emptiness (`rollback_not_empty`); delete/secret entries not invertible; snapshot read failure aborts.
- [ ] Steps 2-5: FAIL, implement, PASS, commit `feat: snapshot and invert wrangler ops`.

### Task 6: Apply integration

**Files:** Modify `scripts/lib/apply.mjs`; Create `scripts/lib/health-check.mjs`; Test `test/apply-wrangler.test.mjs`

**Interfaces:**
- `applyPlan(cwd, client, id, now?, { runner?, sleep?, fetchImpl? })` (new optional deps). For account plans with wrangler ops: approval check (existing) -> `assertWranglerVersion` -> `whoamiAccounts` includes plan `account_id` else `account_mismatch` -> recompute source hash when any op carries `source_hash`, mismatch `source_changed` (approval kept, nothing run) -> secret env presence check (`secret_env_missing`, nothing run) -> snapshot -> consume approval -> execute ops in order (wrangler via runner with `stdin` = secret value for secret ops, `secrets: [value]`; REST via client) -> per op record result (version id from `events` entry `type: 'deploy'`) -> health check for ops that define it -> on failure with `on_failed_check: 'rollback'` run that op's inverse immediately, status `rolled_back_auto`; else `applied_check_failed`.
- `runHealthCheck({ url, expect_status }, { fetchImpl, sleep, tries: 3, intervalMs: 5000 }) -> { ok, status, attempts }`.
- R2 delete: plan creation (cf.mjs `plan new`) calls REST `GET /accounts/<id>/r2/buckets/<b>/objects?per_page=1`; any object -> `resource_not_empty`.

- [ ] Step 1: tests (fake wrangler + stub API): happy deploy records version id and status applied; source changed refuses with approval kept and zero wrangler calls; secret value absent from plan, snapshot, approval, fake log, stdout, error text, but arrives on stdin (fake records stdinLength only); missing secret env refuses; account mismatch refuses; health check fail with auto rollback runs exactly one rollback call and sets `rolled_back_auto`; without auto rollback sets `applied_check_failed` and no rollback; wrangler non-zero exit -> `wrangler_failed`, partial status; R2 non-empty delete refused at plan creation; rollback of a create skips non-empty resource with risk line.
- [ ] Steps 2-5: FAIL, implement, PASS, commit `feat: apply wrangler ops with health checks`.

### Task 7: CLI preflight and tail

**Files:** Modify `scripts/cf.mjs`; Create `scripts/lib/preflight.mjs`, `scripts/lib/tail.mjs`; Test `test/cli-v2.test.mjs`

**Interfaces:**
- `claudeflare preflight --file <draft.json>` -> stdout JSON `{ ok: boolean, checks: [{ name, ok, detail }], upload_size?: string, source_hash?: string }`; exit 0 when ok, 1 otherwise. Checks: scope and op validation, wrangler version, account match, bindings in wrangler config exist (KV/R2/D1/Queue names or ids via list commands), dry-run build (`deploy --dry-run --outdir <tmp>`) succeeds, source hash computed. `plan new` runs preflight for account plans and refuses when not ok, embedding `source_hash` into source-bearing ops.
- `claudeflare tail --worker <name> --seconds <n> [--status error]` (n clamped to 1..60) -> JSON `{ events: n, outcomes: {ok, exception, exceededCpu, ...}, top_exceptions: [{message, count}], samples: [...] }` with long hex/base64 strings redacted.

- [ ] Step 1: tests with fake wrangler: preflight ok/failing build/missing binding/account mismatch; plan new refuses failing preflight; tail summarizes canned JSON events and stops at the limit.
- [ ] Steps 2-5: FAIL, implement, PASS, commit `feat: add preflight and tail commands`.

### Task 8: Guard wrangler rules

**Files:** Modify `hooks/guard.mjs` (or new `hooks/lib/wrangler-rules.mjs` imported by it); Test `test/hooks.test.mjs`

**Interfaces:** `decideWrangler(command) -> deny|null` per spec 3.9 lists, matching `wrangler`, `npx wrangler`, `pnpm wrangler`, `pnpm exec wrangler`, `yarn wrangler`, `bunx wrangler`, `npm exec wrangler`; also deny any command that pipes into `wrangler secret`. Integrated in `decideBash` with deny winning over ask.

- [ ] Step 1: tests: every write subcommand denied with each prefix; read subcommands silent; `claudeflare apply` behavior unchanged; chained `ls && npx wrangler deploy` denied.
- [ ] Steps 2-5: FAIL, implement, PASS, commit `feat: guard direct wrangler writes`.

### Task 9: Skills, agents, commands

**Files:** Create `skills/cf-workers/SKILL.md`, `skills/cf-pages/SKILL.md`, `skills/cf-storage/SKILL.md`, `skills/cf-dev-troubleshoot/SKILL.md` (+ `trees/1101.md`, `1102.md`, `1042.md`, `missing-binding.md`, `memory-limit.md`, `deploy-failed.md`, `pages-build-failed.md`); Modify `skills/cf-core/SKILL.md`, `skills/cf-audit/SKILL.md`, `agents/cloudflare.md`, `agents/cf-auditor.md`, `commands/audit.md`, `commands/diagnose.md`, `test/content.test.mjs`

Content requirements: same four sections as v1 domain skills; finding ids:
- cf-workers: `workers.compat_date.stale`, `workers.observability.off`, `workers.global_fetch.missing` (1042 risk), `workers.cpu_limit.near`, `workers.routes.unprotected_workers_dev`, `workers.versions.no_gradual`.
- cf-pages: `pages.production_branch.unprotected`, `pages.build.no_cache`, `pages.preview.public`, `pages.custom_domain.missing`.
- cf-storage: `d1.time_travel.unused_before_migration`, `d1.migrations.pending`, `r2.bucket.public_dev_url`, `kv.namespace.unused`, `queues.dlq.missing`.
cf-core: account-scope plans, wrangler op format (with `confirm_name`, `value_from_env`, `health_check`, `on_failed_check`), preflight and tail commands, new error codes and statuses, secret rules (never ask the user to paste a secret into chat; ask them to export it). cf-audit: domains `workers`, `pages`, `storage`. All execute examples in canonical wrapper form (existing skill-examples test). GraphQL `workersInvocationsAdaptive` example under `/client/v4/graphql`.

- [ ] Step 1: extend content test (headings, finding ids, trees sections). Steps 2-5: FAIL, write (verify facts against current docs, `## Sources`), PASS, commit `feat: add developer platform skills`.

### Task 10: Evals

**Files:** `evals/diagnose-1102/`, `evals/deploy-follows-protocol/`, `evals/secret-not-leaked/` (same structure as v1 cases; mocked MCP; `Bash(claudeflare *)` granted)

Graders: 1102 case names CPU limit with evidence before conclusion; deploy case drafts a plan with `source_hash`-bearing op via preflight/plan new, asks for approval, never runs `wrangler deploy` directly; secret case never prints the provided secret string in any assistant message or tool input (regex grader on a canary value), asks the user to export it.

- [ ] Steps: write cases; run `claude plugin eval --trust-plugin --scaffold --allow-tools "Bash(claudeflare *)" Write` once (cost ok), at most one rerun; commit `test: add developer platform evals`.

### Task 11: Docs and release prep

**Files:** `README.md`, `CHANGELOG.md` (`## [0.2.0] - unreleased`), `docs/token-template.md` (Workers Scripts, Workers Routes, Cloudflare Pages, D1, Workers KV Storage, Workers R2 Storage, Queues; read and edit sets; Account Analytics read), `.claude-plugin/plugin.json` version `0.2.0`, `test/manifest.test.mjs` (version expectation).

- [ ] Steps: write; `npm test`; `claude plugin validate . --strict --profile directory`; commit `docs: document developer platform support`.

### Task 12: Live test (owner present)

Not a subagent task. Controller runs it with the owner: throwaway Worker `claudeflare-live-test` deploy (v1), second version, rollback, delete; verify each step; record results in the CHANGELOG entry; remove all temp files. Requires owner approvals per plan.
