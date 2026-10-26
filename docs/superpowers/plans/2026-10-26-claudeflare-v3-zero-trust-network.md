# claudeflare v3 (0.3.0) Zero Trust and Network Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Access, Tunnel, Gateway, WARP devices, Load Balancing and Spectrum to claudeflare with audit, diagnosis, and plan/approve/apply/rollback changes, lockout warnings, report-only verification and strict secret handling.

**Architecture:** One shared REST engine (kind registry, default inverses, conflict check, redaction, drift precheck, verification runner) plus one rule module per product under `scripts/lib/products/`. Ops keep the v1 `{ method, path, body }` shape. Product modules add lockout analysis, dependency checks, inverse overrides and default verification checks.

**Tech Stack:** Node.js >= 18, ESM `.mjs`, `node:test` + `node:assert/strict`, no runtime dependencies. Claude Code plugin (skills, agents, commands, hooks).

**Spec:** `docs/superpowers/specs/2026-10-26-claudeflare-v3-zero-trust-network-design.md` (read it with v1 and v2 specs in the same folder).

## Global Constraints

- No new npm dependencies. Node >= 18 built-ins only (`fetch`, `node:net`, `node:crypto`).
- Ops stay `{ method, path, body }`; no new op `kind`. Optional op fields: `confirm_name`, `verify`, `secret_fields_from_env`, all inside the ops hash.
- Account plans may omit `project_dir` only when they hold no `wrangler` op.
- A plan never mixes product (v3) REST ops with `wrangler` ops (`plan_conflict`), and never mixes scopes.
- Lockout lines use the exact prefix `Lockout risk:`. They never refuse a plan.
- Verification is report-only: failed check sets status `applied_verify_failed` and creates a rollback draft; rollback plans are verified but never get a rollback draft of their own.
- New error codes, exact: `not_entitled`, `missing_permission`, `resource_in_use`, `rollback_drift`, `risk_changed`, `too_large`; reused: `secret_env_missing`, `plan_conflict`, `invalid_op`.
- Secrets (tunnel `token`, `credentials_file`, `tunnel_secret`, service token `client_secret`, IdP secret fields) never reach plan files, snapshots, results, stdout, stderr or error messages.
- Verification timeout 60 s per op, retry every 5 s.
- Writes accepted only on account-scoped Zero Trust paths; zone paths `/zones/<z>/access/...` are refused with a message pointing to the account form.
- Not on any allowlist: Dashboard SSO, members, billing, Access `revoke_tokens` / `revoke_user`, service token `refresh` / `rotate`, device unenroll/revoke, Gateway configuration PUT, Gateway list PATCH.
- Docs, skills, code comments: no em or en dashes (`test/no-dashes.test.mjs` enforces).
- Commit after each task with `git commit -- <files>`; never push, tag or release without the owner's explicit approval.
- Cloudflare calls in live steps run from a host allowed by the token IP filter, token read from the OS secret store, never printed; no retry after an auth failure.

## Review Focus

1. **Lists longer than one page** (more than `per_page` Access apps, Gateway rules, CNAMEs): dependency scans and lockout analysis must read every page, or an in-use resource looks unused. Test in Task 6.
2. **429 or 5xx mid-apply:** apply must stop with `partially_applied`, redact the error, and the rollback must still cover the ops that ran. Test in Task 4.
3. **Gateway `traffic` reformatted by the API:** drift and read-back must compare against the value the API returned after apply, not the sent value, or every rollback reports false drift. Test in Task 5 and Task 11.
4. **Plans created by 0.2.x** (no `lockout_risks`, account plans with `project_dir`, Pages rollback op) must still apply and roll back unchanged. Test in Task 2 and Task 6.
5. **A secret echoed back in an API error body** (400 that repeats the request): error messages and stored `error` fields must be redacted like results. Test in Task 4.

---

### Task 0: Spike (owner-gated)

Runs only after the owner has a Zero Trust org on account `denizbarish` and added the section 12 permissions to the token. Every write in this task is announced to the owner first and cleaned up in the same session. Results go into `docs/superpowers/plans/2026-10-26-v3-spike-results.md`.

**Files:**
- Create: `docs/superpowers/plans/2026-10-26-v3-spike-results.md`

- [ ] **Step 1: Read-only checks from the allowed host** (token from the OS secret store, never echoed): `GET /accounts/<id>/access/organizations` (org exists, `auth_domain`), `GET .../access/apps`, `.../gateway/rules`, `.../cfd_tunnel?is_deleted=false`, `.../devices/policies`, `.../load_balancers/pools`. Record which fields GET returns per resource (for `readOnlyFields`) and HTTP codes for missing permissions.
- [ ] **Step 2: Access redirect check:** with owner approval, create a throwaway self-hosted Access app on `spike-v3.denizbarish.com` with one allow policy, `curl -sI` the hostname without a session. Record status code and `Location` host. Then try deleting the reusable policy while attached; record the API response. Delete app and policy.
- [ ] **Step 3: Gateway list delete while referenced:** create list + DNS rule referencing it, try list delete, record response, delete both.
- [ ] **Step 4: Docs-only checks:** `cloudflared` `--token-file` flag availability and minimum version; Spectrum `edge_ips` on re-create; Access and Gateway log datasets (REST `access/logs/access_requests`, GraphQL Gateway datasets).
- [ ] **Step 5: Write results file** with one section per spec "unverified" item: observed behavior, and the plan change it causes (or "no change").
- [ ] **Step 6: Commit**

```bash
git commit -m "docs: v3 spike results" -- docs/superpowers/plans/2026-10-26-v3-spike-results.md
```

