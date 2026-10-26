import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PF } from './fixtures/products/pf.mjs';
import { mapError } from '../scripts/lib/errors.mjs';
import { createPlan, readPlan, updatePlan } from '../scripts/lib/plans.mjs';
import { checkApproval, writeApproval } from '../scripts/lib/approvals.mjs';
import { addRollbackLockout, applyPlan, snapshotFile } from '../scripts/lib/apply.mjs';
import { runPreflight } from '../scripts/lib/preflight.mjs';
import { runProductPreflight } from '../scripts/lib/product-preflight.mjs';

const A = '0123456789abcdef0123456789abcdef';
const ZID = 'fedcba9876543210fedcba9876543210';
const BASE = `/accounts/${A}`;
const ZBASE = `/zones/${ZID}`;
const ID = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';
const T0 = new Date('2026-10-26T10:00:00Z');
const PLAN = { scope: 'account', account_id: A };
const CLI = fileURLToPath(new URL('../scripts/cf.mjs', import.meta.url));
const APPROVE = fileURLToPath(new URL('../hooks/approve.mjs', import.meta.url));
const GUARD = fileURLToPath(new URL('../hooks/guard.mjs', import.meta.url));
const FIXTURE = pathToFileURL(fileURLToPath(new URL('./fixtures/products/pf.mjs', import.meta.url))).href;

const putOp = { method: 'PUT', path: `${BASE}/pf/apps/${ID}`, body: { meta: { name: 'intranet' }, domain: 'a.example.com' } };
const deleteOp = (confirm = 'intranet') => ({ method: 'DELETE', path: `${BASE}/pf/apps/${ID}`, confirm_name: confirm });

// One fake account. route() answers with the full API envelope, so the
// in-process client and the CLI stub server behave the same.
function world(over = {}) {
  const state = {
    entitled: true, probeStatus: 200, app: { id: ID, meta: { name: 'intranet' }, domain: 'a.example.com' },
    rules: [], lockout: [], notes: [], ...over,
  };
  const at = (path, suffix) => path === `${BASE}${suffix}` || path === `${ZBASE}${suffix}`;
  function route(method, path, query = {}, body) {
    if (method !== 'GET') return { result: { id: ID, ...(body ?? {}) } };
    if (path === BASE) return { result: { id: A } };
    if (at(path, '/pf/org')) return { result: { entitled: state.entitled } };
    if (at(path, '/pf/apps')) {
      return state.probeStatus === 403
        ? { status: 403, success: false, errors: [{ code: 10000, message: 'Authentication error' }] }
        : { result: [state.app] };
    }
    if (at(path, `/pf/apps/${ID}`)) return { result: state.app };
    if (at(path, '/pf/rule')) return { result: { value: 'a' } };
    if (at(path, '/pf/state')) return { result: { lockout: state.lockout, notes: state.notes } };
    if (at(path, '/pf/rules')) {
      const page = Number(query.page);
      const per = Number(query.per_page);
      return {
        result: state.rules.slice((page - 1) * per, page * per),
        result_info: { page, per_page: per, total_pages: Math.max(1, Math.ceil(state.rules.length / per)) },
      };
    }
    return { status: 404, success: false, errors: [{ code: 7003, message: `no route ${method} ${path}` }] };
  }
  const calls = [];
  const client = {
    calls,
    async request(method, path, opts = {}) {
      calls.push({ method, path, query: opts.query });
      const out = route(method, path, opts.query, opts.body);
      if (out.status) throw mapError(out.status, out);
      return opts.envelope ? out : out.result;
    },
  };
  return { state, client, route };
}

const failed = (report, name) => report.checks.find((c) => c.name === name && !c.ok);

function setup(t, ops, fields = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'claudeflare-ppf-')));
  const keyDir = realpathSync(mkdtempSync(join(tmpdir(), 'claudeflare-ppfkey-')));
  const saved = process.env.CLAUDEFLARE_KEY_DIR;
  process.env.CLAUDEFLARE_KEY_DIR = keyDir;
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CLAUDEFLARE_KEY_DIR;
    else process.env.CLAUDEFLARE_KEY_DIR = saved;
  });
  const plan = createPlan(cwd, {
    scope: 'account', account_id: A, account_name: 'Acme', summary: 'Zero Trust', risk: 'low', ops, slug: 'pf',
  }, T0);
  return { cwd, keyDir, plan: updatePlan(cwd, plan.id, { slug: 'pf', ...fields }) };
}

