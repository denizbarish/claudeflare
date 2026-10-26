import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPlan, createRollbackPlan, withIrreversibleRisk } from '../scripts/lib/apply.mjs';
import { createPlan, updatePlan } from '../scripts/lib/plans.mjs';
import { writeApproval } from '../scripts/lib/approvals.mjs';
import { classifyProductOp } from '../scripts/lib/products/index.mjs';
import { validateOpTargets, validatePlanOps } from '../scripts/lib/resources.mjs';
import { runProductPreflight } from '../scripts/lib/product-preflight.mjs';
import { opVerifyChecks, runVerify, teamDomainOf } from '../scripts/lib/verify.mjs';
import { CfError } from '../scripts/lib/errors.mjs';

const A = '0123456789abcdef0123456789abcdef';
const BASE = `/accounts/${A}`;
const ACCESS = `${BASE}/access`;
const PLAN = { scope: 'account', account_id: A };
const T0 = new Date('2026-10-26T10:00:00Z');
const T1_TIME = new Date('2026-10-26T10:05:00Z');
const TEAM = 'example-team.cloudflareaccess.com';

const APP_WIKI = 'aaaaaaaa-0000-4000-8000-000000000001';
const APP_ADMIN = 'aaaaaaaa-0000-4000-8000-000000000002';
const APP_DASH = 'aaaaaaaa-0000-4000-8000-000000000003';
const P_EMP = 'bbbbbbbb-0000-4000-8000-000000000001';
const P_CON = 'bbbbbbbb-0000-4000-8000-000000000002';
const P_CI = 'bbbbbbbb-0000-4000-8000-000000000003';
const L_ADMIN = 'cccccccc-0000-4000-8000-000000000001';
const L_DENY = 'cccccccc-0000-4000-8000-000000000002';
const L_DASH = 'cccccccc-0000-4000-8000-000000000003';
const G1 = 'dddddddd-0000-4000-8000-000000000001';
const G2 = 'dddddddd-0000-4000-8000-000000000002';
const IDP_OKTA = 'eeeeeeee-0000-4000-8000-000000000001';
const IDP_OIDC = 'eeeeeeee-0000-4000-8000-000000000002';
const S1 = 'ffffffff-0000-4000-8000-000000000001';
const NEW = '99999999-0000-4000-8000-000000000001';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/api/access/${name}.json`, import.meta.url), 'utf8'));
const TOKEN_CREATED = fx('service-token-create');
const TOKEN_SECRET = TOKEN_CREATED.client_secret;
const TOKEN_CLIENT_ID = TOKEN_CREATED.client_id;
const IDP_SECRET = 'fake-idp-client-secret-0000000000000000000000000000000001';

const COLLECTIONS = {
  apps: 'apps', policies: 'policies', groups: 'groups', identity_providers: 'identity-providers', service_tokens: 'service-tokens',
};
// Fields the fake keeps from the stored resource on a PUT, as the API does.
const KEEP_ON_PUT = ['id', 'aud', 'created_at', 'client_id', 'expires_at', 'last_seen_at', 'app_count', 'reusable'];

// In-memory account built from the recorded responses. Lists page by
// page/per_page like the API; an app's legacy policies are also readable at
// /access/apps/<id>/policies/<pid>.
function fakeApi({ org = fx('organization'), idps = fx('identity-providers'), apps = fx('apps') } = {}) {
  const store = new Map();
  const seed = { apps, policies: fx('policies'), groups: fx('groups'), identity_providers: idps, service_tokens: fx('service-tokens') };
  for (const [name, items] of Object.entries(seed)) {
    for (const item of items) store.set(`${ACCESS}/${name}/${item.id}`, structuredClone(item));
  }
  for (const app of apps) {
    for (const p of app.policies ?? []) if (p.reusable === false) store.set(`${ACCESS}/apps/${app.id}/policies/${p.id}`, structuredClone(p));
  }
  if (org) store.set(`${ACCESS}/organizations`, structuredClone(org));
  const calls = [];
  const missing = (path) => new CfError('not_found', `Not found: ${path}`, { status: 404 });
  const listOf = (path) => [...store.entries()]
    .filter(([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'))
    .map(([, value]) => value);
  const isCollection = (path) => Object.keys(COLLECTIONS).some((name) => path === `${ACCESS}/${name}`) || /\/apps\/[^/]+\/policies$/.test(path);
  const resolvePolicies = (list) => (Array.isArray(list) ? list.map((p, i) => {
    const id = typeof p === 'string' ? p : p.id;
    const found = id && store.get(`${ACCESS}/policies/${id}`);
    return found ? { ...structuredClone(found), precedence: i + 1 } : p;
  }) : list);
  let created = 0;
  return {
    store,
    calls,
    writes: () => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`),
    async request(method, path, opts = {}) {
      calls.push({ method, path, query: opts.query, body: structuredClone(opts.body) });
      if (method === 'GET' && isCollection(path)) {
        const items = listOf(path);
        if (!opts.envelope) return structuredClone(items);
        const page = Number(opts.query?.page ?? 1);
        const per = Number(opts.query?.per_page ?? 50);
        return {
          result: structuredClone(items.slice((page - 1) * per, page * per)),
          result_info: { page, per_page: per, total_pages: Math.max(1, Math.ceil(items.length / per)) },
        };
      }
      if (method === 'GET') {
        if (!store.has(path)) throw missing(path);
        return structuredClone(store.get(path));
      }
      if (method === 'POST' && isCollection(path)) {
        const id = created++ === 0 ? NEW : `99999999-0000-4000-8000-00000000000${created}`;
        const at = '2026-10-26T10:00:00Z';
        let response = { ...structuredClone(opts.body ?? {}), id, created_at: at, updated_at: at };
        if (path.endsWith('/service_tokens')) response = { ...structuredClone(TOKEN_CREATED), ...opts.body, id };
        if (path.endsWith('/apps')) response = { ...response, aud: 'new-aud-0000', policies: resolvePolicies(response.policies) ?? [] };
        const stored = structuredClone(response);
        delete stored.client_secret;
        if (stored.config) delete stored.config.client_secret;
        store.set(`${path}/${id}`, stored);
        return response;
      }
      if (method === 'DELETE') {
        if (!store.has(path)) throw missing(path);
        for (const key of [...store.keys()]) if (key === path || key.startsWith(`${path}/`)) store.delete(key);
        return { id: path.split('/').pop() };
      }
      if (method === 'PUT') {
        const old = store.get(path);
        if (!old) throw missing(path);
        const kept = Object.fromEntries(KEEP_ON_PUT.filter((k) => k in old).map((k) => [k, old[k]]));
        const next = { ...structuredClone(opts.body), ...kept, updated_at: '2026-10-26T10:00:00Z' };
        if (next.policies) next.policies = resolvePolicies(next.policies);
        const response = structuredClone(next);
        if (next.config) delete next.config.client_secret;
        store.set(path, next);
        return response;
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
  const cwd = mkdtempSync(join(tmpdir(), 'claudeflare-access-'));
  const keyDir = mkdtempSync(join(tmpdir(), 'claudeflare-accesskey-'));
  process.env.CLAUDEFLARE_KEY_DIR = keyDir;
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
    if (ORIGINAL_KEY_DIR === undefined) delete process.env.CLAUDEFLARE_KEY_DIR;
    else process.env.CLAUDEFLARE_KEY_DIR = ORIGINAL_KEY_DIR;
  });
  const plan = createPlan(cwd, {
    scope: 'account', account_id: A, account_name: 'Acme', summary: 'Access', risk: 'low', ops, slug: 'access',
  }, T0);
  return { cwd, plan: updatePlan(cwd, plan.id, { slug: 'access', lockout_risks: [], ...fields }) };
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