If the owner cannot provide the org yet, skip Task 0, continue with Task 1, and keep the spec's defaults (preflight refuses in-use deletes itself; Access verify expects 302 to `<team>.cloudflareaccess.com`). Run Task 0 before Task 10.

---

### Task 1: Account plans without `project_dir`

**Files:**
- Modify: `scripts/lib/plans.mjs:88-97` (`accountTarget`), `scripts/cf.mjs:133-140` (`readDraft`), `scripts/lib/apply.mjs:292-294` (rollback target)
- Test: `test/plans.test.mjs`, `test/cli-v2.test.mjs`

**Interfaces:**
- Produces: `accountTarget({ account_id, account_name, project_dir }, { requireProjectDir = true }) -> { account_id, account_name, account_slug, project_dir: string | null }`.

- [ ] **Step 1: Write failing tests**

```js
test('accountTarget accepts a missing project_dir when not required', () => {
  const t = accountTarget({ account_id: A, account_name: 'Acme' }, { requireProjectDir: false });
  assert.equal(t.project_dir, null);
});
test('accountTarget still requires project_dir by default', () => {
  assert.throws(() => accountTarget({ account_id: A, account_name: 'Acme' }), { code: 'invalid_account' });
});
test('plan new: REST-only account draft without project_dir creates a plan', async () => { /* cli-v2 harness, draft ops: [{ method: 'POST', path: `/accounts/${A}/cfd_tunnel`, body: { name: 't', config_src: 'cloudflare' } }] after Task 2 registers the kind; until then use the Pages rollback op */ });
test('plan new: account draft with a wrangler op and no project_dir fails with invalid_account', async () => {});
```

- [ ] **Step 2: Run** `node --test test/plans.test.mjs test/cli-v2.test.mjs` and confirm the new tests fail.
- [ ] **Step 3: Implement.** `readDraft` passes `requireProjectDir: draft.ops.some((op) => op?.kind === 'wrangler')`. `createPlan` stores `project_dir: null` when absent. `createRollbackPlan` copies `project_dir` as is.
- [ ] **Step 4: Run** `npm test`; all pass.
- [ ] **Step 5: Commit** `git commit -m "feat: account plans without project_dir for REST-only ops" -- scripts/lib/plans.mjs scripts/cf.mjs scripts/lib/apply.mjs test/plans.test.mjs test/cli-v2.test.mjs`

---

### Task 2: Product kind registry and op validation

**Files:**
- Create: `scripts/lib/products/index.mjs` (registry, contract JSDoc, lookups), `scripts/lib/products/fields.mjs` (field path helpers)
- Modify: `scripts/lib/resources.mjs` (replace `ACCOUNT_REST_ALLOWLIST` usage, zone ZT deny, extra op fields, mixing rule)
- Test: `test/products-registry.test.mjs`, `test/fields.test.mjs`

**Interfaces:**
- Produces, in `products/index.mjs`:
  - Kind entry contract (JSDoc typedef `ProductKind`):
    `{ kind, product, scope: 'account'|'zone', methods: string[], pattern: RegExp /* relative to base */, resource(m) -> { type, id } | null, read?(m, base) -> string, collection?(m, base) -> string, readOnlyFields: string[], inverse: 'delete_created'|'put_before'|'patch_before'|'recreate'|'none'|Function, destructive: boolean, nameField?: string, secretFields?: string[], redact?: string[], secretSink?: string[], group?(m) -> string, notes?(ctx, op) -> string[] }`
  - Product module contract (`ProductModule`): `{ product, kinds: ProductKind[], entitlement?(client, base) -> Promise<{ ok, detail }>, probePath(base) -> string, gather(client, base, ops) -> Promise<object>, lockoutRisks(ctx, ops) -> string[], dependencies?(ctx, op, entry) -> string[] /* in-use descriptions */, verifyChecks(op, entry, ctx, result) -> Check[], conflicts?(ops, classified) -> void /* throws plan_conflict */ }`
  - `registerProduct(module)` (used by tests), `PRODUCTS: ProductModule[]` (filled by Tasks 9 to 14), `classifyProductOp(op, plan) -> { entry, module, match, base } | null`, `baseFor(plan) -> '/accounts/<id>' | '/zones/<id>'`.
- Produces, in `products/fields.mjs`: `getPath(obj, 'a.b') -> any`, `setPath(obj, 'a.b', v) -> object (copy)`, `omitPaths(obj, paths) -> object (copy)`, `redactPaths(obj, paths, mark = '[redacted]') -> object (copy)`. Paths are dot-separated; a `*` segment matches every array element.

- [ ] **Step 1: Write failing tests** (`test/products-registry.test.mjs`) with a fake product registered through `registerProduct`:

```js
test('account op matching a registered kind is accepted', () => { validateOpTargets([{ method: 'PUT', path: `/accounts/${A}/fake/things/${UUID}`, body: {} }], acctPlan); });
test('unknown account write path is invalid_op', () => { assert.throws(() => validateOpTargets([{ method: 'POST', path: `/accounts/${A}/members` }], acctPlan), { code: 'invalid_op' }); });
test('Pages rollback op still accepted (0.2.x plans)', () => {});
test('zone-scoped access path is refused with a hint to the account form', () => {
  assert.throws(() => validateOpTargets([{ method: 'POST', path: `/zones/${Z}/access/apps`, body: {} }], zonePlan), (e) => e.code === 'invalid_op' && /\/accounts\/<account_id>\/access/.test(e.message));
});
test('other zone writes keep the v1 open policy', () => { validateOpTargets([{ method: 'POST', path: `/zones/${Z}/dns_records`, body: {} }], zonePlan); });
test('product op mixed with a wrangler op is plan_conflict', () => {});
test('destructive kind without confirm_name is invalid_op', () => {});
test('literal value in a secretFields path is invalid_op', () => {});
test('secret_fields_from_env must map declared secretFields to env var names matching /^[A-Z_][A-Z0-9_]*$/', () => {});
test('verify.expect accepts access_login, status:<100-599>, tunnel_serving, pool_healthy, tcp_open only', () => {});
test('two ops on the same resource key is plan_conflict; delete plus any op on the key is plan_conflict', () => {});
```

