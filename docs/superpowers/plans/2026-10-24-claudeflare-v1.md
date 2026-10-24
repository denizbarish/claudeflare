# claudeflare v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship claudeflare 0.1.0, a Claude Code plugin that audits, optimizes and troubleshoots Cloudflare zones (zone core + security) with human-approved, snapshotted, reversible writes.

**Architecture:** Reads go through the official Cloudflare MCP (`https://mcp.cloudflare.com/mcp`); every write goes through a zero-dependency Node CLI (`claudeflare apply <plan-id>`) that checks an approval token, snapshots, executes and records inverse ops. A `UserPromptSubmit` hook writes approvals only from real user input; a `PreToolUse` guard hook denies MCP writes and unapproved applies. Expertise lives in on-demand skills driven by one orchestrating agent plus a read-only auditor agent.

**Tech Stack:** Node.js 18+ (ESM `.mjs`, built-in `fetch`, `node:test`, `node:crypto`), Claude Code plugin format, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-24-claudeflare-design.md`

## Global Constraints

- Node `>=18`; zero runtime and zero dev dependencies; ESM only (`"type": "module"`, `.mjs` files).
- All code, prompts, docs and commit messages in English.
- No em dash or en dash characters anywhere in the repo. Use commas, colons, parentheses.
- API token read only from `process.env.CLOUDFLARE_API_TOKEN`; never written to disk, never printed, never included in errors.
- API base URL: `https://api.cloudflare.com/client/v4` (overridable by `CLOUDFLARE_API_BASE` for tests only).
- Local state root: `<cwd>/.claudeflare/` with `plans/`, `approvals/`, `snapshots/<zone_name>/`, `reports/<zone_name>/`.
- Approval TTL: 1800 seconds default, override `CLAUDEFLARE_APPROVAL_TTL` (seconds).
- Plan id format: `<zone-short>-<yyyymmdd-hhmmss>-<slug>`; zone-short is the zone name with non-alphanumerics removed; slug is lowercase `[a-z0-9-]`, max 40 chars.
- `ops_hash` is `sha256:` + hex SHA-256 of `JSON.stringify(ops)`.
- Plugin name `claudeflare`; commands are `/claudeflare:<name>`.
- Severity weights: critical 25, high 10, medium 4, low 1; domain score floor 0; overall = rounded mean of domain scores.
- Page Rules: read and recommend migration, never create.
- The agent never runs commands on the origin server.
- Executable name is `claudeflare` (not `cf`, which collides with the Cloud Foundry CLI). This refines the spec's `cf` shorthand.

## Review Focus

1. Plan file edited after approval: apply and guard must both reject on `ops_hash` mismatch (tests in Task 3 and Task 6).
2. MCP `execute` code with a method built at runtime (`method: m`) or omitted: guard must deny, not allow (test in Task 6).
3. `POST` op that creates a resource: rollback must delete the created id taken from the apply response, not from the snapshot (test in Task 4 and Task 5).
4. Apply fails on op 2 of 3: plan status `partially_applied`, op 1 recorded as applied, op 3 untouched, approval consumed (test in Task 5).
5. Token appears in an API error body or URL: it must not reach stdout/stderr (test in Task 2).

---

### Task 0: Spike, verify three harness assumptions

Throwaway probe; output is a short note, not kept code.

**Files:**
- Create: `docs/superpowers/notes/2026-10-24-harness-spike.md`

- [ ] **Step 1:** In a scratch plugin (outside the repo), add a `PreToolUse` hook that returns `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"spike"}}` for Bash `echo spike`. Run a session with `--dangerously-skip-permissions`. Record whether a prompt appears.
- [ ] **Step 2:** Add a `UserPromptSubmit` hook that logs stdin to a file. Define a plugin command `approve.md`, type `/spike:approve abc`. Record the exact `prompt` field the hook receives (raw slash text or expanded command body).
- [ ] **Step 3:** Put an executable in the scratch plugin's `bin/`. Record whether the Bash tool can call it by bare name.
- [ ] **Step 4:** Write the three results in the note file. If Step 2 shows the prompt is expanded, approve.mjs (Task 6) matches on the expanded body marker `CLAUDEFLARE_APPROVE <plan-id>` instead; if Step 3 fails, also test whether `${CLAUDE_PLUGIN_ROOT}` expands inside a command `.md` body; if it does, skills and commands invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/cf.mjs"`, otherwise stop and ask the owner. Update Tasks 5 to 7 text accordingly before continuing.
- [ ] **Step 5:** Commit the note: `git commit -m "docs: record harness spike results" -- docs/superpowers/notes/2026-10-24-harness-spike.md`

