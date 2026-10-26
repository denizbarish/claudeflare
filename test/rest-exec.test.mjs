import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import './fixtures/products/sx.mjs';
import { assertSecretFieldsEnv, executeRestOps } from '../scripts/lib/rest-exec.mjs';
import { createClient, redact } from '../scripts/lib/api.mjs';
import { applyPlan, createRollbackPlan, snapshotFile } from '../scripts/lib/apply.mjs';
import { createPlan, readPlan, updatePlan } from '../scripts/lib/plans.mjs';
import { checkApproval, writeApproval } from '../scripts/lib/approvals.mjs';
import { registerProduct } from '../scripts/lib/products/index.mjs';
import { paths } from '../scripts/lib/paths.mjs';
import { CfError } from '../scripts/lib/errors.mjs';

const A = '0123456789abcdef0123456789abcdef';
const BASE = `/accounts/${A}`;
const ID = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';
const NEW = 'ffffffff-4e5f-6789-abcd-ef0123456789';
const NEW2 = 'eeeeeeee-4e5f-6789-abcd-ef0123456789';
const T0 = new Date('2026-10-26T10:00:00Z');
const SECRET = 's3cr3t-okta-value-91';
const TOKEN_SECRET = 'tok-s3cr3t-eyJhIjoiYiJ9';
const TUNNEL_SECRET = 'tun-s3cr3t-AAAABBBB';
const CLIENT_SECRET = 'cs-s3cr3t-0f0f0f0f';
const ALL_SECRETS = [SECRET, TOKEN_SECRET, TUNNEL_SECRET, CLIENT_SECRET];
const CLI = fileURLToPath(new URL('../scripts/cf.mjs', import.meta.url));
const FIXTURE = pathToFileURL(fileURLToPath(new URL('./fixtures/products/sx.mjs', import.meta.url))).href;

const idpCreate = (extra = {}) => ({
  method: 'POST',
  path: `${BASE}/sx/idps`,
  body: { name: 'okta', config: { client_id: 'okta-client' } },
  secret_fields_from_env: { 'config.client_secret': 'OKTA_SECRET' },
  ...extra,
});
const tunnelCreate = { method: 'POST', path: `${BASE}/sx/tunnels`, body: { name: 'home', config_src: 'cloudflare' } };
const tokenCreate = { method: 'POST', path: `${BASE}/sx/tokens`, body: { name: 'ci' } };
const idpUpdate = {
  method: 'PUT',
  path: `${BASE}/sx/idps/${ID}`,
  body: { name: 'okta2', config: { client_id: 'okta-client' } },
  secret_fields_from_env: { 'config.client_secret': 'OKTA_SECRET' },
};

function setup(t, ops, { now = T0 } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'claudeflare-restexec-'));
  const keyDir = mkdtempSync(join(tmpdir(), 'claudeflare-key-'));
  const saved = process.env.CLAUDEFLARE_KEY_DIR;
  process.env.CLAUDEFLARE_KEY_DIR = keyDir;
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CLAUDEFLARE_KEY_DIR;
    else process.env.CLAUDEFLARE_KEY_DIR = saved;
  });
  const plan = createPlan(cwd, {
    scope: 'account', account_id: A, account_name: 'Acme', summary: 'Zero Trust', risk: 'low', ops, slug: 'zt',
  }, now);
  return { cwd, keyDir, plan: updatePlan(cwd, plan.id, { slug: 'zt' }) };
}

const approve = (cwd, plan, now = T0) => writeApproval(cwd, { plan_id: plan.id, session_id: 's1' }, now);

function fakeClient(routes) {
  const calls = [];
  return {
    calls,
    async request(method, path, opts) {
      calls.push({ method, path, opts: structuredClone(opts) });
      const handler = routes[`${method} ${path}`];
      if (handler === undefined) throw new Error(`unexpected request ${method} ${path}`);
      return typeof handler === 'function' ? handler(opts) : structuredClone(handler);
    },
  };
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

function assertNoSecret(value, label, secrets = ALL_SECRETS) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) assert.ok(!text.includes(secret), `${label} contains ${secret}`);
}