`test/fields.test.mjs`: `getPath`, `setPath` copy semantics, `omitPaths` with `config.client_secret`, `redactPaths` with `rules.*.secret`.

- [ ] **Step 2: Run** `node --test test/products-registry.test.mjs test/fields.test.mjs`; expect failures (module missing).
- [ ] **Step 3: Implement** the registry and helpers. In `resources.mjs`: `validateOpTargets` checks `classifyProductOp` for account plans before the Pages rollback entry; zone plans refuse paths matching `^/zones/[^/]+/access(/|$)`; extra op field validation lives in a new exported `validateProductFields(op, entry, index)`; `validatePlanOps` claims `${entry.resource(m).type} ${id}` keys for product ops and then calls each module's `conflicts`.
- [ ] **Step 4: Run** `npm test`; all pass (0.2.x tests unchanged).
- [ ] **Step 5: Commit** `git commit -m "feat: product kind registry and v3 op validation" -- scripts/lib/products scripts/lib/resources.mjs test/products-registry.test.mjs test/fields.test.mjs`

---

### Task 3: Default snapshots and inverses

**Files:**
- Create: `scripts/lib/rest-engine.mjs`
- Modify: `scripts/lib/snapshot.mjs` (`captureSnapshot`, `inverseFor`, `buildRollbackOps` dispatch for product kinds), `scripts/lib/apply.mjs:82-88` (`withIrreversibleRisk` uses product invertibility and `notes`)
- Test: `test/rest-engine.test.mjs`

**Interfaces:**
- Consumes: `classifyProductOp`, `omitPaths` (Task 2).
- Produces, in `rest-engine.mjs`:
  - `captureProductEntry(client, op, classified) -> Promise<{ kind, product, path, before, invertible, group? }>`; `before` is `GET read(m, base)` for `put_before`, `patch_before`, `recreate`, else `null`.
  - `inverseForProduct(entry, applyResult) -> op[]` implementing the spec 4.4 table. `delete_created` uses `applyResult.id`; missing id throws `rollback_ambiguous`. `patch_before` sends before values of the top-level keys of the original op body; a key absent in `before` falls back to `put_before` when the kind declares `putFallback: true`, else throws `rollback_ambiguous`. `recreate` posts to `collection(m, base)`.
  - Snapshot entries for product ops also store `op_body_keys` (top-level keys) so the inverse does not need the plan.

- [ ] **Step 1: Write failing tests**, one per inverse type with a fake kind, plus:

```js
test('put_before strips readOnlyFields', () => { /* before has id, created_at; inverse body lacks them */ });
test('patch_before restores only keys the op set', () => {});
test('patch_before with a key absent before and no putFallback is rollback_ambiguous', () => {});
test('recreate posts to the collection without readOnlyFields', () => {});
test('none yields no inverse and withIrreversibleRisk adds "Not reversible: PUT <path>"', () => {});
test('function inverse from the kind is called with (entry, applyResult)', () => {});
test('withIrreversibleRisk appends kind notes lines', () => {});
test('a product snapshot read error aborts before any write', async () => {});
```

- [ ] **Step 2: Run** `node --test test/rest-engine.test.mjs`; fail.
- [ ] **Step 3: Implement** `rest-engine.mjs` and the dispatch in `snapshot.mjs` (product ops go to `captureProductEntry` / `inverseForProduct`; a `rollback_ambiguous` from a product entry is pushed to `unresolved` like wrangler entries).
- [ ] **Step 4: Run** `npm test`; pass.
- [ ] **Step 5: Commit** `git commit -m "feat: default snapshots and inverses for product kinds" -- scripts/lib/rest-engine.mjs scripts/lib/snapshot.mjs scripts/lib/apply.mjs test/rest-engine.test.mjs`

---

### Task 4: REST executor with secrets handling

**Files:**
- Create: `scripts/lib/rest-exec.mjs`, `scripts/lib/secret-files.mjs`
- Modify: `scripts/lib/apply.mjs` (non-wrangler path calls `executeRestOps`), `scripts/lib/api.mjs` (`redact` accepts extra values), `scripts/lib/paths.mjs` (add `secrets`, `secretFilesIndex`)
- Test: `test/rest-exec.test.mjs`, `test/secret-files.test.mjs`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces:
  - `paths(cwd).secrets -> <cwd>/.claudeflare/secrets`, `paths(cwd).secretFilesIndex -> <cwd>/.claudeflare/secret-files.json`.
  - `executeRestOps({ client, plan, cwd, env = process.env }) -> Promise<{ status, results, error?, post: Array<object|null> }>`: for each op, inject `secret_fields_from_env` values (`setPath`), send, redact the result by the kind's `redact` paths, write `secretSink` fields to the secrets dir, GET `read(m, base)` after a successful product op into `post[i]` (stored redacted). v1 zone ops behave as `executeOps` today (`post[i] = null`).
  - `assertSecretFieldsEnv(plan, env) -> void` throws `secret_env_missing` before the snapshot.
  - `writeSecretFile(cwd, name, data) -> string` (mode 0600, path returned, `.claudeflare/.gitignore` contains `secrets/`), `recordSecretFile(cwd, absPath) -> void` (adds to the index), `listSecretFiles(cwd) -> string[]`.
  - Error redaction: every secret value injected or received in the run is passed to `redact` for `error.message`.

