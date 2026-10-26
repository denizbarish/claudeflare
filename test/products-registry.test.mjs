import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { validateOpTargets, validatePlanOps, validateProductFields } from '../scripts/lib/resources.mjs';
import { PRODUCTS, registerProduct, classifyProductOp, baseFor } from '../scripts/lib/products/index.mjs';
import { CfError } from '../scripts/lib/errors.mjs';

const A = '0123456789abcdef0123456789abcdef';
const Z = 'fedcba9876543210fedcba9876543210';
const UUID = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';
const UUID2 = '1a1b2c3d-4e5f-6789-abcd-ef0123456789';
const acctPlan = { scope: 'account', account_id: A, project_dir: null };
const zonePlan = { scope: 'zone', zone_id: Z };
const THING = `/accounts/${A}/fake/things/${UUID}`;

const thingKey = (m) => ({ type: 'fake_thing', id: m[1] });
const fake = {
  product: 'fake',
  kinds: [
    { kind: 'fake_thing_create', product: 'fake', scope: 'account', methods: ['POST'], pattern: /^\/fake\/things$/, resource: () => null, readOnlyFields: ['id'], inverse: 'delete_created', destructive: false, secretFields: ['config.client_secret', 'rules.*.secret'] },
    { kind: 'fake_thing_update', product: 'fake', scope: 'account', methods: ['PUT'], pattern: /^\/fake\/things\/([0-9a-f-]{36})$/, resource: thingKey, readOnlyFields: ['id'], inverse: 'put_before', destructive: false },
    { kind: 'fake_thing_patch', product: 'fake', scope: 'account', methods: ['PATCH'], pattern: /^\/fake\/things\/([0-9a-f-]{36})$/, resource: thingKey, readOnlyFields: ['id'], inverse: 'patch_before', destructive: false },
    { kind: 'fake_thing_delete', product: 'fake', scope: 'account', methods: ['DELETE'], pattern: /^\/fake\/things\/([0-9a-f-]{36})$/, resource: thingKey, readOnlyFields: ['id'], inverse: 'recreate', destructive: true, nameField: 'name' },
    { kind: 'fake_lb_delete', product: 'fake', scope: 'zone', methods: ['DELETE'], pattern: /^\/fake_lbs\/([0-9a-f]{32})$/, resource: (m) => ({ type: 'fake_lb', id: m[1] }), readOnlyFields: [], inverse: 'recreate', destructive: true, nameField: 'name' },
  ],
  probePath: (base) => `${base}/fake/things`,
  gather: async () => ({}),
  lockoutRisks: () => [],
  verifyChecks: () => [],
  conflicts(ops, classified) {
    ops.forEach((op, i) => {
      if (classified[i] && op.body?.conflict) throw new CfError('plan_conflict', `fake conflict at op ${i}`);
    });
  },
};
const unregister = registerProduct(fake);
after(unregister);

const code = (c) => (err) => err.code === c;

test('registerProduct adds the module and the unregister function removes it', () => {
  assert.ok(PRODUCTS.includes(fake));
  const other = { product: 'other', kinds: [] };
  const drop = registerProduct(other);
  assert.ok(PRODUCTS.includes(other));
  drop();
  assert.ok(!PRODUCTS.includes(other));
});

test('baseFor maps scope to the account or zone base', () => {
  assert.equal(baseFor(acctPlan), `/accounts/${A}`);
  assert.equal(baseFor(zonePlan), `/zones/${Z}`);
  assert.equal(baseFor({ zone_id: Z }), `/zones/${Z}`);
});

test('classifyProductOp matches scope, method and the path after the base', () => {
  const hit = classifyProductOp({ method: 'PUT', path: THING }, acctPlan);
  assert.equal(hit.entry.kind, 'fake_thing_update');
  assert.equal(hit.module, fake);
  assert.equal(hit.match[1], UUID);
  assert.equal(hit.base, `/accounts/${A}`);
  assert.equal(classifyProductOp({ method: 'GET', path: THING }, acctPlan), null);
  assert.equal(classifyProductOp({ method: 'PUT', path: `/accounts/${'1'.repeat(32)}/fake/things/${UUID}` }, acctPlan), null);
  assert.equal(classifyProductOp({ method: 'PUT', path: `/zones/${Z}/fake/things/${UUID}` }, zonePlan), null);
  assert.equal(classifyProductOp({ method: 'DELETE', path: `/zones/${Z}/fake_lbs/${A}` }, zonePlan).entry.kind, 'fake_lb_delete');
  assert.equal(classifyProductOp({ method: 'PUT', path: THING }, undefined), null);
});

