import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPlan, createRollbackPlan, withIrreversibleRisk } from '../scripts/lib/apply.mjs';
import { createPlan, updatePlan } from '../scripts/lib/plans.mjs';
import { writeApproval } from '../scripts/lib/approvals.mjs';
import { classifyProductOp } from '../scripts/lib/products/index.mjs';
import { validateOpTargets, validatePlanOps } from '../scripts/lib/resources.mjs';
import { runProductPreflight } from '../scripts/lib/product-preflight.mjs';
import { CfError } from '../scripts/lib/errors.mjs';

const A = '0123456789abcdef0123456789abcdef';
const BASE = `/accounts/${A}`;
const T1 = '11111111-2222-4333-8444-555555555551';
const NEW = '11111111-2222-4333-8444-555555555552';
const R1 = '22222222-2222-4333-8444-555555555551';
const V1 = '33333333-2222-4333-8444-555555555551';
const V_DEFAULT = '33333333-2222-4333-8444-555555555552';
const PLAN = { scope: 'account', account_id: A };
const T0 = new Date('2026-10-26T10:00:00Z');
const T1_TIME = new Date('2026-10-26T10:05:00Z');

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/api/tunnel/${name}.json`, import.meta.url), 'utf8'));
const CREATED = fx('tunnel-create');
const TOKEN = CREATED.token;
const TUNNEL_SECRET = CREATED.credentials_file.TunnelSecret;

// In-memory account built from the recorded responses. Lists page by
// page/per_page like the API; dns_records filter by type and content.
function fakeApi({ zones = fx('zones'), cnames = fx('dns-cnames'), config = fx('configurations') } = {}) {
  const store = new Map([
    [`${BASE}/cfd_tunnel/${T1}`, fx('tunnel')],
    [`${BASE}/cfd_tunnel/${T1}/configurations`, config],
    [`${BASE}/cfd_tunnel/${T1}/connections`, fx('connections')],
    ...fx('routes').map((r) => [`${BASE}/teamnet/routes/${r.id}`, r]),
    ...fx('virtual-networks').map((v) => [`${BASE}/teamnet/virtual_networks/${v.id}`, v]),
  ]);
  const lists = new Map([
    ['/zones', zones],
    [`${BASE}/cfd_tunnel`, [fx('tunnel')]],
    [`${BASE}/teamnet/routes`, fx('routes')],
    [`${BASE}/teamnet/virtual_networks`, fx('virtual-networks')],
  ]);
  for (const zone of zones) lists.set(`/zones/${zone.id}/dns_records`, cnames.filter((r) => r.zone_id === zone.id));
  const calls = [];
  const missing = (path) => new CfError('not_found', `Not found: ${path}`, { status: 404 });
  return {
    store,
    calls,
    writes: () => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`),
    async request(method, path, opts = {}) {
      calls.push({ method, path, query: opts.query, body: structuredClone(opts.body) });
      if (method === 'GET' && lists.has(path)) {
        const q = opts.query ?? {};
        let items = lists.get(path);
        if (q.type) items = items.filter((r) => r.type === q.type);
        if (q.content) items = items.filter((r) => r.content === q.content);
        if (!opts.envelope) return structuredClone(items);
        const page = Number(q.page ?? 1);
        const per = Number(q.per_page ?? 50);
        return {
          result: structuredClone(items.slice((page - 1) * per, page * per)),
          result_info: { page, per_page: per, total_pages: Math.max(1, Math.ceil(items.length / per)) },
        };
      }
      if (method === 'GET') {
        if (!store.has(path)) throw missing(path);
        return structuredClone(store.get(path));
      }
      if (method === 'POST' && path === `${BASE}/cfd_tunnel`) {
        const { token, credentials_file, ...tunnel } = structuredClone(CREATED);
        store.set(`${path}/${NEW}`, tunnel);
        store.set(`${path}/${NEW}/connections`, []);
        return structuredClone(CREATED);
      }
      if (method === 'DELETE') {
        if (path.endsWith('/connections')) {
          store.set(path, []);
          return null;
        }
        if (!store.has(path)) throw missing(path);
        store.delete(path);
        return null;
      }
      const old = store.get(path);
      if (!old) throw missing(path);
      const next = method === 'PUT' ? { ...old, version: old.version + 1, config: opts.body.config } : { ...old, ...opts.body };
      store.set(path, next);
      return structuredClone(next);
    },
  };
}

