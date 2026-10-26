import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlan, readPlan, updatePlan } from '../scripts/lib/plans.mjs';
import { checkApproval, writeApproval } from '../scripts/lib/approvals.mjs';
import { applyPlan, createRollbackPlan, snapshotFile } from '../scripts/lib/apply.mjs';
import { computeSourceHash } from '../scripts/lib/source-hash.mjs';
import { runWrangler } from '../scripts/lib/wrangler.mjs';
import { runHealthCheck } from '../scripts/lib/health-check.mjs';
import { CfError } from '../scripts/lib/errors.mjs';

const CLI = fileURLToPath(new URL('../scripts/cf.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/wrangler/fake-wrangler.mjs', import.meta.url));
const T0 = new Date('2026-10-24T14:30:00Z');
const AID = 'abcdef0123456789abcdef0123456789';
const TOKEN = 'tok-apply-wrangler-SECRET-987';
const SECRET = 'canary-secret-value-5f3e9a1c';
const V_PREV = '22222222-2222-4222-8222-222222222222';
const V_NEW = '44444444-4444-4444-8444-444444444444';
const V_OTHER = '55555555-5555-4555-8555-555555555555';
const KV_ID = '0f2ac74b498b48028cb68387c421e279';
const HEALTH = { url: 'https://api.example.com/health', expect_status: 200 };
const ENV_KEYS = [
  'CLAUDEFLARE_WRANGLER', 'FAKE_WRANGLER_SCRIPT', 'FAKE_WRANGLER_LOG', 'CLOUDFLARE_API_TOKEN',
  'CLAUDEFLARE_KEY_DIR', 'STRIPE_KEY',
];

const w = (args, extra = {}) => ({ kind: 'wrangler', args, ...extra });
// Deploy op with the source hash plan new would embed.
const dep = (extra = {}) => w(['deploy', '--name', 'api'], { source_hash: computeSourceHash(cwd), ...extra });

let cwd;
let aux;
let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'claudeflare-applyw-')));
  aux = mkdtempSync(join(tmpdir(), 'claudeflare-applyw-aux-'));
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'index.js'), 'export default { fetch() { return new Response("ok"); } };\n');
  process.env.CLAUDEFLARE_WRANGLER = FAKE;
  process.env.FAKE_WRANGLER_SCRIPT = join(aux, 'script.json');
  process.env.FAKE_WRANGLER_LOG = join(aux, 'log.ndjson');
  process.env.CLOUDFLARE_API_TOKEN = TOKEN;
  process.env.CLAUDEFLARE_KEY_DIR = join(aux, 'key');
  delete process.env.STRIPE_KEY;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(cwd, { recursive: true, force: true });
  rmSync(aux, { recursive: true, force: true });
});

const deploymentsJson = (versions) => JSON.stringify([
  { id: 'dep-1', created_on: '2026-10-01T00:00:00Z', versions: versions.map((id) => ({ version_id: id, percentage: 100 })) },
]);

const BASE_SCRIPT = {
  '--version': { stdout: '4.152.0\n' },
  'deployments list --name api --json': { stdout: deploymentsJson([V_PREV]) },
  'deploy --name api': {
    events: [{ type: 'wrangler-session', version: 1 }, { type: 'deploy', version: 1, worker_name: 'api', version_id: V_NEW }],
  },
};

function script(entries) {
  writeFileSync(process.env.FAKE_WRANGLER_SCRIPT, JSON.stringify({ ...BASE_SCRIPT, ...entries }));
}

