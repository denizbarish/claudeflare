import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRollbackLockout, applyPlan, createRollbackPlan, withIrreversibleRisk } from '../scripts/lib/apply.mjs';
import { createPlan, readPlan, updatePlan } from '../scripts/lib/plans.mjs';
import { writeApproval } from '../scripts/lib/approvals.mjs';
import { baseFor, classifyProductOp, zoneProductPathOwner } from '../scripts/lib/products/index.mjs';
import { SPECTRUM, appProtocol, zonePlan } from '../scripts/lib/products/spectrum.mjs';
import { validateOpTargets } from '../scripts/lib/resources.mjs';
import { runProductPreflight } from '../scripts/lib/product-preflight.mjs';
import { CfError } from '../scripts/lib/errors.mjs';

const A = '0123456789abcdef0123456789abcdef';
const Z = 'fedcba9876543210fedcba9876543210';
const ZB = `/zones/${Z}`;
const APPS = `${ZB}/spectrum/apps`;
const ZONE = { scope: 'zone', zone_id: Z };
const T0 = new Date('2026-10-26T10:00:00Z');
const T1 = new Date('2026-10-26T10:05:00Z');

const SSH = 'd0000000000000000000000000000001';
const GAME = 'd0000000000000000000000000000002';
const RANGE = 'd0000000000000000000000000000003';
const NEW_APP = 'd00000000000000000000000000000ff';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/api/spectrum/${name}.json`, import.meta.url), 'utf8'));

// In-memory zone built from the recorded responses. plan sets the zone plan's
// legacy_id; extra adds apps after the recorded ones (paging tests).
function fakeApi({ plan = 'enterprise', deny = [], extra = [] } = {}) {
  const store = new Map();
  const zone = fx('zone');
  zone.plan = { ...zone.plan, legacy_id: plan, name: `${plan[0].toUpperCase()}${plan.slice(1)} Website` };
  store.set(ZB, zone);
  for (const app of [...fx('apps'), ...extra]) store.set(`${APPS}/${app.id}`, structuredClone(app));
  const apps = () => [...store.entries()].filter(([k]) => /\/spectrum\/apps\/[0-9a-f]{32}$/.test(k)).map(([, v]) => v);
  const calls = [];
  let created = 0;
  const missing = (path) => new CfError('not_found', `Not found: ${path}`, { status: 404 });
  return {
    store,
    calls,
    writes: () => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`),
    async request(method, path, opts = {}) {
      calls.push({ method, path, query: opts.query, body: structuredClone(opts.body) });
      if (deny.some((prefix) => path.startsWith(prefix))) throw new CfError('permission', `Forbidden: ${path}`, { status: 403 });
      if (method === 'GET' && path === APPS) {
        const all = apps();
        if (!opts.envelope) return structuredClone(all);
        // Spectrum sends result_info only when page is in the query (spec 2).
        if (opts.query?.page === undefined) return { result: structuredClone(all) };
        const n = Number(opts.query.page);
        const per = Number(opts.query.per_page ?? 50);
        return { result: structuredClone(all.slice((n - 1) * per, n * per)), result_info: { page: n, per_page: per, total_pages: Math.max(1, Math.ceil(all.length / per)) } };
      }
      if (method === 'GET') {
        if (!store.has(path)) throw missing(path);
        return structuredClone(store.get(path));
      }
      if (method === 'POST' && path === APPS) {
        // The first create gets NEW_APP, later ones ...f1, ...f2.
        created += 1;
        const id = created === 1 ? NEW_APP : `${NEW_APP.slice(0, 30)}f${created - 1}`;
        const next = { ...structuredClone(opts.body), id, created_on: '2026-10-26T10:00:00Z', modified_on: '2026-10-26T10:00:00Z' };
        store.set(`${APPS}/${id}`, next);
        return structuredClone(next);
      }
      if (method === 'PUT') {
        const old = store.get(path);
        if (!old) throw missing(path);
        const next = { ...structuredClone(opts.body), id: old.id, created_on: old.created_on, modified_on: '2026-10-26T10:00:01Z' };
        store.set(path, next);
        return structuredClone(next);
      }
      if (method === 'DELETE') {
        if (!store.has(path)) throw missing(path);
        store.delete(path);
        return { id: path.split('/').pop() };
      }
      throw new CfError('api', `unexpected ${method} ${path}`);
    },
  };
}