const redirect = (location) => async () => new Response(null, { status: 302, headers: { location } });
const noFetch = async () => {
  throw new Error('no fetch expected');
};

const appBody = (over = {}) => ({
  name: 'docs', type: 'self_hosted', domain: 'docs.example.com', session_duration: '24h', policies: [P_EMP], ...over,
});
const appCreate = (over) => ({ method: 'POST', path: `${ACCESS}/apps`, body: appBody(over) });
const appUpdate = (id, body) => ({ method: 'PUT', path: `${ACCESS}/apps/${id}`, body });
const appDelete = (id = APP_WIKI, name = 'wiki') => ({ method: 'DELETE', path: `${ACCESS}/apps/${id}`, confirm_name: name });
const policyBody = (over = {}) => ({
  name: 'Employees', decision: 'allow', include: [{ email_domain: { domain: 'example.com' } }], exclude: [], require: [], ...over,
});
const policyUpdate = (id, body) => ({ method: 'PUT', path: `${ACCESS}/policies/${id}`, body });
const policyDelete = (id, name) => ({ method: 'DELETE', path: `${ACCESS}/policies/${id}`, confirm_name: name });
const legacyDelete = (app, id, name) => ({ method: 'DELETE', path: `${ACCESS}/apps/${app}/policies/${id}`, confirm_name: name });
const idpCreate = (extra = {}) => ({
  method: 'POST',
  path: `${ACCESS}/identity_providers`,
  body: { name: 'GitHub', type: 'github', config: { client_id: 'fake-github-client' } },
  ...extra,
});
const tokenCreate = { method: 'POST', path: `${ACCESS}/service_tokens`, body: { name: 'deploy-bot', duration: '8760h' } };

