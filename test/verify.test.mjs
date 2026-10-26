import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accessLoginCheck,
  opVerifyChecks,
  poolHealthyCheck,
  readbackCheck,
  runVerify,
  statusCheck,
  tcpOpenCheck,
  tunnelServingCheck,
} from '../scripts/lib/verify.mjs';
import { applyPlan, createRollbackPlan } from '../scripts/lib/apply.mjs';
import { createPlan, readPlan, updatePlan } from '../scripts/lib/plans.mjs';
import { writeApproval } from '../scripts/lib/approvals.mjs';
import { registerProduct } from '../scripts/lib/products/index.mjs';
import { CfError } from '../scripts/lib/errors.mjs';

const A = '0123456789abcdef0123456789abcdef';
const BASE = `/accounts/${A}`;
const ID = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';
const NEW = 'ffffffff-4e5f-6789-abcd-ef0123456789';
const T0 = new Date('2026-10-26T10:00:00Z');

// The fake product's default checks are set per test.
let moduleChecks = () => [];
const seen = [];
const inverseSaw = [];
const VX = {
  product: 'vx',
  kinds: [
    {
      kind: 'vx_app_create', product: 'vx', scope: 'account', methods: ['POST'], pattern: /^\/vx\/apps$/,
      resource: () => null, readOnlyFields: ['id'], inverse: 'delete_created', destructive: false,
    },
    {
      kind: 'vx_app_update', product: 'vx', scope: 'account', methods: ['PUT'], pattern: /^\/vx\/apps\/([0-9a-f-]{36})$/,
      resource: (m) => ({ type: 'vx_app', id: m[1] }), readOnlyFields: ['id'], inverse: 'put_before', destructive: false,
      secretFields: ['token'],
    },
    {
      kind: 'vx_app_delete', product: 'vx', scope: 'account', methods: ['DELETE'], pattern: /^\/vx\/apps\/([0-9a-f-]{36})$/,
      resource: (m) => ({ type: 'vx_app', id: m[1] }), readOnlyFields: ['id'], inverse: 'none', destructive: true, nameField: 'name',
    },
    {
      kind: 'vx_list_put', product: 'vx', scope: 'account', methods: ['PUT'], pattern: /^\/vx\/lists\/([0-9a-f-]{36})$/,
      resource: (m) => ({ type: 'vx_list', id: m[1] }), readOnlyFields: [], destructive: false,
      read: (m, base) => `${base}/vx/lists/${m[1]}`,
      // Array resources: the engine's put_before needs an object before state.
      inverse: (snap, applyResult) => {
        inverseSaw.push(applyResult);
        return [{ method: 'PUT', path: snap.path, body: snap.before }];
      },
    },
  ],
  probePath: (base) => `${base}/vx/apps`,
  gather: async () => ({ auth_domain: 'acme.cloudflareaccess.com' }),
  lockoutRisks: () => [],
  verifyChecks: (op, entry, ctx, result, post, deps) => {
    seen.push({ op, ctx, result, post, deps });
    return moduleChecks(op, entry, ctx, result, post, deps);
  },
};
registerProduct(VX);

function fakeClock() {
  const clock = { t: 0, sleeps: [] };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => {
    clock.sleeps.push(ms);
    clock.t += ms;
  };
  return clock;
}

function response(status, { location, body = '', headers = {} } = {}) {
  const all = { ...headers, ...(location ? { location } : {}) };
  return {
    status,
    headers: { get: (name) => all[name.toLowerCase()] ?? null },
    body: { cancel: async () => {} },
    text: async () => body,
  };
}

function fakeFetch(answer) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return typeof answer === 'function' ? answer(url, init, calls.length) : answer;
  };
  impl.calls = calls;
  return impl;
}