// Captured once: a test may call setup twice, and its after hooks run in
// registration order.
const ORIGINAL_KEY_DIR = process.env.CLAUDEFLARE_KEY_DIR;

function setup(t, ops, fields = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'claudeflare-spectrum-'));
  const keyDir = mkdtempSync(join(tmpdir(), 'claudeflare-spectrumkey-'));
  process.env.CLAUDEFLARE_KEY_DIR = keyDir;
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
    if (ORIGINAL_KEY_DIR === undefined) delete process.env.CLAUDEFLARE_KEY_DIR;
    else process.env.CLAUDEFLARE_KEY_DIR = ORIGINAL_KEY_DIR;
  });
  const plan = createPlan(cwd, { zone_id: Z, zone_name: 'example.com', summary: 'Spectrum', risk: 'low', ops, slug: 'spectrum' }, T0);
  return { cwd, plan: updatePlan(cwd, plan.id, { slug: 'spectrum', lockout_risks: [], ...fields }) };
}

const approve = (cwd, plan, now = T0) => writeApproval(cwd, { plan_id: plan.id, session_id: 's1' }, now);

function fastVerify(extra = {}) {
  let now = 0;
  return { sleep: async () => {}, clock: () => (now += 10000), ...extra };
}

// Records every connect; never opens a socket.
function fakeConnect({ fail = false } = {}) {
  const seen = [];
  const connect = async (host, port) => {
    seen.push(`${host}:${port}`);
    if (fail) throw new Error('ECONNREFUSED');
  };
  return { seen, connect };
}

const app = (id) => structuredClone(fx('apps').find((a) => a.id === id));
const appBody = (id, change = {}) => {
  const { id: _id, created_on: _c, modified_on: _m, ...body } = app(id);
  return { ...body, ...change };
};
// A pay-as-you-go app: only dns, protocol and origin_direct.
const namedBody = (port, name = 'ssh.example.com') => ({ dns: { type: 'CNAME', name }, protocol: `tcp/${port}`, origin_direct: [`tcp://192.0.2.10:${port}`] });
const genericBody = (protocol = 'tcp/22', change = {}) => ({ ...namedBody(22, 'shell.example.com'), protocol, traffic_type: 'direct', proxy_protocol: 'v1', ip_firewall: true, ...change });

const createApp = (body) => ({ method: 'POST', path: APPS, body });
const updateApp = (id, body) => ({ method: 'PUT', path: `${APPS}/${id}`, body });
const deleteApp = (id, name) => ({ method: 'DELETE', path: `${APPS}/${id}`, confirm_name: name });

const preflight = (api, ops) => runProductPreflight(api, ZONE, ops);
const failed = (report) => report.checks.filter((c) => !c.ok);

test('every Spectrum kind classifies on the zone with its inverse; PATCH and the account form do not', () => {
  const cases = [
    ['POST', APPS, 'spectrum_app_create', 'delete_created'],
    ['PUT', `${APPS}/${SSH}`, 'spectrum_app_update', 'put_before'],
    ['DELETE', `${APPS}/${SSH}`, 'spectrum_app_delete', 'recreate'],
  ];
  for (const [method, path, kind, inverse] of cases) {
    const c = classifyProductOp({ method, path }, ZONE);
    assert.ok(c, `${method} ${path} is not classified`);
    assert.equal(c.entry.kind, kind);
    assert.equal(c.module.product, 'spectrum');
    assert.equal(c.base, baseFor(ZONE));
    assert.equal(c.entry.inverse, inverse, kind);
    assert.equal(c.entry.destructive, kind.endsWith('_delete'), kind);
    assert.deepEqual(c.entry.readOnlyFields, ['id', 'created_on', 'modified_on']);
  }
  assert.equal(classifyProductOp({ method: 'DELETE', path: `${APPS}/${SSH}` }, ZONE).entry.nameField, 'dns.name');
  assert.equal(classifyProductOp({ method: 'POST', path: `/accounts/${A}/spectrum/apps` }, { scope: 'account', account_id: A }), null);
  assert.throws(() => validateOpTargets([{ method: 'PATCH', path: `${APPS}/${SSH}`, body: { tls: 'full' } }], ZONE), (e) => e.code === 'invalid_op' && /spectrum module/.test(e.message) && /POST, PUT, DELETE/.test(e.message));
});