test('every Access kind classifies with its inverse, destructive flag and secret lists', () => {
  const cases = [
    ['POST', '/access/apps', 'access_app_create', 'delete_created'],
    ['PUT', `/access/apps/${APP_WIKI}`, 'access_app_update', 'put_before'],
    ['DELETE', `/access/apps/${APP_WIKI}`, 'access_app_delete', 'recreate'],
    ['POST', '/access/policies', 'access_policy_create', 'delete_created'],
    ['PUT', `/access/policies/${P_EMP}`, 'access_policy_update', 'put_before'],
    ['DELETE', `/access/policies/${P_EMP}`, 'access_policy_delete', 'recreate'],
    ['PUT', `/access/apps/${APP_ADMIN}/policies/${L_ADMIN}`, 'access_app_policy_update', 'put_before'],
    ['DELETE', `/access/apps/${APP_ADMIN}/policies/${L_ADMIN}`, 'access_app_policy_delete', 'recreate'],
    ['POST', '/access/groups', 'access_group_create', 'delete_created'],
    ['PUT', `/access/groups/${G1}`, 'access_group_update', 'put_before'],
    ['DELETE', `/access/groups/${G1}`, 'access_group_delete', 'recreate'],
    ['POST', '/access/identity_providers', 'access_idp_create', 'delete_created'],
    ['PUT', `/access/identity_providers/${IDP_OKTA}`, 'access_idp_update', 'function'],
    ['DELETE', `/access/identity_providers/${IDP_OKTA}`, 'access_idp_delete', 'none'],
    ['POST', '/access/service_tokens', 'access_service_token_create', 'delete_created'],
    ['PUT', `/access/service_tokens/${S1}`, 'access_service_token_update', 'put_before'],
    ['DELETE', `/access/service_tokens/${S1}`, 'access_service_token_delete', 'none'],
    ['PUT', '/access/organizations', 'access_org_update', 'put_before'],
  ];
  const destructive = new Set(['access_app_delete', 'access_policy_delete', 'access_app_policy_delete', 'access_group_delete', 'access_idp_delete', 'access_service_token_delete']);
  for (const [method, rest, kind, inverse] of cases) {
    const c = classifyProductOp({ method, path: `${BASE}${rest}` }, PLAN);
    assert.ok(c, `${method} ${rest} is not classified`);
    assert.equal(c.entry.kind, kind);
    assert.equal(c.module.product, 'access');
    assert.equal(typeof c.entry.inverse === 'function' ? 'function' : c.entry.inverse, inverse, kind);
    assert.equal(c.entry.destructive, destructive.has(kind), kind);
    if (destructive.has(kind)) assert.equal(c.entry.nameField, 'name', kind);
  }
  // A 32 hex IdP id (the form allowed_idps shows) classifies too.
  assert.equal(classifyProductOp({ method: 'PUT', path: `${ACCESS}/identity_providers/699d98642c564d2e855e9661899b7252` }, PLAN).entry.kind, 'access_idp_update');
  const entry = (method, rest) => classifyProductOp({ method, path: `${BASE}${rest}` }, PLAN).entry;
  assert.ok(entry('POST', '/access/identity_providers').secretFields.includes('config.client_secret'));
  assert.ok(entry('PUT', `/access/identity_providers/${IDP_OKTA}`).secretFields.includes('config.client_secret'));
  assert.ok(entry('POST', '/access/identity_providers').redact.includes('scim_config.secret'));
  assert.deepEqual(entry('POST', '/access/service_tokens').secretSink, ['client_id', 'client_secret']);
  assert.deepEqual(entry('POST', '/access/service_tokens').redact, ['client_secret']);
  assert.deepEqual(entry('POST', '/access/apps').readOnlyFields.slice(0, 4), ['id', 'aud', 'created_at', 'updated_at']);
  // Not on any allowlist: token revocation, service token rotation, PATCH.
  for (const [method, rest] of [
    ['POST', `/access/apps/${APP_WIKI}/revoke_tokens`],
    ['POST', `/access/service_tokens/${S1}/rotate`],
    ['POST', `/access/service_tokens/${S1}/refresh`],
    ['POST', '/access/organizations/revoke_user'],
    ['POST', '/access/organizations'],
    ['PATCH', `/access/apps/${APP_WIKI}`],
    ['POST', `/access/apps/${APP_ADMIN}/policies`],
    ['DELETE', '/access/organizations'],
  ]) {
    assert.equal(classifyProductOp({ method, path: `${BASE}${rest}` }, PLAN), null, `${method} ${rest}`);
  }
  assert.throws(() => validateOpTargets([{ method: 'POST', path: `${ACCESS}/apps/${APP_WIKI}/revoke_tokens` }], PLAN), { code: 'invalid_op' });
});