- [ ] **Step 1: Write failing tests**

```js
test('secret_fields_from_env injects the value into the sent body only', async () => {
  // fake client records body; plan file, results, post and stdout contain no "s3cr3t"
});
test('missing env var is secret_env_missing and nothing is sent', async () => {});
test('redact paths replace token and credentials_file in results and post', async () => {});
test('secretSink writes client_id and client_secret to .claudeflare/secrets/<plan>-<i>.json with mode 0600', async () => {});
test('the sink file is listed in secret-files.json and .claudeflare/.gitignore has secrets/', async () => {});
test('a 400 error echoing the injected secret is redacted in error.message', async () => {});
test('429 on op 2 of 3 ends partially_applied with results for op 1 and rollback covers op 1', async () => {});
test('zone v1 plan through executeRestOps behaves exactly as before', async () => {});
```

- [ ] **Step 2: Run** `node --test test/rest-exec.test.mjs test/secret-files.test.mjs`; fail.
- [ ] **Step 3: Implement.** `applyPlan` non-wrangler path: `assertSecretFieldsEnv` before snapshot; `executeRestOps` replaces `executeOps`; `post` is written by Task 5 (keep it in the outcome for now).
- [ ] **Step 4: Run** `npm test`; pass.
- [ ] **Step 5: Commit** `git commit -m "feat: REST executor with secret injection, redaction and sink" -- scripts/lib/rest-exec.mjs scripts/lib/secret-files.mjs scripts/lib/apply.mjs scripts/lib/api.mjs scripts/lib/paths.mjs test/rest-exec.test.mjs test/secret-files.test.mjs`

---

### Task 5: Post-apply state and drift precheck

**Files:**
- Modify: `scripts/lib/apply.mjs` (write post file, rollback precheck, status rules), `scripts/lib/rest-engine.mjs` (`stableEqual`, groups)
- Test: `test/drift.test.mjs`

**Interfaces:**
- Consumes: `post` from Task 4.
- Produces:
  - `postFile(cwd, plan) -> <snapshots dir>/<plan id>.post.json`, written once (`wx`) after a product plan runs.
  - Rollback ops built from product entries carry `precheck: { kind: 'drift', read: <path>, expect: <post state minus readOnlyFields> , group?: string }`, inside the rollback plan's ops hash.
  - `stableEqual(a, b, ignore: string[]) -> boolean` (key-order independent deep equal).
  - Rollback run: before each op with a drift precheck, GET and compare; mismatch skips the op and every later op with the same `group`, records `{ skipped: true, reason: 'rollback_drift' }`; end status `partially_applied` when anything was skipped; source plan becomes `rolled_back` only when status is `applied`.

- [ ] **Step 1: Write failing tests**

```js
test('rollback with unchanged resource runs the inverse', async () => {});
test('rollback after an outside change skips that inverse with rollback_drift', async () => {});
test('skip also skips later ops in the same group, other ops still run', async () => {});
test('rollback with a skip ends partially_applied and the source stays applied', async () => {});
test('drift compares against the post state returned by the API (reformatted traffic does not count as drift)', async () => {
  // op sent traffic 'any(dns.domains[*] == "x.com")', API returned 'any(dns.domains[*] == "x.com") ' reformatted; post holds the returned form
});
test('v1 and v2 rollbacks carry no drift precheck', async () => {});
```

- [ ] **Step 2: Run** `node --test test/drift.test.mjs`; fail.
- [ ] **Step 3: Implement.** `stripComputed` in `preflight.mjs` already drops `precheck`; confirm `plan new` cannot inject a drift precheck (test it).
- [ ] **Step 4: Run** `npm test`; pass.
- [ ] **Step 5: Commit** `git commit -m "feat: drift precheck on product rollbacks" -- scripts/lib/apply.mjs scripts/lib/rest-engine.mjs test/drift.test.mjs`

---

### Task 6: Preflight for product ops: entitlement, permissions, dependencies, lockout

**Files:**
- Create: `scripts/lib/product-preflight.mjs`, `scripts/lib/paginate.mjs`
- Modify: `scripts/lib/preflight.mjs` (`runPreflight` calls product preflight for account and zone plans), `scripts/cf.mjs` (`planNew` stores `lockout_risks`, adds lines to risk), `scripts/lib/apply.mjs` (re-run lockout analysis, `risk_changed`), `scripts/lib/errors.mjs` if codes are enumerated there
- Test: `test/product-preflight.test.mjs`, `test/paginate.test.mjs`

**Interfaces:**
- Consumes: registry (Task 2).
- Produces:
  - `listAll(client, path, { query = {}, perPage = 50, cursor = false }) -> Promise<object[]>` reads every page (`result_info.total_pages`, or `result_info.cursor` when `cursor: true`).
  - `runProductPreflight(client, plan, ops) -> Promise<{ checks: Check[], lockout_risks: string[], dependencies: Record<string, string[]>, ctx: Record<product, object> }>` where `Check = { name, ok, detail }`. Order per product touched: `entitlement` (fail: `not_entitled`), probe GET (403: `missing_permission` naming the token template permission), `gather`, `confirm_name` equals `before[nameField]` for destructive ops, `dependencies` (non-empty: `resource_in_use`), `lockoutRisks`.
  - Plan field `lockout_risks: string[]`; each line also appended to `risk`. Approval message and guard ask show `Lockout risk:` lines first (`hooks/lib/plan-text.mjs`).
  - Apply: for product plans, `runProductPreflight` again before the snapshot; any line in the new `lockout_risks` not in the plan's list: throw `risk_changed` (approval kept, nothing written). A plan without `lockout_risks` (0.2.x) skips this check.