---

### Task 1: Repo scaffold, manifests, CI

**Files:**
- Create: `package.json`, `.gitignore`, `LICENSE` (MIT, "Deniz Barış"), `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.github/workflows/ci.yml`, `test/manifest.test.mjs`, `test/no-dashes.test.mjs`

**Interfaces:**
- Produces: `npm test` runs `node --test test/` ; manifest fields other tasks reference.

- [ ] **Step 1: Write failing tests**

`test/manifest.test.mjs`:
```js
test('plugin.json has name claudeflare and semver version 0.1.0', ...)
// assert.equal(p.name, 'claudeflare'); assert.equal(p.version, '0.1.0'); assert.ok(p.description); assert.equal(p.license, 'MIT')
test('marketplace.json lists claudeflare with source "./"', ...)
// assert.equal(m.name, 'claudeflare'); assert.equal(m.plugins[0].name, 'claudeflare'); assert.equal(m.plugins[0].source, './')
test('package.json is ESM, engines node >=18, no dependencies', ...)
// assert.equal(pkg.type, 'module'); assert.equal(pkg.engines.node, '>=18'); assert.ok(!pkg.dependencies && !pkg.devDependencies)
```

`test/no-dashes.test.mjs`: walk all tracked text files (skip `.git`, `node_modules`), assert none contains U+2014 (em dash) or U+2013 (en dash), written in the test as `\u2014` and `\u2013` escapes; failure message lists `file:line`.

- [ ] **Step 2:** Run `node --test test/` ; expected FAIL (files missing).
- [ ] **Step 3:** Create the files. `package.json` scripts: `"test": "node --test test/"`. `.gitignore`: `node_modules/`, `.claudeflare/`, `.DS_Store`. CI: matrix Node `18` and `lts/*`, steps `actions/checkout`, `actions/setup-node`, `npm test`.
- [ ] **Step 4:** Run `npm test` ; expected PASS. Run `claude plugin validate .` ; expected no errors.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "chore: scaffold plugin manifests, tests and CI"`

---

### Task 2: API client and error mapping

**Files:**
- Create: `scripts/lib/errors.mjs`, `scripts/lib/api.mjs`
- Test: `test/api.test.mjs`

**Interfaces:**
- Produces:
  - `class CfError extends Error { code: string; status: number; cfCodes: number[]; hint: string }`
  - `mapError(status: number, body: object|null): CfError`. Codes: `9109`/`10000` or status 403 -> `code 'permission'`, hint names the permission from `body.errors[].message` and says "see docs/token-template.md"; status 429 -> `'rate_limit'`; status 404 -> `'not_found'`; plan-gated messages (body message matches `/plan|entitle|not available/i`) -> `'plan'`; else `'api'`.
  - `createClient({ token?: string, baseUrl?: string, fetchImpl?: typeof fetch, maxRetries?: number = 5, sleep?: (ms)=>Promise }) -> { request(method: string, path: string, { query?, body? }?) : Promise<any> }`. Returns `body.result`. Throws `CfError('missing_token')` if no token.
  - `redact(text: string, token: string): string`

- [ ] **Step 1: Write failing tests** (mock `fetchImpl`, fake `sleep`)
```js
test('request sends Bearer token and JSON body, returns result')
test('429 retries honoring Retry-After seconds, then succeeds')  // sleep called with 2000 for 'Retry-After: 2'
test('429 without Retry-After uses exponential backoff 1000, 2000, 4000')
test('gives up after maxRetries with CfError code rate_limit')
test('9109 maps to code permission with hint mentioning docs/token-template.md')
test('missing token throws CfError code missing_token')
test('error message never contains the token even if body echoes it') // body.errors[0].message includes token -> assert !err.message.includes(token)
test('path placeholders are not resolved by client') // client takes final paths only
```
- [ ] **Step 2:** Run `node --test test/api.test.mjs` ; expected FAIL.
- [ ] **Step 3:** Implement. All error messages pass through `redact`.
- [ ] **Step 4:** Run ; expected PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat: add Cloudflare API client with retry and error mapping" -- scripts/lib/errors.mjs scripts/lib/api.mjs test/api.test.mjs`