test('IdP body with a literal client_secret is invalid_op and the message never echoes it', () => {
  const literal = idpCreate();
  literal.body.config.client_secret = IDP_SECRET;
  for (const op of [literal, { ...literal, method: 'PUT', path: `${ACCESS}/identity_providers/${IDP_OKTA}` }]) {
    assert.throws(() => validateOpTargets([op], PLAN), (e) => {
      assert.equal(e.code, 'invalid_op');
      assert.match(e.message, /config\.client_secret/);
      assert.ok(!e.message.includes(IDP_SECRET), 'message echoes the secret');
      return true;
    });
  }
  validateOpTargets([idpCreate({ secret_fields_from_env: { 'config.client_secret': 'GITHUB_CLIENT_SECRET' } })], PLAN);
  assert.throws(() => validateOpTargets([idpCreate({ secret_fields_from_env: { 'config.client_id': 'X_ID' } })], PLAN), { code: 'invalid_op' });
  assert.throws(() => validateOpTargets([{ ...idpCreate(), body: { name: 'x' } }], PLAN), { code: 'invalid_op' });
});

test('service token bodies take only name, duration (and enabled on update); secrets and rotation are refused', () => {
  validateOpTargets([tokenCreate], PLAN);
  const update = (body) => [{ method: 'PUT', path: `${ACCESS}/service_tokens/${S1}`, body }];
  validateOpTargets(update({ name: 'ci', duration: '8760h', enabled: true }), PLAN);
  for (const body of [{ name: 'x', client_secret: TOKEN_SECRET }, { name: 'x', client_id: 'y' }]) {
    assert.throws(() => validateOpTargets([{ ...tokenCreate, body }], PLAN), (e) => e.code === 'invalid_op' && !e.message.includes(TOKEN_SECRET));
  }
  assert.throws(() => validateOpTargets(update({ name: 'ci', client_secret_version: 2 }), PLAN), (e) => e.code === 'invalid_op' && /client_secret_version/.test(e.message));
  assert.throws(() => validateOpTargets([{ ...tokenCreate, body: {} }], PLAN), { code: 'invalid_op' });
});

test('app, policy, group and org bodies are validated (invalid_op)', () => {
  validateOpTargets([appCreate()], PLAN);
  for (const body of [null, { name: 'x' }, appBody({ domain: undefined }), appBody({ policies: 'p' })]) {
    assert.throws(() => validateOpTargets([{ ...appCreate(), body }], PLAN), { code: 'invalid_op' }, JSON.stringify(body));
  }
  validateOpTargets([policyUpdate(P_EMP, policyBody())], PLAN);
  for (const body of [policyBody({ decision: 'maybe' }), policyBody({ include: undefined }), policyBody({ name: '' })]) {
    assert.throws(() => validateOpTargets([policyUpdate(P_EMP, body)], PLAN), { code: 'invalid_op' }, JSON.stringify(body));
  }
  assert.throws(() => validateOpTargets([{ method: 'POST', path: `${ACCESS}/groups`, body: { name: 'g' } }], PLAN), { code: 'invalid_op' });
  validateOpTargets([{ method: 'POST', path: `${ACCESS}/groups`, body: { name: 'g', include: [{ email: { email: 'a@example.com' } }] } }], PLAN);
  const org = (body) => [{ method: 'PUT', path: `${ACCESS}/organizations`, body }];
  validateOpTargets(org({ name: 'Example Team', auth_domain: TEAM }), PLAN);
  assert.throws(() => validateOpTargets(org({ name: 'Example Team' }), PLAN), { code: 'invalid_op' });
});

test('a legacy app policy op and an op on the same app conflict', () => {
  const legacyUpdate = { method: 'PUT', path: `${ACCESS}/apps/${APP_ADMIN}/policies/${L_ADMIN}`, body: policyBody({ name: 'Admins' }) };
  assert.throws(() => validatePlanOps([legacyUpdate, appUpdate(APP_ADMIN, appBody({ name: 'admin' }))], PLAN), { code: 'plan_conflict' });
  assert.throws(() => validatePlanOps([legacyUpdate, appDelete(APP_ADMIN, 'admin')], PLAN), { code: 'plan_conflict' });
  validatePlanOps([legacyUpdate, appUpdate(APP_WIKI, appBody({ name: 'wiki' }))], PLAN);
});

test('reusable policy delete is refused while an app uses it, unless an earlier op detaches it', async () => {
  const used = await runProductPreflight(fakeApi(), PLAN, [policyDelete(P_EMP, 'Employees')]);
  const dep = used.checks.find((c) => c.name === 'dependencies');
  assert.equal(dep.ok, false);
  assert.equal(dep.code, 'resource_in_use');
  assert.match(dep.detail, /wiki/);
  assert.match(dep.detail, new RegExp(APP_WIKI));
  const detached = await runProductPreflight(fakeApi(), PLAN, [
    appUpdate(APP_WIKI, appBody({ name: 'wiki', domain: 'wiki.example.com', policies: [P_CON] })),
    policyDelete(P_EMP, 'Employees'),
  ]);
  assert.equal(detached.checks.find((c) => c.name === 'dependencies').ok, true);
  const unused = await runProductPreflight(fakeApi(), PLAN, [policyDelete(P_CON, 'Contractors')]);
  assert.deepEqual(unused.checks.filter((c) => !c.ok), []);
});

