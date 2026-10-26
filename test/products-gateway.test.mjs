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
import { inverseForProduct } from '../scripts/lib/rest-engine.mjs';
import { CfError } from '../scripts/lib/errors.mjs';

const A = '0123456789abcdef0123456789abcdef';
const BASE = `/accounts/${A}`;
const GW = `${BASE}/gateway`;
const PLAN = { scope: 'account', account_id: A };
const T0 = new Date('2026-10-26T10:00:00Z');
const T1 = new Date('2026-10-26T10:05:00Z');

const R_ALLOW = 'aaaaaaaa-1111-4000-8000-000000000001';
const R_THREAT = 'aaaaaaaa-1111-4000-8000-000000000002';
const R_LISTED = 'aaaaaaaa-1111-4000-8000-000000000003';
const NEW_RULE = 'aaaaaaaa-1111-4000-8000-0000000000ff';
const L_BLOCKED = 'bbbbbbbb-1111-4000-8000-000000000001';
const L_OLD = 'bbbbbbbb-1111-4000-8000-000000000002';
const NEW_LIST = 'bbbbbbbb-1111-4000-8000-0000000000ff';
const LOC = 'c0c0c0c0c0c0c0c0c0c0c0c0c0c0c001';
const NEW_LOC = 'c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0ff';

const HONESTY = 'filtering itself is only verified from a device behind Gateway';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/api/gateway/${name}.json`, import.meta.url), 'utf8'));

// The API answers traffic expressions in its own spacing (Review Focus 3).
const reformat = (expr) => (typeof expr === 'string' ? expr.replace(/\s*==\s*/g, ' == ').replace(/\s+/g, ' ').trim() : expr);

const COLLECTIONS = ['rules', 'lists', 'locations'];
const NEW_IDS = { rules: NEW_RULE, lists: NEW_LIST, locations: NEW_LOC };

// In-memory account built from the recorded responses. Collections page by
// page/per_page; list items live apart from the list, as in the API.
// shift: like an API that renumbers on a precedence collision, a rule
// written at a taken precedence pushes the holder (and so on) one down.
function fakeApi({ rules = fx('rules'), org = fx('organization'), idps = fx('identity-providers'), deny = [], shift = false } = {}) {
  const store = new Map();
  for (const rule of rules) store.set(`${GW}/rules/${rule.id}`, structuredClone(rule));
  for (const list of fx('lists')) store.set(`${GW}/lists/${list.id}`, structuredClone(list));
  for (const loc of fx('locations')) store.set(`${GW}/locations/${loc.id}`, structuredClone(loc));
  for (const idp of idps) store.set(`${BASE}/access/identity_providers/${idp.id}`, structuredClone(idp));
  store.set(`${GW}/configuration`, fx('configuration'));
  if (org) store.set(`${BASE}/access/organizations`, structuredClone(org));
  const items = new Map(Object.entries(fx('list-items')).map(([id, values]) => [id, structuredClone(values)]));
  const calls = [];
  const missing = (path) => new CfError('not_found', `Not found: ${path}`, { status: 404 });
  const listOf = (path) => [...store.entries()]
    .filter(([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'))
    .map(([, value]) => value);
  const collection = (path) => COLLECTIONS.find((name) => path === `${GW}/${name}`) ?? (path === `${BASE}/access/identity_providers` ? 'idps' : null);
  const itemsOf = (path) => /\/lists\/([^/]+)\/items$/.exec(path)?.[1];
  const page = (all, opts) => {
    if (!opts.envelope) return structuredClone(all);
    const n = Number(opts.query?.page ?? 1);
    const per = Number(opts.query?.per_page ?? 50);
    return {
      result: structuredClone(all.slice((n - 1) * per, n * per)),
      result_info: { page: n, per_page: per, total_pages: Math.max(1, Math.ceil(all.length / per)) },
    };
  };
  const at = '2026-10-26T10:00:00Z';
  const setItems = (id, list) => items.set(id, list.map((item) => ({ ...item, created_at: at })));
  const makeRoom = (rule) => {
    if (!shift || !Number.isInteger(rule.precedence)) return;
    const holder = listOf(`${GW}/rules`).find((r) => r.id !== rule.id && r.filters?.[0] === rule.filters?.[0] && r.precedence === rule.precedence);
    if (!holder) return;
    const moved = { ...holder, precedence: holder.precedence + 1 };
    makeRoom(moved);
    store.set(`${GW}/rules/${holder.id}`, moved);
  };
  return {
    store,
    items,
    calls,
    writes: () => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`),
    async request(method, path, opts = {}) {
      calls.push({ method, path, query: opts.query, body: structuredClone(opts.body) });
      if (deny.some((prefix) => path.startsWith(prefix))) throw new CfError('permission', `Forbidden: ${path}`, { status: 403 });
      if (method === 'GET' && collection(path)) return page(listOf(path), opts);
      if (method === 'GET' && itemsOf(path)) {
        if (!store.has(path.slice(0, -'/items'.length))) throw missing(path);
        return page(items.get(itemsOf(path)) ?? [], opts);
      }
      if (method === 'GET') {
        if (!store.has(path)) throw missing(path);
        return structuredClone(store.get(path));
      }
      if (method === 'POST' && collection(path)) {
        const name = collection(path);
        const id = NEW_IDS[name];
        const { items: sent, ...body } = structuredClone(opts.body ?? {});
        const next = { ...body, id, created_at: at, updated_at: at };
        if (name === 'rules') {
          Object.assign(next, { traffic: reformat(next.traffic ?? ''), version: 1, read_only: false, deleted_at: null });
          makeRoom(next);
        }
        if (name === 'lists') {
          setItems(id, sent ?? []);
          next.count = (sent ?? []).length;
        }
        if (name === 'locations') Object.assign(next, { doh_subdomain: 'f9e8d7c6b5', ip: '2001:db8:100::ff' });
        store.set(`${path}/${id}`, next);
        return name === 'lists' ? { ...structuredClone(next), items: structuredClone(items.get(id)) } : structuredClone(next);
      }
      if (method === 'DELETE') {
        if (!store.has(path)) throw missing(path);
        store.delete(path);
        return { id: path.split('/').pop() };
      }
      const old = store.get(path);
      if (!old) throw missing(path);
      if (method === 'PATCH' && path === `${GW}/configuration`) {
        const next = { ...old, settings: { ...old.settings, ...structuredClone(opts.body.settings) }, updated_at: at };
        store.set(path, next);
        return structuredClone(next);
      }
      if (method === 'PUT') {
        const { items: sent, ...body } = structuredClone(opts.body ?? {});
        const kept = Object.fromEntries(['id', 'created_at', 'version', 'read_only', 'source_account', 'deleted_at', 'warning_status', 'type', 'doh_subdomain', 'ip', 'ipv4_destination', 'ipv4_destination_backup']
          .filter((k) => k in old).map((k) => [k, old[k]]));
        const next = { ...body, ...kept, updated_at: at };
        if ('traffic' in next) next.traffic = reformat(next.traffic);
        if (typeof next.version === 'number' && path.includes('/rules/')) {
          next.version += 1;
          makeRoom(next);
        }
        if (path.includes('/lists/')) {
          // A PUT replaces the items only when items is non-empty.
          if (Array.isArray(sent) && sent.length) setItems(old.id, sent);
          next.count = items.get(old.id)?.length ?? 0;
        }
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
  const cwd = mkdtempSync(join(tmpdir(), 'claudeflare-gateway-'));
  const keyDir = mkdtempSync(join(tmpdir(), 'claudeflare-gatewaykey-'));
  process.env.CLAUDEFLARE_KEY_DIR = keyDir;
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
    if (ORIGINAL_KEY_DIR === undefined) delete process.env.CLAUDEFLARE_KEY_DIR;
    else process.env.CLAUDEFLARE_KEY_DIR = ORIGINAL_KEY_DIR;
  });
  const plan = createPlan(cwd, {
    scope: 'account', account_id: A, account_name: 'Acme', summary: 'Gateway', risk: 'low', ops, slug: 'gateway',
  }, T0);
  return { cwd, plan: updatePlan(cwd, plan.id, { slug: 'gateway', lockout_risks: [], ...fields }) };
}