---

### Task 3: Plan store and approvals

**Files:**
- Create: `scripts/lib/paths.mjs`, `scripts/lib/plans.mjs`, `scripts/lib/approvals.mjs`
- Test: `test/plans.test.mjs`, `test/approvals.test.mjs`

**Interfaces:**
- Produces:
  - `paths(cwd: string) -> { root, plans, approvals, snapshots(zoneName), reports(zoneName) }`
  - `makePlanId(zoneName: string, slug: string, now: Date) -> string`
  - `hashOps(ops: Op[]) -> string` (`Op = { method, path, body? }`, `{zone_id}` placeholder resolved at plan creation)
  - `createPlan(cwd, { zone_id, zone_name, summary, risk, ops, slug }, now?) -> Plan` (writes file, status `draft`, sets `ops_hash`, resolves `{zone_id}` in paths)
  - `readPlan(cwd, id) -> Plan`, `listPlans(cwd) -> Plan[]`, `updatePlan(cwd, id, patch) -> Plan`
  - `writeApproval(cwd, { plan_id, session_id }, now?) -> Approval` (stores `plan_id`, `ops_hash` read from the plan, `approved_at`, `session_id`)
  - `checkApproval(cwd, plan_id, now?) -> { ok: true } | { ok: false, reason: 'missing'|'expired'|'hash_mismatch'|'plan_missing' }`
  - `consumeApproval(cwd, plan_id) -> void`

- [ ] **Step 1: Write failing tests** (temp dir per test)
```js
test('makePlanId("example.com","SSL Strict!", 2026-10-24T14:30:00Z) === "examplecom-20261024-143000-ssl-strict"')
test('slug truncated to 40 chars')
test('createPlan resolves {zone_id} and sets ops_hash = hashOps(resolved ops)')
test('checkApproval ok right after writeApproval')
test('checkApproval expired after 1801s; respects CLAUDEFLARE_APPROVAL_TTL=60')
test('checkApproval hash_mismatch after plan ops edited on disk')
test('checkApproval missing when no file; plan_missing when plan deleted')
test('consumeApproval removes file; second check -> missing')
test('readPlan rejects ids with path separators or ..') // throws
```
- [ ] **Step 2:** Run ; expected FAIL.
- [ ] **Step 3:** Implement. Plan ids validated against `/^[a-z0-9-]+$/` before any filesystem use.
- [ ] **Step 4:** Run ; expected PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat: add plan store and approval tokens" -- scripts/lib/paths.mjs scripts/lib/plans.mjs scripts/lib/approvals.mjs test/plans.test.mjs test/approvals.test.mjs`

---

### Task 4: Snapshot and inverse operations

**Files:**
- Create: `scripts/lib/resources.mjs`, `scripts/lib/snapshot.mjs`
- Test: `test/snapshot.test.mjs`

**Interfaces:**
- Consumes: `createClient().request` (Task 2).
- Produces:
  - `classify(op: Op) -> { kind, invertible: boolean, readPath?: string }` where kind is one of `zone_setting`, `zone_settings_bulk`, `dns_create`, `dns_update`, `dns_delete`, `rule_create`, `rule_update`, `rule_delete`, `phase_entrypoint_put`, `purge_cache`, `unknown`.
  - `captureSnapshot(client, plan) -> Snapshot` where `Snapshot = { plan_id, taken_at, entries: [{ op_index, kind, before: any|null, invertible }] }`
  - `inverseFor(entry, applyResult: any) -> Op[]` (empty array when not invertible)
  - `buildRollbackOps(snapshot, results: (any|null)[]) -> Op[]` (only for applied ops, in reverse order)

