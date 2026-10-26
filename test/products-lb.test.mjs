import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPlan, createRollbackPlan, withIrreversibleRisk } from '../scripts/lib/apply.mjs';
import { createPlan, readPlan, updatePlan } from '../scripts/lib/plans.mjs';
import { writeApproval } from '../scripts/lib/approvals.mjs';
import { baseFor, classifyProductOp } from '../scripts/lib/products/index.mjs';
import { validateOpTargets } from '../scripts/lib/resources.mjs';
import { runProductPreflight } from '../scripts/lib/product-preflight.mjs';
import { isAllowedCall } from '../hooks/lib/allowed-call.mjs';
import { CfError } from '../scripts/lib/errors.mjs';

const A = '0123456789abcdef0123456789abcdef';
const Z = 'fedcba9876543210fedcba9876543210';
const ACC = `/accounts/${A}`;
const ZB = `/zones/${Z}`;
const LBA = `${ACC}/load_balancers`;
const ACCOUNT = { scope: 'account', account_id: A };
const ZONE = { scope: 'zone', zone_id: Z };
const T0 = new Date('2026-10-26T10:00:00Z');
const T1 = new Date('2026-10-26T10:05:00Z');

const M1 = 'a0000000000000000000000000000001';
const M2 = 'a0000000000000000000000000000002';
const NEW_MONITOR = 'a00000000000000000000000000000ff';
const P1 = 'b0000000000000000000000000000001';
const P2 = 'b0000000000000000000000000000002';
const P3 = 'b0000000000000000000000000000003';
const NEW_POOL = 'b00000000000000000000000000000ff';
const LB1 = 'c0000000000000000000000000000001';
const LB2 = 'c0000000000000000000000000000002';
const NEW_LB = 'c00000000000000000000000000000ff';
const PREVIEW = 'f1aba936b94213e5b8dca0c0dbf1f9cc';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/api/lb/${name}.json`, import.meta.url), 'utf8'));
const HEALTHY = fx('pool-health');

// In-memory account and zone built from the recorded responses. health(path,
// n) answers the n-th health read (default: the recorded healthy pools);
// previewResult is what GET .../preview/<id> returns.
function fakeApi({ deny = [], refs = fx('references'), health = () => structuredClone(HEALTHY), previewResult = fx('preview-result'), notEntitled = false } = {}) {
  const store = new Map();
  store.set(ZB, fx('zone'));
  for (const m of fx('monitors')) store.set(`${LBA}/monitors/${m.id}`, structuredClone(m));
  for (const p of fx('pools')) store.set(`${LBA}/pools/${p.id}`, structuredClone(p));
  for (const lb of fx('load-balancers')) store.set(`${ZB}/load_balancers/${lb.id}`, structuredClone(lb));
  const under = (prefix) => () => [...store.entries()].filter(([k]) => new RegExp(`^${prefix}/[0-9a-f]{32}$`).test(k)).map(([, v]) => v);
  const collections = { [`${LBA}/pools`]: under(`${LBA}/pools`), [`${LBA}/monitors`]: under(`${LBA}/monitors`), [`${ZB}/load_balancers`]: under(`${ZB}/load_balancers`) };
  const newIds = { [`${LBA}/pools`]: NEW_POOL, [`${LBA}/monitors`]: NEW_MONITOR, [`${ZB}/load_balancers`]: NEW_LB };
  const created = {};
  const calls = [];
  const healthReads = [];
  const missing = (path) => new CfError('not_found', `Not found: ${path}`, { status: 404 });
  const page = (all, opts) => {
    if (!opts.envelope) return structuredClone(all);
    const n = Number(opts.query?.page ?? 1);
    const per = Number(opts.query?.per_page ?? 50);
    return { result: structuredClone(all.slice((n - 1) * per, n * per)), result_info: { page: n, per_page: per, total_pages: Math.max(1, Math.ceil(all.length / per)) } };
  };
  return {
    store,
    calls,
    healthReads,
    writes: () => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`),
    async request(method, path, opts = {}) {
      calls.push({ method, path, query: opts.query, body: structuredClone(opts.body) });
      if (deny.some((prefix) => path.startsWith(prefix))) throw new CfError('permission', `Forbidden: ${path}`, { status: 403 });
      if (notEntitled && path.includes('/load_balancers')) throw new CfError('plan', 'Load Balancing is not entitled on this account');
      let m = /\/(?:pools|monitors)\/([0-9a-f]{32})\/references$/.exec(path);
      if (m && method === 'GET') return structuredClone(refs[m[1]] ?? []);
      m = /\/pools\/([0-9a-f]{32})\/health$/.exec(path);
      if (m && method === 'GET') {
        healthReads.push(path);
        return health(path, healthReads.length);
      }
      m = /\/pools\/([0-9a-f]{32})\/preview$/.exec(path);
      if (m && method === 'POST') return { ...fx('preview-start'), pools: { [m[1]]: store.get(`${LBA}/pools/${m[1]}`)?.name } };
      if (method === 'GET' && path === `${LBA}/preview/${PREVIEW}`) return structuredClone(previewResult);
      if (method === 'GET' && collections[path]) return page(collections[path](), opts);
      if (method === 'GET') {
        if (!store.has(path)) throw missing(path);
        return structuredClone(store.get(path));
      }
      if (method === 'POST' && newIds[path]) {
        // The first create gets the NEW_* id, later ones ...f1, ...f2.
        const n = (created[path] = (created[path] ?? 0) + 1);
        const id = n === 1 ? newIds[path] : `${newIds[path].slice(0, 30)}f${n - 1}`;
        const next = { ...structuredClone(opts.body), id, created_on: '2026-10-26T10:00:00Z', modified_on: '2026-10-26T10:00:00Z' };
        store.set(`${path}/${id}`, next);
        return structuredClone(next);
      }
      if (method === 'DELETE') {
        if (!store.has(path)) throw missing(path);
        store.delete(path);
        return { id: path.split('/').pop() };
      }
      if (method === 'PUT') {
        const old = store.get(path);
        if (!old) throw missing(path);
        const next = { ...structuredClone(opts.body), id: old.id, created_on: old.created_on, modified_on: '2026-10-26T10:00:01Z' };
        store.set(path, next);
        return structuredClone(next);
      }
      throw new CfError('api', `unexpected ${method} ${path}`);
    },
  };
}