// Captured once: a test may call setup twice, and its after hooks run in
// registration order, so restoring a per-call value could point the env at a
// temp dir that is already deleted.
const ORIGINAL_KEY_DIR = process.env.CLAUDEFLARE_KEY_DIR;

function setup(t, ops, fields = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'claudeflare-tunnel-'));
  const keyDir = mkdtempSync(join(tmpdir(), 'claudeflare-tunnelkey-'));
  process.env.CLAUDEFLARE_KEY_DIR = keyDir;
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
    if (ORIGINAL_KEY_DIR === undefined) delete process.env.CLAUDEFLARE_KEY_DIR;
    else process.env.CLAUDEFLARE_KEY_DIR = ORIGINAL_KEY_DIR;
  });
  const plan = createPlan(cwd, {
    scope: 'account', account_id: A, account_name: 'Acme', summary: 'Tunnel', risk: 'low', ops, slug: 'tunnel',
  }, T0);
  return { cwd, plan: updatePlan(cwd, plan.id, { slug: 'tunnel', lockout_risks: [], ...fields }) };
}

const approve = (cwd, plan, now = T0) => writeApproval(cwd, { plan_id: plan.id, session_id: 's1' }, now);

// Verification runs without waiting: each clock read is 30 s later.
function fastVerify() {
  let now = 0;
  return { sleep: async () => {}, clock: () => (now += 30000) };
}

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const createOp = { method: 'POST', path: `${BASE}/cfd_tunnel`, body: { name: 'api', config_src: 'cloudflare' } };
const connDelete = (id = T1) => ({ method: 'DELETE', path: `${BASE}/cfd_tunnel/${id}/connections` });
const tunnelDelete = (id = T1, name = 'web') => ({ method: 'DELETE', path: `${BASE}/cfd_tunnel/${id}`, confirm_name: name });
const configOp = (ingress, id = T1) => ({ method: 'PUT', path: `${BASE}/cfd_tunnel/${id}/configurations`, body: { config: { ingress } } });
const rule = (hostname, service = 'http://localhost:3000') => ({ hostname, service });
const CATCH_ALL = { service: 'http_status:404' };

test('every tunnel kind classifies with its inverse', () => {
  const cases = [
    ['POST', '/cfd_tunnel', 'tunnel_create', 'function'],
    ['PATCH', `/cfd_tunnel/${T1}`, 'tunnel_rename', 'patch_before'],
    ['DELETE', `/cfd_tunnel/${T1}`, 'tunnel_delete', 'none'],
    ['PUT', `/cfd_tunnel/${T1}/configurations`, 'tunnel_config_put', 'put_before'],
    ['DELETE', `/cfd_tunnel/${T1}/connections`, 'tunnel_connections_delete', 'none'],
    ['POST', '/teamnet/routes', 'route_create', 'delete_created'],
    ['PATCH', `/teamnet/routes/${R1}`, 'route_update', 'patch_before'],
    ['DELETE', `/teamnet/routes/${R1}`, 'route_delete', 'recreate'],
    ['POST', '/teamnet/virtual_networks', 'vnet_create', 'delete_created'],
    ['PATCH', `/teamnet/virtual_networks/${V1}`, 'vnet_update', 'patch_before'],
    ['DELETE', `/teamnet/virtual_networks/${V1}`, 'vnet_delete', 'recreate'],
  ];
  for (const [method, rest, kind, inverse] of cases) {
    const c = classifyProductOp({ method, path: `${BASE}${rest}` }, PLAN);
    assert.ok(c, `${method} ${rest} is not classified`);
    assert.equal(c.entry.kind, kind);
    assert.equal(c.module.product, 'tunnel');
    assert.equal(typeof c.entry.inverse === 'function' ? 'function' : c.entry.inverse, inverse, kind);
    assert.equal(c.entry.destructive, ['tunnel_delete', 'route_delete', 'vnet_delete'].includes(kind), kind);
  }
  const create = classifyProductOp(createOp, PLAN).entry;
  assert.deepEqual(create.redact, ['token', 'credentials_file', 'tunnel_secret']);
  assert.equal(classifyProductOp(tunnelDelete(), PLAN).entry.nameField, 'name');
  for (const [method, rest] of [
    ['GET', `/cfd_tunnel/${T1}/token`],
    ['PUT', `/cfd_tunnel/${T1}`],
    ['PATCH', `/cfd_tunnel/${T1}/configurations`],
    ['POST', `/cfd_tunnel/${T1}/token`],
    ['DELETE', '/cfd_tunnel'],
  ]) {
    assert.equal(classifyProductOp({ method, path: `${BASE}${rest}` }, PLAN), null, `${method} ${rest}`);
  }
  assert.equal(classifyProductOp(createOp, { scope: 'zone', zone_id: 'fedcba9876543210fedcba9876543210' }), null);
});