const approve = (cwd, plan, now = T0) => writeApproval(cwd, { plan_id: plan.id, session_id: 's1' }, now);

// Verification runs without waiting: each clock read is 30 s later.
function fastVerify() {
  let now = 0;
  return { sleep: async () => {}, clock: () => (now += 30000) };
}

const ruleBody = (fields = {}) => ({ name: 'New rule', action: 'block', enabled: true, filters: ['dns'], traffic: '', precedence: 50, ...fields });
const ruleCreate = (fields) => ({ method: 'POST', path: `${GW}/rules`, body: ruleBody(fields) });
const ruleUpdate = (id, fields) => ({ method: 'PUT', path: `${GW}/rules/${id}`, body: ruleBody(fields) });
const ruleDelete = (id, name) => ({ method: 'DELETE', path: `${GW}/rules/${id}`, confirm_name: name });
const listUpdate = (id, body) => ({ method: 'PUT', path: `${GW}/lists/${id}`, body });
const listDelete = (id, name) => ({ method: 'DELETE', path: `${GW}/lists/${id}`, confirm_name: name });
const values = (n) => Array.from({ length: n }, (_, i) => ({ value: `host${i}.example.net` }));

async function preflight(ops, options) {
  const report = await runProductPreflight(fakeApi(options), PLAN, ops);
  return report;
}