// Captured once: a test may call setup twice, and its after hooks run in
// registration order.
const ORIGINAL_KEY_DIR = process.env.CLAUDEFLARE_KEY_DIR;

function setup(t, ops, { zone = false, ...fields } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'claudeflare-lb-'));
  const keyDir = mkdtempSync(join(tmpdir(), 'claudeflare-lbkey-'));
  process.env.CLAUDEFLARE_KEY_DIR = keyDir;
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
    if (ORIGINAL_KEY_DIR === undefined) delete process.env.CLAUDEFLARE_KEY_DIR;
    else process.env.CLAUDEFLARE_KEY_DIR = ORIGINAL_KEY_DIR;
  });
  const target = zone
    ? { zone_id: Z, zone_name: 'example.com' }
    : { scope: 'account', account_id: A, account_name: 'Acme' };
  const plan = createPlan(cwd, { ...target, summary: 'Load Balancing', risk: 'low', ops, slug: 'lb' }, T0);
  return { cwd, plan: updatePlan(cwd, plan.id, { slug: 'lb', lockout_risks: [], ...fields }) };
}

const approve = (cwd, plan, now = T0) => writeApproval(cwd, { plan_id: plan.id, session_id: 's1' }, now);

// Verification runs without waiting: each clock read is 10 s later, so a
// failing check gets several tries inside the 60 s window.
function fastVerify() {
  let now = 0;
  return { sleep: async () => {}, clock: () => (now += 10000) };
}

const pool = (id) => structuredClone(fx('pools').find((p) => p.id === id));
const poolBody = (id, change = {}) => {
  const { id: _id, created_on: _c, modified_on: _m, ...body } = pool(id);
  return { ...body, ...change };
};
const lbBody = (id, change = {}) => {
  const { id: _id, created_on: _c, modified_on: _m, ...body } = structuredClone(fx('load-balancers').find((lb) => lb.id === id));
  return { ...body, ...change };
};
const monitorBody = (change = {}) => ({ type: 'https', description: 'Health page', path: '/healthz', interval: 60, ...change });

const createMonitor = (body = monitorBody()) => ({ method: 'POST', path: `${LBA}/monitors`, body });
const updateMonitor = (id, body = monitorBody()) => ({ method: 'PUT', path: `${LBA}/monitors/${id}`, body });
const deleteMonitor = (id, name) => ({ method: 'DELETE', path: `${LBA}/monitors/${id}`, confirm_name: name });
const createPool = (body) => ({ method: 'POST', path: `${LBA}/pools`, body });
const updatePool = (id, body) => ({ method: 'PUT', path: `${LBA}/pools/${id}`, body });
const deletePool = (id, name) => ({ method: 'DELETE', path: `${LBA}/pools/${id}`, confirm_name: name });
const createLb = (body) => ({ method: 'POST', path: `${ZB}/load_balancers`, body });
const updateLb = (id, body) => ({ method: 'PUT', path: `${ZB}/load_balancers/${id}`, body });
const deleteLb = (id, name) => ({ method: 'DELETE', path: `${ZB}/load_balancers/${id}`, confirm_name: name });

const allOff = (id) => poolBody(id, { origins: pool(id).origins.map((o) => ({ ...o, enabled: false })) });
const newPool = (change = {}) => ({ name: 'web-canary', monitor: M1, origins: [{ name: 'canary-1', address: '203.0.113.40', enabled: true }], ...change });

const preflight = (api, plan, ops) => runProductPreflight(api, plan, ops);
const failed = (report) => report.checks.filter((c) => !c.ok);

