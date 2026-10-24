import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../scripts/lib/paths.mjs';
import { createPlan, readPlan, updatePlan } from '../scripts/lib/plans.mjs';
import { checkApproval, writeApproval } from '../scripts/lib/approvals.mjs';
import { applyPlan, createRollbackPlan } from '../scripts/lib/apply.mjs';
import { CfError } from '../scripts/lib/errors.mjs';

const T0 = new Date('2026-10-24T14:30:00Z');
const ZID = '0123456789abcdef0123456789abcdef';
const REC = 'ffff0000eeee1111dddd2222cccc3333';

const OPS = [
  { method: 'PATCH', path: '/zones/{zone_id}/settings/ssl', body: { value: 'strict' } },
  { method: 'PATCH', path: '/zones/{zone_id}/settings/always_use_https', body: { value: 'on' } },
  { method: 'POST', path: '/zones/{zone_id}/dns_records', body: { type: 'A', name: 'x', content: '192.0.2.1' } },
];

function setup(t, ops = OPS) {
  const cwd = mkdtempSync(join(tmpdir(), 'claudeflare-apply-'));
  const keyDir = mkdtempSync(join(tmpdir(), 'claudeflare-key-'));
  const saved = process.env.CLAUDEFLARE_KEY_DIR;
  process.env.CLAUDEFLARE_KEY_DIR = keyDir;
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CLAUDEFLARE_KEY_DIR;
    else process.env.CLAUDEFLARE_KEY_DIR = saved;
  });
  const plan = createPlan(
    cwd,
    { zone_id: ZID, zone_name: 'example.com', summary: 'Harden TLS', risk: 'low', ops, slug: 'tls' },
    T0,
  );
  // `plan new` stores the slug on the plan; mirror that here.
  return { cwd, plan: updatePlan(cwd, plan.id, { slug: 'tls' }) };
}

function approve(cwd, plan) {
  writeApproval(cwd, { plan_id: plan.id, session_id: 's1' }, T0);
}

// routes: "METHOD path" -> value or function returning a value (or throwing).
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

const S = `/zones/${ZID}/settings`;
const DNS = `/zones/${ZID}/dns_records`;

function readRoutes() {
  return {
    [`GET ${S}/ssl`]: { id: 'ssl', value: 'flexible' },
    [`GET ${S}/always_use_https`]: { id: 'always_use_https', value: 'off' },
  };
}

function apiFail() {
  throw new CfError('api', 'boom', { status: 400 });
}

const writes = (client) => client.calls.filter((c) => c.method !== 'GET');

test('applyPlan refuses without approval and makes zero API calls', async (t) => {
  const { cwd, plan } = setup(t);
  const client = fakeClient({});
  await assert.rejects(applyPlan(cwd, client, plan.id, T0), (err) => {
    assert.ok(err instanceof CfError);
    assert.equal(err.code, 'not_approved');
    assert.match(err.message, /missing/);
    return true;
  });
  assert.equal(client.calls.length, 0);
  assert.equal(readPlan(cwd, plan.id).status, 'draft');
});

test('applyPlan success: status applied, results stored, snapshot file written, approval consumed', async (t) => {
  const { cwd, plan } = setup(t);
  approve(cwd, plan);
  const client = fakeClient({
    ...readRoutes(),
    [`PATCH ${S}/ssl`]: { id: 'ssl', value: 'strict' },
    [`PATCH ${S}/always_use_https`]: null,
    [`POST ${DNS}`]: { id: REC },
  });
  const result = await applyPlan(cwd, client, plan.id, T0);
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.results, [{ id: 'ssl', value: 'strict' }, true, { id: REC }]);
  assert.deepEqual(writes(client)[0].opts, { body: { value: 'strict' } });

  const stored = readPlan(cwd, plan.id);
  assert.equal(stored.status, 'applied');
  assert.deepEqual(stored.results, result.results);
  const snapFile = join(paths(cwd).snapshots('example.com'), `${plan.id}.json`);
  assert.equal(stored.snapshot_file, snapFile);
  const snap = JSON.parse(readFileSync(snapFile, 'utf8'));
  assert.equal(snap.plan_id, plan.id);
  assert.equal(snap.entries.length, 3);
  assert.equal(snap.entries[0].path, `${S}/ssl`);
  assert.deepEqual(snap.entries[0].before, { id: 'ssl', value: 'flexible' });
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: false, reason: 'missing' });
});

