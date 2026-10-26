import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureProductEntry, inverseForProduct } from '../scripts/lib/rest-engine.mjs';
import { classifyProductOp, kindByName, registerProduct } from '../scripts/lib/products/index.mjs';
import { buildRollbackOps, captureSnapshot, inverseFor } from '../scripts/lib/snapshot.mjs';
import { applyPlan, createRollbackPlan, withIrreversibleRisk } from '../scripts/lib/apply.mjs';
import { createPlan, readPlan, updatePlan } from '../scripts/lib/plans.mjs';
import { writeApproval } from '../scripts/lib/approvals.mjs';
import { CfError } from '../scripts/lib/errors.mjs';

const A = '0123456789abcdef0123456789abcdef';
const ID = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';
const ID2 = '1a1b2c3d-4e5f-6789-abcd-ef0123456789';
const ID3 = '2a1b2c3d-4e5f-6789-abcd-ef0123456789';
const NEW = 'ffffffff-4e5f-6789-abcd-ef0123456789';
const BASE = `/accounts/${A}`;
const PLAN = { scope: 'account', account_id: A, project_dir: null };
const T0 = new Date('2026-10-26T10:00:00Z');

const thingKey = (m) => ({ type: 'rt_thing', id: m[1] });
const fnInverseCalls = [];
const rt = {
  product: 'resttest',
  kinds: [
    { kind: 'rt_thing_create', product: 'resttest', scope: 'account', methods: ['POST'], pattern: /^\/rt\/things$/, resource: () => null, readOnlyFields: ['id', 'created_at'], inverse: 'delete_created', destructive: false },
    { kind: 'rt_thing_update', product: 'resttest', scope: 'account', methods: ['PUT'], pattern: /^\/rt\/things\/([0-9a-f-]{36})$/, resource: thingKey, readOnlyFields: ['id', 'created_at'], inverse: 'put_before', destructive: false, group: (m) => `thing ${m[1]}` },
    { kind: 'rt_thing_patch', product: 'resttest', scope: 'account', methods: ['PATCH'], pattern: /^\/rt\/things\/([0-9a-f-]{36})$/, resource: thingKey, readOnlyFields: ['id', 'created_at'], inverse: 'patch_before', destructive: false },
    { kind: 'rt_thing_delete', product: 'resttest', scope: 'account', methods: ['DELETE'], pattern: /^\/rt\/things\/([0-9a-f-]{36})$/, resource: thingKey, readOnlyFields: ['id', 'created_at'], inverse: 'recreate', destructive: true, nameField: 'name', collection: (m, base) => `${base}/rt/things` },
    { kind: 'rt_widget_patch', product: 'resttest', scope: 'account', methods: ['PATCH'], pattern: /^\/rt\/widgets\/([0-9a-f-]{36})$/, resource: (m) => ({ type: 'rt_widget', id: m[1] }), readOnlyFields: ['id'], inverse: 'patch_before', putFallback: true, destructive: false, read: (m, base) => `${base}/rt/widgets/${m[1]}/full` },
    { kind: 'rt_settings_put', product: 'resttest', scope: 'account', methods: ['PUT'], pattern: /^\/rt\/settings$/, resource: () => ({ type: 'rt_settings', id: 'account' }), readOnlyFields: [], inverse: 'none', destructive: false, notes: (ctx, op) => [`Note: settings change for ${op.path}`] },
    {
      kind: 'rt_action_run', product: 'resttest', scope: 'account', methods: ['POST'], pattern: /^\/rt\/actions\/([0-9a-f-]{36})\/run$/, resource: (m) => ({ type: 'rt_action', id: m[1] }), readOnlyFields: [], destructive: false,
      inverse: (entry, applyResult) => {
        fnInverseCalls.push([entry, applyResult]);
        return [{ method: 'POST', path: `${entry.path.slice(0, -4)}/undo`, body: { run: applyResult.run_id } }];
      },
    },
  ],
  probePath: (base) => `${base}/rt/things`,
  gather: async () => ({}),
  lockoutRisks: () => [],
  verifyChecks: () => [],
};
after(registerProduct(rt));