function calls() {
  try {
    return readFileSync(process.env.FAKE_WRANGLER_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// Every wrangler invocation except the version check.
const workCalls = () => calls().filter((c) => c.argv && c.argv[0] !== '--version').map((c) => c.argv);

function makePlan(ops, slug = 'deploy') {
  const plan = createPlan(
    cwd,
    { scope: 'account', account_id: AID, account_name: 'Acme', project_dir: cwd, summary: 's', risk: 'r', ops, slug },
    T0,
  );
  return updatePlan(cwd, plan.id, { slug });
}

function approve(plan, now = T0) {
  writeApproval(cwd, { plan_id: plan.id, session_id: 's1' }, now);
}

// routes: "METHOD path" -> value or function(opts) returning a value (or throwing).
function fakeClient(routes = {}) {
  const requests = [];
  const all = { [`GET /accounts/${AID}`]: { id: AID, name: 'Acme' }, ...routes };
  return {
    requests,
    async request(method, path, opts) {
      requests.push({ method, path, opts });
      const handler = all[`${method} ${path}`];
      if (handler === undefined) throw new Error(`unexpected request ${method} ${path}`);
      return typeof handler === 'function' ? handler(opts) : handler;
    },
  };
}

function healthDeps(statuses) {
  const fetched = [];
  const slept = [];
  return {
    fetched,
    slept,
    deps: {
      fetchImpl: async (url, init) => {
        fetched.push({ url, init });
        return { status: statuses[Math.min(fetched.length - 1, statuses.length - 1)] };
      },
      sleep: async (ms) => {
        slept.push(ms);
      },
    },
  };
}

test('happy deploy records the version id from ND-JSON and status applied', async () => {
  script({});
  const plan = makePlan([dep({ worker: 'api', health_check: HEALTH })]);
  approve(plan);
  const { fetched, deps } = healthDeps([200]);
  const result = await applyPlan(cwd, fakeClient(), plan.id, T0, deps);
  assert.equal(result.status, 'applied');
  assert.equal(result.error, null);
  assert.equal(result.results[0].version_id, V_NEW);
  assert.ok(Array.isArray(result.results[0].events));
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].init.method, 'GET');
  assert.equal(fetched[0].init.redirect, 'manual');
  assert.deepEqual(workCalls(), [
    ['deployments', 'list', '--name', 'api', '--json'],
    ['deploy', '--name', 'api'],
  ]);
  assert.equal(checkApproval(cwd, plan.id, T0).ok, false);
  const snap = JSON.parse(readFileSync(snapshotFile(cwd, plan), 'utf8'));
  assert.deepEqual(snap.entries[0].before.versions, [{ version_id: V_PREV, percentage: 100 }]);
});

test('changed source refuses with source_changed, keeps the approval and runs no wrangler op', async () => {
  script({});
  const hash = computeSourceHash(cwd);
  const plan = makePlan([w(['deploy', '--name', 'api'], { source_hash: hash })]);
  approve(plan);
  writeFileSync(join(cwd, 'src', 'index.js'), 'export default {};\n');
  await assert.rejects(applyPlan(cwd, fakeClient(), plan.id, T0), (e) => e instanceof CfError && e.code === 'source_changed');
  assert.deepEqual(workCalls(), []);
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: true });
  assert.equal(readPlan(cwd, plan.id).status, 'draft');
  assert.equal(existsSync(snapshotFile(cwd, plan)), false);
});

test('source hash is recomputed with the op source_paths and an unchanged source applies', async () => {
  script({});
  mkdirSync(join(cwd, 'dist'));
  writeFileSync(join(cwd, 'dist', 'app.js'), 'built\n');
  const hash = computeSourceHash(cwd, { extraPaths: ['dist'] });
  const plan = makePlan([w(['deploy', '--name', 'api'], { source_hash: hash, source_paths: ['dist'] })]);
  approve(plan);
  const result = await applyPlan(cwd, fakeClient(), plan.id, T0);
  assert.equal(result.status, 'applied');
});

test('missing secret env refuses with secret_env_missing before anything runs', async () => {
  script({});
  const plan = makePlan([w(['secret', 'put', 'STRIPE_KEY', '--name', 'api'], { worker: 'api', value_from_env: 'STRIPE_KEY' })], 'secret');
  approve(plan);
  await assert.rejects(applyPlan(cwd, fakeClient(), plan.id, T0), (e) => e instanceof CfError && e.code === 'secret_env_missing');
  assert.deepEqual(workCalls(), []);
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: true });
});