test('applyPlan fails on op 2 of 3: status partially_applied, results[0] set, op 3 never called, approval consumed', async (t) => {
  const { cwd, plan } = setup(t);
  approve(cwd, plan);
  const client = fakeClient({
    ...readRoutes(),
    [`PATCH ${S}/ssl`]: { id: 'ssl', value: 'strict' },
    [`PATCH ${S}/always_use_https`]: apiFail,
    [`POST ${DNS}`]: { id: REC },
  });
  const result = await applyPlan(cwd, client, plan.id, T0);
  assert.equal(result.status, 'partially_applied');
  assert.deepEqual(result.results, [{ id: 'ssl', value: 'strict' }, null, null]);
  assert.deepEqual(result.error, { op_index: 1, code: 'api', message: 'boom' });
  assert.equal(writes(client).length, 2);
  assert.ok(!client.calls.some((c) => c.method === 'POST'));
  assert.equal(readPlan(cwd, plan.id).status, 'partially_applied');
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: false, reason: 'missing' });
});

test('applyPlan fails on op 1: status failed', async (t) => {
  const { cwd, plan } = setup(t);
  approve(cwd, plan);
  let approvalDuringWrite;
  const client = fakeClient({
    ...readRoutes(),
    [`PATCH ${S}/ssl`]: () => {
      approvalDuringWrite = checkApproval(cwd, plan.id, T0);
      return apiFail();
    },
  });
  const result = await applyPlan(cwd, client, plan.id, T0);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.op_index, 0);
  // Consumed before the first write, not after execution.
  assert.deepEqual(approvalDuringWrite, { ok: false, reason: 'missing' });
  assert.equal(writes(client).length, 1);
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: false, reason: 'missing' });
});

test('snapshot read failure aborts before any write call', async (t) => {
  const { cwd, plan } = setup(t);
  approve(cwd, plan);
  const client = fakeClient({
    [`GET ${S}/ssl`]: { id: 'ssl', value: 'flexible' },
    [`GET ${S}/always_use_https`]: apiFail,
  });
  await assert.rejects(applyPlan(cwd, client, plan.id, T0), /boom/);
  assert.equal(writes(client).length, 0);
  assert.equal(readPlan(cwd, plan.id).status, 'draft');
  assert.equal(existsSync(join(paths(cwd).snapshots('example.com'), `${plan.id}.json`)), false);
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: true });
});

test('rollback after partial apply creates plan with inverse of op 1 only', async (t) => {
  const { cwd, plan } = setup(t);
  approve(cwd, plan);
  const client = fakeClient({
    ...readRoutes(),
    [`PATCH ${S}/ssl`]: { id: 'ssl', value: 'strict' },
    [`PATCH ${S}/always_use_https`]: apiFail,
  });
  await applyPlan(cwd, client, plan.id, T0);

  const later = new Date(T0.getTime() + 60_000);
  const rollback = createRollbackPlan(cwd, plan.id, later);
  assert.notEqual(rollback.id, plan.id);
  assert.match(rollback.id, /-rollback-tls$/);
  assert.equal(rollback.rollback_of, plan.id);
  assert.equal(rollback.summary, `Rollback of ${plan.id}`);
  assert.equal(rollback.status, 'draft');
  assert.deepEqual(rollback.ops, [{ method: 'PATCH', path: `${S}/ssl`, body: { value: 'flexible' } }]);
  assert.deepEqual(readPlan(cwd, rollback.id), rollback);
});

test('rollback refuses plans that were never applied', (t) => {
  const { cwd, plan } = setup(t);
  assert.throws(() => createRollbackPlan(cwd, plan.id, T0), (err) => err.code === 'not_applied');
});

test('applying a rollback plan marks the original plan rolled_back', async (t) => {
  const { cwd, plan } = setup(t, [OPS[0]]);
  approve(cwd, plan);
  await applyPlan(
    cwd,
    fakeClient({ ...readRoutes(), [`PATCH ${S}/ssl`]: { id: 'ssl', value: 'strict' } }),
    plan.id,
    T0,
  );
  const later = new Date(T0.getTime() + 60_000);
  const rollback = createRollbackPlan(cwd, plan.id, later);
  writeApproval(cwd, { plan_id: rollback.id, session_id: 's1' }, later);
  const done = await applyPlan(
    cwd,
    fakeClient({
      [`GET ${S}/ssl`]: { id: 'ssl', value: 'strict' },
      [`PATCH ${S}/ssl`]: { id: 'ssl', value: 'flexible' },
    }),
    rollback.id,
    later,
  );
  assert.equal(done.status, 'applied');
  assert.equal(readPlan(cwd, plan.id).status, 'rolled_back');
});