const approve = (cwd, plan) => writeApproval(cwd, { plan_id: plan.id, session_id: 's1' }, T0);

// runProductPreflight

test('not entitled product fails with not_entitled', async () => {
  const { client } = world({ entitled: false });
  const report = await runProductPreflight(client, PLAN, [putOp]);
  const check = failed(report, 'entitlement');
  assert.ok(check, JSON.stringify(report.checks));
  assert.equal(check.code, 'not_entitled');
  assert.match(check.detail, /^not_entitled: pf: no organization/);
  assert.ok(!client.calls.some((c) => c.path === `${BASE}/pf/apps`), 'no probe after a failed entitlement');
});

test('403 on probe fails with missing_permission and the permission name', async () => {
  const { client } = world({ probeStatus: 403 });
  const report = await runProductPreflight(client, PLAN, [putOp]);
  const check = failed(report, 'permission');
  assert.equal(check.code, 'missing_permission');
  assert.match(check.detail, /Pf Apps Edit/);
  assert.ok(!client.calls.some((c) => c.method !== 'GET'), 'no write is attempted');
  assert.deepEqual(report.lockout_risks, []);
});

test('missing_permission falls back to the product name without a permission entry', async (t) => {
  const saved = PF.permission;
  delete PF.permission;
  t.after(() => { PF.permission = saved; });
  const { client } = world({ probeStatus: 403 });
  const check = failed(await runProductPreflight(client, PLAN, [putOp]), 'permission');
  assert.match(check.detail, /needs "pf"/);
});

test('confirm_name mismatch fails', async () => {
  const { client } = world();
  const bad = await runProductPreflight(client, PLAN, [deleteOp('extranet')]);
  const check = failed(bad, 'confirm_name');
  assert.ok(check, JSON.stringify(bad.checks));
  assert.match(check.detail, /extranet/);
  assert.match(check.detail, /intranet/);
  const good = await runProductPreflight(client, PLAN, [deleteOp('intranet')]);
  assert.ok(good.checks.every((c) => c.ok), JSON.stringify(good.checks));
});

test('in-use resource on page 2 of a list is found and refused with resource_in_use', async () => {
  const rules = [{ name: 'r1', app: 'other' }, { name: 'r2', app: 'other' }, { name: 'r3', app: ID }];
  const { client } = world({ rules });
  const report = await runProductPreflight(client, PLAN, [deleteOp()]);
  const check = failed(report, 'dependencies');
  assert.equal(check.code, 'resource_in_use');
  assert.match(check.detail, /rule r3 uses app/);
  assert.deepEqual(report.dependencies, { [`DELETE ${BASE}/pf/apps/${ID}`]: [`rule r3 uses app ${ID}`] });
  assert.deepEqual(client.calls.filter((c) => c.path.endsWith('/pf/rules')).map((c) => c.query.page), [1, 2]);
});

test('lockout lines and the gathered ctx come back per product', async () => {
  const { client } = world({ lockout: ['Lockout risk: app a.example.com loses its last allow policy.'] });
  const report = await runProductPreflight(client, PLAN, [putOp]);
  assert.deepEqual(report.lockout_risks, ['Lockout risk: app a.example.com loses its last allow policy.']);
  assert.deepEqual(report.ctx.pf.lockout, report.lockout_risks);
  assert.deepEqual(report.checks.map((c) => c.name), ['entitlement', 'permission', 'gather', 'dependencies']);
});

// runPreflight and plan new

test('zone plan with a product op runs product preflight; without one it stays as before', async () => {
  const { client } = world({ lockout: ['Lockout risk: zone rule.'] });
  const target = { scope: 'zone', zone_id: ZID };
  const report = await runPreflight(target, [{ method: 'PATCH', path: `${ZBASE}/pf/rule`, body: { value: 'b' } }], { client });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.deepEqual(report.lockout_risks, ['Lockout risk: zone rule.']);
  const plain = await runPreflight(target, [{ method: 'PATCH', path: `${ZBASE}/settings/ssl`, body: { value: 'strict' } }], { client: null });
  assert.equal(plain.ok, true);
  assert.equal('lockout_risks' in plain, false);
});