- [ ] **Step 1: Write failing tests**

```js
test('listAll reads three pages', async () => {});
test('listAll follows cursor pagination', async () => {});
test('not entitled product fails with not_entitled', async () => {});
test('403 on probe fails with missing_permission and the permission name', async () => {});
test('confirm_name mismatch fails', async () => {});
test('in-use resource on page 2 of a list is found and refused with resource_in_use', async () => {});
test('lockout lines are stored in lockout_risks and appended to risk', async () => {});
test('apply stops with risk_changed when a new lockout line appears, approval kept', async () => {});
test('apply continues when a lockout line disappeared', async () => {});
test('0.2.x plan without lockout_risks applies as before', async () => {});
test('approval and guard ask text list Lockout risk lines first', () => {});
```

- [ ] **Step 2: Run** the two test files; fail.
- [ ] **Step 3: Implement.** Zone plans: `runPreflight` currently returns early for zone scope; run product preflight first when any op is a product zone op.
- [ ] **Step 4: Run** `npm test`; pass.
- [ ] **Step 5: Commit** `git commit -m "feat: product preflight with lockout analysis and risk_changed" -- scripts/lib/product-preflight.mjs scripts/lib/paginate.mjs scripts/lib/preflight.mjs scripts/cf.mjs scripts/lib/apply.mjs hooks/lib/plan-text.mjs test/product-preflight.test.mjs test/paginate.test.mjs`

---

### Task 7: Verification runner

**Files:**
- Create: `scripts/lib/verify.mjs`
- Modify: `scripts/lib/apply.mjs` (run checks, status, rollback draft, `ROLLBACK_SOURCE_STATUSES`), `scripts/lib/health-check.mjs` (export `tryOnce` for reuse)
- Test: `test/verify.test.mjs`

**Interfaces:**
- Consumes: module `verifyChecks` (Task 2 contract), `post` (Task 4).
- Produces:
  - `Check = { name: string, run: () => Promise<{ ok: boolean, detail: string }> }`.
  - Built-in check factories: `readbackCheck(post, sentBody, ignore)`, `accessLoginCheck(url, teamDomain, { fetchImpl })` (no redirect follow; ok when status 302 and `Location` host equals `teamDomain`), `statusCheck(url, code, { fetchImpl })`, `tunnelServingCheck(url, { fetchImpl })` (ok when the body has no `1016` / `1033` error code and status < 500 or `cf-ray` present), `poolHealthyCheck(client, poolPath)`, `tcpOpenCheck(host, port, { connect })`.
  - `runVerify(checks, { timeoutMs = 60000, intervalMs = 5000, sleep, now }) -> Promise<{ ok, checks: [{ name, ok, detail }] }>`; each check retried until ok or timeout.
  - `opVerifyChecks(op, entry, module, ctx, result, post, deps) -> Check[]` merges module defaults with `op.verify` (`access_login` uses `op.verify.url`, `status:<code>`, `tunnel_serving`, `pool_healthy`, `tcp_open` with `host:port` from `op.verify.url`).
  - Apply: `results[i].verify = { ok, checks }`; any failure on a normal plan: status `applied_verify_failed`, then `createRollbackPlan` runs and its id is stored as `rollback_draft` on the plan and printed. On a rollback plan: status `applied_verify_failed`, no draft. `ROLLBACK_SOURCE_STATUSES` adds `applied_verify_failed`; `createRollbackPlan` refuses sources that have `rollback_of` and status `applied_verify_failed`.

- [ ] **Step 1: Write failing tests**

```js
test('runVerify retries until ok within the timeout', async () => {});
test('runVerify fails after 60 s with the last detail', async () => {});
test('accessLoginCheck ok on 302 to <team>.cloudflareaccess.com, fails on 200', async () => {});
test('tunnelServingCheck fails on a 1033 body', async () => {});
test('failed check sets applied_verify_failed and creates a rollback draft named in the plan', async () => {});
test('failed check on a rollback plan creates no draft', async () => {});
test('op.verify status:404 overrides nothing and adds a check', async () => {});
test('verification never undoes anything (no write requests after the last op)', async () => {});
```

