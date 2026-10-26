// Final review (I1 / M1, M10): rollback_of and lockout_risks are bound into
// the approval hash, apply rebuilds a rollback plan's ops from its source,
// and the cross-module flows the review found untested.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../scripts/lib/paths.mjs';
import { createPlan, hashOps, hashPlan, readPlan, updatePlan } from '../scripts/lib/plans.mjs';
import { checkApproval, writeApproval } from '../scripts/lib/approvals.mjs';
import { addRollbackLockout, applyPlan, createRollbackPlan } from '../scripts/lib/apply.mjs';
import { registerProduct } from '../scripts/lib/products/index.mjs';
import { validateOpTargets, validatePlanOps } from '../scripts/lib/resources.mjs';
import { CfError } from '../scripts/lib/errors.mjs';

const ZID = '0123456789abcdef0123456789abcdef';
const ZID2 = 'fedcba9876543210fedcba9876543210';
const A = '0123456789abcdef0123456789abcdef';
const OTHER = 'ffffffffffffffffffffffffffffffff';
const BASE = `/accounts/${A}`;
const NEW = 'ffffffff-4e5f-6789-abcd-ef0123456789';
const T0 = new Date('2026-10-26T10:00:00Z');
const T1 = new Date('2026-10-26T10:01:00Z');
const T2 = new Date('2026-10-26T10:02:00Z');
const T3 = new Date('2026-10-26T10:03:00Z');

const ORIGINAL_KEY_DIR = process.env.CLAUDEFLARE_KEY_DIR;
const KEY_DIR = mkdtempSync(join(tmpdir(), 'claudeflare-rbi-key-'));
process.env.CLAUDEFLARE_KEY_DIR = KEY_DIR;
after(() => {
  rmSync(KEY_DIR, { recursive: true, force: true });
  if (ORIGINAL_KEY_DIR === undefined) delete process.env.CLAUDEFLARE_KEY_DIR;
  else process.env.CLAUDEFLARE_KEY_DIR = ORIGINAL_KEY_DIR;
});

// Two fake products, so a plan can mix modules without real API shapes.
let verifyFails = false;
const unregister = [
  registerProduct({
    product: 'rbx',
    kinds: [
      { kind: 'rbx_app_create', product: 'rbx', scope: 'account', methods: ['POST'], pattern: /^\/rbx\/apps$/, resource: () => null, readOnlyFields: ['id'], inverse: 'delete_created', destructive: false },
      { kind: 'rbx_app_delete', product: 'rbx', scope: 'account', methods: ['DELETE'], pattern: /^\/rbx\/apps\/([0-9a-f-]{36})$/, resource: (m) => ({ type: 'rbx_app', id: m[1] }), readOnlyFields: ['id'], inverse: 'none', destructive: true, nameField: 'name' },
    ],
    probePath: (b) => `${b}/rbx/apps`,
    gather: async () => ({}),
    lockoutRisks: () => [],
    verifyChecks: (op) => (op.method === 'DELETE' ? [] : [{ name: 'login', once: true, run: async () => ({ ok: !verifyFails, detail: 'login check' }) }]),
  }),
  registerProduct({
    product: 'rby',
    kinds: [
      { kind: 'rby_conf_put', product: 'rby', scope: 'account', methods: ['PUT'], pattern: /^\/rby\/conf$/, resource: () => ({ type: 'rby_conf', id: 'conf' }), readOnlyFields: [], inverse: 'put_before', destructive: false },
    ],
    probePath: (b) => `${b}/rby/conf`,
    gather: async () => ({}),
    lockoutRisks: () => [],
    verifyChecks: () => [],
  }),
];
after(() => unregister.forEach((fn) => fn()));