test('Spectrum app bodies are validated (invalid_op), messages name fields only', () => {
  validateOpTargets([createApp(namedBody(22)), createApp(genericBody('udp/27015')), updateApp(RANGE, appBody(RANGE)), updateApp(GAME, appBody(GAME))], ZONE);
  const bad = [
    createApp('nope'),
    createApp({ ...namedBody(22), protocol: 'ssh' }),
    createApp({ ...namedBody(22), protocol: 'tcp/70000' }),
    createApp({ ...namedBody(22), protocol: 'TCP/22' }),
    createApp({ ...namedBody(22), protocol: ' tcp/22' }),
    createApp({ ...namedBody(22), protocol: 'tcp/2000-1000' }),
    createApp({ ...namedBody(22), dns: { type: 'CNAME' } }),
    createApp({ ...namedBody(22), dns: { type: 'A', name: 'ssh.example.com' } }),
    createApp({ dns: { name: 'ssh.example.com' }, protocol: 'tcp/22' }),
    createApp({ ...namedBody(22), origin_direct: [] }),
    createApp(genericBody('tcp/22', { proxy_protocol: 'v3' })),
    createApp(genericBody('tcp/22', { tls: 'on' })),
    createApp(genericBody('tcp/22', { traffic_type: 'ftp' })),
    createApp(genericBody('tcp/22', { ip_firewall: 'yes' })),
    createApp(genericBody('tcp/22', { edge_ips: { type: 'anycast' } })),
    updateApp(SSH, appBody(SSH, { id: SSH })),
    updateApp(SSH, appBody(SSH, { modified_on: 'x' })),
  ];
  for (const op of bad) assert.throws(() => validateOpTargets([op], ZONE), { code: 'invalid_op' }, JSON.stringify(op));
  assert.throws(
    () => validateOpTargets([createApp({ ...namedBody(22), dns: { type: 'CNAME', name: '' }, protocol: 'tcp/secret-value' })], ZONE),
    (e) => e.code === 'invalid_op' && !/secret-value/.test(e.message),
  );
});

