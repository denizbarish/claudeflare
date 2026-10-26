import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPlan, createRollbackPlan, withIrreversibleRisk } from '../scripts/lib/apply.mjs';
import { createPlan, updatePlan } from '../scripts/lib/plans.mjs';
import { writeApproval } from '../scripts/lib/approvals.mjs';
import { classifyProductOp } from '../scripts/lib/products/index.mjs';
import { validateOpTargets, validatePlanOps } from '../scripts/lib/resources.mjs';
import { runProductPreflight } from '../scripts/lib/product-preflight.mjs';
import { resultId } from '../scripts/lib/rest-engine.mjs';
import { CREATED_ID, resolveCreatedId } from '../scripts/lib/rest-exec.mjs';
import { CfError } from '../scripts/lib/errors.mjs';

const A = '0123456789abcdef0123456789abcdef';
const BASE = `/accounts/${A}`;
const D = `${BASE}/devices`;
const PLAN = { scope: 'account', account_id: A };
const T0 = new Date('2026-10-26T10:00:00Z');
const T1 = new Date('2026-10-26T10:05:00Z');

const P_SALES = 'cccccccc-2222-4000-8000-000000000001';
const P_LAB = 'cccccccc-2222-4000-8000-000000000002';
const NEW_PROFILE = 'cccccccc-2222-4000-8000-0000000000ff';
const DISK = 'dddddddd-2222-4000-8000-000000000001';
const FIREWALL = 'dddddddd-2222-4000-8000-000000000002';
const NEW_POSTURE = 'dddddddd-2222-4000-8000-0000000000ff';

const TEAM = 'example-team.cloudflareaccess.com';
const OKTA = 'example-org.okta.com';
const HONESTY = 'device behavior is only verified on a device';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/api/devices/${name}.json`, import.meta.url), 'utf8'));

const LISTS = ['include', 'exclude', 'fallback_domains'];
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LIST_PATH = new RegExp(`^${D}/policy(?:/(${UUID}))?/(include|exclude|fallback_domains)$`);

// In-memory account built from the recorded responses. A profile holds its
// split tunnel lists; the list endpoints read and write them whole. A PATCH
// that sets include (or exclude) switches the mode and drops the other list,
// as the dashboard's mode switch resets the entries.
function fakeApi({
  org = fx('organization'), policies = fx('access-policies'), apps = fx('access-apps'), idps = fx('identity-providers'),
  settings = fx('settings'), deny = [], createdId = true,
} = {}) {
  const store = new Map();
  store.set(`${D}/policy`, fx('default-profile'));
  for (const p of fx('profiles')) store.set(`${D}/policy/${p.policy_id}`, structuredClone(p));
  for (const p of fx('posture')) store.set(`${D}/posture/${p.id}`, structuredClone(p));
  store.set(`${D}/settings`, structuredClone(settings));
  if (org) store.set(`${BASE}/access/organizations`, structuredClone(org));
  const collections = {
    [`${D}/policies`]: () => [...store.entries()].filter(([k]) => new RegExp(`^${D}/policy/${UUID}$`).test(k)).map(([, v]) => v),
    [`${D}/posture`]: () => [...store.entries()].filter(([k]) => new RegExp(`^${D}/posture/${UUID}$`).test(k)).map(([, v]) => v),
    [`${BASE}/access/policies`]: () => policies,
    [`${BASE}/access/apps`]: () => apps,
    [`${BASE}/access/identity_providers`]: () => idps,
  };
  const calls = [];
  const missing = (path) => new CfError('not_found', `Not found: ${path}`, { status: 404 });
  const page = (all, opts) => {
    if (!opts.envelope) return structuredClone(all);
    const n = Number(opts.query?.page ?? 1);
    const per = Number(opts.query?.per_page ?? 50);
    return {
      result: structuredClone(all.slice((n - 1) * per, n * per)),
      result_info: { page: n, per_page: per, total_pages: Math.max(1, Math.ceil(all.length / per)) },
    };
  };
  const profileKey = (id) => (id ? `${D}/policy/${id}` : `${D}/policy`);
  return {
    store,
    calls,
    writes: () => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`),
    async request(method, path, opts = {}) {
      calls.push({ method, path, query: opts.query, body: structuredClone(opts.body) });
      if (deny.some((prefix) => path.startsWith(prefix))) throw new CfError('permission', `Forbidden: ${path}`, { status: 403 });
      const list = LIST_PATH.exec(path);
      if (list) {
        const key = profileKey(list[1]);
        if (!store.has(key)) throw missing(path);
        if (method === 'GET') return structuredClone(store.get(key)[list[2]] ?? []);
        if (method === 'PUT') {
          store.set(key, { ...store.get(key), [list[2]]: structuredClone(opts.body) });
          return structuredClone(opts.body);
        }
      }
      if (method === 'GET' && collections[path]) return page(collections[path](), opts);
      if (method === 'GET') {
        if (!store.has(path)) throw missing(path);
        return structuredClone(store.get(path));
      }
      if (method === 'POST' && path === `${D}/policy`) {
        const next = { ...structuredClone(opts.body), default: false, gateway_unique_id: '0a1b2c3d4e', target_tests: [] };
        if (createdId) next.policy_id = NEW_PROFILE;
        store.set(`${D}/policy/${NEW_PROFILE}`, next);
        return structuredClone(next);
      }
      if (method === 'POST' && path === `${D}/posture`) {
        const next = { ...structuredClone(opts.body), id: NEW_POSTURE };
        store.set(`${D}/posture/${NEW_POSTURE}`, next);
        return structuredClone(next);
      }
      if (method === 'DELETE') {
        if (!store.has(path)) throw missing(path);
        store.delete(path);
        return { id: path.split('/').pop() };
      }
      const old = store.get(path);
      if (!old) throw missing(path);
      if (method === 'PATCH') {
        const next = { ...old, ...structuredClone(opts.body) };
        if ('include' in opts.body) delete next.exclude;
        if ('exclude' in opts.body) delete next.include;
        store.set(path, next);
        return structuredClone(next);
      }
      if (method === 'PUT') {
        const next = { ...structuredClone(opts.body), id: old.id };
        store.set(path, next);
        return structuredClone(next);
      }
      throw new CfError('api', `unexpected ${method} ${path}`);
    },
  };
}