function tempCwd(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'claudeflare-rbi-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

const approve = (cwd, plan, now = T0) => writeApproval(cwd, { plan_id: plan.id, session_id: 's1' }, now);
const fast = () => ({ env: {}, sleep: async () => {}, clock: () => 0 });
const planFile = (cwd, id) => join(paths(cwd).plans, `${id}.json`);
// Edits the stored plan the way a hand edit would: no CLI, no hash update.
function editFile(cwd, id, patch) {
  const plan = JSON.parse(readFileSync(planFile(cwd, id), 'utf8'));
  writeFileSync(planFile(cwd, id), JSON.stringify({ ...plan, ...patch }));
}

// In-memory account and zone for both fake products and the v1 ssl setting.
function fakeApi() {
  const state = { app: null, conf: { mode: 'a' }, ssl: { id: 'ssl', value: 'flexible' } };
  const calls = [];
  return {
    state,
    calls,
    writes: () => calls.filter((c) => !c.startsWith('GET ')),
    async request(method, path, opts = {}) {
      calls.push(`${method} ${path}`);
      if (path === `/zones/${ZID}/settings/ssl` || path === `/zones/${ZID2}/settings/ssl`) {
        if (method === 'PATCH') state.ssl = { ...state.ssl, ...opts.body };
        return structuredClone(state.ssl);
      }
      if (method === 'POST' && path === `${BASE}/rbx/apps`) {
        state.app = { id: NEW, ...structuredClone(opts.body) };
        return structuredClone(state.app);
      }
      if (path === `${BASE}/rbx/apps/${NEW}`) {
        if (!state.app) throw new CfError('not_found', 'gone');
        if (method === 'DELETE') state.app = null;
        return method === 'DELETE' ? { id: NEW } : structuredClone(state.app);
      }
      if (method === 'GET' && path === `${BASE}/rbx/apps`) return state.app ? [structuredClone(state.app)] : [];
      if (path === `${BASE}/rby/conf`) {
        if (method === 'PUT') state.conf = structuredClone(opts.body);
        return structuredClone(state.conf);
      }
      throw new CfError('not_found', `unexpected ${method} ${path}`);
    },
  };
}

const sslOp = { method: 'PATCH', path: `/zones/${ZID}/settings/ssl`, body: { value: 'strict' } };
const zonePlan = (cwd, fields = {}, now = T0) => createPlan(cwd, {
  zone_id: ZID, zone_name: 'example.com', summary: 'SSL strict', risk: 'low', ops: [sslOp], slug: 'ssl', ...fields,
}, now);
const accountPlan = (cwd, ops, fields = {}, now = T0) => createPlan(cwd, {
  scope: 'account', account_id: A, account_name: 'Acme', summary: 'Apps', risk: 'low', ops, slug: 'apps', lockout_risks: [], ...fields,
}, now);
const appCreate = { method: 'POST', path: `${BASE}/rbx/apps`, body: { name: 'wiki' } };
const confPut = { method: 'PUT', path: `${BASE}/rby/conf`, body: { mode: 'b' } };

async function appliedZonePlan(t) {
  const cwd = tempCwd(t);
  const api = fakeApi();
  const plan = zonePlan(cwd);
  approve(cwd, plan);
  assert.equal((await applyPlan(cwd, api, plan.id, T0)).status, 'applied');
  return { cwd, api, plan };
}

// hashPlan

test('hashPlan binds rollback_of and lockout_risks only when present', () => {
  const ops = [sslOp];
  const zone = { scope: 'zone', ops };
  assert.equal(hashPlan(zone), hashOps(ops), 'zone plans without them keep the v1 hash');
  const account = { scope: 'account', account_id: A, project_dir: null, ops };
  const plain = hashPlan(account);
  const variants = [
    hashPlan({ ...zone, rollback_of: 'x-1' }),
    hashPlan({ ...zone, rollback_of: 'x-2' }),
    hashPlan({ ...zone, lockout_risks: [] }),
    hashPlan({ ...zone, lockout_risks: ['Lockout risk: a'] }),
    hashPlan({ ...zone, lockout_risks: ['Lockout risk: b'] }),
    plain,
    hashPlan({ ...account, rollback_of: 'x-1' }),
    hashPlan({ ...account, lockout_risks: [] }),
    hashPlan({ ...account, lockout_risks: ['Lockout risk: a'] }),
  ];
  assert.equal(new Set([hashOps(ops), ...variants]).size, variants.length + 1);
  // Fields outside the contract stay outside the hash.
  assert.equal(hashPlan({ ...account, status: 'applied', results: [1], slug: 'x', risk: 'y' }), plain);
});

test('createPlan stores rollback_of and lockout_risks with an ops_hash that already covers them', (t) => {
  const cwd = tempCwd(t);
  const plan = accountPlan(cwd, [appCreate], { lockout_risks: ['Lockout risk: x'], rollback_of: 'acme-20261026-090000-src' });
  const stored = readPlan(cwd, plan.id);
  assert.deepEqual(stored.lockout_risks, ['Lockout risk: x']);
  assert.equal(stored.rollback_of, 'acme-20261026-090000-src');
  assert.equal(stored.ops_hash, hashPlan(stored));
  const plain = zonePlan(tempCwd(t));
  assert.equal('rollback_of' in plain, false);
  assert.equal('lockout_risks' in plain, false);
  assert.equal(plain.ops_hash, hashOps(plain.ops));
});

// Approval binding

test('an approval made before lockout_risks changed no longer matches; a new approval applies', async (t) => {
  const cwd = tempCwd(t);
  const plan = accountPlan(cwd, [appCreate]);
  const refused = async (id) => {
    assert.deepEqual(checkApproval(cwd, id, T0), { ok: false, reason: 'hash_mismatch' });
    const api = fakeApi();
    await assert.rejects(applyPlan(cwd, api, id, T0, fast()), (err) => err instanceof CfError && err.code === 'not_approved');
    assert.deepEqual(api.calls, []);
  };
  // (a) A lockout line added after approval, so risk_changed would not see it.
  approve(cwd, plan);
  editFile(cwd, plan.id, { lockout_risks: ['Lockout risk: hidden line'] });
  await refused(plan.id);
  // (b) The key dropped after approval.
  editFile(cwd, plan.id, { lockout_risks: [] });
  approve(cwd, readPlan(cwd, plan.id));
  const raw = JSON.parse(readFileSync(planFile(cwd, plan.id), 'utf8'));
  delete raw.lockout_risks;
  writeFileSync(planFile(cwd, plan.id), JSON.stringify(raw));
  await refused(plan.id);
  // (c) An approval made before lockout_risks entered the hash was computed
  // without them: on a plan that has them it fails closed until the user
  // approves again.
  approve(cwd, readPlan(cwd, plan.id));
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: true });
  editFile(cwd, plan.id, { lockout_risks: [] });
  await refused(plan.id);
  approve(cwd, readPlan(cwd, plan.id));
  assert.equal((await applyPlan(cwd, fakeApi(), plan.id, T0, fast())).status, 'applied');
});