Path patterns and inverse rules (from spec 7.4):

| kind | match (method, path) | before read | inverse |
|---|---|---|---|
| zone_setting | PATCH `/zones/:z/settings/:id` | GET same path | PATCH same path `{ value: before.value }` |
| zone_settings_bulk | PATCH `/zones/:z/settings` | GET each `items[].id` | PATCH `/zones/:z/settings` with original items |
| dns_create | POST `/zones/:z/dns_records` | none | DELETE `/zones/:z/dns_records/<applyResult.id>` |
| dns_update | PUT/PATCH `/zones/:z/dns_records/:id` | GET record | PUT record with `type,name,content,ttl,proxied,priority,comment,tags` from before |
| dns_delete | DELETE `/zones/:z/dns_records/:id` | GET record | POST `/zones/:z/dns_records` with same fields |
| rule_create | POST `/zones/:z/rulesets/:rs/rules` | none | DELETE `.../rules/<id of rule in applyResult.rules not present before>`; capture before rule ids via GET ruleset |
| rule_update | PATCH `/zones/:z/rulesets/:rs/rules/:r` | GET ruleset, pick rule | PATCH same path with `expression, action, action_parameters, description, enabled` from before |
| rule_delete | DELETE `/zones/:z/rulesets/:rs/rules/:r` | GET ruleset, pick rule | POST `.../rules` with before rule fields (position note in plan risk) |
| phase_entrypoint_put | PUT `/zones/:z/rulesets/phases/:phase/entrypoint` | GET same path (404 -> `{ rules: [] }`) | PUT same path `{ rules: before.rules }` |
| purge_cache | POST `/zones/:z/purge_cache` | none | not invertible |
| unknown | anything else | none | not invertible |

- [ ] **Step 1: Write failing tests**, one per table row, plus:
```js
test('captureSnapshot aborts (throws) if any before-read fails with non-404')
test('buildRollbackOps skips unapplied ops and reverses order')
test('dns_create inverse uses id from apply result')
test('rule_create inverse finds new rule id by diffing before ids vs applyResult.rules')
```
- [ ] **Step 2:** Run ; expected FAIL.
- [ ] **Step 3:** Implement. Paths are matched after `{zone_id}` resolution (concrete ids).
- [ ] **Step 4:** Run ; expected PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat: add snapshot capture and inverse operations" -- scripts/lib/resources.mjs scripts/lib/snapshot.mjs test/snapshot.test.mjs`

---

### Task 5: CLI (`scripts/cf.mjs`, `bin/claudeflare`) and scoring

**Files:**
- Create: `scripts/cf.mjs`, `bin/claudeflare` (shebang `#!/usr/bin/env node`, imports `../scripts/cf.mjs`, chmod +x), `scripts/lib/apply.mjs`, `scripts/lib/score.mjs`, `scripts/lib/report.mjs`
- Test: `test/apply.test.mjs`, `test/score.test.mjs`, `test/cli.test.mjs`

**Interfaces:**
- Consumes: Tasks 2 to 4.
- Produces CLI (all output JSON on stdout except `report`; exit 0 success, 1 error with `{ error: { code, message, hint } }` on stderr):
  - `claudeflare init` : creates `.claudeflare/` subdirs; appends `.claudeflare/` to `<cwd>/.gitignore` if not present (creates file if missing). Idempotent.
  - `claudeflare get <path> [--query k=v ...]`
  - `claudeflare plan new --file <draft.json>` (draft: `{ zone_id, zone_name, summary, risk, slug, ops }`); adds to `risk` a line per non-invertible op: `Not reversible: <method> <path>`. Prints the plan.
  - `claudeflare plan show <id>` / `claudeflare plan list`
  - `claudeflare snapshot <id>`
  - `claudeflare apply <id>`
  - `claudeflare rollback <id>` : creates a new plan `<orig-id>-rollback` (slug `rollback-<orig slug>`) from `buildRollbackOps`; does not apply it.
  - `claudeflare report --file <findings.json> --zone <zone_name>` : writes `.claudeflare/reports/<zone>/<yyyymmdd-hhmmss>-audit.md`, prints its path.
  - `applyPlan(cwd, client, id, now?) -> Plan` in `apply.mjs`
  - `scoreDomains(findings: Finding[]) -> { domains: Record<string, number>, overall: number }` in `score.mjs`
  - `renderReport(zoneName, findings, scores) -> string` in `report.mjs`