test('every gateway kind classifies with its inverse; configuration PUT and list PATCH are not allowed', () => {
  const cases = [
    ['POST', '/gateway/rules', 'gateway_rule_create', 'function'],
    ['PUT', `/gateway/rules/${R_ALLOW}`, 'gateway_rule_update', 'function'],
    ['DELETE', `/gateway/rules/${R_ALLOW}`, 'gateway_rule_delete', 'function'],
    ['POST', '/gateway/lists', 'gateway_list_create', 'delete_created'],
    ['PUT', `/gateway/lists/${L_BLOCKED}`, 'gateway_list_update', 'function'],
    ['DELETE', `/gateway/lists/${L_BLOCKED}`, 'gateway_list_delete', 'function'],
    ['POST', '/gateway/locations', 'gateway_location_create', 'delete_created'],
    ['PUT', `/gateway/locations/${LOC}`, 'gateway_location_update', 'put_before'],
    ['DELETE', `/gateway/locations/${LOC}`, 'gateway_location_delete', 'recreate'],
    ['PATCH', '/gateway/configuration', 'gateway_config_patch', 'function'],
  ];
  for (const [method, rest, kind, inverse] of cases) {
    const c = classifyProductOp({ method, path: `${BASE}${rest}` }, PLAN);
    assert.ok(c, `${method} ${rest} is not classified`);
    assert.equal(c.entry.kind, kind);
    assert.equal(c.module.product, 'gateway');
    assert.equal(typeof c.entry.inverse === 'function' ? 'function' : c.entry.inverse, inverse, kind);
    assert.equal(c.entry.destructive, kind.endsWith('_delete'), kind);
    if (kind.endsWith('_delete')) assert.equal(c.entry.nameField, 'name', kind);
  }
  const rule = classifyProductOp(ruleUpdate(R_ALLOW), PLAN).entry;
  for (const field of ['id', 'created_at', 'updated_at', 'deleted_at', 'version', 'read_only', 'source_account', 'warning_status']) {
    assert.ok(rule.readOnlyFields.includes(field), field);
  }
  assert.ok(!rule.readOnlyFields.includes('precedence'));
  for (const [method, rest] of [
    ['PUT', '/gateway/configuration'],
    ['PATCH', `/gateway/lists/${L_BLOCKED}`],
    ['PATCH', `/gateway/rules/${R_ALLOW}`],
    ['PUT', '/gateway/rules'],
    ['DELETE', '/gateway/configuration'],
  ]) {
    assert.equal(classifyProductOp({ method, path: `${BASE}${rest}` }, PLAN), null, `${method} ${rest}`);
    assert.throws(() => validateOpTargets([{ method, path: `${BASE}${rest}`, body: {} }], PLAN), { code: 'invalid_op' }, `${method} ${rest}`);
  }
  assert.equal(classifyProductOp(ruleCreate(), { scope: 'zone', zone_id: 'fedcba9876543210fedcba9876543210' }), null);
});

test('rule, list, location and configuration bodies are validated (invalid_op)', () => {
  validateOpTargets([ruleCreate()], PLAN);
  for (const fields of [{ name: '' }, { action: undefined }, { filters: [] }, { filters: 'dns' }, { traffic: 7 }, { precedence: 1.5 }]) {
    assert.throws(() => validateOpTargets([ruleCreate(fields)], PLAN), { code: 'invalid_op' }, JSON.stringify(fields));
  }
  assert.throws(() => validateOpTargets([{ method: 'POST', path: `${GW}/lists`, body: { name: 'x', items: [] } }], PLAN), { code: 'invalid_op' });
  validateOpTargets([{ method: 'POST', path: `${GW}/lists`, body: { name: 'x', type: 'DOMAIN', items: [{ value: 'a.example.com' }] } }], PLAN);
  assert.throws(() => validateOpTargets([listUpdate(L_BLOCKED, { name: 'Blocked domains', items: [] })], PLAN), (e) => e.code === 'invalid_op' && /items/.test(e.message));
  assert.throws(() => validateOpTargets([listUpdate(L_BLOCKED, { name: 'x', items: ['a.example.com'] })], PLAN), { code: 'invalid_op' });
  validateOpTargets([listUpdate(L_BLOCKED, { name: 'Blocked domains', description: 'renamed' })], PLAN);
  assert.throws(() => validateOpTargets([{ method: 'POST', path: `${GW}/locations`, body: {} }], PLAN), { code: 'invalid_op' });
  const patch = (body) => [{ method: 'PATCH', path: `${GW}/configuration`, body }];
  validateOpTargets(patch({ settings: { tls_decrypt: { enabled: true } } }), PLAN);
  assert.throws(() => validateOpTargets(patch({ settings: {}, extra: 1 }), PLAN), { code: 'invalid_op' });
  assert.throws(() => validateOpTargets(patch({ tls_decrypt: { enabled: true } }), PLAN), { code: 'invalid_op' });
});

test('a list create or update with more than 1000 items is too_large', () => {
  const create = (n) => [{ method: 'POST', path: `${GW}/lists`, body: { name: 'big', type: 'DOMAIN', items: values(n) } }];
  validateOpTargets(create(1000), PLAN);
  assert.throws(() => validateOpTargets(create(1001), PLAN), (e) => e instanceof CfError && e.code === 'too_large' && /1001/.test(e.message) && /1000/.test(e.message));
  validateOpTargets([listUpdate(L_BLOCKED, { name: 'Blocked domains', items: values(1000) })], PLAN);
  assert.throws(() => validateOpTargets([listUpdate(L_BLOCKED, { name: 'Blocked domains', items: values(1001) })], PLAN), { code: 'too_large' });
});

