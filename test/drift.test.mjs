import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPlan, createRollbackPlan, postFile } from '../scripts/lib/apply.mjs';
import { createPlan, hashPlan, readPlan, updatePlan } from '../scripts/lib/plans.mjs';
import { writeApproval } from '../scripts/lib/approvals.mjs';
import { registerProduct } from '../scripts/lib/products/index.mjs';
import { validateOpTargets } from '../scripts/lib/resources.mjs';
import { buildRollbackOps } from '../scripts/lib/snapshot.mjs';
import { driftDetail, stableEqual } from '../scripts/lib/rest-engine.mjs';
import { CfError } from '../scripts/lib/errors.mjs';

const A = '0123456789abcdef0123456789abcdef';
const BASE = `/accounts/${A}`;
const R1 = '0a1b2c3d-4e5f-6789-abcd-ef0123456781';
const R2 = '0a1b2c3d-4e5f-6789-abcd-ef0123456782';
const TH = '0a1b2c3d-4e5f-6789-abcd-ef0123456783';
const PR = '0a1b2c3d-4e5f-6789-abcd-ef0123456784';
const NEW_IDS = ['ffffffff-4e5f-6789-abcd-ef0123456701', 'ffffffff-4e5f-6789-abcd-ef0123456702', 'ffffffff-4e5f-6789-abcd-ef0123456703'];
const T0 = new Date('2026-10-26T10:00:00Z');
const T1 = new Date('2026-10-26T10:05:00Z');
const uuid = '([0-9a-f-]{36})';
const READ_ONLY = ['id', 'created_at', 'updated_at'];

// Fake product: rules share one dependency group (like Gateway precedence of
// one phase); a profile PATCH inverts into two ops (like a device profile mode
// change and its list PUT).
const DX = {
  product: 'dx',
  kinds: [
    {
      kind: 'dx_thing_create', product: 'dx', scope: 'account', methods: ['POST'], pattern: /^\/dx\/things$/,
      resource: () => null, readOnlyFields: READ_ONLY, inverse: 'delete_created', destructive: false,
    },
    {
      kind: 'dx_thing_delete', product: 'dx', scope: 'account', methods: ['DELETE'], pattern: new RegExp(`^/dx/things/${uuid}$`),
      resource: (m) => ({ type: 'dx_thing', id: m[1] }), readOnlyFields: READ_ONLY, inverse: 'recreate', destructive: true, nameField: 'name',
    },
    {
      kind: 'dx_rule_update', product: 'dx', scope: 'account', methods: ['PUT'], pattern: new RegExp(`^/dx/rules/${uuid}$`),
      resource: (m) => ({ type: 'dx_rule', id: m[1] }), readOnlyFields: READ_ONLY, inverse: 'put_before', destructive: false,
      group: () => 'dx_phase:http',
    },
    {
      kind: 'dx_profile_patch', product: 'dx', scope: 'account', methods: ['PATCH'], pattern: new RegExp(`^/dx/profiles/${uuid}$`),
      resource: (m) => ({ type: 'dx_profile', id: m[1] }), readOnlyFields: READ_ONLY, destructive: false,
      read: (m, base) => `${base}/dx/profiles/${m[1]}`,
      inverse: (entry) => [
        { method: 'PATCH', path: entry.path, body: { mode: entry.before.mode } },
        { method: 'PUT', path: `${entry.path}/include`, body: { list: entry.before.list } },
      ],
    },
    {
      kind: 'dx_profile_include_put', product: 'dx', scope: 'account', methods: ['PUT'], pattern: new RegExp(`^/dx/profiles/${uuid}/include$`),
      resource: (m) => ({ type: 'dx_profile_include', id: m[1] }), readOnlyFields: READ_ONLY, inverse: 'put_before', destructive: false,
    },
  ],
  probePath: (base) => `${base}/dx/things`,
  gather: async () => ({}),
  lockoutRisks: () => [],
  verifyChecks: () => [],
};
const unregister = registerProduct(DX);
test.after(() => unregister());