test('protocol per plan follows the spec 2 table (not_entitled on a mismatch)', async () => {
  const bodies = {
    ssh: namedBody(22),
    minecraft: namedBody(25565, 'mc.example.com'),
    rdp: namedBody(3389, 'rdp.example.com'),
    'generic tcp/22': genericBody('tcp/22'),
    'generic udp': genericBody('udp/27015'),
    'generic range': genericBody('tcp/1000-2000'),
    'ssh port with a generic field': { ...namedBody(22), ip_firewall: true },
  };
  const table = {
    free: [],
    pro: ['ssh', 'minecraft'],
    business: ['ssh', 'minecraft', 'rdp'],
    enterprise: Object.keys(bodies),
  };
  for (const [plan, allowed] of Object.entries(table)) {
    for (const [what, body] of Object.entries(bodies)) {
      const report = await preflight(fakeApi({ plan }), [createApp(body)]);
      const ent = report.checks.find((c) => c.name === 'entitlement');
      if (allowed.includes(what)) {
        assert.equal(ent.ok, true, `${plan} ${what}: ${ent.detail}`);
      } else {
        assert.equal(ent.ok, false, `${plan} ${what} should be refused`);
        assert.equal(ent.code, 'not_entitled', `${plan} ${what}`);
      }
    }
  }
  // The brief's case: a Pro zone with a generic tcp/22 app.
  const pro = await preflight(fakeApi({ plan: 'pro' }), [createApp(genericBody('tcp/22'))]);
  const ent = failed(pro)[0];
  assert.equal(ent.code, 'not_entitled');
  assert.match(ent.detail, /generic tcp\/22 app/);
  assert.match(ent.detail, /Enterprise/);
  // An update is checked the same way; a delete needs only a plan with Spectrum.
  // Updates are named by the port alone (Ruling 30): a non-named port is generic.
  assert.equal(failed(await preflight(fakeApi({ plan: 'business' }), [updateApp(RANGE, appBody(RANGE))]))[0].code, 'not_entitled');
  assert.deepEqual(failed(await preflight(fakeApi({ plan: 'business' }), [updateApp(SSH, appBody(SSH, { ip_firewall: true }))])), []);
  // A body read back from the API lists default values; it is still a named
  // app, so restoring it (put_before, recreate) passes on Pro.
  assert.deepEqual(failed(await preflight(fakeApi({ plan: 'pro' }), [updateApp(SSH, appBody(SSH))])), []);
  assert.equal(appProtocol(appBody(SSH)), 'ssh');
  assert.equal(appProtocol(appBody(SSH, { edge_ips: { type: 'static', ips: ['203.0.113.9'] } })), 'generic');
  assert.equal(appProtocol({ ...namedBody(22), origin_dns: { name: 'origin.example.com' } }), 'generic');
  assert.deepEqual(failed(await preflight(fakeApi({ plan: 'pro' }), [deleteApp(SSH, 'ssh.example.com')])), []);
  assert.equal(failed(await preflight(fakeApi({ plan: 'free' }), [deleteApp(SSH, 'ssh.example.com')]))[0].code, 'not_entitled');
  assert.equal(failed(await preflight(fakeApi({ plan: 'partner' }), [createApp(namedBody(22))]))[0].code, 'not_entitled');
  // Helpers behind the table.
  assert.equal(appProtocol(namedBody(3389)), 'rdp');
  assert.equal(appProtocol(namedBody(2222)), 'generic');
  assert.equal(zonePlan({ plan: { name: 'Business Website' } }), 'business');
  assert.equal(zonePlan({ plan: {} }), null);
});

test('a 403 on the zone or the apps list names the permission', async () => {
  const zoneDenied = failed(await preflight(fakeApi({ deny: [ZB] }), [createApp(namedBody(22))]))[0];
  assert.equal(zoneDenied.code, 'missing_permission');
  assert.match(zoneDenied.detail, /Zone Read/);
  const appsDenied = failed(await preflight(fakeApi({ deny: [APPS] }), [createApp(namedBody(22))]))[0];
  assert.equal(appsDenied.name, 'permission');
  assert.equal(appsDenied.code, 'missing_permission');
  assert.match(appsDenied.detail, /Zone Settings Edit/);
});

test('gather sends page=1 explicitly and reads every page of apps', async () => {
  const extra = Array.from({ length: 60 }, (_, i) => ({ ...app(SSH), id: `e${String(i).padStart(31, '0')}`, dns: { type: 'CNAME', name: `n${i}.example.com` } }));
  const last = extra.at(-1);
  const api = fakeApi({ extra });
  const report = await preflight(api, [deleteApp(last.id, last.dns.name)]);
  assert.deepEqual(failed(report), []);
  const lists = api.calls.filter((c) => c.method === 'GET' && c.path === APPS && c.query);
  assert.equal(lists[0].query.page, 1);
  assert.equal(lists.length, 2);
  assert.equal(report.ctx.spectrum.apps[last.id].name, last.dns.name);
  assert.match(withIrreversibleRisk('x', [deleteApp(last.id, last.dns.name)], ZONE, report.ctx), new RegExp(`Deleting Spectrum app ${last.dns.name.replace('.', '\\.')}`));
});