test('two precedence changes in one phase out of ascending order are plan_conflict', () => {
  assert.throws(
    () => validatePlanOps([ruleUpdate(R_LISTED, { precedence: 30 }), ruleCreate({ precedence: 15 })], PLAN),
    (e) => e.code === 'plan_conflict' && /precedence/.test(e.message) && /dns/.test(e.message),
  );
  assert.throws(() => validatePlanOps([ruleUpdate(R_LISTED, { precedence: 30 }), ruleUpdate(R_ALLOW, { action: 'allow', precedence: 30 })], PLAN), { code: 'plan_conflict' });
  validatePlanOps([ruleCreate({ precedence: 15 }), ruleUpdate(R_LISTED, { precedence: 30 })], PLAN);
  // Different phases keep their own order.
  validatePlanOps([ruleUpdate(R_LISTED, { precedence: 30 }), ruleCreate({ precedence: 15, filters: ['http'] })], PLAN);
});

test('a list delete is refused while a rule references it, also when that rule is past the first page', async () => {
  // 60 rules: the referencing rule is number 56, past the first page of 50.
  const rules = Array.from({ length: 60 }, (_, i) => ({
    ...fx('rules')[1], id: `aaaaaaaa-1111-4000-8000-0000000001${String(i).padStart(2, '0')}`, name: `rule ${i}`, precedence: 100 + i,
  }));
  rules[55] = { ...fx('rules')[2], id: R_LISTED, precedence: 155 };
  const used = await preflight([listDelete(L_BLOCKED, 'Blocked domains')], { rules });
  const dep = used.checks.find((c) => c.name === 'dependencies');
  assert.equal(dep?.ok, false, JSON.stringify(used.checks));
  assert.equal(dep.code, 'resource_in_use');
  assert.match(dep.detail, /Block listed domains/);
  assert.match(dep.detail, new RegExp(R_LISTED));
  // An earlier op of the same plan that deletes the rule clears the use.
  const cleared = await preflight([ruleDelete(R_LISTED, 'Block listed domains'), listDelete(L_BLOCKED, 'Blocked domains')], { rules });
  assert.deepEqual(cleared.checks.filter((c) => !c.ok), []);
  const late = await preflight([listDelete(L_BLOCKED, 'Blocked domains'), ruleDelete(R_LISTED, 'Block listed domains')], { rules });
  assert.equal(late.checks.find((c) => c.name === 'dependencies').code, 'resource_in_use');
  // An earlier rule create that references the list makes it used.
  const added = await preflight([ruleCreate({ traffic: `any(dns.domains[*] in $${L_OLD})` }), listDelete(L_OLD, 'Old office IPs')]);
  assert.equal(added.checks.find((c) => c.name === 'dependencies').code, 'resource_in_use');
  const unused = await preflight([listDelete(L_OLD, 'Old office IPs')]);
  assert.deepEqual(unused.checks.filter((c) => !c.ok), []);
});

test('a block rule matching all traffic is a Lockout risk line', async () => {
  for (const traffic of ['', '   ', 'any(dns.domains[*] matches ".*")']) {
    const report = await preflight([ruleCreate({ name: 'Block all', traffic })]);
    assert.deepEqual(report.checks.filter((c) => !c.ok), []);
    assert.equal(report.lockout_risks.length, 1, JSON.stringify(traffic));
    assert.match(report.lockout_risks[0], /^Lockout risk: Gateway block rule Block all .*all (DNS )?traffic/);
  }
  // An allow rule, a disabled block rule and an IP block do not lock anyone out.
  assert.deepEqual((await preflight([ruleCreate({ name: 'Allow all', action: 'allow', traffic: '' })])).lockout_risks, []);
  assert.deepEqual((await preflight([ruleCreate({ enabled: false, traffic: '' })])).lockout_risks, []);
  assert.deepEqual((await preflight([ruleCreate({ filters: ['l4'], traffic: 'net.dst.ip == 192.0.2.1' })])).lockout_risks, []);
});

test('a block rule matching Cloudflare or identity provider domains is a Lockout risk line', async () => {
  const cases = [
    ['any(dns.domains[*] == "cloudflare.com")', /cloudflare\.com/],
    ['any(dns.domains[*] in {"example.net" "cloudflareclient.com"})', /cloudflareclient\.com/],
    ['dns.fqdn == "example-team.cloudflareaccess.com"', /cloudflareaccess\.com/],
    ['dns.fqdn == "example-org.okta.com"', /example-org\.okta\.com.*Okta/],
    ['http.request.host in {"login.microsoftonline.com"}', /login\.microsoftonline\.com.*Microsoft Entra ID/],
    ['any(dns.domains[*] == "com")', /cloudflare\.com/],
  ];
  for (const [traffic, pattern] of cases) {
    const report = await preflight([ruleCreate({ name: 'Risky', traffic, filters: [traffic.startsWith('http') ? 'http' : 'dns'] })]);
    assert.equal(report.lockout_risks.length, 1, traffic);
    assert.match(report.lockout_risks[0], /^Lockout risk: Gateway block rule Risky /);
    assert.match(report.lockout_risks[0], pattern, traffic);
  }
  assert.deepEqual((await preflight([ruleCreate({ traffic: 'any(dns.domains[*] == "ads.example.net")' })])).lockout_risks, []);
  // A list update that puts a Cloudflare domain into a list a block rule uses.
  const listOp = listUpdate(L_BLOCKED, { name: 'Blocked domains', items: [{ value: 'ads.example.net' }, { value: 'cloudflareaccess.com' }] });
  const report = await preflight([listOp]);
  assert.equal(report.lockout_risks.length, 1);
  assert.match(report.lockout_risks[0], /Block listed domains.*cloudflareaccess\.com/);
});