function setup(t, ops) {
  moduleChecks = () => [];
  seen.length = 0;
  const cwd = mkdtempSync(join(tmpdir(), 'claudeflare-verify-'));
  const keyDir = mkdtempSync(join(tmpdir(), 'claudeflare-key-'));
  const saved = process.env.CLAUDEFLARE_KEY_DIR;
  process.env.CLAUDEFLARE_KEY_DIR = keyDir;
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CLAUDEFLARE_KEY_DIR;
    else process.env.CLAUDEFLARE_KEY_DIR = saved;
    moduleChecks = () => [];
    seen.length = 0;
  });
  const plan = createPlan(cwd, {
    scope: 'account', account_id: A, account_name: 'Acme', summary: 'Verify', risk: 'low', ops, slug: 'vx',
  }, T0);
  return { cwd, plan: updatePlan(cwd, plan.id, { slug: 'vx' }) };
}

const approve = (cwd, plan) => writeApproval(cwd, { plan_id: plan.id, session_id: 's1' }, T0);

function fakeClient(routes) {
  const calls = [];
  return {
    calls,
    async request(method, path, opts) {
      calls.push({ method, path });
      const key = `${method} ${path}`;
      const handler = key in routes ? routes[key] : (key === `GET ${BASE}/vx/apps` ? [] : undefined);
      if (handler === undefined) throw new CfError('not_found', `unexpected request ${key}`);
      return typeof handler === 'function' ? handler(opts) : structuredClone(handler);
    },
  };
}

const appCreate = { method: 'POST', path: `${BASE}/vx/apps`, body: { name: 'wiki', domain: 'wiki.acme.dev' } };
const appUpdate = { method: 'PUT', path: `${BASE}/vx/apps/${ID}`, body: { name: 'wiki2' } };
const createRoutes = {
  [`POST ${BASE}/vx/apps`]: { id: NEW, name: 'wiki', domain: 'wiki.acme.dev' },
  [`GET ${BASE}/vx/apps/${NEW}`]: { id: NEW, name: 'wiki', domain: 'wiki.acme.dev' },
};
const failing = (name = 'login') => ({ name, run: async () => ({ ok: false, detail: 'got 200' }) });
const passing = (name = 'readback') => ({ name, run: async () => ({ ok: true, detail: 'ok' }) });

test('runVerify retries until ok within the timeout', async () => {
  const clock = fakeClock();
  let tries = 0;
  const check = { name: 'flaky', run: async () => (++tries < 3 ? { ok: false, detail: `try ${tries}` } : { ok: true, detail: 'serving' }) };
  const out = await runVerify([check, passing()], { sleep: clock.sleep, now: clock.now });
  assert.equal(out.ok, true);
  assert.deepEqual(out.checks, [{ name: 'flaky', ok: true, detail: 'serving' }, { name: 'readback', ok: true, detail: 'ok' }]);
  assert.deepEqual(clock.sleeps, [5000, 5000]);
});

test('runVerify fails after 60 s with the last detail', async () => {
  const clock = fakeClock();
  let tries = 0;
  const check = { name: 'never', run: async () => ({ ok: false, detail: `try ${++tries}` }) };
  const out = await runVerify([check], { sleep: clock.sleep, now: clock.now });
  assert.equal(out.ok, false);
  assert.equal(clock.t, 60000);
  assert.equal(tries, 13);
  assert.deepEqual(out.checks, [{ name: 'never', ok: false, detail: 'try 13' }]);
});

test('runVerify records a throwing check as failed and does not retry a once check', async () => {
  const clock = fakeClock();
  let onceRuns = 0;
  const out = await runVerify([
    { name: 'boom', run: async () => { throw new Error('socket hang up'); } },
    { name: 'static', once: true, run: async () => { onceRuns++; return { ok: false, detail: 'name differs' }; } },
  ], { sleep: clock.sleep, now: clock.now });
  assert.equal(out.ok, false);
  assert.deepEqual(out.checks, [{ name: 'boom', ok: false, detail: 'socket hang up' }, { name: 'static', ok: false, detail: 'name differs' }]);
  assert.equal(onceRuns, 1);
});