test('create body with tunnel_secret, other keys or a local config is invalid_op', () => {
  const refused = [
    { name: 'api', config_src: 'cloudflare', tunnel_secret: TUNNEL_SECRET },
    { name: 'api', config_src: 'local' },
    { name: 'api' },
    { name: 'api', config_src: 'cloudflare', extra: 1 },
    { config_src: 'cloudflare' },
  ];
  for (const body of refused) {
    assert.throws(() => validateOpTargets([{ ...createOp, body }], PLAN), (e) => {
      assert.equal(e.code, 'invalid_op');
      assert.ok(!e.message.includes(TUNNEL_SECRET), 'message echoes the secret');
      return true;
    }, JSON.stringify(Object.keys(body)));
  }
  assert.throws(() => validateOpTargets([{ ...createOp, body: refused[0] }], PLAN), /tunnel_secret/);
  validateOpTargets([createOp], PLAN);
});

test('rename takes only name; tunnel_secret is refused', () => {
  const rename = (body) => [{ method: 'PATCH', path: `${BASE}/cfd_tunnel/${T1}`, body }];
  validateOpTargets(rename({ name: 'web-2' }), PLAN);
  assert.throws(() => validateOpTargets(rename({ name: 'web-2', tunnel_secret: TUNNEL_SECRET }), PLAN), (e) => e.code === 'invalid_op' && /tunnel_secret/.test(e.message) && !e.message.includes(TUNNEL_SECRET));
  assert.throws(() => validateOpTargets(rename({ tunnel_secret: TUNNEL_SECRET }), PLAN), { code: 'invalid_op' });
  assert.throws(() => validateOpTargets(rename({}), PLAN), { code: 'invalid_op' });
});

test('config without a catch-all last rule, or a rule without service, is invalid_op', () => {
  validateOpTargets([configOp([rule('app.example.com'), CATCH_ALL])], PLAN);
  for (const ingress of [
    [rule('app.example.com')],
    [rule('app.example.com'), { path: '/static', service: 'http://localhost:9000' }],
    [{ hostname: 'app.example.com' }, CATCH_ALL],
    [rule('app.example.com'), {}],
    [],
  ]) {
    assert.throws(() => validateOpTargets([configOp(ingress)], PLAN), { code: 'invalid_op' }, JSON.stringify(ingress));
  }
  assert.throws(() => validateOpTargets([{ ...configOp([CATCH_ALL]), body: { ingress: [CATCH_ALL] } }], PLAN), { code: 'invalid_op' });
  assert.throws(() => validateOpTargets([configOp([rule('app.example.com')])], PLAN), /catch-all/);
});

test('tunnel delete needs an earlier connections delete; config PUT and delete conflict', () => {
  assert.throws(() => validatePlanOps([tunnelDelete()], PLAN), (e) => e.code === 'plan_conflict' && /connections/.test(e.message));
  assert.throws(() => validatePlanOps([tunnelDelete(), connDelete()], PLAN), { code: 'plan_conflict' });
  assert.throws(() => validatePlanOps([connDelete(NEW), tunnelDelete()], PLAN), { code: 'plan_conflict' });
  validatePlanOps([connDelete(), tunnelDelete()], PLAN);
  assert.throws(
    () => validatePlanOps([configOp([CATCH_ALL]), connDelete(), tunnelDelete()], PLAN),
    (e) => e.code === 'plan_conflict' && /configuration/.test(e.message),
  );
  // A config PUT on one tunnel and the delete of another do not conflict.
  validatePlanOps([configOp([CATCH_ALL]), connDelete(NEW), tunnelDelete(NEW, 'api')], PLAN);
});