const BEFORE = { id: ID, name: 'alpha', mode: 'a', tags: ['x'], created_at: '2026-01-01T00:00:00Z' };

function fakeClient(routes) {
  const calls = [];
  return {
    calls,
    async request(method, path, opts) {
      calls.push({ method, path, opts });
      const handler = routes[`${method} ${path}`];
      if (handler === undefined) throw new Error(`unexpected request ${method} ${path}`);
      return typeof handler === 'function' ? handler() : handler;
    },
  };
}

async function entryFor(op, routes = {}) {
  const client = fakeClient(routes);
  const entry = await captureProductEntry(client, op, classifyProductOp(op, PLAN));
  return { entry, client };
}

const ambiguous = (err) => err instanceof CfError && err.code === 'rollback_ambiguous';

test('kindByName finds a registered kind and returns null for an unknown name', () => {
  assert.equal(kindByName('rt_thing_update').inverse, 'put_before');
  assert.equal(kindByName('no_such_kind'), null);
});

test('delete_created takes no snapshot and deletes the id from the apply result', async () => {
  const op = { method: 'POST', path: `${BASE}/rt/things`, body: { name: 'alpha' } };
  const { entry, client } = await entryFor(op);
  assert.equal(client.calls.length, 0);
  assert.deepEqual(entry, {
    product: 'resttest', kind: 'rt_thing_create', path: op.path, before: null, invertible: true, op_body_keys: ['name'],
  });
  assert.deepEqual(inverseForProduct(entry, { id: ID }), [{ method: 'DELETE', path: `${BASE}/rt/things/${ID}` }]);
  assert.throws(() => inverseForProduct(entry, true), ambiguous);
  assert.throws(() => inverseForProduct(entry, { id: '../x' }), ambiguous);
});

test('put_before strips readOnlyFields', async () => {
  const op = { method: 'PUT', path: `${BASE}/rt/things/${ID}`, body: { name: 'beta', mode: 'b' } };
  const { entry, client } = await entryFor(op, { [`GET ${op.path}`]: BEFORE });
  assert.deepEqual(client.calls.map((c) => `${c.method} ${c.path}`), [`GET ${op.path}`]);
  assert.equal(entry.group, `thing ${ID}`);
  assert.deepEqual(entry.before, BEFORE);
  assert.deepEqual(inverseForProduct(entry, {}), [
    { method: 'PUT', path: op.path, body: { name: 'alpha', mode: 'a', tags: ['x'] } },
  ]);
});

test('patch_before restores only keys the op set', async () => {
  const op = { method: 'PATCH', path: `${BASE}/rt/things/${ID}`, body: { mode: 'b' } };
  const { entry } = await entryFor(op, { [`GET ${op.path}`]: BEFORE });
  assert.deepEqual(entry.op_body_keys, ['mode']);
  assert.deepEqual(inverseForProduct(entry, {}), [{ method: 'PATCH', path: op.path, body: { mode: 'a' } }]);
});

test('patch_before with a key absent before and no putFallback is rollback_ambiguous', async () => {
  const op = { method: 'PATCH', path: `${BASE}/rt/things/${ID}`, body: { mode: 'b', extra: 1 } };
  const { entry } = await entryFor(op, { [`GET ${op.path}`]: BEFORE });
  assert.throws(() => inverseForProduct(entry, {}), (err) => ambiguous(err) && /extra/.test(err.message));
});

test('patch_before with a key absent before falls back to put_before when the kind sets putFallback', async () => {
  const op = { method: 'PATCH', path: `${BASE}/rt/widgets/${ID}`, body: { extra: 1 } };
  const full = `${BASE}/rt/widgets/${ID}/full`;
  const { entry, client } = await entryFor(op, { [`GET ${full}`]: { id: ID, size: 2 } });
  assert.deepEqual(client.calls.map((c) => c.path), [full]);
  assert.deepEqual(inverseForProduct(entry, {}), [{ method: 'PUT', path: op.path, body: { size: 2 } }]);
});