- [ ] **Step 2: Run** `node --test test/verify.test.mjs`; fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`; pass.
- [ ] **Step 5: Commit** `git commit -m "feat: report-only verification after apply" -- scripts/lib/verify.mjs scripts/lib/apply.mjs scripts/lib/health-check.mjs test/verify.test.mjs`

---

### Task 8: `claudeflare tunnel-token` and guard additions

**Files:**
- Create: `scripts/lib/tunnel-token.mjs`, `hooks/lib/secret-rules.mjs`
- Modify: `scripts/cf.mjs` (command), `hooks/guard.mjs` (`decideRead`, `decideSearch`, `decideBash`, `decideExecute`), `hooks/lib/allowed-call.mjs`
- Test: `test/tunnel-token.test.mjs`, `test/hooks.test.mjs`

**Interfaces:**
- Consumes: `recordSecretFile`, `listSecretFiles` (Task 4).
- Produces:
  - CLI: `claudeflare tunnel-token --account <id> --tunnel <uuid> --env-file <path> [--var TUNNEL_TOKEN]`. Prints `{ "file": "<abs path>", "variable": "TUNNEL_TOKEN", "gitignored": true|false }`. Never prints the value. `--var` must match `/^[A-Z_][A-Z0-9_]*$/`.
  - `writeEnvVar(file, name, value) -> void`: creates with 0600, replaces an existing `NAME=` line, keeps other lines, keeps mode of an existing file but warns when it is group or world readable (`mode_warning` in output).
  - `isGitIgnored(file) -> boolean` via `git check-ignore -q` (false outside a git repo).
  - Guard: `isAllowedCall` denies GET on `/accounts/<id>/cfd_tunnel/<id>/token`; MCP code calling it is denied with reason naming `claudeflare tunnel-token`. Read/Grep/Glob targets inside `.claudeflare/secrets` or equal to a path in `secret-files.json` are denied (`SECRET_REASON`). Bash commands containing one of those paths are denied. Bash `cloudflared` with `--token <literal>` or `service install <literal>` is denied; `cloudflared` reading `TUNNEL_TOKEN` from env, `--token-file`, `--version`, `tunnel list|info`, `access` subcommands are allowed.

- [ ] **Step 1: Write failing tests**

```js
test('tunnel-token writes TUNNEL_TOKEN to a new env file with mode 0600 and prints no value', async () => {});
test('tunnel-token replaces an existing TUNNEL_TOKEN line and keeps others', async () => {});
test('tunnel-token reports gitignored false outside .gitignore', async () => {});
test('tunnel-token records the env file in secret-files.json', async () => {});
// hooks.test.mjs
test('Read of .claudeflare/secrets/x.json is denied', () => {});
test('Read of an env file listed in secret-files.json is denied, other .env files allowed', () => {});
test('Bash cat of a listed env file is denied', () => {});
test('Grep with path .claudeflare/secrets is denied', () => {});
test('MCP execute reading cfd_tunnel/<id>/token is denied with tunnel-token in the reason', () => {});
test('Bash "cloudflared tunnel run --token eyJ..." is denied', () => {});
test('Bash "cloudflared service install eyJ..." is denied', () => {});
test('Bash "cloudflared tunnel --no-autoupdate run" (token from env) is allowed', () => {});
```

- [ ] **Step 2: Run** `node --test test/tunnel-token.test.mjs test/hooks.test.mjs`; fail.
- [ ] **Step 3: Implement.** The token read uses the write token path already used by apply (same `createClient` env).
- [ ] **Step 4: Run** `npm test`; pass.
- [ ] **Step 5: Commit** `git commit -m "feat: tunnel-token command and secret file guard" -- scripts/lib/tunnel-token.mjs scripts/cf.mjs hooks/guard.mjs hooks/lib/secret-rules.mjs hooks/lib/allowed-call.mjs test/tunnel-token.test.mjs test/hooks.test.mjs`

---

Product tasks 9 to 14 share one shape. Each creates `scripts/lib/products/<product>.mjs` (registered in `PRODUCTS`), sanitized fixtures in `test/fixtures/api/<product>/` (ids replaced with obvious fakes, no secrets; real-shaped from the API reference pages and the spike), `test/products-<product>.test.mjs`, the skill `skills/cf-<product>/SKILL.md` with sections `## Read current state`, `## Checks`, `## Applying changes`, `## Traps`, `## Sources` and the finding ids listed in the task, a row in the `cf-audit` domain table, and its entry in the `content.test.mjs` findings map. The kinds and lockout lines come from spec sections 5 and 6; each task lists only what the spec leaves to the plan.

### Task 9: Tunnel

**Files:** Create `scripts/lib/products/tunnel.mjs`, `test/fixtures/api/tunnel/*.json`, `test/products-tunnel.test.mjs`, `skills/cf-tunnel/SKILL.md`; Modify `scripts/lib/products/index.mjs`, `skills/cf-audit/SKILL.md`, `test/content.test.mjs`.

**Interfaces:**
- Kinds (account): `tunnel_create` POST `/cfd_tunnel` (`delete_created`; inverse ops: `DELETE /cfd_tunnel/<id>/connections` then `DELETE /cfd_tunnel/<id>`, group `tunnel:<id>`; `redact: ['token', 'credentials_file', 'tunnel_secret']`; body keys allowed: `name`, `config_src` = `cloudflare`), `tunnel_rename` PATCH `/cfd_tunnel/<uuid>` (`patch_before`; body only `name`), `tunnel_delete` DELETE (`none`, destructive, `nameField: 'name'`), `tunnel_config_put` PUT `/cfd_tunnel/<uuid>/configurations` (`put_before` of `config`), `tunnel_connections_delete` DELETE `/cfd_tunnel/<uuid>/connections` (`none`), `route_*` on `/teamnet/routes[/<uuid>]`, `vnet_*` on `/teamnet/virtual_networks[/<uuid>]`.
- `conflicts`: `tunnel_delete` requires a `tunnel_connections_delete` for the same tunnel earlier in the plan (`plan_conflict`); config PUT and delete on one tunnel conflict.
- `gather`: tunnels, configs of touched tunnels, connections, CNAMEs to `<uuid>.cfargotunnel.com` across the account's zones (`listAll` on `/zones` then `dns_records?type=CNAME&content=<uuid>.cfargotunnel.com`).
- Validation in `dependencies`/preflight: ingress last rule has no `hostname`; each rule has `service`; vnet with routes or named `default` refused.
- Lockout line: spec item 10. Notes: delete lists hostnames that will return 1016.
- Verify: readback; `tunnelServingCheck` for each hostname in a changed config; status `healthy`/`degraded` when the tunnel had connections in `gather`.
- Finding ids: `tunnel.status.down`, `tunnel.connectors.single`, `tunnel.config.no_catch_all`, `tunnel.dns.stale_cname`, `tunnel.config.local_managed`.
- Skill also holds the section 7 templates (Compose, systemd, Kubernetes notes) and the `claudeflare tunnel-token` flow.