test('rollback_of added to an approved plan breaks the approval and is refused before any request', async (t) => {
  const { cwd, plan: source } = await appliedZonePlan(t);
  const victim = zonePlan(cwd, { slug: 'other' }, T1);
  approve(cwd, victim, T1);
  const before = hashPlan(readPlan(cwd, victim.id));
  editFile(cwd, victim.id, { rollback_of: source.id });
  assert.notEqual(hashPlan(readPlan(cwd, victim.id)), before);
  assert.deepEqual(checkApproval(cwd, victim.id, T1), { ok: false, reason: 'hash_mismatch' });
  const api = fakeApi();
  await assert.rejects(applyPlan(cwd, api, victim.id, T1), (err) => err instanceof CfError && ['rollback_stale', 'not_approved'].includes(err.code));
  assert.deepEqual(api.calls, []);
  assert.equal(readPlan(cwd, source.id).status, 'applied');
});

test('createRollbackPlan and addRollbackLockout keep ops_hash equal to the approval hash', async (t) => {
  const cwd = tempCwd(t);
  const api = fakeApi();
  const plan = accountPlan(cwd, [appCreate]);
  approve(cwd, plan);
  assert.equal((await applyPlan(cwd, api, plan.id, T0, fast())).status, 'applied');
  const rollback = createRollbackPlan(cwd, plan.id, T1);
  assert.equal(rollback.rollback_of, plan.id);
  assert.equal(readPlan(cwd, rollback.id).ops_hash, hashPlan(readPlan(cwd, rollback.id)));
  const locked = await addRollbackLockout(cwd, readPlan(cwd, rollback.id), api);
  assert.ok(Array.isArray(locked.lockout_risks));
  assert.equal(readPlan(cwd, rollback.id).ops_hash, hashPlan(readPlan(cwd, rollback.id)));
});