test('recreate posts to the collection without readOnlyFields', async () => {
  const op = { method: 'DELETE', path: `${BASE}/rt/things/${ID}`, confirm_name: 'alpha' };
  const { entry } = await entryFor(op, { [`GET ${op.path}`]: BEFORE });
  assert.equal(entry.collection, `${BASE}/rt/things`);
  assert.deepEqual(entry.op_body_keys, []);
  assert.deepEqual(inverseForProduct(entry, true), [
    { method: 'POST', path: `${BASE}/rt/things`, body: { name: 'alpha', mode: 'a', tags: ['x'] } },
  ]);
});

test('none yields no inverse and withIrreversibleRisk adds "Not reversible: PUT <path>"', async () => {
  const op = { method: 'PUT', path: `${BASE}/rt/settings`, body: { level: 2 } };
  const { entry, client } = await entryFor(op);
  assert.equal(client.calls.length, 0);
  assert.equal(entry.invertible, false);
  assert.deepEqual(inverseForProduct(entry, {}), []);
  const risk = withIrreversibleRisk('Changes settings.', [op], PLAN);
  assert.match(risk, new RegExp(`^Changes settings\\.\\nNot reversible: PUT ${op.path}\\n`));
  // Without a plan the op is unclassified, as before.
  assert.equal(withIrreversibleRisk('Changes settings.', [op]), `Changes settings.\nNot reversible: PUT ${op.path}`);
});

test('function inverse from the kind is called with (entry, applyResult)', async () => {
  const op = { method: 'POST', path: `${BASE}/rt/actions/${ID}/run`, body: {} };
  const { entry } = await entryFor(op);
  fnInverseCalls.length = 0;
  const ops = inverseForProduct(entry, { run_id: 7 });
  assert.deepEqual(fnInverseCalls, [[entry, { run_id: 7 }]]);
  assert.deepEqual(ops, [{ method: 'POST', path: `${BASE}/rt/actions/${ID}/undo`, body: { run: 7 } }]);
});

test('withIrreversibleRisk appends kind notes lines after the Not reversible lines', () => {
  const ops = [
    { method: 'PUT', path: `${BASE}/rt/settings`, body: {} },
    { method: 'PUT', path: `${BASE}/rt/things/${ID}`, body: {} },
    { method: 'POST', path: `${BASE}/unknown/thing`, body: {} },
  ];
  assert.equal(withIrreversibleRisk('Risk.', ops, PLAN), [
    'Risk.',
    `Not reversible: PUT ${BASE}/rt/settings`,
    `Not reversible: POST ${BASE}/unknown/thing`,
    `Note: settings change for ${BASE}/rt/settings`,
  ].join('\n'));
  // An invertible product op gets no line.
  assert.equal(withIrreversibleRisk('Risk.', [ops[1]], PLAN), 'Risk.');
});

test('an unknown kind name is rollback_ambiguous and buildRollbackOps reports it as unresolved', () => {
  const entry = { op_index: 0, op_kind: 'product', product: 'gone', kind: 'gone_kind', path: `${BASE}/gone`, before: null, invertible: true, op_body_keys: [] };
  assert.throws(() => inverseFor(entry, { id: ID }), ambiguous);
  const create = { op_index: 1, op_kind: 'product', product: 'resttest', kind: 'rt_thing_create', path: `${BASE}/rt/things`, before: null, invertible: true, op_body_keys: [] };
  const unresolved = [];
  const ops = buildRollbackOps({ entries: [entry, create] }, [{ id: ID }, { id: ID2 }], { unresolved });
  assert.deepEqual(ops, [{ method: 'DELETE', path: `${BASE}/rt/things/${ID2}` }]);
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0], /gone_kind/);
});

test('captureSnapshot stores self-contained product entries next to v1 entries', async () => {
  const plan = { id: 'p1', ...PLAN, ops: [
    { method: 'PATCH', path: `${BASE}/rt/things/${ID}`, body: { mode: 'b' } },
    { method: 'POST', path: `${BASE}/rt/things`, body: { name: 'n' } },
  ] };
  const client = fakeClient({ [`GET ${BASE}/rt/things/${ID}`]: BEFORE });
  const snapshot = await captureSnapshot(client, plan);
  assert.deepEqual(snapshot.entries.map((e) => [e.op_index, e.op_kind, e.kind, e.invertible]), [
    [0, 'product', 'rt_thing_patch', true],
    [1, 'product', 'rt_thing_create', true],
  ]);
  const ops = buildRollbackOps(snapshot, [{}, { id: ID2 }]);
  assert.deepEqual(ops, [
    { method: 'DELETE', path: `${BASE}/rt/things/${ID2}` },
    { method: 'PATCH', path: `${BASE}/rt/things/${ID}`, body: { mode: 'a' } },
  ]);
});