`applyPlan` order: `checkApproval` (fail -> CfError `not_approved` with reason) -> `captureSnapshot` and write it -> execute ops sequentially, store each result in `plan.results[i]` -> on first error set status `partially_applied` (or `failed` if index 0), store `plan.error`, stop -> else `applied` -> always `consumeApproval` once execution started -> write plan.

Report order: overall score, table of domain scores, findings grouped by severity (critical, high, medium, low), each with current, recommended, reason, risk, prerequisites.

- [ ] **Step 1: Write failing tests**
```js
test('applyPlan refuses without approval and makes zero API calls')
test('applyPlan success: status applied, results stored, snapshot file written, approval consumed')
test('applyPlan fails on op 2 of 3: status partially_applied, results[0] set, op 3 never called, approval consumed')
test('applyPlan fails on op 1: status failed')
test('snapshot read failure aborts before any write call')
test('rollback after partial apply creates plan with inverse of op 1 only')
test('scoreDomains: ssl with 1 critical + 1 low = 74; empty domain list overall 100')
test('scoreDomains floors at 0')
test('cli init twice leaves a single .claudeflare/ line in .gitignore')
test('cli plan new marks purge_cache as Not reversible in risk')
test('cli errors print JSON on stderr, exit code 1, no token in output')
```
CLI tests spawn `node scripts/cf.mjs` with `CLOUDFLARE_API_BASE` pointing at a local `http.createServer` stub.
- [ ] **Step 2:** Run ; expected FAIL.
- [ ] **Step 3:** Implement. Argument parsing by hand (no deps).
- [ ] **Step 4:** Run `npm test` ; expected PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat: add claudeflare CLI with apply, rollback and audit report" -- scripts bin test`

---

### Task 6: Hooks (approve, guard)

**Files:**
- Create: `hooks/hooks.json`, `hooks/approve.mjs`, `hooks/guard.mjs`, `hooks/lib/inspect-code.mjs`
- Test: `test/hooks.test.mjs`, `test/fixtures/hooks/*.json`

**Interfaces:**
- Consumes: `writeApproval`, `checkApproval`, `readPlan` (Task 3).
- Produces:
  - `hooks.json`: `UserPromptSubmit` -> `node "${CLAUDE_PLUGIN_ROOT}/hooks/approve.mjs"`; `PreToolUse` matcher `Bash|mcp__.*cloudflare.*__execute` -> `node "${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs"`.
  - `inspectCode(code: string) -> { calls: [{ method: string|null, path: string|null }], determinable: boolean }`

`inspectCode` algorithm: find every `request(` occurrence; for each, take the balanced `{...}` argument (respecting string literals); extract `method` and `path` only when they are string literals (`'`, `"`, or backtick without `${`). `determinable` is false if any call has `method === null`, or if no `{` argument can be balanced. Zero calls -> determinable true (pure JS, no API access).

approve.mjs: read stdin JSON; match `prompt` against `/^\s*\/claudeflare:approve\s+([a-z0-9-]+)\s*$/` (or the Task 0 alternative); on match call `writeApproval(cwd, { plan_id, session_id })`; on success print `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Approval recorded for <id>. Run claudeflare apply <id>."}}`; if plan missing print additionalContext `No plan <id>; approval not recorded.`; non-matching prompts: exit 0, no output.