test('a block rule placed above an allow rule with an overlapping selector is a Lockout risk line', async () => {
  const above = await preflight([ruleCreate({ name: 'Block example', traffic: 'any(dns.domains[*] == "example.com")', precedence: 5 })]);
  assert.equal(above.lockout_risks.length, 1);
  assert.match(above.lockout_risks[0], /^Lockout risk: Gateway block rule Block example now runs before allow rule Allow partner portal/);
  // Below the allow rule, the allow still wins.
  const below = await preflight([ruleCreate({ name: 'Block example', traffic: 'any(dns.domains[*] == "example.com")', precedence: 15 })]);
  assert.deepEqual(below.lockout_risks, []);
  // Not overlapping: no line.
  const apart = await preflight([ruleCreate({ name: 'Block other', traffic: 'any(dns.domains[*] == "example.net")', precedence: 5 })]);
  assert.deepEqual(apart.lockout_risks, []);
  // Moving the allow rule below a block rule whose expression cannot be analyzed.
  const moved = await preflight([ruleUpdate(R_ALLOW, { name: 'Allow partner portal', action: 'allow', traffic: 'any(dns.domains[*] == "partner.example.com")', precedence: 25 })]);
  assert.equal(moved.lockout_risks.length, 1);
  assert.match(moved.lockout_risks[0], /allow rule Allow partner portal now runs after block rule Block security threats, whose traffic expression could not be analyzed/);
});

test('an expression the matcher cannot analyze gets the generic line, never silence', async () => {
  for (const traffic of ['any(dns.content_category[*] in {1 4})', 'any(dns.domains[*] == "a.example.com") and dns.fqdn == "b.example.com"', 'not(any(dns.domains[*] == "x.example.com"))']) {
    const report = await preflight([ruleCreate({ name: 'Odd rule', traffic })]);
    assert.deepEqual(report.lockout_risks, [
      'Lockout risk: could not analyze traffic expression of rule Odd rule; check it does not block Cloudflare or IdP domains',
    ], traffic);
  }
});

test('an identity provider read refused with 403 names the permission', async () => {
  const report = await preflight([ruleCreate({ traffic: 'any(dns.domains[*] == "ads.example.net")' })], { deny: [`${BASE}/access/identity_providers`] });
  const gather = report.checks.find((c) => c.name === 'gather');
  assert.equal(gather.ok, false);
  assert.equal(gather.code, 'missing_permission');
  assert.match(gather.detail, /access\/identity_providers/);
  assert.match(gather.detail, /Access: Organizations, Identity Providers, and Groups Read/);
});

test('no Zero Trust organization is not_entitled', async () => {
  const report = await preflight([ruleCreate({ traffic: 'any(dns.domains[*] == "ads.example.net")' })], { org: null });
  const ent = report.checks.find((c) => c.name === 'entitlement');
  assert.equal(ent.ok, false);
  assert.equal(ent.code, 'not_entitled');
});

test('rule update: reformatted traffic passes read-back, drift compares the returned form, rollback restores precedence', async (t) => {
  const sent = 'any(dns.domains[*]=="partner.example.com")';
  const op = ruleUpdate(R_ALLOW, { name: 'Allow partner portal', action: 'allow', traffic: sent, precedence: 12 });
  const { cwd, plan } = setup(t, [op]);
  const api = fakeApi();
  approve(cwd, plan);
  const applied = await applyPlan(cwd, api, plan.id, T0, fastVerify());
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  assert.equal(api.store.get(`${GW}/rules/${R_ALLOW}`).traffic, 'any(dns.domains[*] == "partner.example.com")');
  const readback = applied.results[0].verify.checks.find((c) => c.name === 'readback');
  assert.equal(readback.ok, true);
  assert.match(readback.detail, /dig partner\.example\.com/);
  assert.ok(readback.detail.endsWith(HONESTY), readback.detail);

  const rollback = createRollbackPlan(cwd, plan.id, T1);
  assert.equal(rollback.ops.length, 1);
  assert.equal(rollback.ops[0].method, 'PUT');
  assert.equal(rollback.ops[0].body.precedence, 10);
  assert.equal(rollback.ops[0].body.traffic, fx('rules')[0].traffic);
  assert.ok(!('version' in rollback.ops[0].body) && !('id' in rollback.ops[0].body));
  assert.equal(rollback.ops[0].precheck.group, 'gateway-phase:dns');
  assert.equal(rollback.ops[0].precheck.expect.traffic, 'any(dns.domains[*] == "partner.example.com")');
  approve(cwd, rollback, T1);
  const ran = await applyPlan(cwd, api, rollback.id, T1, fastVerify());
  assert.equal(ran.status, 'applied', JSON.stringify(ran.results));
  assert.equal(api.store.get(`${GW}/rules/${R_ALLOW}`).precedence, 10);
});