test('dropping a hostname that still has a CNAME is a Lockout risk line', async () => {
  const api = fakeApi();
  const dropped = await runProductPreflight(api, PLAN, [configOp([rule('app.example.com'), CATCH_ALL])]);
  assert.deepEqual(dropped.checks.filter((c) => !c.ok), []);
  assert.equal(dropped.lockout_risks.length, 1);
  assert.match(dropped.lockout_risks[0], /^Lockout risk: /);
  assert.match(dropped.lockout_risks[0], /wiki\.example\.com/);
  assert.doesNotMatch(dropped.lockout_risks[0], /app\.example\.com/);
  const kept = await runProductPreflight(api, PLAN, [configOp([rule('app.example.com'), rule('*.example.com'), CATCH_ALL])]);
  assert.deepEqual(kept.lockout_risks, []);
});

test('a CNAME hostname with no rule before or after is still a Lockout risk line (it will 404)', async () => {
  const config = { ...fx('configurations'), config: { ingress: [rule('app.example.com'), CATCH_ALL] } };
  const report = await runProductPreflight(fakeApi({ config }), PLAN, [configOp([rule('app.example.com'), rule('api.example.com'), CATCH_ALL])]);
  assert.equal(report.lockout_risks.length, 1);
  assert.match(report.lockout_risks[0], /^Lockout risk: .*still has no rule for wiki\.example\.com.*404/);
  assert.doesNotMatch(report.lockout_risks[0], /app\.example\.com/);
});

test('a path rule does not serve the whole host: dropping the full rule is a Lockout risk line', async () => {
  const ingress = [rule('app.example.com'), { hostname: 'wiki.example.com', path: '/docs', service: 'http://localhost:8080' }, CATCH_ALL];
  const report = await runProductPreflight(fakeApi(), PLAN, [configOp(ingress)]);
  assert.equal(report.lockout_risks.length, 1);
  assert.match(report.lockout_risks[0], /drops wiki\.example\.com/);
});

test('config note suggests a DNS op for a new hostname without a CNAME', async () => {
  const ops = [configOp([rule('app.example.com'), rule('wiki.example.com'), rule('api.example.com'), CATCH_ALL])];
  const report = await runProductPreflight(fakeApi(), PLAN, ops);
  const risk = withIrreversibleRisk('Tunnel config', ops, PLAN, report.ctx);
  assert.match(risk, /api\.example\.com/);
  assert.match(risk, new RegExp(`${T1}\\.cfargotunnel\\.com`));
  assert.doesNotMatch(risk, /app\.example\.com has no CNAME/);
});

test('delete note names each CNAME hostname that will return 1016, across zone pages', async () => {
  // 60 zones: the CNAMEs sit in zone 56, past the first page of 50.
  const zones = Array.from({ length: 60 }, (_, i) => ({ id: `fedcba9876543210fedcba98765${String(43210 + i)}`, name: `z${i}.example`, account: { id: A } }));
  const cnames = fx('dns-cnames').map((r) => ({ ...r, zone_id: zones[55].id }));
  const ops = [connDelete(), tunnelDelete()];
  const report = await runProductPreflight(fakeApi({ zones, cnames }), PLAN, ops);
  assert.deepEqual(report.checks.filter((c) => !c.ok), []);
  const risk = withIrreversibleRisk('Delete tunnel web', ops, PLAN, report.ctx);
  assert.match(risk, /1016/);
  assert.match(risk, /app\.example\.com/);
  assert.match(risk, /wiki\.example\.com/);
  // Active connectors from gather, by count and id.
  assert.match(risk, /1 active connector\(s\) \(55555555-2222-4333-8444-555555555551\)/);
  assert.match(risk, new RegExp(`Not reversible: DELETE ${BASE}/cfd_tunnel/${T1}\\b`));
});

test('delete with a wrong confirm_name fails preflight', async () => {
  const report = await runProductPreflight(fakeApi(), PLAN, [connDelete(), tunnelDelete(T1, 'nope')]);
  assert.equal(report.checks.find((c) => c.name === 'confirm_name')?.ok, false);
});