test('accessLoginCheck ok on 302 to <team>.cloudflareaccess.com, fails on 200', async () => {
  const login = 'https://Acme.cloudflareaccess.com/cdn-cgi/access/login/wiki.acme.dev?kid=1';
  const redirect = fakeFetch(response(302, { location: login }));
  const ok = await accessLoginCheck('https://wiki.acme.dev/', 'acme.cloudflareaccess.com', { fetchImpl: redirect }).run();
  assert.equal(ok.ok, true, ok.detail);
  assert.equal(redirect.calls[0].init.redirect, 'manual');
  assert.equal(redirect.calls[0].init.method, 'GET');

  const open = await accessLoginCheck('https://wiki.acme.dev/', 'acme.cloudflareaccess.com', { fetchImpl: fakeFetch(response(200)) }).run();
  assert.equal(open.ok, false);
  assert.match(open.detail, /200/);

  const elsewhere = await accessLoginCheck('https://wiki.acme.dev/', 'acme.cloudflareaccess.com', {
    fetchImpl: fakeFetch(response(302, { location: 'https://other.cloudflareaccess.com/x' })),
  }).run();
  assert.equal(elsewhere.ok, false);
  const moved = await accessLoginCheck('https://wiki.acme.dev/', 'acme.cloudflareaccess.com', { fetchImpl: fakeFetch(response(301, { location: login })) }).run();
  assert.equal(moved.ok, false);

  // Without a known team domain (rollback plans) any cloudflareaccess.com host passes.
  const anyTeam = await accessLoginCheck('https://wiki.acme.dev/', null, {
    fetchImpl: fakeFetch(response(302, { location: 'https://other.cloudflareaccess.com/x' })),
  }).run();
  assert.equal(anyTeam.ok, true);
  const fake = await accessLoginCheck('https://wiki.acme.dev/', null, {
    fetchImpl: fakeFetch(response(302, { location: 'https://cloudflareaccess.com.evil.dev/x' })),
  }).run();
  assert.equal(fake.ok, false);
});

test('tunnelServingCheck fails on a 1033 body', async () => {
  const down = await tunnelServingCheck('https://app.acme.dev/', {
    fetchImpl: fakeFetch(response(530, { body: '<title>Error 1033</title> error code: 1033', headers: { 'cf-ray': 'abc' } })),
  }).run();
  assert.equal(down.ok, false);
  assert.match(down.detail, /1033/);
  const dns = await tunnelServingCheck('https://app.acme.dev/', { fetchImpl: fakeFetch(response(530, { body: 'error code: 1016' })) }).run();
  assert.equal(dns.ok, false);
  const up = await tunnelServingCheck('https://app.acme.dev/', { fetchImpl: fakeFetch(response(200, { body: 'hello' })) }).run();
  assert.equal(up.ok, true);
  const originError = await tunnelServingCheck('https://app.acme.dev/', {
    fetchImpl: fakeFetch(response(502, { body: 'bad gateway', headers: { 'cf-ray': 'abc' } })),
  }).run();
  assert.equal(originError.ok, true);
  const noRay = await tunnelServingCheck('https://app.acme.dev/', { fetchImpl: fakeFetch(response(502, { body: 'bad gateway' })) }).run();
  assert.equal(noRay.ok, false);
  const unreachable = await tunnelServingCheck('https://app.acme.dev/', { fetchImpl: async () => { throw new Error('ENOTFOUND'); } }).run();
  assert.equal(unreachable.ok, false);
});