// Captured once: a test may call setup twice, and its after hooks run in
// registration order, so restoring a per-call value could point the env at a
// temp dir that is already deleted.
const ORIGINAL_KEY_DIR = process.env.CLAUDEFLARE_KEY_DIR;

function setup(t, ops, fields = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'claudeflare-devices-'));
  const keyDir = mkdtempSync(join(tmpdir(), 'claudeflare-deviceskey-'));
  process.env.CLAUDEFLARE_KEY_DIR = keyDir;
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
    if (ORIGINAL_KEY_DIR === undefined) delete process.env.CLAUDEFLARE_KEY_DIR;
    else process.env.CLAUDEFLARE_KEY_DIR = ORIGINAL_KEY_DIR;
  });
  const plan = createPlan(cwd, {
    scope: 'account', account_id: A, account_name: 'Acme', summary: 'Devices', risk: 'low', ops, slug: 'devices',
  }, T0);
  return { cwd, plan: updatePlan(cwd, plan.id, { slug: 'devices', lockout_risks: [], ...fields }) };
}

const approve = (cwd, plan, now = T0) => writeApproval(cwd, { plan_id: plan.id, session_id: 's1' }, now);

// Verification runs without waiting: each clock read is 30 s later.
function fastVerify() {
  let now = 0;
  return { sleep: async () => {}, clock: () => (now += 30000) };
}

const profilePath = (id) => (id ? `${D}/policy/${id}` : `${D}/policy`);
const patchProfile = (id, body) => ({ method: 'PATCH', path: profilePath(id), body });
const createProfile = (fields = {}) => ({
  method: 'POST', path: `${D}/policy`, body: { name: 'Contractors', match: 'identity.email == "c@example.net"', precedence: 300, ...fields },
});
const deleteProfile = (id, name) => ({ method: 'DELETE', path: profilePath(id), confirm_name: name });
const putList = (id, list, body) => ({ method: 'PUT', path: `${profilePath(id)}/${list}`, body });
const postureCreate = (fields = {}) => ({ method: 'POST', path: `${D}/posture`, body: { name: 'Screen lock', type: 'os_version', ...fields } });
const postureUpdate = (id, fields = {}) => ({ method: 'PUT', path: `${D}/posture/${id}`, body: { name: 'Firewall on', type: 'firewall', ...fields } });
const postureDelete = (id, name) => ({ method: 'DELETE', path: `${D}/posture/${id}`, confirm_name: name });
const host = (h) => ({ host: h });

const preflight = (ops, options) => runProductPreflight(fakeApi(options), PLAN, ops);
const failed = (report) => report.checks.filter((c) => !c.ok);