test('account op matching a registered kind is accepted', () => {
  validateOpTargets([{ method: 'PUT', path: THING, body: {} }], acctPlan);
});

test('unknown account write path is invalid_op', () => {
  assert.throws(() => validateOpTargets([{ method: 'POST', path: `/accounts/${A}/members` }], acctPlan), { code: 'invalid_op' });
});

test('Pages rollback op still accepted (0.2.x plans)', () => {
  const op = { method: 'POST', path: `/accounts/${A}/pages/projects/my-site/deployments/${UUID}/rollback` };
  validateOpTargets([op], acctPlan);
  validateOpTargets([op], { ...acctPlan, project_dir: '/tmp/site' });
  validatePlanOps([op], acctPlan);
});

test('zone-scoped access path is refused with a hint to the account form', () => {
  assert.throws(() => validateOpTargets([{ method: 'POST', path: `/zones/${Z}/access/apps`, body: {} }], zonePlan), (e) => e.code === 'invalid_op' && /\/accounts\/<account_id>\/access/.test(e.message));
  assert.throws(() => validateOpTargets([{ method: 'DELETE', path: `/zones/${Z}/access` }], zonePlan), code('invalid_op'));
});

test('other zone writes keep the v1 open policy', () => {
  validateOpTargets([{ method: 'POST', path: `/zones/${Z}/dns_records`, body: {} }], zonePlan);
  validateOpTargets([{ method: 'PATCH', path: `/zones/${Z}/access_rules_custom/x`, body: {} }], zonePlan);
  assert.throws(() => validateOpTargets([{ method: 'POST', path: `/zones/${Z}/pagerules`, body: {} }], zonePlan), code('invalid_op'));
});

test('zone product kinds get field validation too', () => {
  const path = `/zones/${Z}/fake_lbs/${A}`;
  assert.throws(() => validateOpTargets([{ method: 'DELETE', path }], zonePlan), code('invalid_op'));
  validateOpTargets([{ method: 'DELETE', path, confirm_name: 'lb1' }], zonePlan);
});

test('product op mixed with a wrangler op is plan_conflict', () => {
  const wrangler = { kind: 'wrangler', args: ['deploy', '--name', 'api'], worker: 'api' };
  assert.throws(() => validatePlanOps([{ method: 'PUT', path: THING, body: {} }, wrangler], { ...acctPlan, project_dir: '/tmp/p' }), code('plan_conflict'));
  assert.throws(() => validatePlanOps([wrangler, { method: 'PUT', path: THING, body: {} }], { ...acctPlan, project_dir: '/tmp/p' }), code('plan_conflict'));
});

test('destructive kind without confirm_name is invalid_op', () => {
  assert.throws(() => validateOpTargets([{ method: 'DELETE', path: THING }], acctPlan), (e) => e.code === 'invalid_op' && /confirm_name/.test(e.message));
  assert.throws(() => validateOpTargets([{ method: 'DELETE', path: THING, confirm_name: '' }], acctPlan), code('invalid_op'));
  assert.throws(() => validateOpTargets([{ method: 'DELETE', path: THING, confirm_name: 7 }], acctPlan), code('invalid_op'));
  validateOpTargets([{ method: 'DELETE', path: THING, confirm_name: 'thing-1' }], acctPlan);
});

test('literal value in a secretFields path is invalid_op', () => {
  const path = `/accounts/${A}/fake/things`;
  const msg = (e) => e.code === 'invalid_op' && !e.message.includes('hunter2');
  assert.throws(() => validateOpTargets([{ method: 'POST', path, body: { config: { client_secret: 'hunter2' } } }], acctPlan), msg);
  assert.throws(() => validateOpTargets([{ method: 'POST', path, body: { rules: [{ name: 'a' }, { secret: 'hunter2' }] } }], acctPlan), msg);
  validateOpTargets([{ method: 'POST', path, body: { config: { client_id: 'abc' }, rules: [{ name: 'a' }] } }], acctPlan);
});