test('statusCheck, readbackCheck, poolHealthyCheck and tcpOpenCheck', async () => {
  assert.equal((await statusCheck('https://a.dev/x', 404, { fetchImpl: fakeFetch(response(404)) }).run()).ok, true);
  assert.equal((await statusCheck('https://a.dev/x', 404, { fetchImpl: fakeFetch(response(200)) }).run()).ok, false);

  const post = { id: NEW, name: 'wiki', created_at: 'x', rules: [{ a: 1, b: 2 }] };
  assert.equal((await readbackCheck(post, { name: 'wiki', rules: [{ a: 1 }] }, []).run()).ok, true);
  const differs = await readbackCheck(post, { name: 'wiki2' }, []).run();
  assert.equal(differs.ok, false);
  assert.match(differs.detail, /name/);
  assert.equal((await readbackCheck(post, { name: 'wiki', traffic: 'x' }, ['traffic']).run()).ok, true);
  assert.equal((await readbackCheck(null, { name: 'wiki' }, []).run()).ok, false);
  assert.equal(readbackCheck(post, {}, []).once, true);

  const pool = (popHealth) => ({ async request(method, path) { assert.equal(method, 'GET'); assert.equal(path, `${BASE}/load_balancers/pools/p1/health`); return { pop_health: popHealth }; } });
  assert.equal((await poolHealthyCheck(pool({ ams: { healthy: true } }), `${BASE}/load_balancers/pools/p1`).run()).ok, true);
  const sick = await poolHealthyCheck(pool({ ams: { healthy: true }, fra: { healthy: false } }), `${BASE}/load_balancers/pools/p1`).run();
  assert.equal(sick.ok, false);
  assert.match(sick.detail, /fra/);
  assert.equal((await poolHealthyCheck(pool({}), `${BASE}/load_balancers/pools/p1`).run()).ok, false);
  // The flattened shape of the API reference example: { healthy, origins } on pop_health itself.
  const flat = (healthy) => pool({ healthy, origins: [{ ip: { healthy, failure_reason: 'No failure reasons', response_code: 200, rtt: '201.5ms' } }] });
  assert.equal((await poolHealthyCheck(flat(true), `${BASE}/load_balancers/pools/p1`).run()).ok, true);
  const flatSick = await poolHealthyCheck(flat(false), `${BASE}/load_balancers/pools/p1`).run();
  assert.equal(flatSick.ok, false);
  assert.match(flatSick.detail, /unhealthy/);

  const opened = [];
  const connect = async (host, port, timeoutMs) => { opened.push([host, port, timeoutMs]); };
  assert.equal((await tcpOpenCheck('ssh.acme.dev', 22, { connect }).run()).ok, true);
  assert.deepEqual(opened, [['ssh.acme.dev', 22, 5000]]);
  const refused = await tcpOpenCheck('ssh.acme.dev', 22, { connect: async () => { throw new Error('ECONNREFUSED'); } }).run();
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /ECONNREFUSED/);
});

test('op.verify status:404 overrides nothing and adds a check', async () => {
  const entry = VX.kinds[0];
  moduleChecks = () => [passing('readback')];
  const op = { ...appCreate, verify: { expect: 'status:404', url: 'https://wiki.acme.dev/gone' } };
  const checks = opVerifyChecks(op, entry, VX, {}, { id: NEW }, { id: NEW }, { fetchImpl: fakeFetch(response(404)) });
  assert.deepEqual(checks.map((c) => c.name), ['readback', 'status:404 https://wiki.acme.dev/gone']);
  assert.equal((await checks[1].run()).ok, true);

  const tcp = opVerifyChecks({ ...appCreate, verify: { expect: 'tcp_open', url: 'https://ssh.acme.dev:2222/' } }, entry, VX, {}, {}, null, {
    connect: async (host, port) => assert.deepEqual([host, port], ['ssh.acme.dev', 2222]),
  });
  assert.equal((await tcp.at(-1).run()).ok, true);
  const login = opVerifyChecks({ ...appCreate, verify: { expect: 'access_login', url: 'https://wiki.acme.dev/' } }, entry, VX, { auth_domain: 'acme.cloudflareaccess.com' }, {}, null, {
    fetchImpl: fakeFetch(response(302, { location: 'https://other.cloudflareaccess.com/' })),
  });
  assert.equal((await login.at(-1).run()).ok, false, 'the ctx team domain is used');
});