test('group and service token deletes are refused while a policy references them', async () => {
  const group = await runProductPreflight(fakeApi(), PLAN, [{ method: 'DELETE', path: `${ACCESS}/groups/${G1}`, confirm_name: 'Contractors' }]);
  const gdep = group.checks.find((c) => c.name === 'dependencies');
  assert.equal(gdep.code, 'resource_in_use');
  assert.match(gdep.detail, /Contractors/);
  assert.match(gdep.detail, /Block contractors/);
  const free = await runProductPreflight(fakeApi(), PLAN, [{ method: 'DELETE', path: `${ACCESS}/groups/${G2}`, confirm_name: 'Unused' }]);
  assert.deepEqual(free.checks.filter((c) => !c.ok), []);
  const token = await runProductPreflight(fakeApi(), PLAN, [{ method: 'DELETE', path: `${ACCESS}/service_tokens/${S1}`, confirm_name: 'ci' }]);
  const tdep = token.checks.find((c) => c.name === 'dependencies');
  assert.equal(tdep.code, 'resource_in_use');
  assert.match(tdep.detail, /CI/);
});

test('lockout item 1: an app that loses its last usable allow policy gets a line', async () => {
  const api = fakeApi();
  const legacy = await runProductPreflight(api, PLAN, [legacyDelete(APP_ADMIN, L_ADMIN, 'Admins')]);
  assert.equal(legacy.lockout_risks.length, 1, JSON.stringify(legacy.lockout_risks));
  assert.match(legacy.lockout_risks[0], /^Lockout risk: Access app admin \(admin\.example\.com\).*allow/);
  const keepDeny = await runProductPreflight(api, PLAN, [legacyDelete(APP_ADMIN, L_DENY, 'Block contractors')]);
  assert.deepEqual(keepDeny.lockout_risks, []);
  const reusable = await runProductPreflight(api, PLAN, [policyUpdate(P_EMP, policyBody({ decision: 'deny' }))]);
  assert.equal(reusable.lockout_risks.length, 1);
  assert.match(reusable.lockout_risks[0], /Access app wiki \(wiki\.example\.com\)/);
  const empty = await runProductPreflight(api, PLAN, [policyUpdate(P_EMP, policyBody({ include: [] }))]);
  assert.equal(empty.lockout_risks.length, 1);
  assert.match(empty.lockout_risks[0], /empty include|no allow policy/);
  const app = await runProductPreflight(api, PLAN, [appUpdate(APP_WIKI, appBody({ name: 'wiki', domain: 'wiki.example.com', policies: [] }))]);
  assert.equal(app.lockout_risks.length, 1);
  assert.match(app.lockout_risks[0], /wiki/);
  const fine = await runProductPreflight(api, PLAN, [appUpdate(APP_WIKI, appBody({ name: 'wiki', domain: 'wiki.example.com', policies: [P_EMP, P_CON] }))]);
  assert.deepEqual(fine.lockout_risks, []);
});

test('lockout item 2: an app domain that covers an IdP login host or the team domain gets a line', async () => {
  const api = fakeApi();
  const idp = await runProductPreflight(api, PLAN, [appCreate({ name: 'all', domain: '*.example.com' })]);
  assert.equal(idp.lockout_risks.length, 1, JSON.stringify(idp.lockout_risks));
  assert.match(idp.lockout_risks[0], /^Lockout risk: .*\*\.example\.com.*sso\.example\.com.*Corporate SSO/);
  const team = await runProductPreflight(api, PLAN, [appCreate({ name: 'team', domain: TEAM })]);
  assert.equal(team.lockout_risks.length, 1);
  assert.match(team.lockout_risks[0], /team domain/);
  const okta = await runProductPreflight(api, PLAN, [appCreate({ name: 'okta', domain: 'docs.example.com', self_hosted_domains: ['docs.example.com', 'example-org.okta.com'] })]);
  assert.match(okta.lockout_risks[0], /example-org\.okta\.com.*Okta/);
  const fine = await runProductPreflight(api, PLAN, [appCreate()]);
  assert.deepEqual(fine.lockout_risks, []);
});

test('lockout item 3: removing or changing the only IdP of an app or of the org gets a line', async () => {
  const del = await runProductPreflight(fakeApi(), PLAN, [{ method: 'DELETE', path: `${ACCESS}/identity_providers/${IDP_OKTA}`, confirm_name: 'Okta' }]);
  assert.equal(del.lockout_risks.length, 1, JSON.stringify(del.lockout_risks));
  assert.match(del.lockout_risks[0], /^Lockout risk: .*Okta.*only identity provider.*wiki/);
  const other = await runProductPreflight(fakeApi(), PLAN, [{ method: 'DELETE', path: `${ACCESS}/identity_providers/${IDP_OIDC}`, confirm_name: 'Corporate SSO' }]);
  assert.deepEqual(other.lockout_risks, []);
  const single = fakeApi({ idps: [fx('identity-providers')[0]] });
  const change = await runProductPreflight(single, PLAN, [{
    method: 'PUT', path: `${ACCESS}/identity_providers/${IDP_OKTA}`, body: { name: 'Okta', type: 'okta', config: { client_id: 'x', okta_account: 'https://example-org.okta.com' } },
  }]);
  assert.ok(change.lockout_risks.some((l) => /only login method of the organization/.test(l)), JSON.stringify(change.lockout_risks));
  const unknown = await runProductPreflight(fakeApi(), PLAN, [appUpdate(APP_WIKI, appBody({ name: 'wiki', domain: 'wiki.example.com', allowed_idps: ['eeeeeeee-0000-4000-8000-0000000000aa'] }))]);
  assert.equal(unknown.lockout_risks.length, 1);
  assert.match(unknown.lockout_risks[0], /not configured/);
});