test('secret_fields_from_env must map declared secretFields to env var names matching /^[A-Z_][A-Z0-9_]*$/', () => {
  const path = `/accounts/${A}/fake/things`;
  const op = (map) => ({ method: 'POST', path, body: { config: {} }, secret_fields_from_env: map });
  validateOpTargets([op({ 'config.client_secret': 'OKTA_CLIENT_SECRET' })], acctPlan);
  validateOpTargets([op({ 'rules.*.secret': '_X1' })], acctPlan);
  for (const bad of [{ 'config.client_id': 'OKTA' }, { 'config.client_secret': 'okta' }, { 'config.client_secret': '1OKTA' }, { 'config.client_secret': '' }, { 'config.client_secret': 5 }, [], 'OKTA', null]) {
    assert.throws(() => validateOpTargets([op(bad)], acctPlan), code('invalid_op'), JSON.stringify(bad));
  }
  // A kind without secretFields accepts no map at all.
  assert.throws(() => validateOpTargets([{ method: 'PUT', path: THING, body: {}, secret_fields_from_env: { 'config.client_secret': 'X' } }], acctPlan), code('invalid_op'));
});

test('verify.expect accepts access_login, status:<100-599>, tunnel_serving, pool_healthy, tcp_open only', () => {
  const run = (verify) => validateOpTargets([{ method: 'PUT', path: THING, body: {}, verify }], acctPlan);
  for (const ok of [
    { expect: 'access_login', url: 'https://wiki.example.com/' },
    { expect: 'status:200', url: 'http://example.com/health' },
    { expect: 'status:100', url: 'https://example.com/' },
    { expect: 'status:599', url: 'https://example.com/' },
    { expect: 'tunnel_serving' },
    { expect: 'pool_healthy' },
    { expect: 'tunnel_serving', url: 'https://app.example.com/' },
    { expect: 'tcp_open', url: 'https://ssh.example.com:22/' },
  ]) run(ok);
  for (const bad of [
    { expect: 'status:99', url: 'https://example.com/' },
    { expect: 'status:600', url: 'https://example.com/' },
    { expect: 'status:2000', url: 'https://example.com/' },
    { expect: 'status:20a', url: 'https://example.com/' },
    { expect: 'status:', url: 'https://example.com/' },
    { expect: 'up', url: 'https://example.com/' },
    { expect: 'access_login' },
    { expect: 'status:200' },
    { expect: 'tcp_open' },
    { expect: 'access_login', url: 'ftp://example.com/' },
    { expect: 'access_login', url: 'not a url' },
    { expect: 'access_login', url: 42 },
    { expect: 'pool_healthy', extra: 1 },
    { url: 'https://example.com/' },
    'access_login',
    null,
    [],
  ]) assert.throws(() => run(bad), code('invalid_op'), JSON.stringify(bad));
});

test('v3 op fields on a non-product op are invalid_op', () => {
  assert.throws(() => validateOpTargets([{ method: 'POST', path: `/zones/${Z}/dns_records`, body: {}, verify: { expect: 'pool_healthy' } }], zonePlan), code('invalid_op'));
  assert.throws(() => validateOpTargets([{ method: 'POST', path: `/zones/${Z}/dns_records`, body: {}, confirm_name: 'x' }], zonePlan), code('invalid_op'));
});

test('validateProductFields reports the op index', () => {
  const entry = fake.kinds[3];
  assert.throws(() => validateProductFields({ method: 'DELETE', path: THING }, entry, 4), (e) => e.code === 'invalid_op' && /^Op 4 /.test(e.message));
});

test('two ops on the same resource key is plan_conflict; delete plus any op on the key is plan_conflict', () => {
  const put = { method: 'PUT', path: THING, body: {} };
  const patch = { method: 'PATCH', path: THING, body: {} };
  const del = { method: 'DELETE', path: THING, confirm_name: 'thing-1' };
  for (const pair of [[put, patch], [put, put], [patch, del], [del, put]]) {
    assert.throws(() => validatePlanOps(pair, acctPlan), code('plan_conflict'), JSON.stringify(pair));
  }
  validatePlanOps([put, { method: 'PUT', path: `/accounts/${A}/fake/things/${UUID2}`, body: {} }], acctPlan);
  // Creates have no resource key, so two creates do not conflict.
  const create = { method: 'POST', path: `/accounts/${A}/fake/things`, body: {} };
  validatePlanOps([create, create], acctPlan);
});

test('validatePlanOps calls the module conflicts hook', () => {
  assert.throws(() => validatePlanOps([{ method: 'PUT', path: THING, body: { conflict: true } }], acctPlan), (e) => e.code === 'plan_conflict' && /fake conflict at op 0/.test(e.message));
});

test('validatePlanOps without a plan does not classify product ops (0.2.x behavior)', () => {
  const put = { method: 'PUT', path: THING, body: { conflict: true } };
  validatePlanOps([put, put]);
});