// Every file under .claudeflare except the secrets dir is secret free.
function assertTreeClean(cwd, secrets = ALL_SECRETS) {
  const files = listFiles(paths(cwd).root).filter((f) => !f.startsWith(paths(cwd).secrets));
  assert.ok(files.length > 0);
  for (const file of files) assertNoSecret(readFileSync(file, 'utf8'), file, secrets);
}

const echoIdp = (opts) => ({ id: NEW, ...opts.body });

test('secret_fields_from_env injects the value into the sent body only', async (t) => {
  const { cwd, plan } = setup(t, [idpCreate()]);
  approve(cwd, plan);
  const onDisk = readFileSync(join(paths(cwd).plans, `${plan.id}.json`), 'utf8');
  const client = fakeClient({
    [`POST ${BASE}/sx/idps`]: echoIdp,
    [`GET ${BASE}/sx/idps/${NEW}`]: { id: NEW, name: 'okta', config: { client_id: 'okta-client', client_secret: SECRET } },
  });
  const applied = await applyPlan(cwd, client, plan.id, T0, { env: { OKTA_SECRET: SECRET } });
  assert.equal(applied.status, 'applied');
  const sent = client.calls.find((c) => c.method === 'POST');
  assert.deepEqual(sent.opts.body, { name: 'okta', config: { client_id: 'okta-client', client_secret: SECRET } });
  // The plan's own ops are never changed.
  assert.deepEqual(readPlan(cwd, plan.id).ops, plan.ops);
  assert.ok(!onDisk.includes(SECRET));
  assert.equal(applied.results[0].id, NEW);
  assert.equal(applied.results[0].config.client_secret, '[redacted]');
  assertNoSecret(applied, 'apply result');
  assertNoSecret(readFileSync(snapshotFile(cwd, plan), 'utf8'), 'snapshot');
  assertTreeClean(cwd);
});