test('source-uploading op without source_hash is refused before anything runs', async () => {
  script({});
  for (const args of [['deploy', '--name', 'api'], ['pages', 'deploy', 'dist', '--project-name', 'site'], ['d1', 'migrations', 'apply', 'app-db', '--remote']]) {
    rmSync(join(cwd, '.claudeflare'), { recursive: true, force: true });
    mkdirSync(join(cwd, 'dist'), { recursive: true });
    const plan = makePlan([w(args)]);
    approve(plan);
    await assert.rejects(applyPlan(cwd, fakeClient(), plan.id, T0), (e) => e instanceof CfError && e.code === 'source_hash_missing');
    assert.deepEqual(workCalls(), []);
    assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: true });
  }
});

test('account the token cannot read refuses with account_mismatch before anything runs', async () => {
  script({});
  const plan = makePlan([dep()]);
  approve(plan);
  const client = fakeClient({
    [`GET /accounts/${AID}`]: () => {
      throw new CfError('permission', 'Authentication error', { status: 403 });
    },
  });
  await assert.rejects(applyPlan(cwd, client, plan.id, T0), (e) => e instanceof CfError && e.code === 'account_mismatch');
  assert.deepEqual(workCalls(), []);
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: true });
  assert.equal(readPlan(cwd, plan.id).status, 'draft');
});

test('approval is checked before wrangler runs at all', async () => {
  script({});
  const plan = makePlan([dep()]);
  await assert.rejects(applyPlan(cwd, fakeClient(), plan.id, T0), (e) => e instanceof CfError && e.code === 'not_approved');
  assert.deepEqual(calls(), []);
});

test('failed health check with on_failed_check rollback runs exactly one rollback and sets rolled_back_auto', async () => {
  const plan = makePlan([dep({ health_check: HEALTH, on_failed_check: 'rollback' })]);
  const rollbackKey = ['rollback', V_PREV, '--name', 'api', '--yes', '--message', `claudeflare ${plan.id}`].join(' ');
  script({ [rollbackKey]: { events: [] } });
  approve(plan);
  const { fetched, slept, deps } = healthDeps([500]);
  const result = await applyPlan(cwd, fakeClient(), plan.id, T0, deps);
  assert.equal(result.status, 'rolled_back_auto');
  assert.equal(result.error.code, 'check_failed');
  assert.equal(fetched.length, 3);
  assert.deepEqual(slept, [5000, 5000]);
  const rollbacks = workCalls().filter((argv) => argv[0] === 'rollback');
  assert.deepEqual(rollbacks, [['rollback', V_PREV, '--name', 'api', '--yes', '--message', `claudeflare ${plan.id}`]]);
  assert.equal(result.results[0].auto_rolled_back, true);
});

test('failed health check without on_failed_check sets applied_check_failed and runs no rollback', async () => {
  script({});
  const plan = makePlan([
    dep({ health_check: HEALTH }),
    w(['d1', 'create', 'later-db']),
  ]);
  approve(plan);
  const { deps } = healthDeps([503]);
  const result = await applyPlan(cwd, fakeClient(), plan.id, T0, deps);
  assert.equal(result.status, 'applied_check_failed');
  assert.equal(result.error.code, 'check_failed');
  assert.match(result.error.message, /returned 503 after 3 attempt/);
  assert.equal(result.results[1], null);
  assert.deepEqual(workCalls(), [
    ['deployments', 'list', '--name', 'api', '--json'],
    ['deploy', '--name', 'api'],
  ]);
  // The user can still roll back with a plan.
  const rollback = createRollbackPlan(cwd, plan.id, T0);
  assert.deepEqual(rollback.ops, [w(['rollback', V_PREV, '--name', 'api'])]);
  assert.equal(rollback.scope, 'account');
});