test('every devices kind classifies with its inverse; unenroll, revoke and settings writes are not allowed', () => {
  const cases = [
    ['PATCH', '/devices/policy', 'device_default_profile_patch', 'function'],
    ['POST', '/devices/policy', 'device_profile_create', 'delete_created'],
    ['PATCH', `/devices/policy/${P_LAB}`, 'device_profile_patch', 'function'],
    ['DELETE', `/devices/policy/${P_LAB}`, 'device_profile_delete', 'function'],
    ['PUT', '/devices/policy/include', 'device_split_include_put', 'function'],
    ['PUT', `/devices/policy/${P_LAB}/include`, 'device_split_include_put', 'function'],
    ['PUT', '/devices/policy/exclude', 'device_split_exclude_put', 'function'],
    ['PUT', `/devices/policy/${P_LAB}/exclude`, 'device_split_exclude_put', 'function'],
    ['PUT', '/devices/policy/fallback_domains', 'device_fallback_put', 'function'],
    ['PUT', `/devices/policy/${P_LAB}/fallback_domains`, 'device_fallback_put', 'function'],
    ['POST', '/devices/posture', 'device_posture_create', 'delete_created'],
    ['PUT', `/devices/posture/${DISK}`, 'device_posture_update', 'put_before'],
    ['DELETE', `/devices/posture/${DISK}`, 'device_posture_delete', 'recreate'],
  ];
  for (const [method, rest, kind, inverse] of cases) {
    const c = classifyProductOp({ method, path: `${BASE}${rest}` }, PLAN);
    assert.ok(c, `${method} ${rest} is not classified`);
    assert.equal(c.entry.kind, kind);
    assert.equal(c.module.product, 'devices');
    assert.equal(typeof c.entry.inverse === 'function' ? 'function' : c.entry.inverse, inverse, kind);
    assert.equal(c.entry.destructive, kind.endsWith('_delete'), kind);
    if (kind.endsWith('_delete')) assert.equal(c.entry.nameField, 'name', kind);
  }
  assert.equal(classifyProductOp(createProfile(), PLAN).entry.idField, 'policy_id');
  assert.equal(resultId(classifyProductOp(createProfile(), PLAN).entry, { policy_id: NEW_PROFILE }), NEW_PROFILE);
  for (const [method, rest] of [
    ['POST', '/devices/revoke'],
    ['POST', '/devices/unrevoke'],
    ['DELETE', `/devices/physical-devices/${P_LAB}`],
    ['POST', `/devices/physical-devices/${P_LAB}/revoke`],
    ['DELETE', `/devices/registrations/${P_LAB}`],
    ['PUT', '/devices/settings'],
    ['PATCH', '/devices/settings'],
    ['PUT', `/devices/policy/${P_LAB}`],
    ['DELETE', '/devices/policy'],
    ['PATCH', `/devices/posture/${DISK}`],
  ]) {
    assert.equal(classifyProductOp({ method, path: `${BASE}${rest}` }, PLAN), null, `${method} ${rest}`);
    assert.throws(() => validateOpTargets([{ method, path: `${BASE}${rest}`, body: {} }], PLAN), { code: 'invalid_op' }, `${method} ${rest}`);
  }
});

test('profile, list and posture bodies are validated (invalid_op)', () => {
  validateOpTargets([patchProfile(P_LAB, { switch_locked: true }), createProfile(), putList(P_LAB, 'exclude', [{ address: '10.0.0.0/8' }, host('a.example.com')])], PLAN);
  validateOpTargets([putList(null, 'fallback_domains', [{ suffix: 'corp.example.com', dns_server: ['192.0.2.53'] }]), postureCreate(), postureUpdate(FIREWALL)], PLAN);
  const bad = [
    patchProfile(P_LAB, { include: [host(TEAM)], exclude: [] }),
    patchProfile(null, {}),
    patchProfile(P_LAB, { switch_locked: 'yes' }),
    patchProfile(P_LAB, { policy_id: P_SALES }),
    createProfile({ match: undefined }),
    createProfile({ precedence: 'first' }),
    putList(P_LAB, 'exclude', { address: '10.0.0.0/8' }),
    putList(P_LAB, 'include', [{ description: 'nothing' }]),
    putList(P_LAB, 'include', [{ address: '10.0.0.0/8', host: 'a.example.com' }]),
    putList(null, 'fallback_domains', [{ dns_server: ['192.0.2.53'] }]),
    postureCreate({ type: '' }),
    postureUpdate(FIREWALL, { name: undefined }),
  ];
  for (const op of bad) assert.throws(() => validateOpTargets([op], PLAN), { code: 'invalid_op' }, JSON.stringify(op));
  // Rollback-only fields never come from a draft.
  assert.throws(() => validateOpTargets([{ ...putList(P_LAB, 'exclude', []), created_id_from: 1 }], PLAN), (e) => e.code === 'invalid_op' && /created_id_from/.test(e.message));
});

test('a split tunnel mode change after a list PUT on the same profile is plan_conflict', () => {
  const mode = patchProfile(P_LAB, { include: [host(TEAM), host(OKTA)] });
  assert.throws(
    () => validatePlanOps([putList(P_LAB, 'include', [host(TEAM)]), mode], PLAN),
    (e) => e.code === 'plan_conflict' && /mode/.test(e.message) && e.message.includes(P_LAB),
  );
  assert.throws(() => validatePlanOps([putList(null, 'exclude', [host(TEAM)]), patchProfile(null, { include: [host(TEAM)] })], PLAN), { code: 'plan_conflict' });
  validatePlanOps([mode, putList(P_LAB, 'include', [host(TEAM), host(OKTA)])], PLAN);
  validatePlanOps([putList(P_LAB, 'fallback_domains', [{ suffix: 'lab.example.com' }]), mode], PLAN);
  validatePlanOps([putList(P_SALES, 'include', [host(TEAM)]), mode], PLAN);
  // A profile delete with any write to its lists is a conflict too.
  assert.throws(() => validatePlanOps([deleteProfile(P_LAB, 'Lab'), putList(P_LAB, 'exclude', [])], PLAN), { code: 'plan_conflict' });
});

test('a split tunnel mode change alone is one Lockout risk line', async () => {
  const report = await preflight([patchProfile(P_LAB, { include: [host(TEAM), host(OKTA), { address: '198.51.100.0/24' }] })]);
  assert.deepEqual(failed(report), []);
  assert.equal(report.lockout_risks.length, 1, JSON.stringify(report.lockout_risks));
  assert.match(report.lockout_risks[0], /^Lockout risk: device profile Lab .*split tunnel mode .*from exclude to include/);
  assert.match(report.lockout_risks[0], /resets/);
  const back = await preflight([patchProfile(P_SALES, { exclude: [{ address: '10.0.0.0/8' }] })]);
  assert.equal(back.lockout_risks.length, 1);
  assert.match(back.lockout_risks[0], /Sales laptops .*from include to exclude/);
  // The same mode again is no switch.
  assert.deepEqual((await preflight([patchProfile(P_LAB, { exclude: [{ address: '10.0.0.0/8' }] })])).lockout_risks, []);
  assert.deepEqual((await preflight([patchProfile(null, { support_url: 'https://help.example.com/warp' })])).lockout_risks, []);
});