test('executeRestOps keeps post and results free of the injected value', async () => {
  const plan = { id: 'acme-1-zt', scope: 'account', account_id: A, ops: [idpCreate()] };
  const client = fakeClient({
    [`POST ${BASE}/sx/idps`]: echoIdp,
    // Echoed at a path the kind does not declare: the known value is scrubbed anyway.
    [`GET ${BASE}/sx/idps/${NEW}`]: { id: NEW, name: 'okta', config: { client_id: 'okta-client', client_secret: SECRET }, debug: `sent ${SECRET}` },
  });
  const cwd = mkdtempSync(join(tmpdir(), 'claudeflare-restexec-'));
  try {
    const out = await executeRestOps({ client, plan, cwd, env: { OKTA_SECRET: SECRET } });
    assert.equal(out.status, 'applied');
    assert.equal(out.post[0].id, NEW);
    assert.equal('client_secret' in out.post[0].config, false);
    assert.equal(out.post[0].debug, 'sent [REDACTED]');
    assertNoSecret(out, 'outcome');
    assert.deepEqual(plan.ops[0].body, { name: 'okta', config: { client_id: 'okta-client' } });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('missing env var is secret_env_missing and nothing is sent', async (t) => {
  const { cwd, plan } = setup(t, [tunnelCreate, idpCreate()]);
  approve(cwd, plan);
  const client = fakeClient({});
  await assert.rejects(
    applyPlan(cwd, client, plan.id, T0, { env: { OKTA_SECRET: '' } }),
    (err) => err instanceof CfError && err.code === 'secret_env_missing' && /OKTA_SECRET/.test(err.message),
  );
  assert.deepEqual(client.calls, []);
  assert.equal(readPlan(cwd, plan.id).status, 'draft');
  assert.equal(existsSync(snapshotFile(cwd, plan)), false);
  assert.equal(checkApproval(cwd, plan.id, T0).ok, true);
  assert.throws(() => assertSecretFieldsEnv(plan, {}), (err) => err.code === 'secret_env_missing');
  assert.doesNotThrow(() => assertSecretFieldsEnv(plan, { OKTA_SECRET: 'x' }));
});

test('redact paths replace token and credentials_file in results and post', async () => {
  const plan = { id: 'acme-1-zt', scope: 'account', account_id: A, ops: [tunnelCreate] };
  const created = { id: NEW, name: 'home', token: TOKEN_SECRET, credentials_file: { AccountTag: A, TunnelID: NEW, TunnelSecret: TUNNEL_SECRET } };
  const client = fakeClient({
    [`POST ${BASE}/sx/tunnels`]: created,
    [`GET ${BASE}/sx/tunnels/${NEW}`]: { ...created, status: 'inactive' },
  });
  const out = await executeRestOps({ client, plan, cwd: tmpdir(), env: {} });
  assert.equal(out.status, 'applied');
  assert.deepEqual(out.results[0], { id: NEW, name: 'home', token: '[redacted]', credentials_file: '[redacted]' });
  assert.deepEqual(out.post[0], { id: NEW, name: 'home', token: '[redacted]', credentials_file: '[redacted]', status: 'inactive' });
  assertNoSecret(out, 'outcome');
});

test('secretSink writes client_id and client_secret to .claudeflare/secrets/<plan>-<i>.json with mode 0600', async (t) => {
  const { cwd, plan } = setup(t, [tunnelCreate, tokenCreate]);
  approve(cwd, plan);
  const client = fakeClient({
    [`POST ${BASE}/sx/tunnels`]: { id: NEW, name: 'home' },
    [`GET ${BASE}/sx/tunnels/${NEW}`]: { id: NEW, name: 'home' },
    [`POST ${BASE}/sx/tokens`]: { id: NEW2, name: 'ci', client_id: 'cid.access', client_secret: CLIENT_SECRET },
    [`GET ${BASE}/sx/tokens/${NEW2}`]: { id: NEW2, name: 'ci', client_id: 'cid.access' },
  });
  const applied = await applyPlan(cwd, client, plan.id, T0, { env: {} });
  assert.equal(applied.status, 'applied');
  const file = join(cwd, '.claudeflare', 'secrets', `${plan.id}-1.json`);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { client_id: 'cid.access', client_secret: CLIENT_SECRET });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(applied.results[1], { id: NEW2, name: 'ci', client_id: '[redacted]', client_secret: '[redacted]', secret_file: file });
  assertTreeClean(cwd);
  // delete_created still reads the id from the stored result.
  const rollback = createRollbackPlan(cwd, plan.id, T0);
  assert.deepEqual(rollback.ops.map((op) => `${op.method} ${op.path}`), [`DELETE ${BASE}/sx/tokens/${NEW2}`, `DELETE ${BASE}/sx/tunnels/${NEW}`]);
});

test('the sink file is listed in secret-files.json and .claudeflare/.gitignore has secrets/', async (t) => {
  const { cwd, plan } = setup(t, [tokenCreate]);
  approve(cwd, plan);
  const client = fakeClient({
    [`POST ${BASE}/sx/tokens`]: { id: NEW2, client_id: 'cid.access', client_secret: CLIENT_SECRET },
    [`GET ${BASE}/sx/tokens/${NEW2}`]: { id: NEW2 },
  });
  await applyPlan(cwd, client, plan.id, T0, { env: {} });
  const file = join(cwd, '.claudeflare', 'secrets', `${plan.id}-0.json`);
  assert.deepEqual(JSON.parse(readFileSync(paths(cwd).secretFilesIndex, 'utf8')).files, [file]);
  assert.match(readFileSync(join(cwd, '.claudeflare', '.gitignore'), 'utf8'), /^secrets\/$/m);
});

// A real client against a fake fetch whose 400 body repeats the request.
function echoingClient(failOn) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname.replace('/client/v4', '');
    calls.push(`${init.method} ${path}`);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (`${init.method} ${path}` === failOn) {
      return json(400, { success: false, errors: [{ code: 1001, message: `invalid request ${init.body}` }] });
    }
    if (init.method === 'POST' && path.endsWith('/sx/tokens')) {
      return json(200, { success: true, result: { id: NEW2, client_id: 'cid.access', client_secret: CLIENT_SECRET } });
    }
    if (init.method === 'POST' && path.endsWith('/sx/tunnels')) {
      return json(200, { success: true, result: { id: NEW, token: TOKEN_SECRET } });
    }
    return json(200, { success: true, result: { id: NEW } });
  };
  return { client: createClient({ token: 'api-token-1234', fetchImpl, maxRetries: 0 }), calls };
}