test('first deploy auto rollback deletes the Worker only while it holds just the plan version', async () => {
  for (const [listed, expectDelete] of [[[V_NEW], true], [[V_NEW, V_OTHER], false], [[], false]]) {
    rmSync(join(cwd, '.claudeflare'), { recursive: true, force: true });
    rmSync(process.env.FAKE_WRANGLER_LOG, { force: true });
    script({});
    const plan = makePlan([dep({ health_check: HEALTH, on_failed_check: 'rollback' })]);
    approve(plan);
    const runnerCalls = [];
    let listCount = 0;
    const runner = async (args, opts) => {
      runnerCalls.push(args);
      if (args.join(' ') === 'deployments list --name api --json') {
        listCount++;
        if (listCount === 1) return { code: 1, stdout: '', stderr: 'This Worker does not exist on your account. [code: 10007]', events: [] };
        return { code: 0, stdout: deploymentsJson(listed), stderr: '', events: [] };
      }
      if (args[0] === 'deploy') return { code: 0, stdout: '', stderr: '', events: [{ type: 'deploy', version_id: V_NEW }] };
      if (args[0] === 'delete') return { code: 0, stdout: '', stderr: '', events: [] };
      return runWrangler(args, opts);
    };
    const { deps } = healthDeps([500]);
    const result = await applyPlan(cwd, fakeClient(), plan.id, T0, { ...deps, runner });
    const deletes = runnerCalls.filter((a) => a[0] === 'delete');
    if (expectDelete) {
      assert.equal(result.status, 'rolled_back_auto');
      assert.deepEqual(deletes, [['delete', '--name', 'api']]);
    } else {
      assert.equal(result.status, 'applied_check_failed');
      assert.deepEqual(deletes, []);
      assert.match(result.error.rollback_error, /versions this plan did not create|lists no deployed versions/);
      assert.ok(result.risk_notes.some((n) => n.startsWith('rollback_ambiguous:')));
    }
  }
});

test('wrangler non-zero exit records wrangler_failed with partial or failed status', async () => {
  script({
    'd1 create app-db': { events: [] },
    'deploy --name api': {
      code: 1,
      stderr: 'noise\n',
      events: [{ type: 'command-failed', version: 1, message: 'Build failed with 1 error' }],
    },
  });
  const plan = makePlan([w(['d1', 'create', 'app-db']), dep()]);
  approve(plan);
  const result = await applyPlan(cwd, fakeClient(), plan.id, T0);
  assert.equal(result.status, 'partially_applied');
  assert.equal(result.error.code, 'wrangler_failed');
  assert.equal(result.error.op_index, 1);
  assert.match(result.error.message, /Build failed with 1 error/);
  assert.deepEqual(result.results[0], { events: [] });
  assert.equal(result.results[1], null);

  const first = makePlan([dep()], 'deploy-two');
  approve(first);
  const failed = await applyPlan(cwd, fakeClient(), first.id, T0);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'wrangler_failed');
});

test('secret value reaches wrangler stdin only and is redacted from failures', async () => {
  process.env.STRIPE_KEY = SECRET;
  script({
    'secret put STRIPE_KEY --name api': { code: 1, stderr: `failed to store ${SECRET}\n` },
  });
  const plan = makePlan([w(['secret', 'put', 'STRIPE_KEY', '--name', 'api'], { worker: 'api', value_from_env: 'STRIPE_KEY' })], 'secret');
  approve(plan);
  const result = await applyPlan(cwd, fakeClient(), plan.id, T0);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'wrangler_failed');
  assert.ok(!result.error.message.includes(SECRET));
  assert.match(result.error.message, /\[REDACTED\]/);
  const put = calls().find((c) => c.argv?.[0] === 'secret');
  assert.equal(put.stdinLength, SECRET.length);
});