test('every Load Balancing kind classifies in its own scope with its inverse', () => {
  const cases = [
    [ACCOUNT, 'POST', `${LBA}/monitors`, 'lb_monitor_create', 'delete_created'],
    [ACCOUNT, 'PUT', `${LBA}/monitors/${M1}`, 'lb_monitor_update', 'put_before'],
    [ACCOUNT, 'DELETE', `${LBA}/monitors/${M1}`, 'lb_monitor_delete', 'recreate'],
    [ACCOUNT, 'POST', `${LBA}/pools`, 'lb_pool_create', 'delete_created'],
    [ACCOUNT, 'PUT', `${LBA}/pools/${P1}`, 'lb_pool_update', 'put_before'],
    [ACCOUNT, 'DELETE', `${LBA}/pools/${P1}`, 'lb_pool_delete', 'recreate'],
    [ZONE, 'POST', `${ZB}/load_balancers`, 'lb_create', 'delete_created'],
    [ZONE, 'PUT', `${ZB}/load_balancers/${LB1}`, 'lb_update', 'put_before'],
    [ZONE, 'DELETE', `${ZB}/load_balancers/${LB1}`, 'lb_delete', 'recreate'],
  ];
  for (const [plan, method, path, kind, inverse] of cases) {
    const c = classifyProductOp({ method, path }, plan);
    assert.ok(c, `${method} ${path} is not classified`);
    assert.equal(c.entry.kind, kind);
    assert.equal(c.module.product, 'load_balancing');
    assert.equal(c.base, baseFor(plan));
    assert.equal(c.entry.inverse, inverse, kind);
    assert.equal(c.entry.destructive, kind.endsWith('_delete'), kind);
    if (kind.endsWith('_delete') && kind !== 'lb_monitor_delete') assert.equal(c.entry.nameField, 'name', kind);
    if (kind === 'lb_monitor_delete') {
      assert.equal(c.entry.nameField({ id: M1, description: 'Login page monitor' }), 'Login page monitor');
      assert.equal(c.entry.nameField({ id: M1, description: '' }), M1);
    }
  }
  assert.equal(baseFor(ZONE), ZB);
  // A kind never matches in the other scope.
  assert.equal(classifyProductOp({ method: 'PUT', path: `${ZB}/load_balancers/pools/${P1}` }, ZONE), null);
  assert.equal(classifyProductOp({ method: 'POST', path: `${ACC}/load_balancers` }, ACCOUNT), null);
  // Not product kinds: PATCH, the preview and the user-level forms.
  for (const [plan, method, path] of [
    [ACCOUNT, 'PATCH', `${LBA}/pools/${P1}`],
    [ACCOUNT, 'PATCH', `${LBA}/monitors/${M1}`],
    [ACCOUNT, 'POST', `${LBA}/pools/${P1}/preview`],
    [ACCOUNT, 'POST', `${LBA}/monitors/${M1}/preview`],
  ]) {
    assert.equal(classifyProductOp({ method, path }, plan), null, `${method} ${path}`);
    assert.throws(() => validateOpTargets([{ method, path, body: {} }], plan), { code: 'invalid_op' }, `${method} ${path}`);
  }
});

test('a plan never mixes scopes; zone load balancer paths are accepted where zone Access paths are not', () => {
  validateOpTargets([updateLb(LB1, lbBody(LB1)), createLb(lbBody(LB1, { name: 'shop.example.com' }))], ZONE);
  validateOpTargets([updatePool(P1, poolBody(P1)), createMonitor()], ACCOUNT);
  // An account op and a zone op in one plan: refused in either scope.
  assert.throws(() => validateOpTargets([updatePool(P1, poolBody(P1)), updateLb(LB1, lbBody(LB1))], ACCOUNT), (e) => e.code === 'invalid_op' && /Op 1/.test(e.message));
  assert.throws(() => validateOpTargets([updateLb(LB1, lbBody(LB1)), updatePool(P1, poolBody(P1))], ZONE), (e) => e.code === 'invalid_op' && /Op 1/.test(e.message) && new RegExp(ZB).test(e.message));
  assert.throws(() => validateOpTargets([{ method: 'POST', path: `${ZB}/access/apps`, body: {} }], ZONE), (e) => e.code === 'invalid_op' && /account form/.test(e.message));
});

test('monitor, pool and load balancer bodies are validated (invalid_op)', () => {
  validateOpTargets([createMonitor(), updateMonitor(M1, monitorBody({ type: 'tcp', port: 8443 })), createPool(newPool()), updatePool(P1, poolBody(P1, { monitor: null }))], ACCOUNT);
  const bad = [
    createMonitor('nope'),
    createMonitor(monitorBody({ type: 'ftp' })),
    updateMonitor(M1, monitorBody({ interval: '60' })),
    updateMonitor(M1, monitorBody({ id: M1 })),
    createPool(newPool({ name: '' })),
    createPool(newPool({ origins: [] })),
    createPool(newPool({ origins: [{ name: 'x' }] })),
    createPool(newPool({ origins: [{ address: '192.0.2.1', weight: 2 }] })),
    createPool(newPool({ origins: [{ address: '192.0.2.1', enabled: 'yes' }] })),
    updatePool(P1, poolBody(P1, { minimum_origins: 0 })),
    updatePool(P1, poolBody(P1, { monitor: 'monitor-1' })),
    updatePool(P1, poolBody(P1, { disabled_at: '2026-10-01T00:00:00Z' })),
  ];
  for (const op of bad) assert.throws(() => validateOpTargets([op], ACCOUNT), { code: 'invalid_op' }, JSON.stringify(op));
  validateOpTargets([createLb(lbBody(LB1, { name: 'shop.example.com' }))], ZONE);
  for (const op of [
    createLb(lbBody(LB1, { default_pools: [] })),
    createLb(lbBody(LB1, { fallback_pool: undefined })),
    updateLb(LB1, lbBody(LB1, { name: '' })),
    updateLb(LB1, lbBody(LB1, { default_pools: ['pool-a'] })),
    updateLb(LB1, lbBody(LB1, { created_on: 'x' })),
  ]) {
    assert.throws(() => validateOpTargets([op], ZONE), { code: 'invalid_op' }, JSON.stringify(op));
  }
});