test('a 400 error echoing the injected secret is redacted in error.message', async (t) => {
  const { cwd, plan } = setup(t, [idpCreate()]);
  approve(cwd, plan);
  const { client } = echoingClient(`POST ${BASE}/sx/idps`);
  const applied = await applyPlan(cwd, client, plan.id, T0, { env: { OKTA_SECRET: SECRET } });
  assert.equal(applied.status, 'failed');
  assert.equal(applied.error.op_index, 0);
  assert.match(applied.error.message, /\[REDACTED\]/);
  assertNoSecret(applied, 'apply result');
  assertTreeClean(cwd);
});

test('an error echoing a secret received earlier in the run is redacted', async (t) => {
  const failing = { method: 'POST', path: `${BASE}/sx/idps`, body: { name: 'x', config: { note: CLIENT_SECRET } } };
  const plan = { id: 'acme-1-zt', scope: 'account', account_id: A, ops: [tokenCreate, tunnelCreate, failing] };
  const cwd = mkdtempSync(join(tmpdir(), 'claudeflare-restexec-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const { client } = echoingClient(`POST ${BASE}/sx/idps`);
  const out = await executeRestOps({ client, plan, cwd, env: {} });
  assert.equal(out.status, 'partially_applied');
  assert.equal(out.error.op_index, 2);
  assertNoSecret(out, 'outcome');
});

test('429 on op 2 of 3 ends partially_applied with results for op 1 and rollback covers op 1', async (t) => {
  const { cwd, plan } = setup(t, [tunnelCreate, idpUpdate, tokenCreate]);
  approve(cwd, plan);
  const client = fakeClient({
    [`GET ${BASE}/sx/idps/${ID}`]: { id: ID, name: 'okta', config: { client_id: 'okta-client', client_secret: 'masked' } },
    [`POST ${BASE}/sx/tunnels`]: { id: NEW, name: 'home', token: TOKEN_SECRET },
    [`GET ${BASE}/sx/tunnels/${NEW}`]: { id: NEW, name: 'home' },
    [`PUT ${BASE}/sx/idps/${ID}`]: (opts) => { throw new CfError('rate_limit', `Too many requests for ${JSON.stringify(opts.body)} ${TOKEN_SECRET}`, { status: 429 }); },
  });
  const applied = await applyPlan(cwd, client, plan.id, T0, { env: { OKTA_SECRET: SECRET } });
  assert.equal(applied.status, 'partially_applied');
  assert.equal(applied.error.op_index, 1);
  assert.equal(applied.error.code, 'rate_limit');
  assert.equal(applied.results[0].id, NEW);
  assert.deepEqual(applied.results.slice(1), [null, null]);
  assert.equal(client.calls.some((c) => c.path === `${BASE}/sx/tokens`), false);
  assertNoSecret(applied, 'apply result');
  assertTreeClean(cwd);
  const rollback = createRollbackPlan(cwd, plan.id, T0);
  assert.deepEqual(rollback.ops, [{ method: 'DELETE', path: `${BASE}/sx/tunnels/${NEW}` }]);
});

test('a failing post read is recorded as post_error and does not fail the apply', async () => {
  const plan = { id: 'acme-1-zt', scope: 'account', account_id: A, ops: [tunnelCreate] };
  const client = fakeClient({
    [`POST ${BASE}/sx/tunnels`]: { id: NEW, token: TOKEN_SECRET },
    [`GET ${BASE}/sx/tunnels/${NEW}`]: () => { throw new CfError('api', `read failed ${TOKEN_SECRET}`, { status: 500 }); },
  });
  const out = await executeRestOps({ client, plan, cwd: tmpdir(), env: {} });
  assert.equal(out.status, 'applied');
  assert.deepEqual(out.post, [null]);
  assert.match(out.results[0].note, /^post_error: api: read failed \[REDACTED\]$/);
  assert.equal(out.results[0].id, NEW);
  assertNoSecret(out, 'outcome');
});

test('a product DELETE sends no post read', async () => {
  const op = { method: 'DELETE', path: `${BASE}/sx/things/${ID}`, confirm_name: 'x' };
  const plan = { id: 'acme-1-zt', scope: 'account', account_id: A, ops: [op] };
  const client = fakeClient({ [`DELETE ${BASE}/sx/things/${ID}`]: null });
  const out = await executeRestOps({ client, plan, cwd: tmpdir(), env: {} });
  assert.deepEqual(out, { status: 'applied', results: [true], post: [null] });
  assert.equal(client.calls.length, 1);
});

const ZID = '0123456789abcdef0123456789abcdef';
const ZONE_OPS = [
  { method: 'PATCH', path: `/zones/${ZID}/settings/ssl`, body: { value: 'strict' } },
  { method: 'PATCH', path: `/zones/${ZID}/settings/always_use_https`, body: { value: 'on' } },
  { method: 'POST', path: `/zones/${ZID}/dns_records`, body: { type: 'A', name: 'x', content: '192.0.2.1' } },
];

test('zone v1 plan through executeRestOps behaves exactly as before', async () => {
  const plan = { id: 'examplecom-1-tls', zone_id: ZID, zone_name: 'example.com', ops: ZONE_OPS };
  const ok = fakeClient({
    [`PATCH /zones/${ZID}/settings/ssl`]: { id: 'ssl', value: 'strict' },
    [`PATCH /zones/${ZID}/settings/always_use_https`]: null,
    [`POST /zones/${ZID}/dns_records`]: { id: 'rec1' },
  });
  const out = await executeRestOps({ client: ok, plan, cwd: tmpdir(), env: {} });
  assert.deepEqual(out, { status: 'applied', results: [{ id: 'ssl', value: 'strict' }, true, { id: 'rec1' }], post: [null, null, null] });
  assert.deepEqual(ok.calls, ZONE_OPS.map(({ method, path, body }) => ({ method, path, opts: { body } })));

  const boom = () => { throw new CfError('api', 'boom', { status: 400 }); };
  const partial = await executeRestOps({ client: fakeClient({ [`PATCH /zones/${ZID}/settings/ssl`]: { id: 'ssl' }, [`PATCH /zones/${ZID}/settings/always_use_https`]: boom }), plan, cwd: tmpdir(), env: {} });
  assert.deepEqual(partial, { status: 'partially_applied', results: [{ id: 'ssl' }, null, null], error: { op_index: 1, code: 'api', message: 'boom' }, post: [null, null, null] });
  const failed = await executeRestOps({ client: fakeClient({ [`PATCH /zones/${ZID}/settings/ssl`]: boom }), plan, cwd: tmpdir(), env: {} });
  assert.deepEqual(failed, { status: 'failed', results: [null, null, null], error: { op_index: 0, code: 'api', message: 'boom' }, post: [null, null, null] });
});

test('redact keeps its signature and also replaces extra values, longest first', () => {
  assert.equal(redact('a tok b', 'tok'), 'a [REDACTED] b');
  assert.equal(redact('plain', undefined), 'plain');
  assert.equal(redact('x abc abcdef y', undefined, ['abc', 'abcdef']), 'x [REDACTED] [REDACTED] y');
  assert.equal(redact('t1 v1', 't1', ['v1', '', null]), '[REDACTED] [REDACTED]');
});

const kind = (extra) => ({
  kind: `guard_${Math.random().toString(36).slice(2)}`, product: 'guard', scope: 'account', methods: ['POST'], pattern: /^\/guard$/,
  resource: () => null, readOnlyFields: [], inverse: 'none', destructive: false, ...extra,
});

test('registerProduct refuses a kind whose redact or secretSink names id', () => {
  for (const extra of [{ redact: ['id'] }, { secretSink: ['client_secret', 'id'] }]) {
    assert.throws(() => registerProduct({ product: 'guard', kinds: [kind(extra)] }), /id/);
  }
});

test('registerProduct refuses secret paths ending in * or a numeric index', () => {
  for (const field of ['secretFields', 'redact', 'secretSink']) {
    for (const path of ['rules.*', 'rules.0', '*', '12']) {
      assert.throws(() => registerProduct({ product: 'guard', kinds: [kind({ [field]: [path] })] }), /last segment/, `${field} ${path}`);
    }
  }
  const unregister = registerProduct({ product: 'guard', kinds: [kind({ secretFields: ['rules.*.secret'], redact: ['a.0.token'] })] });
  unregister();
});

// CLI: the child process registers the fake product with --import.
function runCli(cwd, args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', FIXTURE, CLI, ...args], {
      cwd,
      env: { PATH: process.env.PATH, CLAUDEFLARE_KEY_DIR: process.env.CLAUDEFLARE_KEY_DIR, CLOUDFLARE_API_TOKEN: 'api-token-1234', ...env },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

async function stubServer(t, handle) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const { status = 200, body } = handle(req.method, req.url.split('?')[0], raw);
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('cli apply never prints or stores the injected or received secrets', async (t) => {
  const now = new Date();
  const { cwd, plan } = setup(t, [idpCreate(), tokenCreate], { now });
  approve(cwd, plan, now);
  const base = await stubServer(t, (method, path, raw) => {
    if (method === 'POST' && path === `${BASE}/sx/idps`) return { body: { success: true, result: { id: NEW, ...JSON.parse(raw) } } };
    if (method === 'POST' && path === `${BASE}/sx/tokens`) return { body: { success: true, result: { id: NEW2, client_id: 'cid', client_secret: CLIENT_SECRET } } };
    return { body: { success: true, result: { id: NEW, echo: `${SECRET} ${CLIENT_SECRET}` } } };
  });
  const res = await runCli(cwd, ['apply', plan.id], { CLOUDFLARE_API_BASE: base, OKTA_SECRET: SECRET });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).status, 'applied');
  assertNoSecret(res.stdout, 'stdout');
  assertNoSecret(res.stderr, 'stderr');
  assertTreeClean(cwd);
});

test('cli apply failure echoing the secret keeps stderr and the plan clean', async (t) => {
  const now = new Date();
  const { cwd, plan } = setup(t, [idpCreate()], { now });
  approve(cwd, plan, now);
  const base = await stubServer(t, (method, path, raw) => ({
    status: 400,
    body: { success: false, errors: [{ code: 1001, message: `bad request ${raw}` }] },
  }));
  const res = await runCli(cwd, ['apply', plan.id], { CLOUDFLARE_API_BASE: base, OKTA_SECRET: SECRET });
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stderr).error.code, 'apply_failed');
  assertNoSecret(res.stdout, 'stdout');
  assertNoSecret(res.stderr, 'stderr');
  assertTreeClean(cwd);
});