test('lockout item 4: deleting the Dashboard SSO allow policy gets a line', async () => {
  const report = await runProductPreflight(fakeApi(), PLAN, [legacyDelete(APP_DASH, L_DASH, 'Dashboard SSO allow')]);
  assert.ok(report.lockout_risks.some((l) => /^Lockout risk: .*Dashboard SSO allow.*Zero Trust dashboard app/.test(l)), JSON.stringify(report.lockout_risks));
  const app = await runProductPreflight(fakeApi(), PLAN, [appUpdate(APP_DASH, { name: 'Cloudflare Dashboard SSO', type: 'dash_sso', policies: [P_EMP] })]);
  assert.ok(app.lockout_risks.some((l) => /Dashboard SSO allow/.test(l)), JSON.stringify(app.lockout_risks));
});

test('app delete note names the new AUD and the app domains', async () => {
  const ops = [appDelete()];
  const report = await runProductPreflight(fakeApi(), PLAN, ops);
  assert.deepEqual(report.checks.filter((c) => !c.ok), []);
  const risk = withIrreversibleRisk('Delete app wiki', ops, PLAN, report.ctx);
  assert.match(risk, /new AUD/);
  assert.match(risk, /wiki\.example\.com/);
  const bare = withIrreversibleRisk('Delete app wiki', ops, PLAN, {});
  assert.match(bare, /new AUD/);
});

test('org auth_domain change and service token create add notes', async () => {
  const org = [{ method: 'PUT', path: `${ACCESS}/organizations`, body: { name: 'Example Team', auth_domain: 'other-team.cloudflareaccess.com' } }];
  const report = await runProductPreflight(fakeApi(), PLAN, org);
  assert.match(withIrreversibleRisk('Org', org, PLAN, report.ctx), /ends existing sessions and breaks bookmarks/);
  assert.match(withIrreversibleRisk('Token', [tokenCreate], PLAN, {}), /shown only once/);
});

test('no Zero Trust organization is not_entitled', async () => {
  const report = await runProductPreflight(fakeApi({ org: null }), PLAN, [appCreate()]);
  const ent = report.checks.find((c) => c.name === 'entitlement');
  assert.equal(ent.ok, false);
  assert.equal(ent.code, 'not_entitled');
});

test('gather stores the team domain where verify reads it (teamDomainOf pin)', async () => {
  const report = await runProductPreflight(fakeApi(), PLAN, [appCreate()]);
  assert.equal(teamDomainOf(report.ctx.access), TEAM);
  // The op-level access_login check reads the same ctx: another team fails.
  const op = { ...appCreate(), verify: { expect: 'access_login', url: 'https://docs.example.com/' } };
  const { entry, module } = classifyProductOp(op, PLAN);
  const checks = opVerifyChecks(op, entry, module, report.ctx.access, { id: NEW }, null, { fetchImpl: redirect('https://other-team.cloudflareaccess.com/cdn-cgi/access/login') });
  const login = checks.filter((c) => c.name.startsWith('access_login'));
  assert.ok(login.length >= 1);
  for (const check of login) assert.equal((await check.run()).ok, false);
});

test('app create verify passes on a 302 to the team domain and fails otherwise', async (t) => {
  const run = async (fetchImpl) => {
    const { cwd, plan } = setup(t, [appCreate()]);
    approve(cwd, plan);
    return applyPlan(cwd, fakeApi(), plan.id, T0, { fetchImpl, ...fastVerify() });
  };
  const ok = await run(redirect(`https://${TEAM}/cdn-cgi/access/login/docs.example.com?redirect_url=%2F`));
  assert.equal(ok.status, 'applied', JSON.stringify(ok.results));
  assert.deepEqual(ok.results[0].verify.checks.map((c) => c.name).sort(), ['access_login https://docs.example.com/', 'readback', 'readback policies']);
  assert.ok(ok.results[0].verify.ok);
  const wrong = await run(redirect('https://other-team.cloudflareaccess.com/cdn-cgi/access/login'));
  assert.equal(wrong.status, 'applied_verify_failed');
  const open = await run(async () => new Response('hello', { status: 200 }));
  assert.equal(open.status, 'applied_verify_failed');
  assert.match(open.results[0].verify.checks.find((c) => c.name.startsWith('access_login')).detail, /expected 302/);
});

