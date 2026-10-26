import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSourceHash } from '../scripts/lib/source-hash.mjs';
import { configBindings, parseToml } from '../scripts/lib/wrangler-config.mjs';
import { clampSeconds, redactText, runTail, splitJsonObjects } from '../scripts/lib/tail.mjs';
import { CfError } from '../scripts/lib/errors.mjs';
import { writeApproval } from '../scripts/lib/approvals.mjs';
import { applyPlan } from '../scripts/lib/apply.mjs';

const CLI = fileURLToPath(new URL('../scripts/cf.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/wrangler/fake-wrangler.mjs', import.meta.url));
const AID = 'abcdef0123456789abcdef0123456789';
const OTHER = 'fedcba9876543210fedcba9876543210';
const KV_ID = '0f2ac74b498b48028cb68387c421e279';
const D1_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TOKEN = 'tok-cli-v2-SECRET-123';
const ROLLBACK = { method: 'POST', path: `/accounts/${AID}/pages/projects/my-site/deployments/0a1b2c3d-4e5f-6789-abcd-ef0123456789/rollback` };

let cwd;
let aux;

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'claudeflare-cliv2-')));
  aux = mkdtempSync(join(tmpdir(), 'claudeflare-cliv2-aux-'));
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'index.js'), 'export default { fetch() { return new Response("ok"); } };\n');
  writeFileSync(
    join(cwd, 'wrangler.jsonc'),
    `{
  // api worker
  "name": "api",
  "main": "src/index.js",
  "kv_namespaces": [{ "binding": "CACHE", "id": "${KV_ID}" }],
  "r2_buckets": [{ "binding": "FILES", "bucket_name": "files" }],
  "d1_databases": [{ "binding": "DB", "database_name": "app-db", "database_id": "${D1_ID}" }],
  "queues": { "producers": [{ "binding": "JOBS", "queue": "jobs" }] },
}
`,
  );
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(aux, { recursive: true, force: true });
});

const BASE_SCRIPT = {
  '--version': { stdout: '4.152.0\n' },
  'deploy --name api --dry-run --outdir *': { stdout: 'Total Upload: 1.23 KiB / gzip: 0.50 KiB\n--dry-run: exiting now.\n' },
};

function script(entries = {}) {
  writeFileSync(join(aux, 'script.json'), JSON.stringify({ ...BASE_SCRIPT, ...entries }));
}

const GOOD_ROUTES = {
  [`GET /accounts/${AID}`]: { id: AID, name: 'Acme' },
  [`GET /accounts/${AID}/storage/kv/namespaces/${KV_ID}`]: { id: KV_ID, title: 'cache' },
  [`GET /accounts/${AID}/r2/buckets/files`]: { name: 'files' },
  [`GET /accounts/${AID}/d1/database/${D1_ID}`]: { uuid: D1_ID, name: 'app-db' },
  [`GET /accounts/${AID}/queues`]: [{ queue_name: 'jobs' }],
};

async function stubServer(t, routes) {
  const server = createServer((req, res) => {
    const result = routes[`${req.method} ${req.url.split('?')[0]}`];
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
  return `http://127.0.0.1:${server.address().port}`;
}

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        cwd,
        env: {
          PATH: process.env.PATH,
          CLAUDEFLARE_KEY_DIR: join(aux, 'key'),
          CLAUDEFLARE_WRANGLER: FAKE,
          FAKE_WRANGLER_SCRIPT: join(aux, 'script.json'),
          FAKE_WRANGLER_LOG: join(aux, 'log.ndjson'),
          CLOUDFLARE_API_TOKEN: TOKEN,
          ...env,
        },
      },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });
}

function draft(ops, extra = {}) {
  const value = { scope: 'account', account_id: AID, account_name: 'Acme', project_dir: cwd, summary: 's', risk: 'r', slug: 'deploy', ops, ...extra };
  writeFileSync(join(aux, 'draft.json'), JSON.stringify(value));
  return join(aux, 'draft.json');
}

const deployOp = { kind: 'wrangler', args: ['deploy', '--name', 'api'] };
const checkNamed = (report, name) => report.checks.find((c) => c.name === name);

test('preflight passes with bindings, dry-run size and a source hash over the deploy inputs', async (t) => {
  script();
  const base = await stubServer(t, GOOD_ROUTES);
  const res = await run(['preflight', '--file', draft([deployOp])], { CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 0, res.stderr || res.stdout);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map((c) => c.name), ['ops', 'wrangler', 'account', 'config', 'bindings', 'build', 'source']);
  assert.equal(report.upload_size, '1.23 KiB / gzip: 0.50 KiB');
  assert.equal(report.source_hash, computeSourceHash(cwd, { extraPaths: ['src/index.js', 'wrangler.jsonc'] }));
  assert.equal(report.ops, undefined);
});