test('failed check sets applied_verify_failed and creates a rollback draft named in the plan', async (t) => {
  const { cwd, plan } = setup(t, [appCreate]);
  approve(cwd, plan);
  moduleChecks = () => [passing(), failing()];
  const clock = fakeClock();
  const client = fakeClient(createRoutes);
  const applied = await applyPlan(cwd, client, plan.id, T0, { env: {}, sleep: clock.sleep, clock: clock.now });
  assert.equal(applied.status, 'applied_verify_failed');
  assert.equal(applied.results[0].id, NEW);
  assert.deepEqual(applied.results[0].verify, {
    ok: false,
    checks: [{ name: 'readback', ok: true, detail: 'ok' }, { name: 'login', ok: false, detail: 'got 200' }],
  });
  assert.equal(clock.t, 60000);
  assert.equal(typeof applied.rollback_draft, 'string');
  const draft = readPlan(cwd, applied.rollback_draft);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.rollback_of, plan.id);
  assert.deepEqual(draft.ops.map((op) => [op.method, op.path]), [['DELETE', `${BASE}/vx/apps/${NEW}`]]);
  assert.equal(readPlan(cwd, plan.id).rollback_draft, draft.id);
  // The module saw the apply-time preflight ctx, the result and the post state.
  assert.deepEqual(seen[0].ctx, { auth_domain: 'acme.cloudflareaccess.com' });
  assert.equal(seen[0].result.id, NEW);
  assert.equal(seen[0].post.name, 'wiki');
});

test('passing checks keep status applied and create no draft', async (t) => {
  const { cwd, plan } = setup(t, [appCreate]);
  approve(cwd, plan);
  moduleChecks = () => [passing()];
  const clock = fakeClock();
  const applied = await applyPlan(cwd, fakeClient(createRoutes), plan.id, T0, { env: {}, sleep: clock.sleep, clock: clock.now });
  assert.equal(applied.status, 'applied');
  assert.deepEqual(applied.results[0].verify, { ok: true, checks: [{ name: 'readback', ok: true, detail: 'ok' }] });
  assert.equal(applied.rollback_draft, undefined);
  assert.equal(clock.t, 0);
});

test('partially_applied stays partially_applied when a check fails, the draft is still created', async (t) => {
  const { cwd, plan } = setup(t, [appCreate, appUpdate]);
  approve(cwd, plan);
  moduleChecks = () => [failing()];
  const clock = fakeClock();
  const client = fakeClient({
    ...createRoutes,
    [`GET ${BASE}/vx/apps/${ID}`]: { id: ID, name: 'old' },
    [`PUT ${BASE}/vx/apps/${ID}`]: () => { throw new CfError('rate_limit', 'Too many requests', { status: 429 }); },
  });
  const applied = await applyPlan(cwd, client, plan.id, T0, { env: {}, sleep: clock.sleep, clock: clock.now });
  assert.equal(applied.status, 'partially_applied');
  assert.equal(applied.results[0].verify.ok, false);
  assert.equal(applied.results[1], null);
  assert.equal(seen.length, 1, 'ops that did not run are not verified');
  assert.equal(readPlan(cwd, applied.rollback_draft).rollback_of, plan.id);
});