test('a wildcard app domain skips the login check; non self-hosted apps have none', async () => {
  const { ACCESS: MODULE } = await import('../scripts/lib/products/access.mjs');
  const op = appCreate({ domain: '*.docs.example.com' });
  const { entry } = classifyProductOp(op, PLAN);
  const checks = MODULE.verifyChecks(op, entry, { auth_domain: TEAM }, { id: NEW }, { ...op.body, policies: [{ id: P_EMP }] }, {});
  const skip = checks.find((c) => c.name.startsWith('access_login'));
  assert.equal(skip.once, true);
  assert.match((await skip.run()).detail, /skipped/);
  const saas = appCreate({ type: 'saas', domain: undefined });
  assert.ok(!MODULE.verifyChecks(saas, entry, {}, { id: NEW }, saas.body, {}).some((c) => c.name.startsWith('access_login')));
});

test('reusable policy update verify re-reads every app using it', async (t) => {
  const { cwd, plan } = setup(t, [policyUpdate(P_EMP, policyBody({ name: 'Staff' }))]);
  approve(cwd, plan);
  const applied = await applyPlan(cwd, fakeApi(), plan.id, T0, { fetchImpl: noFetch, ...fastVerify() });
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  const names = applied.results[0].verify.checks.map((c) => c.name);
  assert.ok(names.includes('readback'));
  assert.ok(names.includes(`app_policy ${APP_WIKI}`), JSON.stringify(names));
});

test('IdP create via secret_fields_from_env sends the value and stores none of it', async (t) => {
  const op = idpCreate({ secret_fields_from_env: { 'config.client_secret': 'GITHUB_CLIENT_SECRET' } });
  const { cwd, plan } = setup(t, [op]);
  approve(cwd, plan);
  const api = fakeApi();
  const env = { GITHUB_CLIENT_SECRET: IDP_SECRET };
  const applied = await applyPlan(cwd, api, plan.id, T0, { env, fetchImpl: noFetch, ...fastVerify() });
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  const sent = api.calls.find((c) => c.method === 'POST');
  assert.equal(sent.body.config.client_secret, IDP_SECRET);
  assert.equal(applied.results[0].config.client_secret, '[redacted]');
  const rollback = createRollbackPlan(cwd, plan.id, T1_TIME);
  assert.deepEqual(rollback.ops.map((o) => `${o.method} ${o.path}`), [`DELETE ${ACCESS}/identity_providers/${NEW}`]);
  const texts = [JSON.stringify(applied), JSON.stringify(rollback), ...filesUnder(cwd).map((f) => readFileSync(f, 'utf8'))];
  for (const text of texts) assert.ok(!text.includes(IDP_SECRET), 'IdP secret leaked');
});

test('IdP update rollback puts the non-secret fields back; a secret change has no inverse', async (t) => {
  const body = { name: 'SSO EU', type: 'oidc', config: { client_id: 'claudeflare-test-client', auth_url: 'https://sso.example.com/oauth2/authorize', token_url: 'https://sso.example.com/oauth2/token', certs_url: 'https://sso.example.com/oauth2/keys', scopes: ['openid', 'email'] } };
  const plain = { method: 'PUT', path: `${ACCESS}/identity_providers/${IDP_OIDC}`, body };
  {
    const { cwd, plan } = setup(t, [plain]);
    approve(cwd, plan);
    const api = fakeApi();
    const applied = await applyPlan(cwd, api, plan.id, T0, { fetchImpl: noFetch, ...fastVerify() });
    assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
    const rollback = createRollbackPlan(cwd, plan.id, T1_TIME);
    assert.equal(rollback.ops.length, 1);
    assert.equal(rollback.ops[0].method, 'PUT');
    assert.equal(rollback.ops[0].body.name, 'Corporate SSO');
    assert.ok(!('client_secret' in rollback.ops[0].body.config));
    assert.ok(!('id' in rollback.ops[0].body));
    assert.equal(rollback.ops[0].precheck.read, `${ACCESS}/identity_providers/${IDP_OIDC}`);
  }
  const secret = { ...plain, secret_fields_from_env: { 'config.client_secret': 'OKTA_CLIENT_SECRET' } };
  assert.match(withIrreversibleRisk('IdP', [secret], PLAN, {}), /Not reversible: PUT .*identity_providers/);
  const { cwd, plan } = setup(t, [secret]);
  approve(cwd, plan);
  const applied = await applyPlan(cwd, fakeApi(), plan.id, T0, { env: { OKTA_CLIENT_SECRET: IDP_SECRET }, fetchImpl: noFetch, ...fastVerify() });
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  assert.throws(() => createRollbackPlan(cwd, plan.id, T1_TIME), { code: 'nothing_to_rollback' });
  for (const f of filesUnder(cwd)) assert.ok(!readFileSync(f, 'utf8').includes(IDP_SECRET), `${f} holds the IdP secret`);
});