test('include mode without the team domain or the identity provider hosts is a Lockout risk line', async () => {
  const noTeam = await preflight([putList(P_SALES, 'include', [host(OKTA), { address: '198.51.100.0/24' }])]);
  assert.equal(noTeam.lockout_risks.length, 1);
  assert.match(noTeam.lockout_risks[0], /^Lockout risk: device profile Sales laptops .*include mode/);
  assert.ok(noTeam.lockout_risks[0].includes(TEAM), noTeam.lockout_risks[0]);
  assert.ok(!noTeam.lockout_risks[0].includes(OKTA), noTeam.lockout_risks[0]);
  const noIdp = await preflight([putList(P_SALES, 'include', [host(TEAM)])]);
  assert.equal(noIdp.lockout_risks.length, 1);
  assert.ok(noIdp.lockout_risks[0].includes(OKTA));
  assert.deepEqual((await preflight([putList(P_SALES, 'include', [host(TEAM), host(OKTA)])])).lockout_risks, []);
  assert.deepEqual((await preflight([putList(P_SALES, 'include', [host('*.cloudflareaccess.com'), host(OKTA)])])).lockout_risks, []);
  // A mode change to include with a list that misses them: both lines.
  const both = await preflight([patchProfile(P_LAB, { include: [{ address: '198.51.100.0/24' }] })]);
  assert.equal(both.lockout_risks.length, 2, JSON.stringify(both.lockout_risks));
  assert.ok(both.lockout_risks.some((l) => /split tunnel mode/.test(l)));
  assert.ok(both.lockout_risks.some((l) => l.includes(TEAM) && l.includes(OKTA)));
  // The include list of a profile in exclude mode is checked as well: a PUT there may switch the mode.
  assert.equal((await preflight([putList(P_LAB, 'include', [{ address: '198.51.100.0/24' }])])).lockout_risks.length, 1);
});

test('switch_locked without admin override codes is a Lockout risk line', async () => {
  const locked = await preflight([patchProfile(null, { switch_locked: true })]);
  assert.equal(locked.lockout_risks.length, 1);
  assert.match(locked.lockout_risks[0], /^Lockout risk: device profile Default .*switch_locked/);
  assert.match(locked.lockout_risks[0], /admin override/);
  const created = await preflight([createProfile({ switch_locked: true })]);
  assert.equal(created.lockout_risks.length, 1);
  assert.match(created.lockout_risks[0], /new device profile Contractors/);
  const override = { ...fx('settings'), disable_for_time: 3600 };
  assert.deepEqual((await preflight([patchProfile(null, { switch_locked: true })], { settings: override })).lockout_risks, []);
  assert.deepEqual((await preflight([patchProfile(null, { switch_locked: false })])).lockout_risks, []);
});

test('excluding Access or identity provider hosts while device posture is required is a Lockout risk line', async () => {
  const ops = [putList(P_LAB, 'exclude', [{ address: '10.0.0.0/8' }, host(TEAM)])];
  const report = await preflight(ops);
  assert.equal(report.lockout_risks.length, 1);
  assert.match(report.lockout_risks[0], /^Lockout risk: device profile Lab excludes example-team\.cloudflareaccess\.com/);
  assert.match(report.lockout_risks[0], /Employees on managed laptops/);
  assert.equal((await preflight([putList(null, 'exclude', [host('cloudflareaccess.com')])])).lockout_risks.length, 1);
  assert.equal((await preflight([putList(null, 'exclude', [host(OKTA)])])).lockout_risks.length, 1);
  // No Access policy requires posture: no line.
  const noPosture = { policies: fx('access-policies').slice(1), apps: [] };
  assert.deepEqual((await preflight(ops, noPosture)).lockout_risks, []);
});

test('a posture rule delete is refused while an Access policy references it, also past the first page', async () => {
  const filler = Array.from({ length: 60 }, (_, i) => ({ ...fx('access-policies')[1], id: `bbbbbbbb-2222-4000-8000-0000000001${String(i).padStart(2, '0')}`, name: `policy ${i}` }));
  filler[55] = fx('access-policies')[0];
  const used = await preflight([postureDelete(DISK, 'Disk encrypted')], { policies: filler, apps: [] });
  const dep = used.checks.find((c) => c.name === 'dependencies');
  assert.equal(dep?.ok, false, JSON.stringify(used.checks));
  assert.equal(dep.code, 'resource_in_use');
  assert.match(dep.detail, /Employees on managed laptops/);
  // A policy that lives only inside an app counts too.
  const inline = [{ ...fx('access-apps')[0], policies: [{ ...fx('access-policies')[0], id: 'bbbbbbbb-2222-4000-8000-0000000000aa', name: 'Wiki posture', require: [{ device_posture: { integration_uid: FIREWALL } }] }] }];
  const appUsed = await preflight([postureDelete(FIREWALL, 'Firewall on')], { apps: inline });
  assert.equal(appUsed.checks.find((c) => c.name === 'dependencies').code, 'resource_in_use');
  assert.match(appUsed.checks.find((c) => c.name === 'dependencies').detail, /Wiki posture.*wiki/);
  const free = await preflight([postureDelete(FIREWALL, 'Firewall on')]);
  assert.deepEqual(failed(free), []);
});