// The API reformats Gateway-style traffic expressions (trailing space here).
const reformat = (body) => (typeof body?.traffic === 'string' && !body.traffic.endsWith(' ') ? { ...body, traffic: `${body.traffic} ` } : body);

// In-memory account: GET reads, writes change state, every write bumps updated_at.
function fakeApi(initial = {}) {
  const store = new Map(Object.entries(structuredClone(initial)));
  const calls = [];
  const ids = [...NEW_IDS];
  let tick = 0;
  const missing = (path) => new CfError('not_found', `Not found: ${path}`, { status: 404 });
  return {
    store,
    calls,
    writes: () => calls.filter((c) => c.method !== 'GET'),
    async request(method, path, opts = {}) {
      calls.push({ method, path, body: structuredClone(opts?.body) });
      tick += 1;
      if (method === 'GET') {
        if (!store.has(path)) throw missing(path);
        return structuredClone(store.get(path));
      }
      if (method === 'POST') {
        const id = ids.shift();
        const obj = { id, ...reformat(opts.body), created_at: `t${tick}` };
        store.set(`${path}/${id}`, obj);
        return structuredClone(obj);
      }
      if (method === 'DELETE') {
        if (!store.has(path)) throw missing(path);
        store.delete(path);
        return null;
      }
      const old = store.get(path);
      if (method === 'PATCH' && !old) throw missing(path);
      // Key order differs from the stored object on purpose.
      const next = method === 'PUT'
        ? { updated_at: `t${tick}`, ...reformat(opts.body), id: old?.id ?? path.split('/').at(-2) }
        : { ...old, ...reformat(opts.body), updated_at: `t${tick}` };
      store.set(path, next);
      return structuredClone(next);
    },
  };
}

function setup(t, ops) {
  const cwd = mkdtempSync(join(tmpdir(), 'claudeflare-drift-'));
  const keyDir = mkdtempSync(join(tmpdir(), 'claudeflare-key-'));
  const saved = process.env.CLAUDEFLARE_KEY_DIR;
  process.env.CLAUDEFLARE_KEY_DIR = keyDir;
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CLAUDEFLARE_KEY_DIR;
    else process.env.CLAUDEFLARE_KEY_DIR = saved;
  });
  const plan = createPlan(cwd, {
    scope: 'account', account_id: A, account_name: 'Acme', summary: 'Zero Trust', risk: 'low', ops, slug: 'zt',
  }, T0);
  return { cwd, plan: updatePlan(cwd, plan.id, { slug: 'zt' }) };
}

const approve = (cwd, plan, now = T0) => writeApproval(cwd, { plan_id: plan.id, session_id: 's1' }, now);

async function applyAndRollback(cwd, api, plan, change = () => {}) {
  approve(cwd, plan);
  const applied = await applyPlan(cwd, api, plan.id, T0);
  const rollback = createRollbackPlan(cwd, plan.id, T1);
  change(api.store);
  approve(cwd, rollback, T1);
  api.calls.length = 0;
  const ran = await applyPlan(cwd, api, rollback.id, T1);
  return { applied, rollback, ran };
}

const thingCreate = { method: 'POST', path: `${BASE}/dx/things`, body: { name: 'alpha', enabled: true } };
const ruleUpdate = (id, body) => ({ method: 'PUT', path: `${BASE}/dx/rules/${id}`, body });
const rule = (id, extra = {}) => ({ id, name: `rule-${id.at(-1)}`, traffic: 'any(dns.domains[*] == "old.com") ', precedence: 1, created_at: 't0', updated_at: 't0', ...extra });