test('preflight fails on a failing build, a missing binding and an account mismatch', async (t) => {
  script({ 'deploy --name api --dry-run --outdir *': { code: 1, stderr: 'X [ERROR] Could not resolve "./missing"\n' } });
  const routes = { ...GOOD_ROUTES, [`GET /accounts/${AID}`]: { id: OTHER, name: 'Other' } };
  delete routes[`GET /accounts/${AID}/storage/kv/namespaces/${KV_ID}`];
  const base = await stubServer(t, routes);
  const res = await run(['preflight', '--file', draft([deployOp])], { CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, false);
  assert.equal(checkNamed(report, 'account').ok, false);
  assert.match(checkNamed(report, 'account').detail, /account_mismatch/);
  assert.equal(checkNamed(report, 'bindings').ok, false);
  assert.match(checkNamed(report, 'bindings').detail, new RegExp(`KV namespace ${KV_ID} \\(binding CACHE\\) does not exist`));
  assert.equal(checkNamed(report, 'build').ok, false);
  assert.match(checkNamed(report, 'build').detail, /Could not resolve/);
});

test('preflight skips bindings of resources the same draft creates', async (t) => {
  script({});
  const routes = { ...GOOD_ROUTES };
  delete routes[`GET /accounts/${AID}/r2/buckets/files`];
  delete routes[`GET /accounts/${AID}/storage/kv/namespaces/${KV_ID}`];
  const base = await stubServer(t, routes);
  const ops = [
    { kind: 'wrangler', args: ['r2', 'bucket', 'create', 'files'] },
    { kind: 'wrangler', args: ['kv', 'namespace', 'create', 'cache'] },
    deployOp,
  ];
  const res = await run(['preflight', '--file', draft(ops)], { CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 0, res.stdout);
  assert.equal(checkNamed(JSON.parse(res.stdout), 'bindings').ok, true);
});

test('plan new refuses a failing preflight and writes no plan', async (t) => {
  script({ 'deploy --name api --dry-run --outdir *': { code: 1, stderr: 'build broke\n' } });
  const base = await stubServer(t, GOOD_ROUTES);
  const res = await run(['plan', 'new', '--file', draft([deployOp])], { CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 1);
  const { error } = JSON.parse(res.stderr);
  assert.equal(error.code, 'preflight_failed');
  assert.match(error.message, /build: dry-run build failed: build broke/);
  assert.equal(existsSync(join(cwd, '.claudeflare', 'plans')), false);
});

test('plan new embeds source_hash and source_paths, ignores draft-supplied ones and keeps REST ops', async (t) => {
  script();
  const base = await stubServer(t, GOOD_ROUTES);
  const forged = { ...deployOp, source_hash: 'sha256:forged', source_paths: ['nothing'] };
  const res = await run(['plan', 'new', '--file', draft([forged, ROLLBACK])], { CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 0, res.stderr);
  const plan = JSON.parse(res.stdout);
  assert.equal(plan.scope, 'account');
  assert.equal(plan.account_slug, 'acme');
  assert.match(plan.id, /^acme-\d{8}-\d{6}-deploy$/);
  assert.deepEqual(plan.ops, [
    { ...deployOp, source_hash: computeSourceHash(cwd, { extraPaths: ['src/index.js', 'wrangler.jsonc'] }), source_paths: ['src/index.js', 'wrangler.jsonc'] },
    ROLLBACK,
  ]);
});

test('plan new lists pending D1 migrations in the risk and preflight shows their SQL', async (t) => {
  mkdirSync(join(cwd, 'migrations'));
  writeFileSync(join(cwd, 'migrations', '0001_init.sql'), 'CREATE TABLE users (id INTEGER PRIMARY KEY);\n');
  writeFileSync(join(cwd, 'migrations', '0000_old.sql'), 'SELECT 1;\n');
  script({
    'd1 migrations list app-db --remote': { stdout: 'Migrations to be applied:\n┌───────────────┐\n│ Name          │\n├───────────────┤\n│ 0001_init.sql │\n└───────────────┘\n' },
  });
  const base = await stubServer(t, GOOD_ROUTES);
  const file = draft([{ kind: 'wrangler', args: ['d1', 'migrations', 'apply', 'app-db', '--remote'] }], { slug: 'migrate' });
  const pre = await run(['preflight', '--file', file], { CLOUDFLARE_API_BASE: base });
  assert.equal(pre.code, 0, pre.stdout);
  const report = JSON.parse(pre.stdout);
  assert.deepEqual(report.pending_migrations, [
    { database: 'app-db', files: [{ name: '0001_init.sql', sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY);\n' }] },
  ]);
  assert.equal(checkNamed(report, 'bindings'), undefined);
  assert.equal(report.source_hash, computeSourceHash(cwd, { extraPaths: ['migrations', 'wrangler.jsonc'] }));

  const res = await run(['plan', 'new', '--file', file], { CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 0, res.stderr);
  const plan = JSON.parse(res.stdout);
  assert.match(plan.risk, /Pending migrations on app-db: 0001_init\.sql\./);
  assert.deepEqual(plan.ops[0].source_paths, ['migrations', 'wrangler.jsonc']);
});

test('preflight of a zone draft only validates the ops', async () => {
  const file = join(aux, 'zone.json');
  writeFileSync(file, JSON.stringify({ zone_id: '023e105f4ecef8ad9ca31a8372d0c353', zone_name: 'example.com', summary: 's', risk: 'r', ops: [{ method: 'PATCH', path: '/zones/{zone_id}/settings/ssl', body: { value: 'strict' } }] }));
  const res = await run(['preflight', '--file', file]);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).checks.map((c) => [c.name, c.ok]), [['ops', true]]);
});

test('parseToml reads the binding tables wrangler configs use', () => {
  const config = parseToml(`
name = "api" # worker
main = "src/index.ts"
assets = { directory = "./public", binding = "ASSETS" }

[[kv_namespaces]]
binding = "CACHE"
id = "${KV_ID}"

[[d1_databases]]
binding = 'DB'
database_name = "app-db"
migrations_dir = "db/migrations"

[[queues.producers]]
binding = "JOBS"
queue = "jobs"

[vars]
LIMIT = 10
FLAGS = ["a", "b#c"]
`);
  assert.equal(config.main, 'src/index.ts');
  assert.deepEqual(config.assets, { directory: './public', binding: 'ASSETS' });
  assert.deepEqual(config.vars, { LIMIT: 10, FLAGS: ['a', 'b#c'] });
  assert.deepEqual(configBindings(config), {
    kv: [{ binding: 'CACHE', id: KV_ID }],
    r2: [],
    d1: [{ binding: 'DB', name: 'app-db', id: undefined, migrations_dir: 'db/migrations' }],
    queue: [{ binding: 'JOBS', name: 'jobs' }],
  });
});

const TAIL_EVENTS = [
  { outcome: 'exception', event: { request: { url: 'https://api.example.com/pay?token=abc123' }, response: null }, exceptions: [{ name: 'Error', message: 'boom' }], logs: [{ level: 'log', message: ['auth', `Bearer ${'x'.repeat(10)}`] }] },
  { outcome: 'exceededCpu', event: { request: { url: 'https://api.example.com/slow' } }, exceptions: [{ name: 'Error', message: 'boom' }], logs: [] },
  { outcome: 'ok', event: { request: { url: 'https://api.example.com/' }, response: { status: 200 } }, exceptions: [], logs: [{ level: 'info', message: [`key ${'a1'.repeat(20)}`] }] },
];
const prettyEvents = TAIL_EVENTS.map((e) => JSON.stringify(e, null, 2)).join('\n');

test('tail summarizes events, ranks exceptions and redacts secret-looking values', async () => {
  script({ 'tail api --format json --status error': { stdout: `Connected to api, waiting for logs...\n${prettyEvents}\n` } });
  process.env.CLAUDEFLARE_WRANGLER = FAKE;
  process.env.FAKE_WRANGLER_SCRIPT = join(aux, 'script.json');
  try {
    const res = await runTail({ cwd, worker: 'api', seconds: 5, status: 'error' });
    assert.equal(res.events, 3);
    assert.deepEqual(res.outcomes, { exception: 1, exceededCpu: 1, ok: 1 });
    assert.deepEqual(res.top_exceptions, [{ message: 'Error: boom', count: 2 }]);
    assert.equal(res.samples[0].url, 'https://api.example.com/pay?[REDACTED]');
    assert.deepEqual(res.samples[0].logs, ['log: auth Bearer [REDACTED]']);
    assert.equal(res.samples[2].logs[0], 'info: key [REDACTED]');
    assert.equal(redactText('https://u:p@h.example.com/x password=hunter2 {"token":"abc"} sk_live_abcdefgh123'), 'https://[REDACTED]@h.example.com/x password=[REDACTED] {"token":"[REDACTED]"} [REDACTED]');
    assert.equal(redactText('https://a-very-long-subdomain-name-used-for-tests.example.com/path'), 'https://a-very-long-subdomain-name-used-for-tests.example.com/path');
    assert.ok(!JSON.stringify(res).includes('abc123'));
  } finally {
    delete process.env.CLAUDEFLARE_WRANGLER;
    delete process.env.FAKE_WRANGLER_SCRIPT;
  }
});

test('tail stops at the time limit and keeps what it collected', async () => {
  script({ 'tail api --format json': { stdout: `${prettyEvents}\n`, hang: true } });
  process.env.CLAUDEFLARE_WRANGLER = FAKE;
  process.env.FAKE_WRANGLER_SCRIPT = join(aux, 'script.json');
  try {
    const started = Date.now();
    const res = await runTail({ cwd, worker: 'api', seconds: 1 });
    assert.ok(Date.now() - started < 10000);
    assert.equal(res.seconds, 1);
    assert.equal(res.events, 3);
  } finally {
    delete process.env.CLAUDEFLARE_WRANGLER;
    delete process.env.FAKE_WRANGLER_SCRIPT;
  }
});

test('tail helpers clamp seconds, split pretty JSON and refuse bad input', async () => {
  assert.equal(clampSeconds('0'), 1);
  assert.equal(clampSeconds(500), 60);
  assert.equal(clampSeconds('12.7'), 12);
  assert.deepEqual(splitJsonObjects('noise {"a":"}{"}\n{"b":{"c":1}} {"cut":'), [{ a: '}{' }, { b: { c: 1 } }]);
  assert.equal(redactText('id 0123456789abcdef0123456789abcdef!'), 'id [REDACTED]!');
  await assert.rejects(runTail({ cwd, worker: 'bad name', seconds: 5 }), (e) => e instanceof CfError && e.code === 'usage');
  await assert.rejects(runTail({ cwd, worker: 'api', seconds: 5, status: 'all' }), (e) => e instanceof CfError && e.code === 'usage');
});

// ---- deploy inputs: --config, --env, missing inputs, round trip with apply ----

const V_NEW = '44444444-4444-4444-8444-444444444444';

function fakeRunner(calls) {
  return async (args) => {
    const key = args.join(' ');
    calls.push(key);
    if (key === '--version') return { code: 0, stdout: '4.152.0\n', stderr: '', events: [] };
    if (key.startsWith('deployments list')) return { code: 0, stdout: JSON.stringify([{ id: 'd', versions: [{ version_id: 'v-old', percentage: 100 }] }]), stderr: '', events: [] };
    if (key.startsWith('deploy')) return { code: 0, stdout: '', stderr: '', events: [{ type: 'deploy', version_id: V_NEW }] };
    return { code: 1, stdout: '', stderr: `unexpected ${key}`, events: [] };
  };
}

const fakeClient = { request: async (method, path) => (path === `/accounts/${AID}` ? { id: AID, name: 'Acme' } : null) };

test('preflight reads the op --config file and hashes its main and assets', async (t) => {
  writeFileSync(join(cwd, 'other.toml'), 'name = "api"\nmain = "src/other.js"\nassets = { directory = "public" }\n');
  writeFileSync(join(cwd, 'src', 'other.js'), 'export default {};\n');
  script({ 'deploy --name api --config other.toml --dry-run --outdir *': { stdout: '' } });
  const base = await stubServer(t, GOOD_ROUTES);
  const op = { kind: 'wrangler', args: ['deploy', '--name', 'api', '--config', 'other.toml'] };
  const res = await run(['plan', 'new', '--file', draft([op])], { CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).ops[0].source_paths, ['other.toml', 'public', 'src/other.js']);
});

test('preflight applies --env: env bindings are checked and root bindings are not inherited', async (t) => {
  const STAGING_KV = '1f2ac74b498b48028cb68387c421e279';
  writeFileSync(join(cwd, 'wrangler.jsonc'), JSON.stringify({
    name: 'api',
    main: 'src/index.js',
    kv_namespaces: [{ binding: 'CACHE', id: KV_ID }],
    env: { staging: { kv_namespaces: [{ binding: 'CACHE', id: STAGING_KV }], assets: { directory: 'dist-staging' } } },
  }));
  script({ 'deploy --name api --env staging --dry-run --outdir *': { stdout: '' } });
  const base = await stubServer(t, GOOD_ROUTES);
  const op = { kind: 'wrangler', args: ['deploy', '--name', 'api', '--env', 'staging'] };
  const res = await run(['preflight', '--file', draft([op])], { CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout);
  assert.match(checkNamed(report, 'bindings').detail, new RegExp(`KV namespace ${STAGING_KV}`));
  assert.doesNotMatch(checkNamed(report, 'bindings').detail, new RegExp(KV_ID));

  const missingEnv = { kind: 'wrangler', args: ['deploy', '--name', 'api', '--env', 'prod'] };
  const bad = await run(['preflight', '--file', draft([missingEnv])], { CLOUDFLARE_API_BASE: base });
  assert.match(checkNamed(JSON.parse(bad.stdout), 'config').detail, /invalid_config: wrangler.jsonc has no env.prod section/);
});

test('an assets directory missing at plan time is still bound: it appearing before apply is source_changed', async (t) => {
  writeFileSync(join(cwd, 'wrangler.jsonc'), JSON.stringify({ name: 'api', main: 'src/index.js', assets: { directory: 'public' } }));
  script();
  const base = await stubServer(t, GOOD_ROUTES);
  const res = await run(['plan', 'new', '--file', draft([deployOp])], { CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 0, res.stderr);
  const plan = JSON.parse(res.stdout);
  assert.deepEqual(plan.ops[0].source_paths, ['public', 'src/index.js', 'wrangler.jsonc']);

  const saved = { key: process.env.CLAUDEFLARE_KEY_DIR, token: process.env.CLOUDFLARE_API_TOKEN };
  process.env.CLAUDEFLARE_KEY_DIR = join(aux, 'key');
  process.env.CLOUDFLARE_API_TOKEN = TOKEN;
  try {
    writeApproval(cwd, { plan_id: plan.id, session_id: 's1' });
    mkdirSync(join(cwd, 'public'));
    writeFileSync(join(cwd, 'public', 'evil.html'), '<script></script>\n');
    const calls = [];
    await assert.rejects(applyPlan(cwd, fakeClient, plan.id, new Date(), { runner: fakeRunner(calls) }), (e) => e instanceof CfError && e.code === 'source_changed');
    assert.equal(calls.some((c) => c.startsWith('deploy')), false);

    rmSync(join(cwd, 'public'), { recursive: true });
    const applied = await applyPlan(cwd, fakeClient, plan.id, new Date(), { runner: fakeRunner(calls) });
    assert.equal(applied.status, 'applied');
    assert.equal(applied.results[0].version_id, V_NEW);
  } finally {
    for (const [k, v] of [['CLAUDEFLARE_KEY_DIR', saved.key], ['CLOUDFLARE_API_TOKEN', saved.token]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('preflight fails closed on a TOML value it cannot read under a relied key', async (t) => {
  rmSync(join(cwd, 'wrangler.jsonc'));
  writeFileSync(join(cwd, 'wrangler.toml'), 'name = "api"\nmain = "src/index.js"\n[assets]\ndirectory = """\ndist\n"""\n');
  script();
  const base = await stubServer(t, GOOD_ROUTES);
  const res = await run(['preflight', '--file', draft([deployOp])], { CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 1);
  assert.match(checkNamed(JSON.parse(res.stdout), 'config').detail, /invalid_config: wrangler.toml could not be parsed: multi-line string under directory/);
});

test('d1 create plus migrations apply in one draft treats every local migration as pending and embeds the SQL', async (t) => {
  mkdirSync(join(cwd, 'migrations'));
  writeFileSync(join(cwd, 'migrations', '0001_init.sql'), 'CREATE TABLE a (id INTEGER);\n');
  writeFileSync(join(cwd, 'migrations', '0002_more.sql'), 'CREATE TABLE b (id INTEGER);\n');
  script({});
  const base = await stubServer(t, GOOD_ROUTES);
  const ops = [
    { kind: 'wrangler', args: ['d1', 'create', 'app-db'] },
    { kind: 'wrangler', args: ['d1', 'migrations', 'apply', 'app-db', '--remote'] },
  ];
  const res = await run(['plan', 'new', '--file', draft(ops, { slug: 'db' })], { CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 0, res.stderr);
  const plan = JSON.parse(res.stdout);
  assert.match(plan.risk, /Pending migrations on app-db: 0001_init\.sql, 0002_more\.sql\./);
  assert.deepEqual(plan.ops[1].pending_migrations, [
    { name: '0001_init.sql', sql: 'CREATE TABLE a (id INTEGER);\n' },
    { name: '0002_more.sql', sql: 'CREATE TABLE b (id INTEGER);\n' },
  ]);
  assert.equal(plan.ops[0].pending_migrations, undefined);
});