test('an Access policy read refused with 403 names the permission; no organization is not_entitled', async () => {
  const report = await preflight([postureDelete(FIREWALL, 'Firewall on')], { deny: [`${BASE}/access/policies`] });
  const gather = report.checks.find((c) => c.name === 'gather');
  assert.equal(gather.ok, false);
  assert.equal(gather.code, 'missing_permission');
  assert.match(gather.detail, /Access: Apps and Policies Read/);
  const lists = await preflight([putList(P_LAB, 'exclude', [])], { deny: [`${D}/policy/${P_LAB}/`] });
  assert.match(lists.checks.find((c) => c.name === 'gather').detail, /Zero Trust/);
  const ent = (await preflight([postureCreate()], { org: null })).checks.find((c) => c.name === 'entitlement');
  assert.equal(ent.ok, false);
  assert.equal(ent.code, 'not_entitled');
});

test('profile delete rollback re-creates the profile and puts its saved lists on the new id', async (t) => {
  const op = deleteProfile(P_SALES, 'Sales laptops');
  const { cwd, plan } = setup(t, [op]);
  const api = fakeApi();
  const report = await runProductPreflight(api, PLAN, [op]);
  assert.deepEqual(failed(report), []);
  assert.match(withIrreversibleRisk('Delete profile', [op], PLAN, report.ctx), /default profile.*new id/);
  approve(cwd, plan);
  const applied = await applyPlan(cwd, api, plan.id, T0, fastVerify());
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  assert.ok(!api.store.has(`${D}/policy/${P_SALES}`));

  const rollback = createRollbackPlan(cwd, plan.id, T1);
  assert.deepEqual(rollback.ops.map((o) => `${o.method} ${o.path}`), [
    `POST ${D}/policy`,
    `PUT ${D}/policy/${CREATED_ID}/include`,
    `PUT ${D}/policy/${CREATED_ID}/fallback_domains`,
  ]);
  // Ops aimed at the re-created profile get no Not reversible line.
  assert.ok(!rollback.risk.includes(CREATED_ID), rollback.risk);
  assert.ok(!/Not reversible/.test(rollback.risk), rollback.risk);
  const [recreate, include, fallback] = rollback.ops;
  const saved = fx('profiles')[0];
  for (const field of ['policy_id', 'default', 'gateway_unique_id', 'target_tests', 'fallback_domains', 'exclude', 'lists']) assert.ok(!(field in recreate.body), field);
  assert.equal(recreate.body.match, saved.match);
  assert.equal(recreate.body.precedence, 100);
  assert.deepEqual(recreate.precheck.expect, { absent: true });
  assert.equal(recreate.precheck.group, `profile:${P_SALES}`);
  assert.deepEqual(include.body, saved.include);
  assert.deepEqual(fallback.body, saved.fallback_domains);
  assert.deepEqual([include.created_id_from, fallback.created_id_from], [1, 2]);
  assert.deepEqual([include.precheck.group, fallback.precheck.group], [`profile:${P_SALES}`, `profile:${P_SALES}`]);

  approve(cwd, rollback, T1);
  const ran = await applyPlan(cwd, api, rollback.id, T1, fastVerify());
  assert.equal(ran.status, 'applied', JSON.stringify(ran.results));
  assert.deepEqual(api.writes().slice(-3), [
    `POST ${D}/policy`,
    `PUT ${D}/policy/${NEW_PROFILE}/include`,
    `PUT ${D}/policy/${NEW_PROFILE}/fallback_domains`,
  ]);
  const restored = api.store.get(`${D}/policy/${NEW_PROFILE}`);
  assert.deepEqual(restored.include, saved.include);
  assert.deepEqual(restored.fallback_domains, saved.fallback_domains);
  assert.equal(restored.name, 'Sales laptops');
  for (const result of ran.results) {
    const checks = result.verify?.checks ?? [];
    assert.ok(checks.length && checks.every((c) => c.ok), JSON.stringify(result));
  }
});

test('a rollback op whose re-create returned no id stops with rollback_ambiguous', async (t) => {
  const { cwd, plan } = setup(t, [deleteProfile(P_SALES, 'Sales laptops')]);
  const api = fakeApi({ createdId: false });
  approve(cwd, plan);
  assert.equal((await applyPlan(cwd, api, plan.id, T0, fastVerify())).status, 'applied');
  const rollback = createRollbackPlan(cwd, plan.id, T1);
  approve(cwd, rollback, T1);
  const ran = await applyPlan(cwd, api, rollback.id, T1, fastVerify());
  assert.equal(ran.status, 'partially_applied');
  assert.equal(ran.error.code, 'rollback_ambiguous');
  assert.equal(ran.error.op_index, 1);
  assert.ok(!api.writes().some((w) => w.includes(CREATED_ID)));
});