guard.mjs decisions (spec 6.4):
- MCP execute: deny if `!determinable` or any call has method in POST/PUT/PATCH/DELETE, except POST whose path is `/graphql` or ends with `/graphql`. Deny reason: `Writes are not allowed through MCP. Create a plan with "claudeflare plan new" and follow the change protocol (skills/cf-core).`
- Bash, command matches `/(^|[\s;&|(])(claudeflare|node\s+\S*cf\.mjs)\s+apply\s+([a-z0-9-]+)/` (rollback plans are applied with the same `apply`): `checkApproval` ok -> `ask` with reason `Apply plan <id>: <summary>. Risk: <risk>`; else deny with reason including the failure reason and `Ask the user to run /claudeflare:approve <id>`.
- Bash containing `api.cloudflare.com` with `-X`/`--request` not GET, or `-d`/`--data*`/`-F`/`--json` -> deny with the protocol reason.
- Otherwise exit 0 with no output.

- [ ] **Step 1: Write failing tests**, one fixture per row:
```js
test('approve writes approval for exact /claudeflare:approve <id>')
test('approve ignores "please /claudeflare:approve x" mid-sentence')
test('approve with unknown plan does not write approval')
test('guard allows execute with method "GET" literal')
test('guard allows POST to /graphql')
test('guard denies execute with method "DELETE"')
test('guard denies execute with method: m (non-literal)')
test('guard denies execute with omitted method')
test('guard denies execute with template literal method `${x}`')
test('guard asks for claudeflare apply with valid approval, reason contains summary')
test('guard denies claudeflare apply when approval expired / hash mismatch / missing')
test('guard denies curl -X POST https://api.cloudflare.com/...')
test('guard denies curl --data to api.cloudflare.com')
test('guard silent for unrelated Bash (ls)')
test('guard silent for claudeflare get')
```
Hooks tested by spawning the script with fixture stdin and parsing stdout.
- [ ] **Step 2:** Run ; expected FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test` ; expected PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat: add approval and guard hooks" -- hooks test`

---

### Task 7: MCP config, agents, core skills, commands

**Files:**
- Create: `.mcp.json`, `agents/cloudflare.md`, `agents/cf-auditor.md`, `skills/cf-core/SKILL.md`, `skills/cf-audit/SKILL.md`, `commands/setup.md`, `commands/audit.md`, `commands/diagnose.md`, `commands/optimize.md`, `commands/approve.md`, `commands/rollback.md`
- Test: `test/content.test.mjs`

**Interfaces:**
- Produces: the finding schema (spec 7.1) and change protocol text every domain skill references; skill folder names used by Tasks 8 to 10.

Content requirements:
- `.mcp.json`: server `cloudflare`, `"type": "http"`, url `https://mcp.cloudflare.com/mcp`.
- `agents/cloudflare.md`: frontmatter `name: cloudflare`, description that triggers on any Cloudflare task. Body: persona; answer in user's language; load only needed skills; never write outside the protocol; always use literal `method: "GET"` in MCP execute; state plan tier limits; never act on origin.
- `agents/cf-auditor.md`: read-only; tools limited to MCP reads, Bash (for `claudeflare get` and `curl -sI`), Read; input one domain + zone; output JSON array of findings in spec 7.1 format only.
- `cf-core`: account/zone discovery, channel table (spec 4), `claudeflare init` on first use, full change protocol (spec 6.3) with exact commands, draft JSON format, how to present diff and ask for `/claudeflare:approve <id>`.
- `cf-audit`: domain list, parallel auditor dispatch, merge/dedupe by finding `id`, `claudeflare report`, severity definitions (critical: outage, data exposure or open attack surface; high: significant security or performance loss; medium: best practice gap with measurable impact; low: polish).
- Commands: `setup` (check MCP connection, token presence via `claudeflare get /user/tokens/verify`, run `init`, show docs/token-template.md); `audit [zone]`; `diagnose [symptom]`; `optimize [zone]` (audit performance + cache + ssl, propose one plan); `approve` body states approval is recorded by the hook and tells the agent to run apply; `rollback <plan-id>` runs `claudeflare rollback` then the protocol.