- [ ] **Step 1: Write failing tests:** classification of every kind; create body with `tunnel_secret` refused; create result `token` redacted everywhere; delete without connection cleanup is `plan_conflict`; config without catch-all refused; dropping a hostname that has a CNAME yields `Lockout risk:`; delete note names each CNAME hostname; rollback of create deletes connections then tunnel; verify fails on a 1033 body.
- [ ] **Step 2: Run** `node --test test/products-tunnel.test.mjs`; fail.
- [ ] **Step 3: Implement module, fixtures, skill, audit row.**
- [ ] **Step 4: Run** `npm test`; pass.
- [ ] **Step 5: Commit** with every file listed.

### Task 10: Access

**Files:** as Task 9 with `access`.

**Interfaces:**
- Kinds (account, base `/accounts/<id>/access`): `access_app_{create,update,delete}` (`delete_created`/`put_before`/`recreate`, readOnly `id, aud, created_at, updated_at` plus spike additions; delete destructive `nameField: 'name'`, note: new AUD and the app domains), `access_policy_{create,update,delete}` (reusable), `access_app_policy_{update,delete}` (legacy), `access_group_{create,update,delete}`, `access_idp_{create,update,delete}` (`secretFields: ['config.client_secret']` plus other secret config keys per IdP type from the API reference; update/delete inverse `none` when the body touches a secret field, else `put_before` with secret fields omitted), `access_service_token_{create,update,delete}` (`secretSink: ['client_id', 'client_secret']`, `redact: ['client_secret']`, delete `none`), `access_org_update` PUT `/organizations` (`put_before`).
- `gather`: org (`auth_domain`, login methods), all apps (`listAll`), reusable policies, groups, IdPs.
- Dependencies: policy used by apps, group used by policies, service token used by policies, posture rule ids are checked by Task 12.
- Lockout lines: spec items 1 to 4.
- Verify: readback; `accessLoginCheck(https://<app domain>/, auth_domain)` for self-hosted apps with a public domain; policy changes add readback of each app using it.
- Finding ids: `access.policy.everyone_allow`, `access.app.no_mfa`, `access.session.long`, `access.service_token.expiring`, `access.group.unused`, `access.idp.single_login_method`.

- [ ] **Step 1: Write failing tests:** every kind; IdP create with literal `client_secret` refused; IdP create via `secret_fields_from_env` sends the value and stores none; service token create writes the sink file and results hold `[redacted]`; reusable policy delete in use refused; each lockout item 1 to 4 produces its line; app delete note mentions the new AUD; verify passes on 302 to the team domain.
- [ ] **Step 2 to 5:** as Task 9.

### Task 11: Gateway

**Interfaces:**
- Kinds (account, base `/accounts/<id>/gateway`): `gateway_rule_{create,update,delete}` (readOnly per spec 2; delete `recreate` with `precedence` from snapshot; group `gateway-phase:<filters[0]>`), `gateway_list_{create,update,delete}` (update `put_before` including items; more than 1000 items: `too_large`), `gateway_location_{create,update,delete}` (delete note: new DoH subdomain and IPs), `gateway_config_patch` PATCH `/configuration` (`patch_before`).
- `gather`: all rules (`listAll`), lists, locations, configuration, IdP hosts from Access org (`/access/identity_providers`) for the domain matcher.
- `conflicts`: spec 4.5 precedence rule.
- Traffic matcher (left to builder per spec 13) covers: empty traffic, `any(dns.domains[*] ...)`, `dns.fqdn`, `http.request.host`, `net.dst.ip`, list references `$<list uuid>`; anything else yields the line "Lockout risk: could not analyze traffic expression of rule <name>; check it does not block Cloudflare or IdP domains".
- Lockout lines: spec items 5 and 6; TLS decryption on: plain risk line.
- Verify: readback against the returned `traffic`; detail text always ends with the `dig` test command and "filtering itself is only verified from a device behind Gateway".
- Finding ids: `gateway.dns.no_security_baseline`, `gateway.rule.shadowed`, `gateway.tls.decrypt_off_with_http_rules`, `gateway.list.unused`, `gateway.location.none`.

- [ ] **Step 1: Write failing tests:** kinds; reformatted traffic readback passes; list delete referenced by a rule refused; 1001-item list `too_large`; block-all rule line; block above overlapping allow line; unknown expression line; precedence restore on rule delete rollback; two precedence changes out of order `plan_conflict`.
- [ ] **Step 2 to 5:** as Task 9.

### Task 12: Devices (WARP)

**Interfaces:**
- Kinds (account, base `/accounts/<id>/devices`): `device_default_profile_patch` PATCH `/policy`, `device_profile_{create,patch,delete}` (`/policy`, `/policy/<uuid>`; delete `recreate` whose inverse ops also PUT the saved include/exclude/fallback lists to the new id, group `profile:<id>`), `device_split_{include,exclude}_put` and `device_fallback_put` (default and per profile paths, `put_before`), `device_posture_{create,update,delete}`.
- `conflicts`: spec 4.5 devices rule.
- `gather`: default profile, custom profiles, their lists, posture rules, Access policies (for posture references), org `auth_domain`, IdP hosts.
- Dependencies: posture rule referenced by an Access policy.
- Lockout lines: spec items 7 to 9.
- Verify: readback; detail notes device behavior is verified on a device.
- Section 7 MDM templates in the skill with the secret placeholder rule.
- Finding ids: `devices.switch.unlocked_with_posture`, `devices.exclude.no_local_networks`, `devices.profile.unused`, `devices.posture.unused`.