// Apply rebuilds rollback ops from the source plan

test('apply refuses a rollback plan whose ops differ from the inverse rebuilt from its source', async (t) => {
  const { cwd, plan: source } = await appliedZonePlan(t);
  // (a) An engine-built rollback whose ops were edited and approved again.
  const rollback = createRollbackPlan(cwd, source.id, T1);
  editFile(cwd, rollback.id, { ops: [{ ...rollback.ops[0], body: { value: 'off' } }] });
  approve(cwd, readPlan(cwd, rollback.id), T1);
  let api = fakeApi();
  await assert.rejects(applyPlan(cwd, api, rollback.id, T1), (err) => err instanceof CfError && err.code === 'rollback_stale' && /rebuilt/.test(err.message));
  assert.deepEqual(api.calls, []);
  assert.equal(readPlan(cwd, rollback.id).status, 'draft');

  // (b) A hand-made plan naming the source, approved with rollback_of in view.
  const foreign = createPlan(cwd, {
    zone_id: ZID, zone_name: 'example.com', summary: 'x', risk: 'low', slug: 'hand',
    ops: [{ method: 'DELETE', path: `/zones/${ZID}/dns_records/abc` }], rollback_of: source.id,
  }, T2);
  approve(cwd, foreign, T2);
  api = fakeApi();
  await assert.rejects(applyPlan(cwd, api, foreign.id, T2), (err) => err instanceof CfError && err.code === 'rollback_stale');
  assert.deepEqual(api.calls, []);
  assert.equal(readPlan(cwd, source.id).status, 'applied');

  // (c) The untouched engine-built rollback still applies and marks the source.
  const good = createRollbackPlan(cwd, source.id, T3);
  approve(cwd, good, T3);
  api = fakeApi();
  api.state.ssl = { id: 'ssl', value: 'strict' };
  assert.equal((await applyPlan(cwd, api, good.id, T3)).status, 'applied');
  assert.equal(readPlan(cwd, source.id).status, 'rolled_back');
});

test('apply refuses a hand-made account rollback_of plan whose source has no snapshot (review probe)', async (t) => {
  const cwd = tempCwd(t);
  const src = accountPlan(cwd, [], { lockout_risks: undefined, slug: 'src' });
  updatePlan(cwd, src.id, { status: 'applied' });
  const bad = accountPlan(cwd, [{ method: 'DELETE', path: `/accounts/${OTHER}/members/m1` }], { slug: 'bad', rollback_of: src.id }, T2);
  approve(cwd, bad, T2);
  const api = fakeApi();
  await assert.rejects(applyPlan(cwd, api, bad.id, T3, fast()), (err) => err instanceof CfError && err.code === 'rollback_stale');
  assert.deepEqual(api.calls, []);
  assert.equal(readPlan(cwd, src.id).status, 'applied');
});