test('a rollback draft that cannot be built is recorded as rollback_draft_error', async (t) => {
  const SECRET = 'verify-s3cr3t-value';
  const op = { method: 'PUT', path: `${BASE}/vx/apps/${ID}`, body: { name: 'wiki2' }, secret_fields_from_env: { token: 'VX_TOKEN' } };
  const { cwd, plan } = setup(t, [op]);
  approve(cwd, plan);
  moduleChecks = () => [failing()];
  const clock = fakeClock();
  const client = fakeClient({
    [`GET ${BASE}/vx/apps/${ID}`]: { id: ID, name: 'old' },
    [`PUT ${BASE}/vx/apps/${ID}`]: { id: ID, name: 'wiki2' },
  });
  // Removing the snapshot makes createRollbackPlan throw snapshot_missing.
  const { snapshotFile } = await import('../scripts/lib/apply.mjs');
  const realRequest = client.request;
  client.request = async (method, path, opts) => {
    const out = await realRequest(method, path, opts);
    if (method === 'PUT') rmSync(snapshotFile(cwd, readPlan(cwd, plan.id)), { force: true });
    return out;
  };
  const applied = await applyPlan(cwd, client, plan.id, T0, { env: { VX_TOKEN: SECRET }, sleep: clock.sleep, clock: clock.now });
  assert.equal(applied.status, 'applied_verify_failed');
  assert.equal(applied.rollback_draft, undefined);
  assert.match(applied.rollback_draft_error, /snapshot_missing/);
  assert.equal(applied.results[0].verify.ok, false);
});

test('failed check on a rollback plan creates no draft', async (t) => {
  const { cwd, plan } = setup(t, [appCreate]);
  approve(cwd, plan);
  const clock = fakeClock();
  const routes = { ...createRoutes, [`DELETE ${BASE}/vx/apps/${NEW}`]: null };
  const applied = await applyPlan(cwd, fakeClient(routes), plan.id, T0, { env: {}, sleep: clock.sleep, clock: clock.now });
  assert.equal(applied.status, 'applied');

  const rollback = createRollbackPlan(cwd, plan.id, T0);
  approve(cwd, rollback);
  moduleChecks = (op, entry, ctx) => [{ name: 'gone', run: async () => ({ ok: false, detail: `still there ${JSON.stringify(ctx)}` }) }];
  const rolled = await applyPlan(cwd, fakeClient(routes), rollback.id, T0, { env: {}, sleep: clock.sleep, clock: clock.now });
  assert.equal(rolled.status, 'applied_verify_failed');
  assert.equal(rolled.results[0].verify.ok, false);
  assert.equal(rolled.results[0].verify.checks[0].detail, 'still there {}', 'rollback plans verify with an empty ctx');
  assert.equal(rolled.rollback_draft, undefined);
  assert.equal(rolled.results[0].value, true, 'a DELETE result without a body is kept as { value, verify }');
  // Every rollback op ran, so the source counts as rolled back.
  assert.equal(readPlan(cwd, plan.id).status, 'rolled_back');
  assert.throws(() => createRollbackPlan(cwd, rollback.id, T0), (err) => err.code === 'not_applied' && /rollback of a rollback/.test(err.message));
});

test('verification never undoes anything (no write requests after the last op)', async (t) => {
  const { cwd, plan } = setup(t, [appCreate]);
  approve(cwd, plan);
  moduleChecks = (op, entry, ctx, result, post, deps) => [
    { name: 'api', run: async () => { await deps.client.request('GET', `${BASE}/vx/apps/${NEW}`); return { ok: false, detail: 'no' }; } },
  ];
  const clock = fakeClock();
  const client = fakeClient(createRoutes);
  const fetchImpl = fakeFetch(response(200));
  const applied = await applyPlan(cwd, client, plan.id, T0, {
    env: {}, sleep: clock.sleep, clock: clock.now, fetchImpl,
  });
  assert.equal(applied.status, 'applied_verify_failed');
  const lastWrite = client.calls.findLastIndex((c) => c.method !== 'GET');
  assert.equal(client.calls[lastWrite].method, 'POST');
  assert.equal(client.calls.filter((c) => c.method !== 'GET').length, 1);
  assert.ok(client.calls.length > lastWrite + 2, 'checks read after the op');
  assert.equal(readPlan(cwd, applied.rollback_draft).status, 'draft');
});