// Kv create: the new namespace id comes from a follow-up list by exact title.
// Rollback then skips the non-empty bucket and the unverifiable queue and D1 database.
test('rollback of creates deletes empty resources and skips non-empty or unverifiable ones with a risk line', async () => {
  script({
    'r2 bucket create assets': { events: [] },
    'kv namespace create cache': { events: [] },
    'kv namespace list': { stdout: JSON.stringify([{ id: 'ffffffffffffffffffffffffffffffff', title: 'cache-old' }, { id: KV_ID, title: 'cache' }]) },
    'd1 create app-db': { events: [] },
    'queues create jobs': { events: [] },
    [`kv namespace delete --namespace-id ${KV_ID} -y`]: { events: [] },
    'd1 delete app-db -y': { events: [] },
  });
  const plan = makePlan([
    w(['r2', 'bucket', 'create', 'assets']),
    w(['kv', 'namespace', 'create', 'cache']),
    w(['d1', 'create', 'app-db']),
    w(['queues', 'create', 'jobs']),
  ], 'create');
  approve(plan);
  const applied = await applyPlan(cwd, fakeClient(), plan.id, T0);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.results[1].resource_id, KV_ID);

  const rollback = createRollbackPlan(cwd, plan.id, T0);
  assert.equal(rollback.scope, 'account');
  approve(rollback);
  const client = fakeClient({
    [`GET /accounts/${AID}/r2/buckets/assets/objects`]: [{ key: 'logo.png' }],
    [`GET /accounts/${AID}/storage/kv/namespaces/${KV_ID}/keys`]: [],
  });
  rmSync(process.env.FAKE_WRANGLER_LOG, { force: true });
  const done = await applyPlan(cwd, client, rollback.id, T0);
  assert.equal(done.status, 'applied');
  assert.deepEqual(workCalls(), [['kv', 'namespace', 'delete', '--namespace-id', KV_ID, '-y']]);
  const r2Probe = client.requests.find((r) => r.path.endsWith('/objects'));
  assert.deepEqual(r2Probe.opts.query, { per_page: 1 });
  const kvProbe = client.requests.find((r) => r.path.endsWith('/keys'));
  assert.deepEqual(kvProbe.opts.query, { limit: 10 });
  assert.equal(client.requests.some((r) => r.path.includes('queues') || r.path.includes('/d1/')), false);
  const skippedCodes = done.results.filter((r) => r?.skipped).map((r) => r.skipped);
  assert.deepEqual(skippedCodes, ['rollback_not_empty', 'rollback_not_empty', 'rollback_not_empty']);
  assert.equal(done.risk_notes.length, 3);
  assert.ok(done.risk_notes.some((n) => /^rollback_not_empty: .*d1 app-db cannot be verified/.test(n)));
  assert.ok(done.risk_notes.some((n) => /^rollback_not_empty: .*r2 assets is not empty/.test(n)));
  assert.ok(done.risk_notes.some((n) => /^rollback_not_empty: .*queue jobs cannot be verified/.test(n)));
  assert.equal(readPlan(cwd, plan.id).status, 'rolled_back');
});

test('runHealthCheck passes on a later try and treats network errors as failures', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) throw new Error('ECONNRESET');
    return { status: n === 2 ? 302 : 200 };
  };
  const slept = [];
  const res = await runHealthCheck({ url: HEALTH.url, expect_status: 200 }, { fetchImpl, sleep: async (ms) => slept.push(ms), intervalMs: 7 });
  assert.deepEqual(res, { ok: true, status: 200, attempts: 3 });
  assert.deepEqual(slept, [7, 7]);
  const down = await runHealthCheck({ url: HEALTH.url }, { fetchImpl: async () => { throw new Error('down'); }, sleep: async () => {} });
  assert.deepEqual(down, { ok: false, status: null, attempts: 3 });
});

// ---- CLI: plan new R2 refusal and secret canary across every written file ----

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        cwd,
        env: {
          PATH: process.env.PATH,
          CLAUDEFLARE_KEY_DIR: process.env.CLAUDEFLARE_KEY_DIR,
          CLAUDEFLARE_WRANGLER: FAKE,
          FAKE_WRANGLER_SCRIPT: process.env.FAKE_WRANGLER_SCRIPT,
          FAKE_WRANGLER_LOG: process.env.FAKE_WRANGLER_LOG,
          CLOUDFLARE_API_TOKEN: TOKEN,
          ...env,
        },
      },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });
}