test('no add-on is not_entitled; a 403 names the permission of the scope', async () => {
  for (const [plan, op] of [[ACCOUNT, createMonitor()], [ZONE, updateLb(LB1, lbBody(LB1))]]) {
    const report = await preflight(fakeApi({ notEntitled: true }), plan, [op]);
    const ent = report.checks.find((c) => c.name === 'entitlement');
    assert.equal(ent.ok, false, JSON.stringify(report.checks));
    assert.equal(ent.code, 'not_entitled');
    assert.match(ent.detail, /paid add-on/);
  }
  const zoneProbe = await preflight(fakeApi({ deny: [`${ZB}/load_balancers`] }), ZONE, [updateLb(LB1, lbBody(LB1))]);
  const zoneFail = failed(zoneProbe)[0];
  assert.equal(zoneFail.code, 'missing_permission');
  assert.match(zoneFail.detail, /Load Balancers/);
  const poolRead = await preflight(fakeApi({ deny: [`${LBA}/pools`] }), ACCOUNT, [updatePool(P1, poolBody(P1))]);
  assert.equal(failed(poolRead)[0].code, 'missing_permission');
  assert.match(failed(poolRead)[0].detail, /Load Balancing: Monitors and Pools Read/);
  const probe = await preflight(fakeApi({ deny: [`${LBA}/monitors`] }), ACCOUNT, [createMonitor()]);
  assert.equal(probe.checks.find((c) => c.name === 'permission').code, 'missing_permission');
  assert.match(probe.checks.find((c) => c.name === 'permission').detail, /Load Balancing: Monitors and Pools Edit/);
});

test('a pool or monitor delete with references is refused (resource_in_use)', async () => {
  const used = await preflight(fakeApi(), ACCOUNT, [deletePool(P2, 'web-backup')]);
  const dep = used.checks.find((c) => c.name === 'dependencies');
  assert.equal(dep?.ok, false, JSON.stringify(used.checks));
  assert.equal(dep.code, 'resource_in_use');
  assert.match(dep.detail, /load balancer www\.example\.com/);
  const monitor = await preflight(fakeApi(), ACCOUNT, [deleteMonitor(M1, 'Login page monitor')]);
  assert.equal(monitor.checks.find((c) => c.name === 'dependencies').code, 'resource_in_use');
  assert.match(monitor.checks.find((c) => c.name === 'dependencies').detail, /pool web-primary.*pool web-backup/);
  // Free: no referrer, or only a referral (the pool's own monitor).
  assert.deepEqual(failed(await preflight(fakeApi(), ACCOUNT, [deleteMonitor(M2, 'Unused TCP probe')])), []);
  const referralOnly = { ...fx('references'), [P2]: fx('references')[P2].filter((r) => r.reference_type === 'referral') };
  assert.deepEqual(failed(await preflight(fakeApi({ refs: referralOnly }), ACCOUNT, [deletePool(P2, 'web-backup')])), []);
  // Pools this plan deletes or moves to another monitor first no longer hold the monitor.
  const freed = { ...referralOnly, [P1]: [] };
  const ops = [updatePool(P1, poolBody(P1, { monitor: M2 })), deletePool(P2, 'web-backup'), deleteMonitor(M1, 'Login page monitor')];
  assert.deepEqual(failed(await preflight(fakeApi({ refs: freed }), ACCOUNT, ops)), []);
  assert.equal((await preflight(fakeApi({ refs: freed }), ACCOUNT, [deleteMonitor(M1, 'Login page monitor'), deletePool(P2, 'web-backup')])).checks.find((c) => c.name === 'dependencies').code, 'resource_in_use');
});