test('resolveCreatedId fills the created id from an earlier op and refuses anything else', () => {
  const ops = [createProfile(), { method: 'PUT', path: `${D}/policy/${CREATED_ID}/include`, body: [], created_id_from: 1 }];
  assert.equal(resolveCreatedId(ops, 0, [], PLAN), ops[0]);
  const sent = resolveCreatedId(ops, 1, [{ policy_id: NEW_PROFILE }], PLAN);
  assert.deepEqual(sent, { method: 'PUT', path: `${D}/policy/${NEW_PROFILE}/include`, body: [] });
  const ambiguous = (e) => e instanceof CfError && e.code === 'rollback_ambiguous';
  assert.throws(() => resolveCreatedId(ops, 1, [{ policy_id: '../x' }], PLAN), ambiguous);
  assert.throws(() => resolveCreatedId(ops, 1, [{ skipped: true }], PLAN), ambiguous);
  assert.throws(() => resolveCreatedId([ops[1]], 0, [], PLAN), ambiguous);
  assert.throws(() => resolveCreatedId([ops[0], { ...ops[1], path: `${D}/policy/${NEW_PROFILE}/include` }], 1, [{ policy_id: NEW_PROFILE }], PLAN), ambiguous);
});

test('profile create rollback deletes the profile by its policy_id', async (t) => {
  const { cwd, plan } = setup(t, [createProfile()]);
  const api = fakeApi();
  approve(cwd, plan);
  const applied = await applyPlan(cwd, api, plan.id, T0, fastVerify());
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  assert.ok(applied.results[0].verify.ok, JSON.stringify(applied.results[0].verify));
  const rollback = createRollbackPlan(cwd, plan.id, T1);
  assert.deepEqual(rollback.ops.map((o) => `${o.method} ${o.path}`), [`DELETE ${D}/policy/${NEW_PROFILE}`]);
  assert.equal(rollback.ops[0].precheck.read, `${D}/policy/${NEW_PROFILE}`);
  approve(cwd, rollback, T1);
  assert.equal((await applyPlan(cwd, api, rollback.id, T1, fastVerify())).status, 'applied');
  assert.ok(!api.store.has(`${D}/policy/${NEW_PROFILE}`));
});

test('a list PUT reads back, rolls back with the saved array and stops on drift', async (t) => {
  const op = putList(null, 'exclude', [{ address: '10.0.0.0/8', description: 'Local network' }]);
  const { cwd, plan } = setup(t, [op]);
  const api = fakeApi();
  approve(cwd, plan);
  const applied = await applyPlan(cwd, api, plan.id, T0, fastVerify());
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  const readback = applied.results[0].verify.checks.find((c) => c.name === 'readback');
  assert.equal(readback.ok, true, readback.detail);
  assert.ok(readback.detail.endsWith(HONESTY), readback.detail);
  const rollback = createRollbackPlan(cwd, plan.id, T1);
  assert.deepEqual(rollback.ops.map((o) => `${o.method} ${o.path}`), [`PUT ${D}/policy/exclude`]);
  assert.deepEqual(rollback.ops[0].body, fx('default-profile').exclude);
  assert.deepEqual(rollback.ops[0].precheck.expect, op.body);
  assert.equal(rollback.ops[0].precheck.read, `${D}/policy/exclude`);
  assert.equal(rollback.ops[0].precheck.group, 'profile:default');
  approve(cwd, rollback, T1);
  const ran = await applyPlan(cwd, api, rollback.id, T1, fastVerify());
  assert.equal(ran.status, 'applied', JSON.stringify(ran.results));
  assert.deepEqual(api.store.get(`${D}/policy`).exclude, fx('default-profile').exclude);

  // Someone changed the list after apply: the rollback skips it.
  const second = setup(t, [op]);
  const api2 = fakeApi();
  approve(second.cwd, second.plan);
  assert.equal((await applyPlan(second.cwd, api2, second.plan.id, T0, fastVerify())).status, 'applied');
  api2.store.set(`${D}/policy`, { ...api2.store.get(`${D}/policy`), exclude: [{ address: '172.16.0.0/12' }] });
  const back = createRollbackPlan(second.cwd, second.plan.id, T1);
  approve(second.cwd, back, T1);
  const skipped = await applyPlan(second.cwd, api2, back.id, T1, fastVerify());
  assert.equal(skipped.status, 'partially_applied');
  assert.equal(skipped.results[0].reason, 'rollback_drift');
  assert.deepEqual(api2.store.get(`${D}/policy`).exclude, [{ address: '172.16.0.0/12' }]);
});