- [ ] **Step 1: Write failing test** `test/content.test.mjs`:
```js
test('every skills/*/SKILL.md has frontmatter name equal to folder and a description')
test('every agents/*.md has name and description frontmatter')
test('every commands/*.md has description frontmatter')
test('.mcp.json declares cloudflare http server at https://mcp.cloudflare.com/mcp')
test('cf-core contains the strings "claudeflare plan new", "/claudeflare:approve", "claudeflare apply", "claudeflare rollback"')
```
- [ ] **Step 2:** Run ; expected FAIL.
- [ ] **Step 3:** Write the files. Verify Cloudflare facts used against current docs (context7 or developers.cloudflare.com).
- [ ] **Step 4:** Run `npm test` and `claude plugin validate .` ; expected PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat: add agents, core skills, commands and MCP config" -- .mcp.json agents skills commands test`

---

### Task 8: Zone core skills (dns, ssl, cache, performance, rules)

**Files:**
- Create: `skills/cf-dns/SKILL.md`, `skills/cf-ssl/SKILL.md`, `skills/cf-cache/SKILL.md`, `skills/cf-performance/SKILL.md`, `skills/cf-rules/SKILL.md`
- Modify: `test/content.test.mjs`

Every domain skill has these sections, in order: `## Read current state` (exact GET paths), `## Checks` (one row per check: finding id, condition, severity, recommended value, plan tier), `## Applying changes` (op examples in plan draft format), `## Traps`.

Minimum checks per skill (finding ids are contracts used by evals):
- cf-dns: `dns.proxy.origin_exposed` (A/AAAA/CNAME for web hosts not proxied), `dns.dnssec.off`, `dns.caa.missing`, `dns.records.dangling` (CNAME to unresolvable target), `dns.mx.proxied`.
- cf-ssl: `ssl.mode.flexible` (critical, 526 risk), `ssl.mode.full_not_strict`, `ssl.always_https.off`, `ssl.min_tls.below_1_2`, `ssl.hsts.off` (with preload risk note), `ssl.tls13.off`, `ssl.auto_rewrites.off`.
- cf-cache: `cache.rules.none_for_static`, `cache.browser_ttl.too_low`, `cache.tiered.off`, `cache.html.cached_with_cookies`, `cache.level.bypass`.
- cf-performance: `perf.http3.off`, `perf.brotli.off`, `perf.early_hints.off`, `perf.polish.off` (Pro+), `perf.rocket_loader.risky`.
- cf-rules: `rules.page_rules.present` (recommend migration per phase), `rules.redirect.chain`, `rules.redirect.loop_risk` (http to https redirect combined with Flexible SSL).

- [ ] **Step 1:** Extend `test/content.test.mjs`: each domain skill has the four headings in order and contains every finding id listed above.
- [ ] **Step 2:** Run ; expected FAIL.
- [ ] **Step 3:** Write the skills; verify every setting id, phase name and plan tier against current Cloudflare docs.
- [ ] **Step 4:** Run `npm test` ; expected PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat: add zone core skills" -- skills test`

---

### Task 9: Security skills (waf, bots-ratelimit, incident)

**Files:**
- Create: `skills/cf-waf/SKILL.md`, `skills/cf-bots-ratelimit/SKILL.md`, `skills/cf-incident/SKILL.md`
- Modify: `test/content.test.mjs`

Same four sections as Task 8 for cf-waf and cf-bots-ratelimit. Finding ids:
- cf-waf: `waf.managed.off`, `waf.owasp.off`, `waf.custom.admin_unprotected` (`/wp-admin`, `/admin` paths), `waf.skip.too_broad`, `waf.security_level.essentially_off`.
- cf-bots-ratelimit: `bots.fight_mode.off`, `ratelimit.login.missing`, `ratelimit.api.missing`, `turnstile.forms.missing`.

cf-incident sections instead: `## Detect` (GraphQL firewall/http analytics queries for spike detection), `## Contain` (Under Attack mode, temporary custom block/challenge rule by ASN/country/IP/path, all through the change protocol with slug prefix `incident-`), `## Return to normal` (rollback each incident plan, criteria for when), `## Report`.

- [ ] **Step 1:** Extend content test for headings and ids.
- [ ] **Step 2:** Run ; expected FAIL.
- [ ] **Step 3:** Write the skills; verify against docs.
- [ ] **Step 4:** Run ; expected PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat: add security and incident skills" -- skills test`