test('disabling every origin, minimum_origins above the enabled ones, or the last usable pool of a load balancer is a Lockout risk line', async () => {
  const off = await preflight(fakeApi(), ACCOUNT, [updatePool(P1, allOff(P1))]);
  assert.deepEqual(failed(off), []);
  assert.equal(off.lockout_risks.length, 1, JSON.stringify(off.lockout_risks));
  assert.match(off.lockout_risks[0], /^Lockout risk: pool web-primary .*no enabled origin.*critical; load balancers www\.example\.com use it/);
  const min = await preflight(fakeApi(), ACCOUNT, [updatePool(P1, poolBody(P1, { minimum_origins: 3 }))]);
  assert.equal(min.lockout_risks.length, 1);
  assert.match(min.lockout_risks[0], /^Lockout risk: pool web-primary .*minimum_origins 3 above its 2 enabled/);
  // api-pool is the only pool of api.example.com: disabling it strands the load balancer.
  const last = await preflight(fakeApi(), ACCOUNT, [updatePool(P3, poolBody(P3, { enabled: false }))]);
  assert.equal(last.lockout_risks.length, 1, JSON.stringify(last.lockout_risks));
  assert.match(last.lockout_risks[0], /^Lockout risk: pool api-pool .*last usable pool of load balancer api\.example\.com/);
  // www.example.com keeps web-backup.
  assert.deepEqual((await preflight(fakeApi(), ACCOUNT, [updatePool(P1, poolBody(P1, { enabled: false }))])).lockout_risks, []);
  // Disabling both pools of www.example.com in one plan strands it.
  const both = await preflight(fakeApi(), ACCOUNT, [updatePool(P1, poolBody(P1, { enabled: false })), updatePool(P2, allOff(P2))]);
  assert.ok(both.lockout_risks.some((l) => /pool web-backup .*last usable pool of load balancer www\.example\.com/.test(l)), JSON.stringify(both.lockout_risks));
  assert.deepEqual((await preflight(fakeApi(), ACCOUNT, [updatePool(P1, poolBody(P1, { description: 'renamed' }))])).lockout_risks, []);
});

test('a load balancer with no usable pool, or whose only pool is critical in preview, is a Lockout risk line', async () => {
  const api = fakeApi();
  api.store.set(`${LBA}/pools/${P3}`, { ...pool(P3), enabled: false });
  const dead = await preflight(api, ZONE, [updateLb(LB2, lbBody(LB2, { ttl: 60 }))]);
  assert.deepEqual(failed(dead), []);
  assert.equal(dead.lockout_risks.length, 1, JSON.stringify(dead.lockout_risks));
  assert.match(dead.lockout_risks[0], /^Lockout risk: load balancer api\.example\.com would have no usable pool: api-pool/);
  // One pool, previewed critical (P1 is new to the load balancer here).
  const only = await preflight(fakeApi(), ZONE, [createLb(lbBody(LB1, { name: 'shop.example.com', default_pools: [P1], fallback_pool: P1 }))]);
  assert.equal(only.lockout_risks.length, 1, JSON.stringify(only.lockout_risks));
  assert.match(only.lockout_risks[0], /^Lockout risk: load balancer shop\.example\.com has one pool, web-primary .*preview found it critical;/);
  const healthy = { [P1]: { healthy: true, origins: [] } };
  assert.deepEqual((await preflight(fakeApi({ previewResult: healthy }), ZONE, [createLb(lbBody(LB1, { name: 'shop.example.com', default_pools: [P1], fallback_pool: P1 }))])).lockout_risks, []);
  // Two pools: a critical preview is a note, not a lockout line.
  assert.deepEqual((await preflight(fakeApi(), ZONE, [createLb(lbBody(LB1, { name: 'shop.example.com' }))])).lockout_risks, []);
});

test('preflight previews new or changed pools by POST to the preview path only, and records the result in ctx and the notes', async () => {
  const api = fakeApi();
  const op = updatePool(P1, poolBody(P1, { description: 'tuned' }));
  const report = await preflight(api, ACCOUNT, [op]);
  assert.deepEqual(failed(report), []);
  assert.deepEqual(api.writes(), [`POST ${LBA}/pools/${P1}/preview`]);
  const sent = api.calls.find((c) => c.method === 'POST').body;
  assert.equal(sent.path, '/health');
  for (const field of ['id', 'created_on', 'modified_on']) assert.ok(!(field in sent), field);
  assert.equal(report.ctx.load_balancing.preview[P1].healthy, false);
  assert.match(withIrreversibleRisk('x', [op], ACCOUNT, report.ctx), /Pool web-primary .*preview found it critical \(TCP connection failed\)/);
  // The zone plan previews the pools a load balancer write adds, through the zone's account.
  const zoneApi = fakeApi();
  const zoneOp = updateLb(LB1, lbBody(LB1, { default_pools: [P1, P2, P3] }));
  const zoneReport = await preflight(zoneApi, ZONE, [zoneOp]);
  assert.deepEqual(zoneApi.writes(), [], 'api-pool has no monitor, so nothing is previewed');
  assert.match(withIrreversibleRisk('x', [zoneOp], ZONE, zoneReport.ctx), /Pool api-pool .*preview skipped: the pool has no monitor/);
  // The agent cannot send it through MCP execute.
  assert.equal(isAllowedCall({ method: 'POST', path: `${LBA}/pools/${P1}/preview` }), false);
  assert.equal(isAllowedCall({ method: 'POST', path: `/client/v4${LBA}/monitors/${M1}/preview` }), false);
  assert.equal(isAllowedCall({ method: 'GET', path: `${LBA}/preview/${PREVIEW}` }), true);
});