// Review fixes: identifiers stay intact, post-request failures are recorded,
// claudeflare's own variables are never a secret source.

test('tunnel create keeps account_tag and id intact while token and credentials_file are redacted', async () => {
  const failing = { method: 'POST', path: `${BASE}/sx/idps`, body: { name: 'x', config: {} } };
  const plan = { id: 'acme-1-zt', scope: 'account', account_id: A, ops: [tunnelCreate, failing] };
  const created = { id: NEW, name: 'home', account_tag: A, token: TOKEN_SECRET, credentials_file: { AccountTag: A, TunnelID: NEW, TunnelSecret: TUNNEL_SECRET } };
  const client = fakeClient({
    [`POST ${BASE}/sx/tunnels`]: created,
    [`GET ${BASE}/sx/tunnels/${NEW}`]: { id: NEW, name: 'home', account_tag: A },
    [`POST ${BASE}/sx/idps`]: () => { throw new CfError('api', `tunnel ${NEW} in ${A} rejected ${TUNNEL_SECRET}`, { status: 400 }); },
  });
  const out = await executeRestOps({ client, plan, cwd: tmpdir(), env: {} });
  assert.deepEqual(out.results[0], { id: NEW, name: 'home', account_tag: A, token: '[redacted]', credentials_file: '[redacted]' });
  assert.deepEqual(out.post[0], { id: NEW, name: 'home', account_tag: A });
  assert.equal(out.error.message, `tunnel ${NEW} in ${A} rejected [REDACTED]`);
  assertNoSecret(out, 'outcome');
});