test('the delete note names the hostname, the new id and new anycast IPs unless edge_ips is static', async () => {
  const report = await preflight(fakeApi(), [deleteApp(SSH, 'ssh.example.com'), deleteApp(GAME, 'game.example.com')]);
  assert.deepEqual(failed(report), []);
  assert.deepEqual(report.lockout_risks, []);
  const risk = withIrreversibleRisk('x', [deleteApp(SSH, 'ssh.example.com')], ZONE, report.ctx);
  assert.match(risk, /Deleting Spectrum app ssh\.example\.com \(d0+1\): Cloudflare stops proxying tcp\/22 traffic for ssh\.example\.com/);
  assert.match(risk, /new id/);
  assert.match(risk, /new anycast IPs/);
  const staticRisk = withIrreversibleRisk('x', [deleteApp(GAME, 'game.example.com')], ZONE, report.ctx);
  assert.match(staticRisk, /new id/);
  assert.match(staticRisk, /edge_ips\.type is static, so the re-created app keeps its IPs/);
  assert.ok(!/new anycast IPs/.test(staticRisk));
  // confirm_name is dns.name.
  const wrong = await preflight(fakeApi(), [deleteApp(SSH, 'ssh')]);
  assert.equal(failed(wrong)[0].name, 'confirm_name');
  assert.equal(failed(wrong)[0].code, 'invalid_op');
});

test('verify: read-back plus a TCP connect to dns.name on the edge port; failure drafts a rollback', async (t) => {
  const net = fakeConnect();
  const { cwd, plan } = setup(t, [createApp(namedBody(22))]);
  approve(cwd, plan);
  const api = fakeApi();
  const applied = await applyPlan(cwd, api, plan.id, T0, fastVerify({ connect: net.connect }));
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  const checks = applied.results[0].verify.checks;
  assert.deepEqual(checks.map((c) => c.name), ['readback', 'tcp_open ssh.example.com:22']);
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
  assert.deepEqual(net.seen, ['ssh.example.com:22']);

  const down = fakeConnect({ fail: true });
  const second = setup(t, [updateApp(SSH, appBody(SSH, { ip_firewall: true }))]);
  approve(second.cwd, second.plan);
  const bad = await applyPlan(second.cwd, fakeApi(), second.plan.id, T0, fastVerify({ connect: down.connect }));
  assert.equal(bad.status, 'applied_verify_failed');
  assert.match(bad.results[0].verify.checks[1].detail, /cannot connect to ssh\.example\.com:22: ECONNREFUSED/);
  assert.ok(down.seen.length > 1, 'the connect is retried within the window');
  assert.ok(readPlan(second.cwd, second.plan.id).rollback_draft);
});

test('verify skips the TCP connect for UDP, a port range or a missing dns.name, with a note', async (t) => {
  const net = fakeConnect({ fail: true });
  const { cwd, plan } = setup(t, [updateApp(GAME, appBody(GAME, { ip_firewall: false })), updateApp(RANGE, appBody(RANGE, { tls: 'strict' }))]);
  approve(cwd, plan);
  const applied = await applyPlan(cwd, fakeApi(), plan.id, T0, fastVerify({ connect: net.connect }));
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  const [udp, range] = applied.results.map((r) => r.verify.checks[1]);
  assert.deepEqual([udp.ok, range.ok], [true, true]);
  assert.match(udp.detail, /^skipped: UDP app/);
  assert.match(range.detail, /^skipped: port range 1000-2000/);
  assert.deepEqual(net.seen, []);
  // A post state without dns.name (and a body without one) is skipped, not failed.
  const entry = SPECTRUM.kinds.find((k) => k.kind === 'spectrum_app_update');
  const [, noHost] = SPECTRUM.verifyChecks({ method: 'PUT', path: `${APPS}/${SSH}`, body: { protocol: 'tcp/22' } }, entry, {}, {}, { protocol: 'tcp/22' }, { connect: net.connect });
  assert.deepEqual(await noHost.run(), { ok: true, detail: 'skipped: the app has no dns.name to connect to' });
  assert.equal(noHost.once, true);
  assert.deepEqual(SPECTRUM.verifyChecks({ method: 'DELETE', path: `${APPS}/${SSH}` }, entry, {}, {}, null, {}), []);
});