- [ ] **Step 1: Write failing tests:** kinds; mode change after list PUT in one plan `plan_conflict`; mode change alone gets the lockout line; include mode without team domain line; `switch_locked` without override line; profile delete rollback restores lists to the new id; posture delete in use refused.
- [ ] **Step 2 to 5:** as Task 9.

### Task 13: Load Balancing

**Interfaces:**
- Kinds: account `lb_monitor_{create,update,delete}`, `lb_pool_{create,update,delete}` on `/accounts/<id>/load_balancers/...`; zone `lb_{create,update,delete}` on `/zones/<id>/load_balancers[/<id>]` (all `delete_created`/`put_before`/`recreate`; deletes destructive, `nameField: 'name'`).
- `entitlement`: pools list readable and zone LB list reachable, else `not_entitled`.
- Dependencies: `references` of monitor or pool non-empty.
- Preflight extra: `POST .../pools/<id>/preview` result for new or changed pools stored in `ctx` (this is a read-like call; it is sent by preflight, never by the agent through MCP, and only to the `preview` path).
- Lockout line: spec item 11.
- Verify: `poolHealthyCheck` on changed pools; readback.
- Fixture-only tests (no live test).
- Finding ids: `lb.pool.no_monitor`, `lb.monitor.interval_short`, `lb.fallback.missing`, `lb.pool.single_origin`.

- [ ] **Step 1: Write failing tests:** kinds on both scopes; not entitled; pool delete with references refused; disabling every origin line; verify waits for Healthy.
- [ ] **Step 2 to 5:** as Task 9.

### Task 14: Spectrum

**Interfaces:**
- Kinds (zone): `spectrum_app_{create,update,delete}` on `/zones/<id>/spectrum/apps[/<id>]`, `nameField: 'dns.name'`; `listAll` sends `page=1` explicitly.
- `entitlement`: zone plan from `GET /zones/<id>` and protocol table in spec 2 (Free: none; Pro: `minecraft`, `ssh`; Business: plus `rdp`; Enterprise: all); mismatch `not_entitled`.
- Delete note: new id, and new anycast IPs unless `edge_ips.type` is `static` (adjust after spike).
- Verify: readback; `tcpOpenCheck(dns.name, port)` for TCP protocols, skipped for UDP.
- Finding ids: `spectrum.app.no_ip_access_rules`, `spectrum.app.proxy_protocol_off`, `spectrum.app.tls_off`.

- [ ] **Step 1: Write failing tests:** kinds; Pro zone with a `tcp/22` generic app `not_entitled`; delete note; tcp check skipped for UDP.
- [ ] **Step 2 to 5:** as Task 9.

---

### Task 15: Troubleshooting skill, core docs, evals, release prep

**Files:**
- Create: `skills/cf-zt-troubleshoot/SKILL.md`, `skills/cf-zt-troubleshoot/trees/{access-redirect-loop,access-403,access-jwt-invalid,tunnel-1016,tunnel-1033,tunnel-502,gateway-overblocking,warp-private-route,lb-no-healthy-pool,spectrum-no-connect}.md`, four eval folders under `evals/` (`zt-access-plan`, `tunnel-token-not-leaked`, `diagnose-gateway-overblocking`, `tunnel-delete-risk`) following `evals/secret-not-leaked/` layout
- Modify: `skills/cf-core/SKILL.md`, `skills/cf-audit/SKILL.md` (scope text for the six domains), `README.md`, `docs/token-template.md`, `CHANGELOG.md`, `.claude-plugin/plugin.json`, `package.json`, `test/content.test.mjs` (tree list), `test/manifest.test.mjs` (version)

- [ ] **Step 1: Write failing content tests:** every tree has `## Evidence`, `## Hypotheses`, `## Fix`, `## Sources` in order; `cf-zt-troubleshoot` links every tree; `cf-core` contains `secret_fields_from_env`, `confirm_name`, `Lockout risk:`, `claudeflare tunnel-token`, `risk_changed`, `rollback_drift`, `applied_verify_failed`; manifest version `0.3.0`.
- [ ] **Step 2: Run** `node --test test/content.test.mjs test/manifest.test.mjs`; fail.
- [ ] **Step 3: Write** the skill, trees, cf-core and cf-audit sections, README Zero Trust section and threat model note, token template sets from spec 12 (both Read and Edit names), CHANGELOG 0.3.0 dated on release day, version bump to `0.3.0`, evals (mocks from the product fixtures; graders check that no token-like value appears and that plans carry `Lockout risk:` where expected).
- [ ] **Step 4: Run** `npm test`, `claude plugin validate . --strict --profile directory`, and each new eval with `claude plugin eval --case <name>` (one case per run). Expected: tests pass, validate clean, evals score 1.00 (rerun once on a single failing run before investigating).
- [ ] **Step 5: Commit** with every file listed.

### Task 16: Final review and live test (owner-gated)

- [ ] **Step 1:** Independent `code-reviewer` agent on the whole branch diff plus `security` agent (secrets, guard, apply). Fix critical findings; at most two rounds.
- [ ] **Step 2:** Live test per spec section 11 on `denizbarish` from the allowed host (`git archive HEAD` copied into `/tmp/claudeflare-live`, Docker `node:22-slim`, `CLAUDEFLARE_KEY_DIR=/work/key`). Each plan's approval is typed by the owner. Order: tunnel create, config with `v3-live.denizbarish.com`, Access app plus policy (verify login redirect), Gateway DNS rule create and rollback, WARP custom profile create and rollback, then delete plans for everything. Clean root-owned files with Docker.
- [ ] **Step 3:** Record live results in `CHANGELOG.md`; commit.
- [ ] **Step 4:** Ask the owner before push, PR, merge, tag `v0.3.0` and release.