test('apply refuses a rollback plan whose source is of another target or scope', async (t) => {
  const { cwd, plan: source } = await appliedZonePlan(t);
  const real = createRollbackPlan(cwd, source.id, T1);
  // Same ops as the true inverse, but stored on a plan for another zone.
  const otherZone = createPlan(cwd, {
    zone_id: ZID2, zone_name: 'example.net', summary: 'x', risk: 'low', slug: 'z2', ops: real.ops, rollback_of: source.id,
  }, T2);
  approve(cwd, otherZone, T2);
  const otherScope = createPlan(cwd, {
    scope: 'account', account_id: A, account_name: 'Acme', summary: 'x', risk: 'low', slug: 'acct', ops: real.ops, rollback_of: source.id,
  }, T3);
  approve(cwd, otherScope, T3);
  for (const plan of [otherZone, otherScope]) {
    const api = fakeApi();
    await assert.rejects(applyPlan(cwd, api, plan.id, T3, fast()), (err) => err instanceof CfError && err.code === 'rollback_stale' && /target|scope/.test(err.message), plan.id);
    assert.deepEqual(api.calls, []);
  }
  assert.equal(readPlan(cwd, source.id).status, 'applied');
});

// M10: cross-module flows

test('verify failed, then the rollback draft is approved and applied end to end', async (t) => {
  const cwd = tempCwd(t);
  const api = fakeApi();
  const plan = accountPlan(cwd, [appCreate]);
  approve(cwd, plan);
  verifyFails = true;
  t.after(() => { verifyFails = false; });
  const applied = await applyPlan(cwd, api, plan.id, T0, fast());
  assert.equal(applied.status, 'applied_verify_failed');
  assert.ok(applied.rollback_draft, applied.rollback_draft_error);
  const draft = readPlan(cwd, applied.rollback_draft);
  assert.equal(draft.rollback_of, plan.id);
  assert.deepEqual(draft.ops.map((o) => `${o.method} ${o.path}`), [`DELETE ${BASE}/rbx/apps/${NEW}`]);
  assert.equal(draft.ops[0].precheck.kind, 'drift');
  assert.equal(draft.ops[0].precheck.read, `${BASE}/rbx/apps/${NEW}`);
  assert.ok(Array.isArray(draft.lockout_risks));
  assert.equal(draft.ops_hash, hashPlan(draft));
  verifyFails = false;
  approve(cwd, draft, T1);
  const rolled = await applyPlan(cwd, api, draft.id, T1, fast());
  assert.equal(rolled.status, 'applied', JSON.stringify(rolled.results));
  assert.equal(api.state.app, null);
  assert.equal(readPlan(cwd, plan.id).status, 'rolled_back');
});

test('a plan mixing two product modules applies, rolls back in reverse and skips only the drifted module', async (t) => {
  const cwd = tempCwd(t);
  const api = fakeApi();
  const ops = [appCreate, confPut];
  validatePlanOps(ops, { scope: 'account', account_id: A });
  const plan = accountPlan(cwd, ops);
  approve(cwd, plan);
  const applied = await applyPlan(cwd, api, plan.id, T0, fast());
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  assert.deepEqual(api.writes(), [`POST ${BASE}/rbx/apps`, `PUT ${BASE}/rby/conf`]);
  const snapshot = JSON.parse(readFileSync(applied.snapshot_file, 'utf8'));
  assert.deepEqual(snapshot.entries.map((e) => e.product), ['rbx', 'rby']);
  const rollback = createRollbackPlan(cwd, plan.id, T1);
  assert.deepEqual(rollback.ops.map((o) => `${o.method} ${o.path}`), [`PUT ${BASE}/rby/conf`, `DELETE ${BASE}/rbx/apps/${NEW}`]);
  assert.deepEqual(rollback.ops[0].body, { mode: 'a' });
  assert.ok(rollback.ops.every((o) => o.precheck?.kind === 'drift' && typeof o.precheck.read === 'string'));
  // A hand edit of the rby resource skips its inverse; the rbx inverse still runs.
  api.state.conf = { mode: 'c' };
  approve(cwd, rollback, T1);
  const ran = await applyPlan(cwd, api, rollback.id, T1, fast());
  assert.equal(ran.status, 'partially_applied');
  assert.equal(ran.results[0].reason, 'rollback_drift');
  assert.ok(!ran.results[1]?.skipped, JSON.stringify(ran.results));
  assert.deepEqual(api.state.conf, { mode: 'c' });
  assert.equal(api.state.app, null);
  assert.equal(readPlan(cwd, plan.id).status, 'applied');
});