async function stubServer(t, route) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const out = route(req.method, url.pathname, Object.fromEntries(url.searchParams), raw ? JSON.parse(raw) : undefined);
      res.statusCode = out.status ?? 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: !out.status, ...out }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

function runCli(cwd, args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', FIXTURE, CLI, ...args], {
      cwd,
      env: { PATH: process.env.PATH, CLAUDEFLARE_KEY_DIR: process.env.CLAUDEFLARE_KEY_DIR, CLOUDFLARE_API_TOKEN: 'api-token-1234', ...env },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

test('lockout lines are stored in lockout_risks and appended to risk', async (t) => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'claudeflare-ppfcli-')));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const line = 'Lockout risk: app a.example.com loses its last allow policy; keep this terminal open.';
  const { route } = world({ lockout: [line], notes: ['Note from preflight data.'] });
  const base = await stubServer(t, route);
  const draft = { scope: 'account', account_id: A, account_name: 'Acme', summary: 'Update app', risk: 'Low.', ops: [putOp], slug: 'pf' };
  writeFileSync(join(cwd, 'draft.json'), JSON.stringify(draft));
  const res = await runCli(cwd, ['plan', 'new', '--file', 'draft.json'], { CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 0, res.stderr);
  const plan = JSON.parse(res.stdout);
  assert.deepEqual(plan.lockout_risks, [line]);
  assert.deepEqual(plan.risk.split('\n'), ['Low.', 'Note from preflight data.', line]);
  assert.deepEqual(readPlan(cwd, plan.id).lockout_risks, [line]);

  const pre = await runCli(cwd, ['preflight', '--file', 'draft.json'], { CLOUDFLARE_API_BASE: base });
  const out = JSON.parse(pre.stdout);
  assert.deepEqual(out.lockout_risks, [line]);
  assert.equal('ctx' in out, false, 'gathered reads are not printed');
});

test('plan new refuses a product plan whose preflight fails', async (t) => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'claudeflare-ppfcli-')));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const base = await stubServer(t, world({ entitled: false }).route);
  const draft = { scope: 'account', account_id: A, account_name: 'Acme', summary: 'Update app', ops: [putOp], slug: 'pf' };
  writeFileSync(join(cwd, 'draft.json'), JSON.stringify(draft));
  const res = await runCli(cwd, ['plan', 'new', '--file', 'draft.json'], { CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 1);
  const error = JSON.parse(res.stderr).error;
  assert.equal(error.code, 'preflight_failed');
  assert.match(error.message, /not_entitled/);
});

// apply

test('apply stops with risk_changed when a new lockout line appears, approval kept', async (t) => {
  const { cwd, plan } = setup(t, [putOp], { lockout_risks: ['Lockout risk: A.'] });
  approve(cwd, plan);
  const { client } = world({ lockout: ['Lockout risk: A.', 'Lockout risk: B.'] });
  await assert.rejects(applyPlan(cwd, client, plan.id, T0), (err) => {
    assert.equal(err.code, 'risk_changed');
    assert.match(err.message, /Lockout risk: B\./);
    assert.doesNotMatch(err.message, /Lockout risk: A\./);
    assert.match(err.hint, /new plan/);
    return true;
  });
  assert.ok(!client.calls.some((c) => c.method !== 'GET'), 'nothing written');
  assert.equal(existsSync(snapshotFile(cwd, plan)), false);
  assert.equal(checkApproval(cwd, plan.id, T0, { plan }).ok, true);
  assert.equal(readPlan(cwd, plan.id).status, 'draft');
});

test('apply continues when a lockout line disappeared', async (t) => {
  const { cwd, plan } = setup(t, [putOp], { lockout_risks: ['Lockout risk: A.'] });
  approve(cwd, plan);
  const { client } = world({ lockout: [] });
  const result = await applyPlan(cwd, client, plan.id, T0);
  assert.equal(result.status, 'applied', JSON.stringify(result.error));
  assert.ok(client.calls.some((c) => c.method === 'PUT'));
});