test('rollback with unchanged resource runs the inverse', async (t) => {
  const { cwd, plan } = setup(t, [thingCreate]);
  const api = fakeApi();
  const { applied, rollback, ran } = await applyAndRollback(cwd, api, plan);
  assert.equal(applied.status, 'applied');
  const id = NEW_IDS[0];
  assert.deepEqual(rollback.ops, [{
    method: 'DELETE',
    path: `${BASE}/dx/things/${id}`,
    precheck: { kind: 'drift', read: `${BASE}/dx/things/${id}`, expect: { name: 'alpha', enabled: true }, ignore: READ_ONLY },
  }]);
  assert.equal(ran.status, 'applied');
  // The rollback's own snapshot reads the thing too (recreate kind); the drift read precedes the DELETE.
  assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`).slice(-2), [`GET ${BASE}/dx/things/${id}`, `DELETE ${BASE}/dx/things/${id}`]);
  assert.equal(readPlan(cwd, plan.id).status, 'rolled_back');
});

test('rollback after an outside change skips that inverse with rollback_drift', async (t) => {
  const { cwd, plan } = setup(t, [ruleUpdate(R1, { name: 'new', traffic: 'any(dns.domains[*] == "x.com")', precedence: 1 })]);
  const api = fakeApi({ [`${BASE}/dx/rules/${R1}`]: rule(R1) });
  const { ran } = await applyAndRollback(cwd, api, plan, (store) => {
    store.set(`${BASE}/dx/rules/${R1}`, { ...store.get(`${BASE}/dx/rules/${R1}`), name: 'edited-by-hand' });
  });
  assert.equal(ran.status, 'partially_applied');
  assert.equal(ran.results.length, 1);
  assert.equal(ran.results[0].skipped, true);
  assert.equal(ran.results[0].reason, 'rollback_drift');
  assert.match(ran.results[0].detail, /changed after apply/);
  assert.deepEqual(api.writes(), []);
  assert.equal(api.store.get(`${BASE}/dx/rules/${R1}`).name, 'edited-by-hand');
});

test('skip also skips later ops in the same group, other ops still run', async (t) => {
  const { cwd, plan } = setup(t, [
    thingCreate,
    ruleUpdate(R1, { name: 'one', traffic: 'any(dns.domains[*] == "a.com")', precedence: 1 }),
    ruleUpdate(R2, { name: 'two', traffic: 'any(dns.domains[*] == "b.com")', precedence: 2 }),
  ]);
  const api = fakeApi({ [`${BASE}/dx/rules/${R1}`]: rule(R1), [`${BASE}/dx/rules/${R2}`]: rule(R2, { precedence: 2 }) });
  const { rollback, ran } = await applyAndRollback(cwd, api, plan, (store) => {
    store.set(`${BASE}/dx/rules/${R2}`, { ...store.get(`${BASE}/dx/rules/${R2}`), precedence: 9 });
  });
  assert.deepEqual(rollback.ops.map((op) => [op.method, op.path, op.precheck.group]), [
    ['PUT', `${BASE}/dx/rules/${R2}`, 'dx_phase:http'],
    ['PUT', `${BASE}/dx/rules/${R1}`, 'dx_phase:http'],
    ['DELETE', `${BASE}/dx/things/${NEW_IDS[0]}`, undefined],
  ]);
  assert.equal(ran.status, 'partially_applied');
  assert.deepEqual(ran.results.map((r) => r?.reason ?? 'ran'), ['rollback_drift', 'rollback_drift', 'ran']);
  assert.match(ran.results[1].detail, /dx_phase:http/);
  assert.deepEqual(api.writes().map((c) => `${c.method} ${c.path}`), [`DELETE ${BASE}/dx/things/${NEW_IDS[0]}`]);
});

const profileState = {
  [`${BASE}/dx/profiles/${PR}`]: { id: PR, mode: 'exclude', list: ['10.0.0.0/8'], updated_at: 't0' },
  [`${BASE}/dx/profiles/${PR}/include`]: { id: PR, list: ['10.0.0.0/8'] },
};

test('inverse ops of one source share its group and skip together', async (t) => {
  const { cwd, plan } = setup(t, [{ method: 'PATCH', path: `${BASE}/dx/profiles/${PR}`, body: { mode: 'include' } }]);
  const api = fakeApi(profileState);
  const { rollback, ran } = await applyAndRollback(cwd, api, plan, (store) => {
    store.set(`${BASE}/dx/profiles/${PR}`, { ...store.get(`${BASE}/dx/profiles/${PR}`), list: ['192.168.0.0/16'] });
  });
  assert.equal(rollback.ops.length, 2);
  const [first, second] = rollback.ops.map((op) => op.precheck);
  assert.equal(first.read, `${BASE}/dx/profiles/${PR}`);
  assert.equal(typeof first.group, 'string');
  assert.deepEqual(second, { kind: 'drift', group: first.group });
  assert.equal(ran.status, 'partially_applied');
  assert.deepEqual(ran.results.map((r) => r.reason), ['rollback_drift', 'rollback_drift']);
  assert.deepEqual(api.writes(), []);
});

test('function inverse ops run in order when the source is unchanged (no false drift after the first op)', async (t) => {
  const { cwd, plan } = setup(t, [{ method: 'PATCH', path: `${BASE}/dx/profiles/${PR}`, body: { mode: 'include' } }]);
  const api = fakeApi(profileState);
  const { ran } = await applyAndRollback(cwd, api, plan);
  assert.equal(ran.status, 'applied');
  assert.deepEqual(api.writes().map((c) => c.method), ['PATCH', 'PUT']);
  assert.equal(readPlan(cwd, plan.id).status, 'rolled_back');
});

test('rollback with a skip ends partially_applied and the source stays applied', async (t) => {
  const { cwd, plan } = setup(t, [thingCreate]);
  const api = fakeApi();
  const { ran } = await applyAndRollback(cwd, api, plan, (store) => {
    store.set(`${BASE}/dx/things/${NEW_IDS[0]}`, { ...store.get(`${BASE}/dx/things/${NEW_IDS[0]}`), enabled: false });
  });
  assert.equal(ran.status, 'partially_applied');
  assert.equal(ran.error, null);
  assert.equal(readPlan(cwd, plan.id).status, 'applied');
  assert.equal(readPlan(cwd, ran.id).status, 'partially_applied');
});

test('drift compares against the post state returned by the API (reformatted traffic does not count as drift)', async (t) => {
  // op sent traffic 'any(dns.domains[*] == "x.com")', API returned 'any(dns.domains[*] == "x.com") ' reformatted; post holds the returned form
  const sent = 'any(dns.domains[*] == "x.com")';
  const { cwd, plan } = setup(t, [ruleUpdate(R1, { name: 'new', traffic: sent, precedence: 1 })]);
  const api = fakeApi({ [`${BASE}/dx/rules/${R1}`]: rule(R1) });
  const { rollback, ran } = await applyAndRollback(cwd, api, plan);
  assert.equal(rollback.ops[0].precheck.expect.traffic, `${sent} `);
  assert.equal(ran.status, 'applied');
  assert.deepEqual(api.writes().map((c) => `${c.method} ${c.path}`), [`PUT ${BASE}/dx/rules/${R1}`]);
});

test('a deleted resource rolls back only while it is still absent', async (t) => {
  const del = { method: 'DELETE', path: `${BASE}/dx/things/${TH}`, confirm_name: 'beta' };
  const initial = { [`${BASE}/dx/things/${TH}`]: { id: TH, name: 'beta', enabled: true, created_at: 't0' } };

  const first = setup(t, [del]);
  const api = fakeApi(initial);
  const { rollback, ran } = await applyAndRollback(first.cwd, api, first.plan);
  assert.deepEqual(rollback.ops[0].precheck, { kind: 'drift', read: `${BASE}/dx/things/${TH}`, expect: { absent: true }, ignore: READ_ONLY });
  assert.equal(ran.status, 'applied');
  assert.deepEqual(api.writes().map((c) => `${c.method} ${c.path}`), [`POST ${BASE}/dx/things`]);

  const second = setup(t, [del]);
  const api2 = fakeApi(initial);
  const out = await applyAndRollback(second.cwd, api2, second.plan, (store) => {
    store.set(`${BASE}/dx/things/${TH}`, { id: TH, name: 'beta', enabled: true });
  });
  assert.equal(out.ran.status, 'partially_applied');
  assert.equal(out.ran.results[0].reason, 'rollback_drift');
  assert.deepEqual(api2.writes(), []);
});

test('a failed post read makes the inverse fail closed with post-apply state unknown', async (t) => {
  const { cwd, plan } = setup(t, [thingCreate]);
  const api = fakeApi();
  const request = api.request.bind(api);
  let failed = false;
  api.request = async (method, path, opts) => {
    if (method === 'GET' && !failed) {
      failed = true;
      throw new CfError('api', 'read failed', { status: 500 });
    }
    return request(method, path, opts);
  };
  const { applied, rollback, ran } = await applyAndRollback(cwd, api, plan);
  assert.match(applied.results[0].note, /^post_error/);
  assert.deepEqual(rollback.ops[0].precheck, { kind: 'drift', unknown: true });
  assert.equal(ran.status, 'partially_applied');
  assert.deepEqual(ran.results[0], { skipped: true, reason: 'rollback_drift', detail: 'post-apply state unknown' });
  assert.deepEqual(api.writes(), []);
});

test('a missing post file gives every product inverse the unknown precheck', async (t) => {
  const { cwd, plan } = setup(t, [thingCreate]);
  const api = fakeApi();
  approve(cwd, plan);
  const applied = await applyPlan(cwd, api, plan.id, T0);
  rmSync(postFile(cwd, applied));
  const rollback = createRollbackPlan(cwd, plan.id, T1);
  assert.deepEqual(rollback.ops[0].precheck, { kind: 'drift', unknown: true });
});

test('the post file is written once next to the snapshot, only for product plans', async (t) => {
  const { cwd, plan } = setup(t, [thingCreate]);
  const api = fakeApi();
  approve(cwd, plan);
  const applied = await applyPlan(cwd, api, plan.id, T0);
  const file = postFile(cwd, applied);
  assert.equal(file, join(cwd, '.claudeflare', 'snapshots', applied.account_slug, `${plan.id}.post.json`));
  const post = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(post.plan_id, plan.id);
  assert.deepEqual(post.ops, [{ op_index: 0, read: `${BASE}/dx/things/${NEW_IDS[0]}`, state: { id: NEW_IDS[0], name: 'alpha', enabled: true, created_at: 't1' } }]);
});

test('the rollback precheck is inside the ops hash', async (t) => {
  const { cwd, plan } = setup(t, [thingCreate]);
  const api = fakeApi();
  approve(cwd, plan);
  await applyPlan(cwd, api, plan.id, T0);
  const rollback = createRollbackPlan(cwd, plan.id, T1);
  assert.equal(hashPlan(rollback), rollback.ops_hash);
  const tampered = structuredClone(rollback);
  tampered.ops[0].precheck.expect.enabled = false;
  assert.notEqual(hashPlan(tampered), rollback.ops_hash);
});

test('plan new refuses a REST draft op that carries precheck', () => {
  const plan = { scope: 'account', account_id: A };
  const op = { ...thingCreate, precheck: { kind: 'drift', unknown: true } };
  assert.throws(() => validateOpTargets([op], plan), (err) => err.code === 'invalid_op' && /precheck/.test(err.message));
  const ZID = '0123456789abcdef0123456789abcdef';
  const zoneOp = { method: 'PATCH', path: `/zones/${ZID}/settings/ssl`, body: { value: 'strict' }, precheck: { kind: 'drift' } };
  assert.throws(() => validateOpTargets([zoneOp], { zone_id: ZID }), (err) => err.code === 'invalid_op');
});

test('v1 and v2 rollbacks carry no drift precheck', async (t) => {
  // v1: zone plan, real apply and rollback; no post file.
  const ZID = '0123456789abcdef0123456789abcdef';
  const S = `/zones/${ZID}/settings`;
  const cwd = mkdtempSync(join(tmpdir(), 'claudeflare-drift-v1-'));
  const keyDir = mkdtempSync(join(tmpdir(), 'claudeflare-key-'));
  const saved = process.env.CLAUDEFLARE_KEY_DIR;
  process.env.CLAUDEFLARE_KEY_DIR = keyDir;
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CLAUDEFLARE_KEY_DIR;
    else process.env.CLAUDEFLARE_KEY_DIR = saved;
  });
  const created = createPlan(cwd, {
    zone_id: ZID, zone_name: 'example.com', summary: 'TLS', risk: 'low', ops: [{ method: 'PATCH', path: `${S}/ssl`, body: { value: 'strict' } }], slug: 'tls',
  }, T0);
  const plan = updatePlan(cwd, created.id, { slug: 'tls' });
  const api = fakeApi({ [`${S}/ssl`]: { id: 'ssl', value: 'flexible' } });
  approve(cwd, plan);
  const applied = await applyPlan(cwd, api, plan.id, T0);
  assert.equal(applied.status, 'applied');
  assert.equal(existsSync(postFile(cwd, applied)), false);
  const rollback = createRollbackPlan(cwd, plan.id, T1);
  assert.deepEqual(rollback.ops, [{ method: 'PATCH', path: `${S}/ssl`, body: { value: 'flexible' } }]);
  approve(cwd, rollback, T1);
  const ran = await applyPlan(cwd, api, rollback.id, T1);
  assert.equal(ran.status, 'applied');
  assert.equal(readPlan(cwd, plan.id).status, 'rolled_back');

  // v2: wrangler entries keep their own precheck and never get a drift one.
  const snap = {
    plan_id: 'p',
    entries: [{ op_index: 0, op_kind: 'wrangler', kind: 'resource_create', invertible: true, before: null, target: { kind: 'resource_create', type: 'd1', name: 'app-db', target_args: [] } }],
  };
  const ops = buildRollbackOps(snap, [{ events: [] }], { post: null });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].precheck, 'empty');
});

test('stableEqual ignores key order and the listed fields, not array order', () => {
  assert.equal(stableEqual({ a: 1, b: { c: [1, 2], d: 'x' } }, { b: { d: 'x', c: [1, 2] }, a: 1 }), true);
  assert.equal(stableEqual({ a: 1, updated_at: 't1' }, { updated_at: 't2', a: 1 }, ['updated_at']), true);
  assert.equal(stableEqual({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 } }, ['a.c']), true);
  assert.equal(stableEqual({ a: [1, 2] }, { a: [2, 1] }), false);
  assert.equal(stableEqual({ a: 1 }, { a: 1, b: null }), false);
  assert.equal(stableEqual(null, null), true);
  assert.equal(stableEqual('x', 'x '), false);
});

test('driftDetail refuses a read path outside the plan base and maps read errors to drift', async () => {
  const base = BASE;
  const client = { calls: [], async request(method, path) { this.calls.push(path); throw new CfError('rate_limit', 'slow down', { status: 429 }); } };
  assert.match(await driftDetail(client, { kind: 'drift', read: '/accounts/other/dx/things/x', expect: {} }, { base }), /outside/);
  assert.deepEqual(client.calls, []);
  assert.match(await driftDetail(client, { kind: 'drift', read: `${BASE}/dx/things/x`, expect: {} }, { base }), /rate_limit/);
  assert.match(await driftDetail(client, { kind: 'drift', read: `${BASE}/dx/things/x`, expect: { absent: true } }, { base }), /rate_limit/);
  assert.equal(await driftDetail(client, { kind: 'drift', group: 'g' }, { base }), null);
  assert.equal(await driftDetail(client, { kind: 'drift', unknown: true }, { base }), 'post-apply state unknown');
});