test('plans without product ops get no verification', async (t) => {
  const { cwd } = setup(t, [appCreate]);
  const zonePlan = createPlan(cwd, {
    zone_id: 'a'.repeat(32), zone_name: 'acme.dev', summary: 'ssl', risk: 'low', slug: 'ssl',
    ops: [{ method: 'PATCH', path: `/zones/${'a'.repeat(32)}/settings/ssl`, body: { value: 'strict' } }],
  }, T0);
  approve(cwd, zonePlan);
  moduleChecks = () => [failing()];
  const client = fakeClient({
    [`GET /zones/${'a'.repeat(32)}/settings/ssl`]: { id: 'ssl', value: 'full' },
    [`PATCH /zones/${'a'.repeat(32)}/settings/ssl`]: { id: 'ssl', value: 'strict' },
  });
  const applied = await applyPlan(cwd, client, zonePlan.id, T0, { env: {} });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.results[0].verify, undefined);
  assert.equal(seen.length, 0);
});

test('a draft whose lockout analysis fails carries a could-not-run lockout line', async (t) => {
  const SECRET = 'lockout-s3cr3t-value';
  const op = { ...appUpdate, secret_fields_from_env: { token: 'VX_TOKEN' } };
  const { cwd, plan } = setup(t, [op]);
  approve(cwd, plan);
  moduleChecks = () => [failing()];
  const clock = fakeClock();
  const client = fakeClient({
    [`GET ${BASE}/vx/apps/${ID}`]: { id: ID, name: 'old' },
    [`PUT ${BASE}/vx/apps/${ID}`]: { id: ID, name: 'wiki2' },
  });
  const addLockout = async () => { throw new CfError('internal', `analysis exploded near ${SECRET}`); };
  const applied = await applyPlan(cwd, client, plan.id, T0, { env: { VX_TOKEN: SECRET }, sleep: clock.sleep, clock: clock.now, addLockout });
  assert.equal(applied.status, 'applied_verify_failed');
  const draft = readPlan(cwd, applied.rollback_draft);
  const line = 'Lockout risk: lockout analysis could not run (internal: analysis exploded near [REDACTED]); review the ops before approving.';
  assert.deepEqual(draft.lockout_risks, [line]);
  assert.equal(draft.risk.split('\n').at(-1), line);
  assert.match(applied.rollback_draft_error, /lockout analysis of draft .* could not run: internal: analysis exploded near \[REDACTED\]/);
  assert.equal(JSON.stringify([applied, draft]).includes(SECRET), false);
});

test('an array result survives verification and still rolls back', async (t) => {
  const LIST = '11111111-4e5f-6789-abcd-ef0123456789';
  const path = `${BASE}/vx/lists/${LIST}`;
  const { cwd, plan } = setup(t, [{ method: 'PUT', path, body: [{ address: '10.0.0.0/8' }] }]);
  approve(cwd, plan);
  moduleChecks = () => [failing()];
  const clock = fakeClock();
  const client = fakeClient({
    [`GET ${path}`]: [{ address: '192.168.0.0/16' }],
    [`PUT ${path}`]: [{ address: '10.0.0.0/8' }],
  });
  const applied = await applyPlan(cwd, client, plan.id, T0, { env: {}, sleep: clock.sleep, clock: clock.now });
  assert.equal(applied.status, 'applied_verify_failed');
  assert.deepEqual(applied.results[0].value, [{ address: '10.0.0.0/8' }]);
  assert.equal(applied.results[0].verify.ok, false);
  assert.equal(applied.rollback_draft_error, undefined, applied.rollback_draft_error);
  const draft = readPlan(cwd, applied.rollback_draft);
  assert.deepEqual(draft.ops.map((o) => [o.method, o.path, o.body]), [['PUT', path, [{ address: '192.168.0.0/16' }]]]);
  assert.deepEqual(inverseSaw.at(-1), [{ address: '10.0.0.0/8' }], 'the rollback inverse sees the original array, not the wrapper');
});