test('a v3 rollback of a rollback is refused once the source was rolled back', async (t) => {
  const cwd = tempCwd(t);
  const api = fakeApi();
  const plan = accountPlan(cwd, [appCreate, confPut]);
  approve(cwd, plan);
  assert.equal((await applyPlan(cwd, api, plan.id, T0, fast())).status, 'applied');
  const first = createRollbackPlan(cwd, plan.id, T1);
  const second = createRollbackPlan(cwd, plan.id, T2);
  approve(cwd, first, T2);
  assert.equal((await applyPlan(cwd, api, first.id, T2, fast())).status, 'applied');
  assert.equal(readPlan(cwd, plan.id).status, 'rolled_back');
  approve(cwd, second, T2);
  const before = api.calls.length;
  await assert.rejects(applyPlan(cwd, api, second.id, T2, fast()), (err) => err instanceof CfError && err.code === 'rollback_stale');
  assert.equal(api.calls.length, before);
  assert.equal(readPlan(cwd, second.id).status, 'draft');
  // A rollback plan whose verification failed is never rolled back in turn.
  updatePlan(cwd, first.id, { status: 'applied_verify_failed' });
  assert.throws(() => createRollbackPlan(cwd, first.id, T3), (err) => err instanceof CfError && err.code === 'not_applied');
});

// M1 (code review): the CLI message of a rollback that drift left partial.

test('a partially applied rollback names the skipped ops and never suggests a rollback of the rollback', async () => {
  const { applyFailure } = await import('../scripts/lib/apply-message.mjs');
  const skipped = { skipped: true, reason: 'rollback_drift', detail: `${BASE}/rby/conf changed after apply` };
  const partial = applyFailure({ id: 'r1', status: 'partially_applied', rollback_of: 's1', results: [skipped, { id: 'x' }] });
  assert.equal(partial.code, 'apply_failed');
  assert.match(partial.message, /^Plan r1 partially_applied: /);
  assert.match(partial.message, /op 0 skipped \(rollback_drift\): \/accounts\/[0-9a-f]+\/rby\/conf changed after apply/);
  assert.doesNotMatch(partial.hint, /claudeflare rollback r1/);
  assert.match(partial.hint, /do not roll back this rollback/i);
  assert.match(partial.hint, /fresh plan/);
  const none = applyFailure({ id: 'r1', status: 'partially_applied', rollback_of: 's1', results: [skipped, { ...skipped, detail: 'group g skipped: x' }] });
  assert.match(none.message, /nothing was applied/);
  assert.match(none.message, /op 1 skipped \(rollback_drift\): group g skipped: x/);
  // A normal partial apply keeps the rollback hint.
  const normal = applyFailure({ id: 'p1', status: 'partially_applied', results: [{ id: 'x' }, null], error: { code: 'api', message: 'op 1 failed' } });
  assert.equal(normal.message, 'Plan p1 partially_applied: op 1 failed');
  assert.match(normal.hint, /claudeflare rollback p1/);
});

// L1 (security review): encoded separators in a REST op path are refused.

test('validateOpTargets refuses encoded slashes, backslashes and dots in a zone or account path', () => {
  const zone = { scope: 'zone', zone_id: ZID };
  for (const path of [
    `/zones/${ZID}/x%2f..%2faccess/apps`,
    `/zones/${ZID}/x%2F..%2Fload_balancers`,
    `/zones/${ZID}/x%252f..%252fspectrum/apps`,
    `/zones/${ZID}/settings%5cssl`,
    `/zones/${ZID}/settings/ssl%2E`,
  ]) {
    assert.throws(() => validateOpTargets([{ method: 'PATCH', path, body: {} }], zone), (err) => err instanceof CfError && err.code === 'invalid_op', path);
  }
  validateOpTargets([{ method: 'PATCH', path: `/zones/${ZID}/settings/ssl`, body: { value: 'strict' } }], zone);
});