test('a preview the token cannot run degrades to a note and never blocks the plan', async () => {
  const api = fakeApi({ deny: [`${LBA}/pools/${P1}/preview`] });
  const op = updatePool(P1, poolBody(P1, { description: 'tuned' }));
  const report = await preflight(api, ACCOUNT, [op]);
  assert.deepEqual(failed(report), []);
  assert.deepEqual(report.lockout_risks, []);
  assert.match(withIrreversibleRisk('x', [op], ACCOUNT, report.ctx), /Pool web-primary .*preview skipped: the token cannot run it; it needs "Load Balancing: Monitors and Pools Edit"/);
  const pending = await preflight(fakeApi({ previewResult: {} }), ACCOUNT, [op]);
  assert.match(withIrreversibleRisk('x', [op], ACCOUNT, pending.ctx), /preview skipped: no result yet/);
  assert.match(withIrreversibleRisk('x', [createPool(newPool())], ACCOUNT, {}), /preview skipped: a pool has no id until apply/);
});

test('verify waits for the pool to report Healthy, and fails after the timeout', async (t) => {
  const op = updatePool(P1, poolBody(P1, { description: 'tuned' }));
  // No data on the first two reads, healthy on the third.
  const slow = fakeApi({ previewResult: {}, health: (path, n) => (n < 3 ? { pool_id: P1, pop_health: {} } : structuredClone(HEALTHY)) });
  const { cwd, plan } = setup(t, [op]);
  approve(cwd, plan);
  const applied = await applyPlan(cwd, slow, plan.id, T0, fastVerify());
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  const checks = applied.results[0].verify.checks;
  assert.deepEqual(checks.map((c) => c.name), ['readback', `pool_healthy ${LBA}/pools/${P1}`]);
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
  assert.equal(slow.healthReads.length, 3);

  const sick = fakeApi({ previewResult: {}, health: () => ({ pool_id: P1, pop_health: { 'Amsterdam, NL': { healthy: false, origins: [] } } }) });
  const second = setup(t, [op]);
  approve(second.cwd, second.plan);
  const bad = await applyPlan(second.cwd, sick, second.plan.id, T0, fastVerify());
  assert.equal(bad.status, 'applied_verify_failed');
  assert.match(bad.results[0].verify.checks[1].detail, /unhealthy from Amsterdam, NL/);
  assert.ok(sick.healthReads.length > 1);
  assert.ok(readPlan(second.cwd, second.plan.id).rollback_draft);
});

test('no Healthy wait that can only fail: no monitor, every origin off, or a critical preview is skipped', async (t) => {
  const { LOAD_BALANCING } = await import('../scripts/lib/products/load-balancing.mjs');
  const run = async (op, post, ctx = {}) => {
    const { entry } = classifyProductOp(op, ACCOUNT);
    const checks = LOAD_BALANCING.verifyChecks(op, entry, ctx, post, post, { client: fakeApi(), readPath: `${LBA}/pools/${NEW_POOL}` });
    return Promise.all(checks.map(async (c) => ({ name: c.name, once: c.once === true, ...(await c.run()) })));
  };
  const noMonitor = await run(createPool(newPool({ monitor: null })), { ...newPool({ monitor: null }), id: NEW_POOL });
  assert.equal(noMonitor[1].ok, true);
  assert.equal(noMonitor[1].once, true);
  assert.match(noMonitor[1].detail, /^skipped: the pool has no monitor/);
  const off = await run(updatePool(P1, allOff(P1)), allOff(P1));
  assert.match(off[1].detail, /^skipped: every origin is disabled/);
  const predicted = await run(updatePool(P1, poolBody(P1)), poolBody(P1), { preview: { [P1]: { healthy: false, reasons: [] } } });
  assert.match(predicted[1].detail, /^skipped: the preflight preview found the pool critical/);
  // Monitors and deletes: read-back only, or nothing.
  assert.deepEqual((await run(updateMonitor(M1), monitorBody())).map((c) => c.name), ['readback']);
  assert.deepEqual(await run(deletePool(P1, 'web-primary'), null), []);

  // A new pool without a monitor applies with every check passing.
  const api = fakeApi();
  const { cwd, plan } = setup(t, [createPool(newPool({ monitor: null }))]);
  approve(cwd, plan);
  const applied = await applyPlan(cwd, api, plan.id, T0, fastVerify());
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  assert.equal(api.healthReads.length, 0);
});