test('a mode change rollback switches back with the saved list; posture rules roll back too', async (t) => {
  const op = patchProfile(P_LAB, { include: [host(TEAM), host(OKTA)] });
  const api = fakeApi();
  const report = await runProductPreflight(api, PLAN, [op]);
  // The plan shows the mode switch line, so apply's fresh analysis finds nothing new.
  const { cwd, plan } = setup(t, [op], { lockout_risks: report.lockout_risks });
  approve(cwd, plan);
  const applied = await applyPlan(cwd, api, plan.id, T0, fastVerify());
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  assert.ok(applied.results[0].verify.ok, JSON.stringify(applied.results[0].verify));
  assert.equal(report.lockout_risks.length, 1);
  const rollback = createRollbackPlan(cwd, plan.id, T1);
  assert.deepEqual(rollback.ops.map((o) => `${o.method} ${o.path}`), [`PATCH ${D}/policy/${P_LAB}`]);
  assert.deepEqual(rollback.ops[0].body, { exclude: fx('profiles')[1].exclude });
  approve(cwd, rollback, T1);
  assert.equal((await applyPlan(cwd, api, rollback.id, T1, fastVerify())).status, 'applied');
  const lab = api.store.get(`${D}/policy/${P_LAB}`);
  assert.deepEqual(lab.exclude, fx('profiles')[1].exclude);
  assert.ok(!('include' in lab));

  const del = postureDelete(FIREWALL, 'Firewall on');
  const update = postureUpdate(DISK, { name: 'Disk encrypted', type: 'disk_encryption', input: { requireAll: false } });
  const second = setup(t, [update, del]);
  approve(second.cwd, second.plan);
  const run = await applyPlan(second.cwd, api, second.plan.id, T0, fastVerify());
  assert.equal(run.status, 'applied', JSON.stringify(run.results));
  const back = createRollbackPlan(second.cwd, second.plan.id, T1);
  assert.deepEqual(back.ops.map((o) => `${o.method} ${o.path}`), [`POST ${D}/posture`, `PUT ${D}/posture/${DISK}`]);
  assert.ok(!('id' in back.ops[0].body));
  assert.equal(back.ops[0].body.type, 'firewall');
  assert.deepEqual(back.ops[1].body.input, { requireAll: true });
});

test('verification is a read-back with the device honesty note; notes name what a delete changes', async () => {
  const { DEVICES } = await import('../scripts/lib/products/devices.mjs');
  const op = putList(P_LAB, 'fallback_domains', [{ suffix: 'lab.example.com' }]);
  const { entry } = classifyProductOp(op, PLAN);
  const ok = await DEVICES.verifyChecks(op, entry, {}, op.body, [{ suffix: 'lab.example.com', dns_server: [] }], {})[0].run();
  assert.equal(ok.ok, true, ok.detail);
  assert.ok(ok.detail.endsWith(HONESTY));
  const bad = await DEVICES.verifyChecks(op, entry, {}, op.body, [], {})[0].run();
  assert.equal(bad.ok, false);
  assert.ok(bad.detail.endsWith(HONESTY));
  const patch = patchProfile(P_LAB, { include: [host(TEAM)] });
  const pe = classifyProductOp(patch, PLAN).entry;
  const listed = await DEVICES.verifyChecks(patch, pe, {}, {}, { name: 'Lab', lists: { include: [host(TEAM)] } }, {})[0].run();
  assert.equal(listed.ok, true, listed.detail);
  assert.deepEqual(DEVICES.verifyChecks(postureDelete(DISK, 'x'), classifyProductOp(postureDelete(DISK, 'x'), PLAN).entry, {}, {}, null, {}), []);
  const ctx = (await runProductPreflight(fakeApi(), PLAN, [postureDelete(FIREWALL, 'Firewall on')])).ctx;
  assert.match(withIrreversibleRisk('x', [postureDelete(FIREWALL, 'Firewall on')], PLAN, ctx), /Firewall on.*new id/);
});

test('a mode change followed by a PUT of the new list rolls back to the original profile (no self drift)', async (t) => {
  const ops = [patchProfile(P_LAB, { include: [host(TEAM)] }), putList(P_LAB, 'include', [host(TEAM), host(OKTA)])];
  const api = fakeApi();
  const report = await runProductPreflight(api, PLAN, ops);
  assert.deepEqual(failed(report), []);
  const { cwd, plan } = setup(t, ops, { lockout_risks: report.lockout_risks });
  approve(cwd, plan);
  const applied = await applyPlan(cwd, api, plan.id, T0, fastVerify());
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  const rollback = createRollbackPlan(cwd, plan.id, T1);
  assert.deepEqual(rollback.ops.map((o) => `${o.method} ${o.path}`), [`PUT ${D}/policy/${P_LAB}/include`, `PATCH ${D}/policy/${P_LAB}`]);
  for (const field of ['include', 'exclude', 'fallback_domains']) assert.ok(!(field in rollback.ops[1].precheck.expect), field);
  approve(cwd, rollback, T1);
  const ran = await applyPlan(cwd, api, rollback.id, T1, fastVerify());
  assert.equal(ran.status, 'applied', JSON.stringify(ran.results));
  assert.ok(ran.results.every((r) => !r?.skipped), JSON.stringify(ran.results));
  assert.deepEqual(api.store.get(`${D}/policy/${P_LAB}`), fx('profiles')[1]);
});