test('virtual network delete is refused while routes use it or when it is the default', async () => {
  const vnetDelete = (id, name) => ({ method: 'DELETE', path: `${BASE}/teamnet/virtual_networks/${id}`, confirm_name: name });
  const routeDelete = { method: 'DELETE', path: `${BASE}/teamnet/routes/${R1}`, confirm_name: '10.0.0.0/24' };
  const used = await runProductPreflight(fakeApi(), PLAN, [vnetDelete(V1, 'office')]);
  const dep = used.checks.find((c) => c.name === 'dependencies');
  assert.equal(dep.ok, false);
  assert.equal(dep.code, 'resource_in_use');
  assert.match(dep.detail, /10\.0\.0\.0\/24/);
  const cleared = await runProductPreflight(fakeApi(), PLAN, [routeDelete, vnetDelete(V1, 'office')]);
  assert.deepEqual(cleared.checks.filter((c) => !c.ok), []);
  const late = await runProductPreflight(fakeApi(), PLAN, [vnetDelete(V1, 'office'), routeDelete]);
  assert.equal(late.checks.find((c) => c.name === 'dependencies').code, 'resource_in_use');
  const def = await runProductPreflight(fakeApi(), PLAN, [vnetDelete(V_DEFAULT, 'default')]);
  assert.match(def.checks.find((c) => c.name === 'dependencies').detail, /default/);
});

test('create: token and credentials never reach results, plan, snapshot, post or rollback files', async (t) => {
  const { cwd, plan } = setup(t, [createOp]);
  const api = fakeApi();
  approve(cwd, plan);
  const fetchImpl = async () => {
    throw new Error('no fetch expected for a create');
  };
  const applied = await applyPlan(cwd, api, plan.id, T0, { fetchImpl, ...fastVerify() });
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  assert.equal(applied.results[0].id, NEW);
  // credentials_file repeats the name; a name is an identifier, not a secret to scrub.
  assert.equal(applied.results[0].name, 'api');
  assert.equal(applied.results[0].token, '[redacted]');
  assert.equal(applied.results[0].credentials_file, '[redacted]');
  assert.equal(applied.results[0].verify.ok, true);
  const rollback = createRollbackPlan(cwd, plan.id, T1_TIME);
  const texts = [JSON.stringify(applied), JSON.stringify(rollback), ...filesUnder(cwd).map((f) => readFileSync(f, 'utf8'))];
  for (const text of texts) {
    assert.ok(!text.includes(TOKEN), 'token leaked');
    assert.ok(!text.includes(TUNNEL_SECRET), 'tunnel secret leaked');
  }
});

test('rollback of a create deletes connections, then the tunnel, as one group', async (t) => {
  const { cwd, plan } = setup(t, [createOp]);
  const api = fakeApi();
  approve(cwd, plan);
  await applyPlan(cwd, api, plan.id, T0, fastVerify());
  // A connector came up after apply: status and connections are not drift.
  api.store.set(`${BASE}/cfd_tunnel/${NEW}`, { ...api.store.get(`${BASE}/cfd_tunnel/${NEW}`), status: 'healthy', connections: [{ id: 'x' }] });
  const rollback = createRollbackPlan(cwd, plan.id, T1_TIME);
  assert.deepEqual(rollback.ops.map((op) => `${op.method} ${op.path}`), [
    `DELETE ${BASE}/cfd_tunnel/${NEW}/connections`,
    `DELETE ${BASE}/cfd_tunnel/${NEW}`,
  ]);
  assert.equal(rollback.ops[0].precheck.read, `${BASE}/cfd_tunnel/${NEW}`);
  assert.deepEqual(rollback.ops.map((op) => op.precheck.group), [`tunnel:${NEW}`, `tunnel:${NEW}`]);
  assert.ok(rollback.ops.every((op) => !('group' in op)));
  approve(cwd, rollback, T1_TIME);
  api.calls.length = 0;
  const ran = await applyPlan(cwd, api, rollback.id, T1_TIME, fastVerify());
  assert.equal(ran.status, 'applied', JSON.stringify(ran.results));
  assert.deepEqual(api.writes(), [`DELETE ${BASE}/cfd_tunnel/${NEW}/connections`, `DELETE ${BASE}/cfd_tunnel/${NEW}`]);
  assert.equal(api.store.has(`${BASE}/cfd_tunnel/${NEW}`), false);
});

test('rollback of a create skips both deletes when the tunnel was renamed after apply', async (t) => {
  const { cwd, plan } = setup(t, [createOp]);
  const api = fakeApi();
  approve(cwd, plan);
  await applyPlan(cwd, api, plan.id, T0, fastVerify());
  api.store.set(`${BASE}/cfd_tunnel/${NEW}`, { ...api.store.get(`${BASE}/cfd_tunnel/${NEW}`), name: 'renamed' });
  const rollback = createRollbackPlan(cwd, plan.id, T1_TIME);
  approve(cwd, rollback, T1_TIME);
  api.calls.length = 0;
  const ran = await applyPlan(cwd, api, rollback.id, T1_TIME, fastVerify());
  assert.equal(ran.status, 'partially_applied');
  assert.deepEqual(api.writes(), []);
  assert.ok(ran.results.every((r) => r.skipped && r.reason === 'rollback_drift'));
});