test('account rollbacks: pool update restores with a drift baseline, pool and monitor creates are deleted, a monitor delete is re-created', async (t) => {
  const api = fakeApi({ previewResult: {} });
  const ops = [updatePool(P1, poolBody(P1, { description: 'tuned', origins: [pool(P1).origins[0]] })), createMonitor(), deleteMonitor(M2, 'Unused TCP probe')];
  const { cwd, plan } = setup(t, ops);
  approve(cwd, plan);
  const applied = await applyPlan(cwd, api, plan.id, T0, fastVerify());
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  const rollback = createRollbackPlan(cwd, plan.id, T1);
  assert.deepEqual(rollback.ops.map((o) => `${o.method} ${o.path}`), [`POST ${LBA}/monitors`, `DELETE ${LBA}/monitors/${NEW_MONITOR}`, `PUT ${LBA}/pools/${P1}`]);
  const [recreate, del, restore] = rollback.ops;
  assert.equal(recreate.body.description, 'Unused TCP probe');
  assert.ok(!('id' in recreate.body));
  assert.deepEqual(recreate.precheck.expect, { absent: true });
  assert.equal(del.precheck.read, `${LBA}/monitors/${NEW_MONITOR}`);
  assert.equal(restore.precheck.read, `${LBA}/pools/${P1}`);
  for (const field of ['id', 'created_on', 'modified_on']) {
    assert.ok(!(field in restore.body), field);
    assert.ok(!(field in restore.precheck.expect), field);
  }
  assert.equal(restore.body.origins.length, 2);
  assert.match(rollback.risk, /Restores/);
  approve(cwd, rollback, T1);
  const ran = await applyPlan(cwd, api, rollback.id, T1, fastVerify());
  assert.equal(ran.status, 'applied', JSON.stringify(ran.results));
  assert.equal(api.store.get(`${LBA}/pools/${P1}`).origins.length, 2);
  assert.ok(!api.store.has(`${LBA}/monitors/${NEW_MONITOR}`));

  // A hand edit of the pool after apply: its restore is skipped with rollback_drift.
  const second = setup(t, [updatePool(P1, poolBody(P1, { description: 'tuned' }))]);
  const api2 = fakeApi({ previewResult: {} });
  approve(second.cwd, second.plan);
  assert.equal((await applyPlan(second.cwd, api2, second.plan.id, T0, fastVerify())).status, 'applied');
  api2.store.set(`${LBA}/pools/${P1}`, { ...api2.store.get(`${LBA}/pools/${P1}`), description: 'edited by hand' });
  const back = createRollbackPlan(second.cwd, second.plan.id, T1);
  approve(second.cwd, back, T1);
  const skipped = await applyPlan(second.cwd, api2, back.id, T1, fastVerify());
  assert.equal(skipped.status, 'partially_applied');
  assert.equal(skipped.results[0].reason, 'rollback_drift');
});

test('zone plans: a load balancer delete names the hostname, rolls back by re-creating it, and an update rolls back with PUT', async (t) => {
  const api = fakeApi();
  const del = deleteLb(LB2, 'api.example.com');
  const report = await preflight(api, ZONE, [del]);
  assert.deepEqual(failed(report), []);
  assert.match(withIrreversibleRisk('x', [del], ZONE, report.ctx), /api\.example\.com stops resolving through the load balancer.*new id/);
  const { cwd, plan } = setup(t, [del], { zone: true });
  approve(cwd, plan);
  const applied = await applyPlan(cwd, api, plan.id, T0, fastVerify());
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  assert.ok(!api.store.has(`${ZB}/load_balancers/${LB2}`));
  const rollback = createRollbackPlan(cwd, plan.id, T1);
  assert.deepEqual(rollback.ops.map((o) => `${o.method} ${o.path}`), [`POST ${ZB}/load_balancers`]);
  assert.equal(rollback.ops[0].body.name, 'api.example.com');
  assert.ok(!('id' in rollback.ops[0].body));
  approve(cwd, rollback, T1);
  const ran = await applyPlan(cwd, api, rollback.id, T1, fastVerify());
  assert.equal(ran.status, 'applied', JSON.stringify(ran.results));
  assert.equal(api.store.get(`${ZB}/load_balancers/${NEW_LB}`).name, 'api.example.com');

  // A wrong confirm_name stops the delete at preflight.
  const wrong = await preflight(fakeApi(), ZONE, [deleteLb(LB2, 'www.example.com')]);
  assert.equal(wrong.checks.find((c) => c.name === 'confirm_name').ok, false);

  const update = updateLb(LB1, lbBody(LB1, { ttl: 60 }));
  const zoneApi = fakeApi();
  const second = setup(t, [update], { zone: true });
  approve(second.cwd, second.plan);
  const run = await applyPlan(second.cwd, zoneApi, second.plan.id, T0, fastVerify());
  assert.equal(run.status, 'applied', JSON.stringify(run.results));
  assert.deepEqual(run.results[0].verify.checks.map((c) => c.name), ['readback']);
  const back = createRollbackPlan(second.cwd, second.plan.id, T1);
  assert.deepEqual(back.ops.map((o) => `${o.method} ${o.path}`), [`PUT ${ZB}/load_balancers/${LB1}`]);
  assert.equal(back.ops[0].body.ttl, 30);
  assert.equal(back.ops[0].precheck.read, `${ZB}/load_balancers/${LB1}`);
  approve(second.cwd, back, T1);
  assert.equal((await applyPlan(second.cwd, zoneApi, back.id, T1, fastVerify())).status, 'applied');
  assert.equal(zoneApi.store.get(`${ZB}/load_balancers/${LB1}`).ttl, 30);
});