const flaky = {
  product: 'flaky',
  kinds: [{
    kind: 'flaky_put', product: 'flaky', scope: 'account', methods: ['PUT'], pattern: /^\/flaky\/([0-9a-f-]{36})$/,
    resource: (m) => ({ type: 'flaky', id: m[1] }), readOnlyFields: ['id'], inverse: 'none', destructive: false,
    secretFields: ['config.client_secret'], redact: ['token'],
    read: () => { throw new Error(`read() broke with ${SECRET}`); },
  }],
  probePath: (base) => `${base}/flaky`,
  gather: async () => ({}),
  lockoutRisks: () => [],
  verifyChecks: () => [],
};

test('a kind whose read() throws after op 2 ran ends partially_applied with op 2 recorded and the error redacted', async (t) => {
  t.after(registerProduct(flaky));
  const put = { method: 'PUT', path: `${BASE}/flaky/${ID}`, body: { config: {} }, secret_fields_from_env: { 'config.client_secret': 'OKTA_SECRET' } };
  const plan = { id: 'acme-1-zt', scope: 'account', account_id: A, ops: [tunnelCreate, put, tokenCreate] };
  const client = fakeClient({
    [`POST ${BASE}/sx/tunnels`]: { id: NEW, token: TOKEN_SECRET },
    [`GET ${BASE}/sx/tunnels/${NEW}`]: { id: NEW },
    [`PUT ${BASE}/flaky/${ID}`]: { id: ID, token: TOKEN_SECRET, config: { client_secret: SECRET } },
  });
  const out = await executeRestOps({ client, plan, cwd: tmpdir(), env: { OKTA_SECRET: SECRET } });
  assert.equal(out.status, 'partially_applied');
  assert.equal(out.error.op_index, 1);
  assert.equal(out.error.message, 'read() broke with [REDACTED]');
  assert.equal(out.results[0].id, NEW);
  assert.deepEqual(out.results[1], { id: ID, token: '[redacted]', config: { client_secret: '[redacted]' } });
  assert.equal(out.results[2], null);
  assert.equal(client.calls.some((c) => c.path === `${BASE}/sx/tokens`), false);
  assertNoSecret(out, 'outcome');

  // On op 1 the op still ran, so the plan is partially applied, not failed.
  const first = await executeRestOps({ client, plan: { ...plan, ops: [put] }, cwd: tmpdir(), env: { OKTA_SECRET: SECRET } });
  assert.equal(first.status, 'partially_applied');
  assert.equal(first.results[0].id, ID);
});