function setup(t, ops) {
  const cwd = mkdtempSync(join(tmpdir(), 'claudeflare-rest-'));
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
    scope: 'account', account_id: A, account_name: 'Acme', summary: 'Things', risk: 'low', ops, slug: 'things',
  }, T0);
  return { cwd, plan: updatePlan(cwd, plan.id, { slug: 'things' }) };
}

const approve = (cwd, plan) => writeApproval(cwd, { plan_id: plan.id, session_id: 's1' }, T0);

test('a product snapshot read error aborts before any write', async (t) => {
  const ops = [
    { method: 'POST', path: `${BASE}/rt/things`, body: { name: 'n' } },
    { method: 'PUT', path: `${BASE}/rt/things/${ID}`, body: { name: 'beta' } },
  ];
  const { cwd, plan } = setup(t, ops);
  approve(cwd, plan);
  const client = fakeClient({
    [`GET ${BASE}/rt/things/${ID}`]: () => { throw new CfError('permission', 'denied', { status: 403 }); },
  });
  await assert.rejects(applyPlan(cwd, client, plan.id, T0), (err) => err.code === 'permission');
  assert.deepEqual(client.calls.filter((c) => c.method !== 'GET'), []);
  assert.equal(readPlan(cwd, plan.id).status, 'draft');
});

test('REST-only account plan without project_dir: apply, then rollback builds the product inverses', async (t) => {
  const ops = [
    { method: 'POST', path: `${BASE}/rt/things`, body: { name: 'new' } },
    { method: 'PUT', path: `${BASE}/rt/things/${ID}`, body: { name: 'beta', mode: 'b' } },
    { method: 'PATCH', path: `${BASE}/rt/widgets/${ID2}`, body: { size: 3 } },
    { method: 'DELETE', path: `${BASE}/rt/things/${ID3}`, confirm_name: 'gamma' },
    { method: 'PUT', path: `${BASE}/rt/settings`, body: { level: 2 } },
  ];
  const { cwd, plan } = setup(t, ops);
  assert.equal(plan.project_dir, null);
  approve(cwd, plan);
  const client = fakeClient({
    [`GET ${BASE}/rt/things/${ID}`]: BEFORE,
    [`GET ${BASE}/rt/widgets/${ID2}/full`]: { id: ID2, size: 1 },
    [`GET ${BASE}/rt/things/${ID3}`]: { id: ID3, name: 'gamma', mode: 'g' },
    [`POST ${BASE}/rt/things`]: { id: NEW, name: 'new' },
    [`PUT ${BASE}/rt/things/${ID}`]: { id: ID, name: 'beta' },
    [`PATCH ${BASE}/rt/widgets/${ID2}`]: { id: ID2, size: 3 },
    [`DELETE ${BASE}/rt/things/${ID3}`]: { id: ID3 },
    [`PUT ${BASE}/rt/settings`]: { level: 2 },
  });
  const applied = await applyPlan(cwd, client, plan.id, T0);
  assert.equal(applied.status, 'applied');

  const rollback = createRollbackPlan(cwd, plan.id, T0);
  assert.equal(rollback.scope, 'account');
  assert.equal(rollback.project_dir, null);
  assert.equal(rollback.rollback_of, plan.id);
  assert.deepEqual(rollback.ops, [
    { method: 'POST', path: `${BASE}/rt/things`, body: { name: 'gamma', mode: 'g' } },
    { method: 'PATCH', path: `${BASE}/rt/widgets/${ID2}`, body: { size: 1 } },
    { method: 'PUT', path: `${BASE}/rt/things/${ID}`, body: { name: 'alpha', mode: 'a', tags: ['x'] } },
    { method: 'DELETE', path: `${BASE}/rt/things/${NEW}` },
  ]);
  assert.doesNotMatch(rollback.risk, /Not reversible/);
});