// Fix round 1

test('Ruling 27: a preview-only lockout line found at apply is advisory and does not stop apply', async (t) => {
  const op = createLb(lbBody(LB1, { name: 'shop.example.com', default_pools: [P1], fallback_pool: P1 }));
  // Plan new: the preview has no result yet, so no line.
  const atPlan = await preflight(fakeApi({ previewResult: {} }), ZONE, [op]);
  assert.deepEqual(atPlan.lockout_risks, []);
  const { cwd, plan } = setup(t, [op], { zone: true, lockout_risks: atPlan.lockout_risks });
  approve(cwd, plan);
  // Apply: the preview now finds P1 critical.
  const api = fakeApi();
  const fresh = await preflight(fakeApi(), ZONE, [op]);
  assert.equal(fresh.lockout_risks.length, 1);
  assert.deepEqual(fresh.advisory_lockout, fresh.lockout_risks);
  assert.ok(!/TCP connection failed/.test(fresh.lockout_risks[0]), 'failure reasons stay in the note');
  const applied = await applyPlan(cwd, api, plan.id, T0, fastVerify());
  assert.equal(applied.status, 'applied', JSON.stringify(applied));
  assert.ok(api.store.has(`${ZB}/load_balancers/${NEW_LB}`));

  // A new line that does not rest on the preview still stops apply.
  const dead = updateLb(LB2, lbBody(LB2, { ttl: 60 }));
  const second = setup(t, [dead], { zone: true, lockout_risks: [] });
  approve(second.cwd, second.plan);
  const api2 = fakeApi();
  api2.store.set(`${LBA}/pools/${P3}`, { ...pool(P3), enabled: false });
  await assert.rejects(() => applyPlan(second.cwd, api2, second.plan.id, T0, fastVerify()), (e) => e.code === 'risk_changed' && /no usable pool/.test(e.message));
  assert.deepEqual(api2.writes(), []);
});

test('Ruling 26: a zone write on a load balancer path with a method no kind takes is refused; other zone writes stay open', () => {
  for (const op of [
    { method: 'PATCH', path: `${ZB}/load_balancers/${LB1}`, body: { ttl: 60 } },
    { method: 'PUT', path: `${ZB}/load_balancers`, body: {} },
    { method: 'POST', path: `${ZB}/load_balancers/${LB1}`, body: {} },
  ]) {
    assert.throws(() => validateOpTargets([op], ZONE), (e) => e.code === 'invalid_op' && /load_balancing module/.test(e.message), `${op.method} ${op.path}`);
  }
  assert.throws(() => validateOpTargets([{ method: 'PATCH', path: `${ZB}/load_balancers/${LB1}`, body: {} }], ZONE), /use PUT or DELETE/);
  validateOpTargets([
    { method: 'POST', path: `${ZB}/dns_records`, body: {} },
    { method: 'PATCH', path: `${ZB}/settings/ssl`, body: { value: 'strict' } },
    { method: 'PATCH', path: `${ZB}/load_balancers_custom/x`, body: {} },
    { method: 'GET', path: `${ZB}/load_balancers/${LB1}` },
  ], ZONE);
});

test('Ruling 28: a monitor without a description is confirmed by its id; preview ids and a monitorless PUT are handled', async () => {
  const api = fakeApi();
  api.store.set(`${LBA}/monitors/${M2}`, { ...api.store.get(`${LBA}/monitors/${M2}`), description: '' });
  const byId = await preflight(api, ACCOUNT, [deleteMonitor(M2, M2)]);
  assert.deepEqual(failed(byId), []);
  const wrong = await preflight(api, ACCOUNT, [deleteMonitor(M2, '')]);
  assert.equal(failed(wrong)[0]?.name, 'confirm_name');
  // With a description, the description is the name.
  assert.deepEqual(failed(await preflight(fakeApi(), ACCOUNT, [deleteMonitor(M2, 'Unused TCP probe')])), []);
  assert.equal(failed(await preflight(fakeApi(), ACCOUNT, [deleteMonitor(M2, M2)]))[0]?.name, 'confirm_name');

  // A PUT without monitor leaves the pool without one: no preview is sent.
  const { monitor: _m, ...noMonitor } = poolBody(P1);
  const plain = fakeApi();
  const report = await preflight(plain, ACCOUNT, [updatePool(P1, noMonitor)]);
  assert.deepEqual(plain.writes(), []);
  assert.match(report.ctx.load_balancing.preview[P1].skipped, /no monitor/);
  // A stored monitor id that is not 32 hex never reaches a path.
  const odd = fakeApi();
  odd.store.set(`${LBA}/pools/${P3}`, { ...pool(P3), monitor: '../x' });
  const zoneReport = await preflight(odd, ZONE, [updateLb(LB2, lbBody(LB2, { ttl: 60 }))]);
  assert.match(zoneReport.ctx.load_balancing.preview[P3].skipped, /not 32 hex/);
  assert.ok(!odd.calls.some((c) => c.path.includes('../x')));
});