test('service token create writes the sink file; results, plan, snapshot and rollback hold [redacted]', async (t) => {
  const { cwd, plan } = setup(t, [tokenCreate]);
  approve(cwd, plan);
  const api = fakeApi();
  const applied = await applyPlan(cwd, api, plan.id, T0, { fetchImpl: noFetch, ...fastVerify() });
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  const result = applied.results[0];
  assert.equal(result.id, NEW);
  assert.equal(result.client_secret, '[redacted]');
  assert.equal(result.client_id, '[redacted]');
  assert.ok(result.verify.ok, JSON.stringify(result.verify));
  const sink = result.secret_file;
  assert.ok(sink.includes(join('.claudeflare', 'secrets')));
  assert.equal(statSync(sink).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(sink, 'utf8')), { client_id: TOKEN_CLIENT_ID, client_secret: TOKEN_SECRET });
  const rollback = createRollbackPlan(cwd, plan.id, T1_TIME);
  assert.deepEqual(rollback.ops.map((o) => `${o.method} ${o.path}`), [`DELETE ${ACCESS}/service_tokens/${NEW}`]);
  assert.equal(rollback.ops[0].precheck.read, `${ACCESS}/service_tokens/${NEW}`);
  const texts = [JSON.stringify(applied), JSON.stringify(rollback), ...filesUnder(cwd).filter((f) => f !== sink).map((f) => readFileSync(f, 'utf8'))];
  for (const text of texts) {
    assert.ok(!text.includes(TOKEN_SECRET), 'client_secret leaked');
    assert.ok(!text.includes(TOKEN_CLIENT_ID), 'client_id leaked');
  }
});

test('rollback of an app update puts the previous app back and is skipped on drift', async (t) => {
  const op = appUpdate(APP_WIKI, appBody({ name: 'wiki', domain: 'wiki.example.com', session_duration: '8h', allowed_idps: [IDP_OKTA] }));
  const { cwd, plan } = setup(t, [op]);
  approve(cwd, plan);
  const api = fakeApi();
  const applied = await applyPlan(cwd, api, plan.id, T0, { fetchImpl: redirect(`https://${TEAM}/cdn-cgi/access/login/wiki.example.com`), ...fastVerify() });
  assert.equal(applied.status, 'applied', JSON.stringify(applied.results));
  const rollback = createRollbackPlan(cwd, plan.id, T1_TIME);
  assert.equal(rollback.ops.length, 1);
  assert.equal(rollback.ops[0].method, 'PUT');
  assert.equal(rollback.ops[0].body.session_duration, '24h');
  for (const key of ['id', 'aud', 'created_at', 'updated_at']) assert.ok(!(key in rollback.ops[0].body), key);
  assert.equal(rollback.ops[0].precheck.read, `${ACCESS}/apps/${APP_WIKI}`);
  approve(cwd, rollback, T1_TIME);
  api.calls.length = 0;
  const ran = await applyPlan(cwd, api, rollback.id, T1_TIME, { fetchImpl: redirect(`https://${TEAM}/x`), ...fastVerify() });
  assert.equal(ran.status, 'applied', JSON.stringify(ran.results));
  assert.equal(api.store.get(`${ACCESS}/apps/${APP_WIKI}`).session_duration, '24h');

  const second = setup(t, [op]);
  approve(second.cwd, second.plan);
  const api2 = fakeApi();
  await applyPlan(second.cwd, api2, second.plan.id, T0, { fetchImpl: redirect(`https://${TEAM}/x`), ...fastVerify() });
  api2.store.set(`${ACCESS}/apps/${APP_WIKI}`, { ...api2.store.get(`${ACCESS}/apps/${APP_WIKI}`), session_duration: '1h' });
  const drifted = createRollbackPlan(second.cwd, second.plan.id, T1_TIME);
  approve(second.cwd, drifted, T1_TIME);
  api2.calls.length = 0;
  const skipped = await applyPlan(second.cwd, api2, drifted.id, T1_TIME, fastVerify());
  assert.equal(skipped.status, 'partially_applied');
  assert.deepEqual(api2.writes(), []);
});

test('app create rollback deletes the created app; delete_created reads <path>/<id> as baseline', async (t) => {
  const { cwd, plan } = setup(t, [appCreate()]);
  approve(cwd, plan);
  const api = fakeApi();
  await applyPlan(cwd, api, plan.id, T0, { fetchImpl: redirect(`https://${TEAM}/x`), ...fastVerify() });
  const rollback = createRollbackPlan(cwd, plan.id, T1_TIME);
  assert.deepEqual(rollback.ops.map((o) => `${o.method} ${o.path}`), [`DELETE ${ACCESS}/apps/${NEW}`]);
  assert.equal(rollback.ops[0].precheck.read, `${ACCESS}/apps/${NEW}`);
  assert.ok(!rollback.ops[0].precheck.unknown);
});