test('rollbacks: create is deleted, update restores with a drift baseline, delete is re-created without its id', async (t) => {
  const net = fakeConnect();
  const api = fakeApi();
  const { cwd, plan } = setup(t, [createApp(namedBody(25565, 'mc.example.com')), updateApp(SSH, appBody(SSH, { ip_firewall: true })), deleteApp(GAME, 'game.example.com')]);
  approve(cwd, plan);
  const applied = await applyPlan(cwd, api, plan.id, T0, fastVerify({ connect: net.connect }));
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  const rollback = createRollbackPlan(cwd, plan.id, T1);
  assert.deepEqual(rollback.ops.map((o) => `${o.method} ${o.path}`), [`POST ${APPS}`, `PUT ${APPS}/${SSH}`, `DELETE ${APPS}/${NEW_APP}`]);
  // Every inverse carries a drift baseline (Ruling 8).
  for (const op of rollback.ops) assert.equal(op.precheck?.kind, 'drift', `${op.method} ${op.path}`);
  assert.equal(rollback.ops[0].body.dns.name, 'game.example.com');
  assert.deepEqual(rollback.ops[0].body.edge_ips, { type: 'static', ips: ['203.0.113.50'] });
  assert.ok(!('id' in rollback.ops[0].body) && !('created_on' in rollback.ops[0].body));
  assert.equal(rollback.ops[1].body.ip_firewall, false);
  approve(cwd, rollback, T1);
  const ran = await applyPlan(cwd, api, rollback.id, T1, fastVerify({ connect: net.connect }));
  assert.equal(ran.status, 'applied', JSON.stringify(ran.results));
  assert.equal(api.store.get(`${APPS}/${SSH}`).ip_firewall, false);
  assert.ok(!api.store.has(`${APPS}/${NEW_APP}`));
  assert.equal(api.store.get(`${APPS}/${NEW_APP.slice(0, 30)}f1`).dns.name, 'game.example.com');
  assert.equal(readPlan(cwd, plan.id).status, 'rolled_back');
});

test('a change made after apply skips that inverse with rollback_drift', async (t) => {
  const api = fakeApi();
  const { cwd, plan } = setup(t, [updateApp(SSH, appBody(SSH, { tls: 'full' }))]);
  approve(cwd, plan);
  assert.equal((await applyPlan(cwd, api, plan.id, T0, fastVerify({ connect: fakeConnect().connect }))).status, 'applied');
  api.store.set(`${APPS}/${SSH}`, { ...api.store.get(`${APPS}/${SSH}`), tls: 'strict' });
  const rollback = createRollbackPlan(cwd, plan.id, T1);
  approve(cwd, rollback, T1);
  const ran = await applyPlan(cwd, api, rollback.id, T1, fastVerify({ connect: fakeConnect().connect }));
  assert.equal(ran.status, 'partially_applied');
  assert.equal(ran.results[0].reason, 'rollback_drift');
  assert.equal(api.store.get(`${APPS}/${SSH}`).tls, 'strict');
});

test('Ruling 26: spectrum/apps is owned; PATCH and path variants are refused, other zone writes stay open', () => {
  const variants = [
    `${APPS}/${SSH}/`,
    `${APPS}/`,
    `${APPS}/${SSH.toUpperCase()}`,
    `${ZB}/%73pectrum/apps/${SSH}`,
    `${ZB}/%2573pectrum/apps/${SSH}`,
    `${ZB}/spectrum;x/apps/${SSH}`,
    `${ZB}/spectrum.json`,
    `${ZB}/spectrum,x/apps`,
    `${ZB}/spectrum%20/apps`,
    `${ZB}/spectrum/apps/${SSH}/x`,
    `${ZB}/spectrum/analytics`,
  ];
  for (const path of variants) {
    for (const method of ['PATCH', 'PUT', 'POST', 'DELETE']) {
      assert.throws(() => validateOpTargets([{ method, path, body: {} }], ZONE), (e) => e.code === 'invalid_op' && /spectrum module/.test(e.message), `${method} ${path}`);
    }
  }
  assert.equal(zoneProductPathOwner({ method: 'PATCH', path: `${APPS}/${SSH}` }, ZONE).product, 'spectrum');
  validateOpTargets([
    { method: 'PATCH', path: `${ZB}/spectrum_custom/x`, body: {} },
    { method: 'PATCH', path: `${ZB}/spectrum2/x`, body: {} },
    { method: 'GET', path: `${APPS}/${SSH}` },
    { method: 'POST', path: `${ZB}/dns_records`, body: {} },
  ], ZONE);
});