test('config PUT verify fails on a 1033 body and passes when the hostnames serve', async (t) => {
  const ingress = [rule('app.example.com'), rule('wiki.example.com'), CATCH_ALL];
  const fetched = [];
  const run = async (body, status) => {
    const { cwd, plan } = setup(t, [configOp(ingress)]);
    approve(cwd, plan);
    const fetchImpl = async (url) => {
      fetched.push(url);
      return new Response(body, { status, headers: status === 200 ? { 'cf-ray': '8f00000000000000-FRA' } : {} });
    };
    return applyPlan(cwd, fakeApi(), plan.id, T0, { fetchImpl, ...fastVerify() });
  };
  const broken = await run('<html><title>Cloudflare Tunnel error</title>error code: 1033</html>', 530);
  assert.equal(broken.status, 'applied_verify_failed');
  const checks = broken.results[0].verify.checks;
  assert.deepEqual(checks.map((c) => c.name).sort(), [
    'readback',
    `tunnel_serving https://app.example.com/`,
    `tunnel_serving https://wiki.example.com/`,
    `tunnel_status ${T1}`,
  ]);
  assert.ok(checks.filter((c) => c.name.startsWith('tunnel_serving')).every((c) => !c.ok && /1033/.test(c.detail)));
  assert.ok(checks.find((c) => c.name === 'readback').ok);
  assert.ok(checks.find((c) => c.name === `tunnel_status ${T1}`).ok);
  assert.ok(fetched.includes('https://app.example.com/'));

  const fine = await run('ok', 200);
  assert.equal(fine.status, 'applied');
  assert.ok(fine.results[0].verify.ok);
});

test('config PUT with a new hostname that has no CNAME yet skips its serving check (Ruling 18)', async (t) => {
  const ingress = [rule('app.example.com'), rule('wiki.example.com'), rule('api.example.com'), CATCH_ALL];
  const { cwd, plan } = setup(t, [configOp(ingress)]);
  approve(cwd, plan);
  const fetched = [];
  // The new hostname would answer 1033 (no DNS); the served ones answer.
  const fetchImpl = async (url) => {
    fetched.push(url);
    return url.includes('api.example.com')
      ? new Response('error code: 1033', { status: 530 })
      : new Response('ok', { status: 200, headers: { 'cf-ray': '8f00000000000000-FRA' } });
  };
  const applied = await applyPlan(cwd, fakeApi(), plan.id, T0, { fetchImpl, ...fastVerify() });
  assert.equal(applied.status, 'applied');
  const skip = applied.results[0].verify.checks.find((c) => c.name === 'tunnel_serving https://api.example.com/');
  assert.deepEqual(skip, { name: 'tunnel_serving https://api.example.com/', ok: true, detail: 'skipped: no DNS record yet' });
  assert.ok(!fetched.includes('https://api.example.com/'));
  assert.ok(fetched.includes('https://app.example.com/'));
});

test('rename verify checks status only when the tunnel had connections', async () => {
  const { TUNNEL } = await import('../scripts/lib/products/tunnel.mjs');
  const op = { method: 'PATCH', path: `${BASE}/cfd_tunnel/${T1}`, body: { name: 'web-2' } };
  const { entry } = classifyProductOp(op, PLAN);
  const post = { ...fx('tunnel'), name: 'web-2' };
  const names = (ctx) => TUNNEL.verifyChecks(op, entry, ctx, { id: T1 }, post, {}).map((c) => c.name);
  assert.deepEqual(names({ connectors: { [T1]: 1 } }), ['readback', `tunnel_status ${T1}`]);
  assert.deepEqual(names({ connectors: { [T1]: 0 } }), ['readback']);
  assert.deepEqual(names({}), ['readback']);
  const del = TUNNEL.verifyChecks(tunnelDelete(), classifyProductOp(tunnelDelete(), PLAN).entry, {}, true, null, {});
  assert.deepEqual(del, []);
});