test('claudeflare variables and the API token value are never a secret source (invalid_op, value not echoed)', () => {
  const plan = (name) => ({ ops: [idpCreate({ secret_fields_from_env: { 'config.client_secret': name } })] });
  for (const name of ['CLOUDFLARE_API_TOKEN', 'CLAUDEFLARE_KEY_DIR', 'CF_API_KEY']) {
    assert.throws(() => assertSecretFieldsEnv(plan(name), { [name]: 'v' }), (e) => e.code === 'invalid_op' && e.message.includes(name));
  }
  const token = 'cf-api-token-value-123';
  assert.throws(
    () => assertSecretFieldsEnv(plan('OKTA_SECRET'), { OKTA_SECRET: token, CLOUDFLARE_API_TOKEN: token }),
    (e) => e.code === 'invalid_op' && /OKTA_SECRET/.test(e.message) && !e.message.includes(token) && !e.hint.includes(token),
  );
  const saved = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = token;
  try {
    assert.throws(() => assertSecretFieldsEnv(plan('OKTA_SECRET'), { OKTA_SECRET: token }), (e) => e.code === 'invalid_op');
  } finally {
    if (saved === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = saved;
  }
});

test('a failed sink write keeps the result and tells the user to rotate the credential', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'claudeflare-restexec-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'claudeflare-elsewhere-'));
  t.after(() => { rmSync(cwd, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); });
  // A symlinked .claudeflare makes the secret write refuse.
  symlinkSync(elsewhere, join(cwd, '.claudeflare'));
  const plan = { id: 'acme-1-zt', scope: 'account', account_id: A, ops: [tokenCreate] };
  const client = fakeClient({ [`POST ${BASE}/sx/tokens`]: { id: NEW2, client_id: 'cid', client_secret: CLIENT_SECRET } });
  const out = await executeRestOps({ client, plan, cwd, env: {} });
  assert.equal(out.status, 'partially_applied');
  assert.equal(out.results[0].id, NEW2);
  assert.match(out.error.hint, /rotate or recreate/);
  assertNoSecret(out, 'outcome');
  assert.deepEqual(readdirSync(elsewhere), []);
});