async function stubServer(t, routes) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const path = req.url.split('?')[0];
    const result = routes[`${req.method} ${path}`];
    res.setHeader('Content-Type', 'application/json');
    if (result === undefined) {
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false, errors: [{ code: 7003, message: 'no route' }] }));
      return;
    }
    res.end(JSON.stringify({ success: true, errors: [], messages: [], result }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

function r2DeleteDraft(name, extraArgs = []) {
  return {
    scope: 'account',
    account_id: AID,
    account_name: 'Acme',
    project_dir: cwd,
    summary: 'Delete bucket',
    risk: 'r',
    slug: 'drop',
    ops: [w(['r2', 'bucket', 'delete', name, ...extraArgs], { confirm_name: name })],
  };
}

test('cli plan new refuses an R2 delete of a non-empty bucket and writes nothing', async (t) => {
  const { base, seen } = await stubServer(t, {
    [`GET /accounts/${AID}/r2/buckets/full/objects`]: [{ key: 'a.txt' }],
    [`GET /accounts/${AID}/r2/buckets/empty/objects`]: [],
  });
  writeFileSync(join(cwd, 'draft.json'), JSON.stringify(r2DeleteDraft('full')));
  const res = await run(['plan', 'new', '--file', 'draft.json'], { CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stderr).error.code, 'resource_not_empty');
  assert.ok(seen.includes(`GET /accounts/${AID}/r2/buckets/full/objects?per_page=1`));
  assert.equal(existsSync(join(cwd, '.claudeflare', 'plans')), false);

  writeFileSync(join(cwd, 'draft.json'), JSON.stringify(r2DeleteDraft('assets-eu', ['--jurisdiction', 'eu'])));
  const eu = await run(['plan', 'new', '--file', 'draft.json'], { CLOUDFLARE_API_BASE: base });
  assert.equal(JSON.parse(eu.stderr).error.code, 'resource_not_empty');

  writeFileSync(join(cwd, 'draft.json'), JSON.stringify(r2DeleteDraft('empty')));
  const ok = await run(['plan', 'new', '--file', 'draft.json'], { CLOUDFLARE_API_BASE: base });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(JSON.parse(ok.stdout).risk, /Not reversible: wrangler r2 bucket delete empty/);
});

test('cli apply of a secret put never writes or prints the secret value', async (t) => {
  const { base } = await stubServer(t, { [`GET /accounts/${AID}`]: { id: AID, name: 'Acme' } });
  script({
    'secret put STRIPE_KEY --name api': {
      echoStdin: true,
      stderr: `debug ${SECRET}\n`,
      events: [{ type: 'wrangler-session', version: 1 }, { type: 'note', message: `stored ${SECRET}` }],
    },
  });
  const plan = makePlan([w(['secret', 'put', 'STRIPE_KEY', '--name', 'api'], { worker: 'api', value_from_env: 'STRIPE_KEY' })], 'secret');
  approve(plan, new Date());
  const res = await run(['apply', plan.id], { CLOUDFLARE_API_BASE: base, STRIPE_KEY: SECRET });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).status, 'applied');
  const put = calls().find((c) => c.argv?.[0] === 'secret');
  assert.equal(put.stdinLength, SECRET.length);
  for (const text of [res.stdout, res.stderr, readFileSync(process.env.FAKE_WRANGLER_LOG, 'utf8')]) {
    assert.ok(!text.includes(SECRET));
  }
  const files = listFiles(cwd);
  assert.ok(files.some((f) => f.includes(`${join('.claudeflare', 'plans')}`)));
  assert.ok(files.some((f) => f.includes(`${join('.claudeflare', 'snapshots')}`)));
  for (const file of files) assert.ok(!readFileSync(file, 'utf8').includes(SECRET), file);
});