test('verify fails when the returned traffic differs beyond formatting', async () => {
  const { GATEWAY } = await import('../scripts/lib/products/gateway.mjs');
  const op = ruleCreate({ traffic: 'any(dns.domains[*]  ==  "ads.example.net")' });
  const { entry } = classifyProductOp(op, PLAN);
  const check = (traffic) => GATEWAY.verifyChecks(op, entry, {}, { id: NEW_RULE }, { ...op.body, id: NEW_RULE, traffic }, {})
    .find((c) => c.name === 'readback').run();
  const same = await check('any(dns.domains[*] == "ads.example.net")');
  assert.equal(same.ok, true, same.detail);
  const other = await check('any(dns.domains[*] == "other.example.net")');
  assert.equal(other.ok, false);
  assert.match(other.detail, /traffic/);
  assert.ok(other.detail.endsWith(HONESTY));
  const none = await GATEWAY.verifyChecks(op, entry, {}, { id: NEW_RULE }, null, {})[0].run();
  assert.equal(none.ok, false);
  assert.ok(none.detail.endsWith(HONESTY));
  assert.deepEqual(GATEWAY.verifyChecks(ruleDelete(R_ALLOW, 'x'), classifyProductOp(ruleDelete(R_ALLOW, 'x'), PLAN).entry, {}, {}, null, {}), []);
});

test('rule delete rollback re-creates the rule with its precedence in the phase group', async (t) => {
  const op = ruleDelete(R_LISTED, 'Block listed domains');
  const { cwd, plan } = setup(t, [op]);
  const api = fakeApi();
  const report = await runProductPreflight(api, PLAN, [op]);
  assert.deepEqual(report.checks.filter((c) => !c.ok), []);
  assert.match(withIrreversibleRisk('Delete rule', [op], PLAN, report.ctx), /re-creates.*precedence 30/);
  approve(cwd, plan);
  const applied = await applyPlan(cwd, api, plan.id, T0, fastVerify());
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  const rollback = createRollbackPlan(cwd, plan.id, T1);
  assert.equal(rollback.ops.length, 1);
  const [recreate] = rollback.ops;
  assert.equal(recreate.method, 'POST');
  assert.equal(recreate.path, `${GW}/rules`);
  assert.equal(recreate.body.precedence, 30);
  assert.deepEqual(recreate.body.filters, ['dns']);
  assert.equal(recreate.body.traffic, fx('rules')[2].traffic);
  for (const field of ['id', 'version', 'created_at', 'updated_at', 'read_only']) assert.ok(!(field in recreate.body), field);
  assert.equal(recreate.precheck.group, 'gateway-phase:dns');
  assert.deepEqual(recreate.precheck.expect, { absent: true });
  approve(cwd, rollback, T1);
  const ran = await applyPlan(cwd, api, rollback.id, T1, fastVerify());
  assert.equal(ran.status, 'applied', JSON.stringify(ran.results));
  assert.equal(api.store.get(`${GW}/rules/${NEW_RULE}`).precedence, 30);
});

test('list update rollback restores the items; list delete rollback re-creates the list with its items', async (t) => {
  const update = listUpdate(L_BLOCKED, { name: 'Blocked domains', description: 'Domains blocked for every user', items: [{ value: 'new.example.net' }] });
  const { cwd, plan } = setup(t, [update]);
  const api = fakeApi();
  approve(cwd, plan);
  const applied = await applyPlan(cwd, api, plan.id, T0, fastVerify());
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  assert.ok(applied.results[0].verify.checks.every((c) => c.ok), JSON.stringify(applied.results[0].verify));
  assert.deepEqual(api.items.get(L_BLOCKED).map((i) => i.value), ['new.example.net']);
  const rollback = createRollbackPlan(cwd, plan.id, T1);
  assert.deepEqual(rollback.ops.map((o) => `${o.method} ${o.path}`), [`PUT ${GW}/lists/${L_BLOCKED}`]);
  assert.deepEqual(rollback.ops[0].body, {
    name: 'Blocked domains',
    description: 'Domains blocked for every user',
    items: [{ value: 'ads.example.net' }, { value: 'tracker.example.org', description: 'analytics' }],
  });
  approve(cwd, rollback, T1);
  const ran = await applyPlan(cwd, api, rollback.id, T1, fastVerify());
  assert.equal(ran.status, 'applied', JSON.stringify(ran.results));
  assert.deepEqual(api.items.get(L_BLOCKED).map((i) => i.value), ['ads.example.net', 'tracker.example.org']);

  const del = listDelete(L_OLD, 'Old office IPs');
  const second = setup(t, [del]);
  approve(second.cwd, second.plan);
  assert.equal((await applyPlan(second.cwd, api, second.plan.id, T0, fastVerify())).status, 'applied');
  const back = createRollbackPlan(second.cwd, second.plan.id, T1);
  assert.deepEqual(back.ops.map((o) => `${o.method} ${o.path}`), [`POST ${GW}/lists`]);
  assert.deepEqual(back.ops[0].body, { name: 'Old office IPs', description: '', type: 'IP', items: [{ value: '192.0.2.0/24' }] });
});