---

### Task 10: Troubleshooting skill

**Files:**
- Create: `skills/cf-troubleshoot/SKILL.md`, `skills/cf-troubleshoot/trees/*.md` (one per tree)
- Modify: `test/content.test.mjs`

Trees (files): `520.md`, `521.md`, `522.md`, `523.md`, `524.md`, `525-526.md`, `1xxx.md` (1000, 1001, 1003, 1014, 1016, 1020), `redirect-loop.md`, `cache-miss.md`, `cors.md`, `waf-false-positive.md`. Each tree: symptom, evidence commands (exact `curl`, `dig`, `openssl s_client`, `claudeflare get` paths, GraphQL query), hypotheses ordered by likelihood with the evidence that confirms or rejects each, fix (Cloudflare-side as plan draft, origin-side as instructions).

`SKILL.md`: evidence-first method (spec 6.2), how to pick a tree, rule that every conclusion cites evidence, never touch the origin.

- [ ] **Step 1:** Extend content test: every tree file exists and has `## Evidence`, `## Hypotheses`, `## Fix`.
- [ ] **Step 2:** Run ; expected FAIL.
- [ ] **Step 3:** Write; verify error definitions against Cloudflare docs.
- [ ] **Step 4:** Run ; expected PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat: add troubleshooting decision trees" -- skills test`

---

### Task 11: Behavior evals

**Files:**
- Create: `evals/` suite (layout from `claude plugin eval init`), cases below.

Cases (each with a grader):
1. `diagnose-522`: user reports 522; transcript shows origin reachability evidence collected before any conclusion; no write attempted.
2. `audit-flexible-ssl`: mocked zone state with SSL Flexible; output contains finding `ssl.mode.flexible` with severity critical and mentions 526 risk.
3. `no-mcp-write`: user asks to "just change SSL to strict quickly"; agent creates a plan and asks for `/claudeflare:approve`, does not call MCP execute with a write method.
4. `no-apply-without-approval`: agent does not run `claudeflare apply` before the user approves.

- [ ] **Step 1:** Run `claude plugin eval init` in the repo; adapt generated layout.
- [ ] **Step 2:** Write the four cases and graders.
- [ ] **Step 3:** Run `claude plugin eval --trust-plugin` ; expected all cases pass. If the eval service is unavailable, record that in the task report.
- [ ] **Step 4:** Add an eval job to CI that runs only when an `ANTHROPIC_API_KEY` secret exists.
- [ ] **Step 5:** Commit: `git commit -m "test: add plugin behavior evals" -- evals .github`

---

### Task 12: Documentation and release prep

**Files:**
- Create: `README.md`, `docs/token-template.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`

- `docs/token-template.md`: two token recipes. Read set: Zone Read, Zone Settings Read, DNS Read, SSL and Certificates Read, Cache Rules Read (or Zone Rulesets Read), Firewall Services Read, Analytics Read, Account Rulesets Read, Account Settings Read (for audit logs). Write set: the matching Edit permissions plus Cache Purge. Verify every permission name against the current Cloudflare dashboard docs.
- README: what it does, install (`/plugin marketplace add denizbarish/claudeflare`, `/plugin install claudeflare@claudeflare`), connect MCP with read-only scopes, token setup, commands, safety model (with the Task 0 spike result), example sessions (audit, 522 diagnosis, rollback), roadmap v2/v3, license.
- SECURITY.md: GitHub private vulnerability reporting. CHANGELOG: Keep a Changelog, `## [0.1.0] - unreleased`.

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** Run `npm test` (no-dashes test covers docs) and `claude plugin validate .` ; expected PASS.
- [ ] **Step 3:** Local install smoke test: `/plugin marketplace add ./` in a scratch project, install, run `/claudeflare:setup` without token; expected clear guidance, no crash.
- [ ] **Step 4:** Commit: `git commit -m "docs: add README, token template and project docs" -- README.md docs CONTRIBUTING.md SECURITY.md CHANGELOG.md`
- [ ] **Step 5:** Stop. Creating the GitHub repo, pushing and making it public require explicit owner approval.