test('list read-back ignores order and normalizes hosts, bare IPs and empty descriptions', async () => {
  const { DEVICES } = await import('../scripts/lib/products/devices.mjs');
  const op = putList(P_LAB, 'exclude', [{ address: '10.0.0.1' }, { host: 'Printer.Example.com.', description: '' }, { address: '2001:db8::1' }]);
  const { entry } = classifyProductOp(op, PLAN);
  const run = (post) => DEVICES.verifyChecks(op, entry, {}, op.body, post, {})[0].run();
  const reordered = await run([{ address: '2001:db8::1/128' }, { host: 'printer.example.com' }, { address: '10.0.0.1/32', description: '' }]);
  assert.equal(reordered.ok, true, reordered.detail);
  assert.ok(reordered.detail.endsWith(HONESTY));
  assert.equal((await run([{ address: '10.0.0.2/32' }, { host: 'printer.example.com' }, { address: '2001:db8::1/128' }])).ok, false);
  assert.equal((await run([{ address: '10.0.0.1/32' }, { host: 'printer.example.com' }])).ok, false);
  // The same rules hold for a profile's include list.
  const patch = patchProfile(P_LAB, { include: [host(TEAM), host(OKTA)] });
  const pe = classifyProductOp(patch, PLAN).entry;
  const swapped = await DEVICES.verifyChecks(patch, pe, {}, {}, { name: 'Lab', include: [host(OKTA.toUpperCase()), host(TEAM)] }, {})[0].run();
  assert.equal(swapped.ok, true, swapped.detail);
});

test('a hand edit of the list a mode-change PATCH set, or of a created profile, makes the rollback skip with rollback_drift', async (t) => {
  // (a) A PATCH-only mode change; someone then adds an include entry by hand.
  const op = patchProfile(P_LAB, { include: [host(TEAM), host(OKTA)] });
  const api = fakeApi();
  const report = await runProductPreflight(api, PLAN, [op]);
  const { cwd, plan } = setup(t, [op], { lockout_risks: report.lockout_risks });
  approve(cwd, plan);
  assert.equal((await applyPlan(cwd, api, plan.id, T0, fastVerify())).status, 'applied');
  const edited = [host(TEAM), host(OKTA), host('wiki.example.com')];
  api.store.set(`${D}/policy/${P_LAB}`, { ...api.store.get(`${D}/policy/${P_LAB}`), include: edited });
  const rollback = createRollbackPlan(cwd, plan.id, T1);
  assert.ok('include' in rollback.ops[0].precheck.expect);
  for (const field of ['exclude', 'fallback_domains']) assert.ok(!(field in rollback.ops[0].precheck.expect), field);
  approve(cwd, rollback, T1);
  const ran = await applyPlan(cwd, api, rollback.id, T1, fastVerify());
  assert.equal(ran.status, 'partially_applied');
  assert.equal(ran.results[0].reason, 'rollback_drift');
  assert.deepEqual(api.store.get(`${D}/policy/${P_LAB}`).include, edited);

  // (b) A created profile whose exclude list is edited by hand is not deleted.
  const second = setup(t, [createProfile()]);
  const api2 = fakeApi();
  approve(second.cwd, second.plan);
  assert.equal((await applyPlan(second.cwd, api2, second.plan.id, T0, fastVerify())).status, 'applied');
  api2.store.set(`${D}/policy/${NEW_PROFILE}`, { ...api2.store.get(`${D}/policy/${NEW_PROFILE}`), exclude: [{ address: '10.0.0.0/8' }] });
  const back = createRollbackPlan(second.cwd, second.plan.id, T1);
  approve(second.cwd, back, T1);
  const skipped = await applyPlan(second.cwd, api2, back.id, T1, fastVerify());
  assert.equal(skipped.status, 'partially_applied');
  assert.equal(skipped.results[0].reason, 'rollback_drift');
  assert.ok(api2.store.has(`${D}/policy/${NEW_PROFILE}`));
});

// Final review I2: the old mode's list is now inactive, but the rollback
// PATCHes it back; a hand edit of it after apply must not be overwritten.
test('a hand edit of the old mode list after a mode change makes the rollback skip with rollback_drift', async (t) => {
  for (const profile of [null, P_LAB]) {
    const op = patchProfile(profile, { include: [host(TEAM), host(OKTA)] });
    const api = fakeApi();
    const report = await runProductPreflight(api, PLAN, [op]);
    const { cwd, plan } = setup(t, [op], { lockout_risks: report.lockout_risks });
    approve(cwd, plan);
    assert.equal((await applyPlan(cwd, api, plan.id, T0, fastVerify())).status, 'applied');
    const rollback = createRollbackPlan(cwd, plan.id, T1);
    const extra = rollback.ops[0].precheck.also;
    assert.ok(Array.isArray(extra) && extra.length === 1, JSON.stringify(rollback.ops[0].precheck));
    assert.equal(extra[0].read, `${profilePath(profile)}/exclude`);
    assert.ok(!('drift' in rollback.ops[0]));
    // Someone edits the (inactive) exclude list by hand.
    const edited = [{ address: '192.168.0.0/16' }];
    api.store.set(profilePath(profile), { ...api.store.get(profilePath(profile)), exclude: edited });
    approve(cwd, rollback, T1);
    const ran = await applyPlan(cwd, api, rollback.id, T1, fastVerify());
    assert.equal(ran.status, 'partially_applied', JSON.stringify(ran.results));
    assert.equal(ran.results[0].reason, 'rollback_drift');
    assert.match(ran.results[0].detail, /exclude changed after apply/);
    assert.deepEqual(api.store.get(profilePath(profile)).exclude, edited);
  }
});