test('a list update that filled an empty list cannot be rolled back with PUT', () => {
  const entry = {
    product: 'gateway', kind: 'gateway_list_update', path: `${GW}/lists/${L_OLD}`, invertible: true,
    before: { id: L_OLD, name: 'Old office IPs', type: 'IP', items: [] }, op_body_keys: ['name', 'items'],
  };
  assert.throws(() => inverseForProduct(entry, {}), (e) => e.code === 'rollback_ambiguous' && /empty/.test(e.message));
  // Without items in the op body the PUT leaves the items alone.
  assert.deepEqual(inverseForProduct({ ...entry, op_body_keys: ['name'] }, {}), [{ method: 'PUT', path: entry.path, body: { name: 'Old office IPs' } }]);
});

test('location delete note names the DoH subdomain and IPs; TLS decryption on is a Lockout line (Ruling 20)', async () => {
  const del = { method: 'DELETE', path: `${GW}/locations/${LOC}`, confirm_name: 'Head office' };
  const report = await preflight([del]);
  assert.deepEqual(report.checks.filter((c) => !c.ok), []);
  const risk = withIrreversibleRisk('Delete location', [del], PLAN, report.ctx);
  assert.match(risk, /a1b2c3d4e5/);
  assert.match(risk, /172\.64\.36\.1/);
  assert.match(risk, /new DoH subdomain/);
  const tls = { method: 'PATCH', path: `${GW}/configuration`, body: { settings: { tls_decrypt: { enabled: true } } } };
  const tlsReport = await preflight([tls]);
  assert.equal(tlsReport.lockout_risks.length, 1);
  assert.match(tlsReport.lockout_risks[0], /^Lockout risk: turning on TLS decryption .*certificate pinning/);
  // Already on: no note.
  const off = { method: 'PATCH', path: `${GW}/configuration`, body: { settings: { tls_decrypt: { enabled: false } } } };
  assert.deepEqual((await preflight([off])).lockout_risks, []);
});

// ---------- fix round 1 ----------

const configPatch = (settings) => ({ method: 'PATCH', path: `${GW}/configuration`, body: { settings } });

test('config rollback restores only the subcollections the op set, with the previous values', async (t) => {
  const op = configPatch({ block_page: { enabled: true, footer_text: 'Blocked' } });
  const { cwd, plan } = setup(t, [op]);
  const api = fakeApi();
  approve(cwd, plan);
  assert.equal((await applyPlan(cwd, api, plan.id, T0, fastVerify())).status, 'applied');
  const rollback = createRollbackPlan(cwd, plan.id, T1);
  assert.deepEqual(rollback.ops.map((o) => `${o.method} ${o.path}`), [`PATCH ${GW}/configuration`]);
  assert.deepEqual(rollback.ops[0].body, { settings: { block_page: { enabled: false } } });
  approve(cwd, rollback, T1);
  assert.equal((await applyPlan(cwd, api, rollback.id, T1, fastVerify())).status, 'applied');
  assert.deepEqual(api.store.get(`${GW}/configuration`).settings, fx('configuration').settings);
});

test('config rollback of a subcollection absent before sends its documented off value, else is not reversible', async () => {
  const entry = (settings, keys = Object.keys(settings)) => ({
    product: 'gateway', kind: 'gateway_config_patch', path: `${GW}/configuration`, invertible: true, op_body_keys: ['settings'],
    before: { settings: Object.fromEntries(keys.map((k) => [k, settings[k] ?? null])) },
  });
  assert.deepEqual(inverseForProduct(entry({ tls_decrypt: null }), {}), [
    { method: 'PATCH', path: `${GW}/configuration`, body: { settings: { tls_decrypt: { enabled: false } } } },
  ]);
  assert.deepEqual(inverseForProduct(entry({ tls_decrypt: { enabled: false }, protocol_detection: null }), {})[0].body, {
    settings: { tls_decrypt: { enabled: false }, protocol_detection: { enabled: false } },
  });
  assert.throws(() => inverseForProduct(entry({ custom_certificate: null }), {}), (e) => e.code === 'rollback_ambiguous' && /custom_certificate/.test(e.message));
  // The plan says so before approval.
  const op = configPatch({ custom_certificate: { enabled: true, id: 'd1b364c5-1311-466e-a194-f0e943e0799f' } });
  const report = await preflight([op]);
  assert.match(withIrreversibleRisk('Custom certificate', [op], PLAN, report.ctx), /Not reversible: PATCH .*settings\.custom_certificate/);
  const tls = configPatch({ tls_decrypt: { enabled: true } });
  assert.doesNotMatch(withIrreversibleRisk('TLS', [tls], PLAN, report.ctx), /Not reversible/);
});