test('applyPlan refuses a non-draft plan before the approval check, with zero API calls', async (t) => {
  const { cwd, plan } = setup(t, [OPS[0]]);
  approve(cwd, plan);
  await applyPlan(cwd, fakeClient({ ...readRoutes(), [`PATCH ${S}/ssl`]: { value: 'strict' } }), plan.id, T0);
  approve(cwd, plan);
  const client = fakeClient({});
  await assert.rejects(applyPlan(cwd, client, plan.id, T0), (err) => err.code === 'not_draft');
  assert.equal(client.calls.length, 0);
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: true });
});

test('applyPlan validates ops of non-rollback plans before any API call', async (t) => {
  const dup = { method: 'PATCH', path: `/zones/{zone_id}/dns_records/${REC}`, body: { ttl: 60 } };
  const { cwd, plan } = setup(t, [dup, dup]);
  approve(cwd, plan);
  const client = fakeClient({});
  await assert.rejects(applyPlan(cwd, client, plan.id, T0), (err) => err.code === 'plan_conflict');
  assert.equal(client.calls.length, 0);
});

test('applyPlan refuses to overwrite an existing apply snapshot and keeps the approval', async (t) => {
  const { cwd, plan } = setup(t);
  approve(cwd, plan);
  const dir = paths(cwd).snapshots('example.com');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${plan.id}.json`);
  writeFileSync(file, '{"baseline":true}');
  const client = fakeClient(readRoutes());
  await assert.rejects(applyPlan(cwd, client, plan.id, T0), (err) => err.code === 'snapshot_exists');
  assert.equal(writes(client).length, 0);
  assert.equal(readFileSync(file, 'utf8'), '{"baseline":true}');
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: true });
  assert.equal(readPlan(cwd, plan.id).status, 'draft');
});

test('rollback slug is slugified from the original slug', async (t) => {
  const { cwd, plan } = setup(t, [OPS[0]]);
  updatePlan(cwd, plan.id, { slug: 'x'.repeat(38) });
  approve(cwd, plan);
  await applyPlan(cwd, fakeClient({ ...readRoutes(), [`PATCH ${S}/ssl`]: { value: 'strict' } }), plan.id, T0);
  const rollback = createRollbackPlan(cwd, plan.id, new Date(T0.getTime() + 60_000));
  assert.equal(rollback.slug, `rollback-${'x'.repeat(31)}`);
  assert.ok(rollback.id.endsWith(rollback.slug));
});

test('applyPlan refuses a second rollback draft once the source was rolled back', async (t) => {
  const { cwd, plan } = setup(t, [OPS[0]]);
  approve(cwd, plan);
  await applyPlan(cwd, fakeClient({ ...readRoutes(), [`PATCH ${S}/ssl`]: { id: 'ssl', value: 'strict' } }), plan.id, T0);
  const t1 = new Date(T0.getTime() + 60_000);
  const t2 = new Date(T0.getTime() + 120_000);
  const first = createRollbackPlan(cwd, plan.id, t1);
  const second = createRollbackPlan(cwd, plan.id, t2);
  const routes = { [`GET ${S}/ssl`]: { id: 'ssl', value: 'strict' }, [`PATCH ${S}/ssl`]: { id: 'ssl', value: 'flexible' } };
  writeApproval(cwd, { plan_id: first.id, session_id: 's1' }, t2);
  assert.equal((await applyPlan(cwd, fakeClient(routes), first.id, t2)).status, 'applied');
  writeApproval(cwd, { plan_id: second.id, session_id: 's1' }, t2);
  const client = fakeClient(routes);
  await assert.rejects(applyPlan(cwd, client, second.id, t2), (err) => err instanceof CfError && err.code === 'rollback_stale');
  assert.equal(client.calls.length, 0);
  assert.equal(readPlan(cwd, second.id).status, 'draft');
});