test('Task 13 carry: load_balancers variants with ;, ., comma, space and double encoding are owned; load_balancers_custom is not', () => {
  const LB1 = 'c0000000000000000000000000000001';
  for (const path of [
    `${ZB}/load_balancers;x/${LB1}`,
    `${ZB}/load_balancers.json`,
    `${ZB}/load_balancers,x`,
    `${ZB}/load_balancers%20/${LB1}`,
    `${ZB}/%256coad_balancers/${LB1}`,
    `${ZB}/%25256coad_balancers/${LB1}`,
  ]) {
    assert.throws(() => validateOpTargets([{ method: 'PATCH', path, body: {} }], ZONE), (e) => e.code === 'invalid_op' && /load_balancing module/.test(e.message), path);
  }
  for (const path of [`${ZB}/load_balancers_custom/x`, `${ZB}/load_balancersx/y`]) {
    assert.equal(zoneProductPathOwner({ method: 'PATCH', path }, ZONE), null, path);
  }
});

// Fix round 1

test('fix 1: an invalid escape elsewhere in the path does not stop the decoding of the owned segment', () => {
  for (const [path, module] of [
    [`${ZB}/%256coad_balancers/%25ZZ`, 'load_balancing'],
    [`${ZB}/%2573pectrum/apps/${SSH}/%25ZZ`, 'spectrum'],
  ]) {
    assert.throws(() => validateOpTargets([{ method: 'PATCH', path, body: {} }], ZONE), (e) => e.code === 'invalid_op' && new RegExp(`${module} module`).test(e.message), path);
  }
  // A path that does not decode strictly is refused earlier (zone Access check).
  for (const path of [`${ZB}/%2573pectrum/apps/%ZZ`, `${ZB}/spectrum/apps/${SSH}%`]) {
    assert.throws(() => validateOpTargets([{ method: 'PATCH', path, body: {} }], ZONE), { code: 'invalid_op' }, path);
  }
});

test('Ruling 30: on Pro, an update or a rollback of a named app with extra keys passes; a create with a non-default field does not', async (t) => {
  const extra = { ...app(SSH), ip_firewall: true, origin_port: 22, edge_ips: { type: 'dynamic', connectivity: 'ipv4' }, future_field: 'x' };
  const api = fakeApi({ plan: 'pro' });
  api.store.set(`${APPS}/${SSH}`, structuredClone(extra));

  // Update: the whole app read back, one field changed.
  const { id: _i, created_on: _c, modified_on: _m, ...readBack } = extra;
  const update = updateApp(SSH, { ...readBack, tls: 'off' });
  assert.deepEqual(failed(await preflight(api, [update])), []);

  // Rollback of a delete re-creates the snapshot body with every extra key.
  const del = deleteApp(SSH, 'ssh.example.com');
  const { cwd, plan } = setup(t, [del]);
  approve(cwd, plan);
  assert.equal((await applyPlan(cwd, api, plan.id, T0, fastVerify())).status, 'applied');
  const rollback = createRollbackPlan(cwd, plan.id, T1);
  assert.equal(rollback.ops[0].method, 'POST');
  assert.equal(rollback.ops[0].body.future_field, 'x');
  const report = await runProductPreflight(api, rollback, rollback.ops);
  assert.equal(report.checks.find((c) => c.name === 'entitlement').ok, true, JSON.stringify(report.checks));
  const withLines = await addRollbackLockout(cwd, rollback, api);
  assert.deepEqual(withLines.lockout_risks, []);
  approve(cwd, withLines, T1);
  const ran = await applyPlan(cwd, api, rollback.id, T1, fastVerify({ connect: fakeConnect().connect }));
  assert.equal(ran.status, 'applied', JSON.stringify(ran.results));

  // The same body as a create on a normal plan is still a generic app.
  const create = await preflight(fakeApi({ plan: 'pro' }), [createApp({ ...namedBody(22), ip_firewall: true })]);
  assert.equal(failed(create)[0].code, 'not_entitled');
  // A port that is not a named app stays generic for updates too.
  const other = await preflight(fakeApi({ plan: 'pro' }), [updateApp(SSH, { ...readBack, protocol: 'tcp/2222', origin_direct: ['tcp://192.0.2.10:2222'] })]);
  assert.equal(failed(other)[0].code, 'not_entitled');
});