test('two rule moves in one phase roll back to the old order (phase precedence snapshot, Ruling 22)', async (t) => {
  const ops = [
    ruleUpdate(R_LISTED, { name: 'Block listed domains', traffic: fx('rules')[2].traffic, precedence: 15 }),
    ruleUpdate(R_ALLOW, { name: 'Allow partner portal', action: 'allow', traffic: fx('rules')[0].traffic, precedence: 25 }),
  ];
  const api = fakeApi();
  const report = await runProductPreflight(api, PLAN, ops);
  const { cwd, plan } = setup(t, ops, { lockout_risks: report.lockout_risks });
  approve(cwd, plan);
  assert.equal((await applyPlan(cwd, api, plan.id, T0, fastVerify())).status, 'applied');
  const rollback = createRollbackPlan(cwd, plan.id, T1);
  assert.deepEqual(rollback.ops.map((o) => `${o.method} ${o.path} ${o.body.precedence}`), [
    `PUT ${GW}/rules/${R_ALLOW} 10`,
    `PUT ${GW}/rules/${R_LISTED} 30`,
  ]);
  assert.ok(rollback.ops.every((o) => o.precheck.group === 'gateway-phase:dns' && !('phase_precedence' in o.body) && !('phase_rules' in o.body)));
  approve(cwd, rollback, T1);
  const ran = await applyPlan(cwd, api, rollback.id, T1, fastVerify());
  assert.equal(ran.status, 'applied', JSON.stringify(ran.results));
  const prec = (id) => api.store.get(`${GW}/rules/${id}`).precedence;
  assert.deepEqual([prec(R_ALLOW), prec(R_THREAT), prec(R_LISTED)], [10, 20, 30]);
});

test('a rule the API shifted on a precedence collision is moved back; one moved after apply is rollback_drift', async (t) => {
  const op = ruleUpdate(R_ALLOW, { name: 'Allow partner portal', action: 'allow', traffic: fx('rules')[0].traffic, precedence: 20 });
  const run = async (afterApply) => {
    const api = fakeApi({ shift: true });
    const report = await runProductPreflight(api, PLAN, [op]);
    const { cwd, plan } = setup(t, [op], { lockout_risks: report.lockout_risks });
    approve(cwd, plan);
    assert.equal((await applyPlan(cwd, api, plan.id, T0, fastVerify())).status, 'applied');
    // The API pushed the threat rule from 20 to 21.
    assert.equal(api.store.get(`${GW}/rules/${R_THREAT}`).precedence, 21);
    afterApply(api);
    const rollback = createRollbackPlan(cwd, plan.id, T1);
    assert.deepEqual(rollback.ops.map((o) => `${o.method} ${o.path} ${o.body.precedence}`), [
      `PUT ${GW}/rules/${R_ALLOW} 10`,
      `PUT ${GW}/rules/${R_THREAT} 20`,
    ]);
    assert.equal(rollback.ops[1].precheck.read, `${GW}/rules/${R_THREAT}`);
    assert.equal(rollback.ops[1].precheck.expect.precedence, 21);
    assert.equal(rollback.ops[1].precheck.group, 'gateway-phase:dns');
    approve(cwd, rollback, T1);
    return { api, ran: await applyPlan(cwd, api, rollback.id, T1, fastVerify()) };
  };
  const clean = await run(() => {});
  assert.equal(clean.ran.status, 'applied', JSON.stringify(clean.ran.results));
  assert.equal(clean.api.store.get(`${GW}/rules/${R_THREAT}`).precedence, 20);
  assert.equal(clean.api.store.get(`${GW}/rules/${R_ALLOW}`).precedence, 10);

  const moved = await run((api) => {
    api.store.set(`${GW}/rules/${R_THREAT}`, { ...api.store.get(`${GW}/rules/${R_THREAT}`), precedence: 99 });
  });
  assert.equal(moved.ran.status, 'partially_applied');
  assert.equal(moved.ran.results[1].reason, 'rollback_drift');
  assert.equal(moved.api.store.get(`${GW}/rules/${R_THREAT}`).precedence, 99);
});

test('a new block rule without precedence has an unknown place: variant line when it overlaps an allow rule', async () => {
  const op = { method: 'POST', path: `${GW}/rules`, body: { name: 'Block example', action: 'block', enabled: true, filters: ['dns'], traffic: 'any(dns.domains[*] == "example.com")' } };
  const report = await preflight([op]);
  assert.equal(report.lockout_risks.length, 1);
  assert.match(report.lockout_risks[0], /^Lockout risk: Gateway block rule Block example has no precedence, so it may run before allow rule Allow partner portal/);
  const apart = { ...op, body: { ...op.body, traffic: 'any(dns.domains[*] == "example.net")' } };
  assert.deepEqual((await preflight([apart])).lockout_risks, []);
});