test('apply stops before any write when product preflight fails, approval kept', async (t) => {
  const { cwd, plan } = setup(t, [putOp], { lockout_risks: [] });
  approve(cwd, plan);
  const { client } = world({ entitled: false });
  await assert.rejects(applyPlan(cwd, client, plan.id, T0), (err) => err.code === 'not_entitled');
  assert.ok(!client.calls.some((c) => c.method !== 'GET'));
  assert.equal(checkApproval(cwd, plan.id, T0, { plan }).ok, true);
});

test('0.2.x plan without lockout_risks applies as before', async (t) => {
  // A product plan without lockout_risks runs no product preflight.
  const legacy = setup(t, [putOp]);
  approve(legacy.cwd, legacy.plan);
  const { client } = world({ entitled: false, lockout: ['Lockout risk: new.'] });
  const result = await applyPlan(legacy.cwd, client, legacy.plan.id, T0);
  assert.equal(result.status, 'applied', JSON.stringify(result.error));
  assert.ok(!client.calls.some((c) => c.path.endsWith('/pf/org') || c.path.endsWith('/pf/state')));

  // A v1 zone plan from 0.2.x reads and writes only its own paths.
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'claudeflare-ppf02-')));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const plan = createPlan(cwd, {
    zone_id: ZID, zone_name: 'example.com', summary: 'TLS', risk: 'low', slug: 'tls',
    ops: [{ method: 'PATCH', path: '/zones/{zone_id}/settings/ssl', body: { value: 'strict' } }],
  }, T0);
  writeApproval(cwd, { plan_id: plan.id, session_id: 's1' }, T0);
  const calls = [];
  const v1 = {
    async request(method, path) {
      calls.push(`${method} ${path}`);
      if (path === `${ZBASE}/settings/ssl`) return { id: 'ssl', value: method === 'GET' ? 'full' : 'strict' };
      throw new Error(`unexpected request ${method} ${path}`);
    },
  };
  const applied = await applyPlan(cwd, v1, plan.id, T0);
  assert.equal(applied.status, 'applied', JSON.stringify(applied.error));
  assert.ok(calls.every((c) => c.endsWith('/settings/ssl')), calls.join(', '));
});

test('rollback plans store lockout lines computed at creation and skip product preflight at apply', async (t) => {
  const { cwd, plan } = setup(t, [putOp], { lockout_risks: ['Lockout risk: R.'] });
  const { client } = world({ lockout: ['Lockout risk: R.'] });
  const updated = await addRollbackLockout(cwd, plan, client);
  assert.deepEqual(updated.lockout_risks, ['Lockout risk: R.']);
  assert.deepEqual(readPlan(cwd, plan.id).risk.split('\n'), ['low', 'Lockout risk: R.']);

  const broken = world({ probeStatus: 403 });
  const again = await addRollbackLockout(cwd, readPlan(cwd, plan.id), broken.client);
  assert.equal(again.lockout_risks.length, 1);
  assert.match(again.lockout_risks[0], /^Lockout risk: lockout analysis could not run/);
});

// approval and guard text

function runHook(script, cwd, keyDir, input) {
  const res = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ session_id: 'sess-1', cwd, ...input }),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDEFLARE_KEY_DIR: keyDir },
  });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('approval and guard ask text list Lockout risk lines first', (t) => {
  const lines = ['Lockout risk: app a.example.com loses its last allow policy.', 'Lockout risk: IdP okta is the only login method.'];
  const { cwd, keyDir, plan } = setup(t, [putOp], { risk: ['Low.', lines[0], 'Not reversible: x.', lines[1]].join('\n'), lockout_risks: lines });
  const approved = runHook(APPROVE, cwd, keyDir, { prompt: `/claudeflare:approve ${plan.id}` }).systemMessage;
  assert.ok(approved.startsWith(`${lines[0]}\n${lines[1]}\nApproval recorded for ${plan.id}.`), approved);
  assert.match(approved, /Risk: Low\.\nNot reversible: x\. 1 op/);
  const reason = runHook(GUARD, cwd, keyDir, { tool_name: 'Bash', tool_input: { command: `claudeflare apply ${plan.id}` } })
    .hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.startsWith(`${lines[0]}\n${lines[1]}\nApply plan ${plan.id}: Zero Trust. Risk: Low.\nNot reversible: x. Ops:`), reason);
});
