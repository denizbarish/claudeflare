import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureSnapshot, buildRollbackOps } from '../scripts/lib/snapshot.mjs';
import { captureWranglerEntry, inverseForWrangler } from '../scripts/lib/wrangler-snapshot.mjs';
import { validateWranglerOp } from '../scripts/lib/wrangler-ops.mjs';
import { validateOpTargets } from '../scripts/lib/resources.mjs';

const AID = 'abcdef0123456789abcdef0123456789';
const DIR = '/work/app';
const V_OLD = '11111111-1111-4111-8111-111111111111';
const V_PREV = '22222222-2222-4222-8222-222222222222';
const V_CANARY = '33333333-3333-4333-8333-333333333333';
const BOOKMARK = '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';
const KV_ID = '0f2ac74b498b48028cb68387c421e279';

const w = (args, extra = {}) => ({ kind: 'wrangler', args, ...extra });

function planWith(ops) {
  return { id: 'acct-20261025-120000-test', scope: 'account', account_id: AID, project_dir: DIR, ops };
}

const PLAN = planWith([]);

// Fake runner keyed by the joined args. A handler is either a result object
// or a value printed as JSON on stdout with exit code 0.
function fakeRunner(routes) {
  const calls = [];
  const runner = async (args, opts) => {
    calls.push({ args, opts });
    const key = args.join(' ');
    if (!(key in routes)) throw new Error(`unexpected wrangler call: ${key}`);
    const handler = routes[key];
    if (handler && typeof handler === 'object' && 'code' in handler) return handler;
    return { code: 0, stdout: `${JSON.stringify(handler, null, 2)}\n`, stderr: '', events: [] };
  };
  runner.calls = calls;
  return runner;
}

const noClient = {
  async request() {
    throw new Error('REST client must not be called');
  },
};

function assertValidWrangler(ops) {
  for (const op of ops) assert.doesNotThrow(() => validateWranglerOp(op, PLAN), JSON.stringify(op.args));
}

// Shape from wrangler 4.152 source: `deployments list --json` prints the API
// deployments sorted by created_on ascending.
const DEPLOYMENTS = [
  {
    id: 'dep-1',
    source: 'wrangler',
    strategy: 'percentage',
    author_email: 'dev@example.com',
    created_on: '2026-10-20T10:00:00.000000Z',
    annotations: { 'workers/triggered_by': 'upload' },
    versions: [{ version_id: V_OLD, percentage: 100 }],
  },
  {
    id: 'dep-2',
    source: 'wrangler',
    strategy: 'percentage',
    author_email: 'dev@example.com',
    created_on: '2026-10-24T10:00:00.000000Z',
    annotations: { 'workers/triggered_by': 'upload' },
    versions: [{ version_id: V_PREV, percentage: 100 }],
  },
];

// Shape from wrangler 4.152 source: `pages deployment list --json` maps each
// API deployment to { Id, Environment, Branch, Source, Deployment, Status, Build };
// Status is a relative time for finished successful deployments, else the
// title-cased stage status. Newest first is the API order (doc-based).
const PAGES_DEPLOYMENTS = [
  {
    Id: 'f64788e9-fccd-4d4a-a28a-cb84f88f6eee',
    Environment: 'Production',
    Branch: 'main',
    Source: 'abc1234',
    Deployment: 'https://f64788e9.site.pages.dev',
    Status: 'Failure',
    Build: 'https://dash.cloudflare.com/x/pages/view/site/f64788e9',
  },
  {
    Id: '0a1b2c3d-1111-2222-3333-444455556666',
    Environment: 'Production',
    Branch: 'main',
    Source: 'def5678',
    Deployment: 'https://0a1b2c3d.site.pages.dev',
    Status: '2 hours ago',
    Build: 'https://dash.cloudflare.com/x/pages/view/site/0a1b2c3d',
  },
  {
    Id: '99999999-1111-2222-3333-444455556666',
    Environment: 'Production',
    Branch: 'main',
    Source: '0123abc',
    Deployment: 'https://99999999.site.pages.dev',
    Status: '3 days ago',
    Build: 'https://dash.cloudflare.com/x/pages/view/site/99999999',
  },
];

test('worker deploy snapshot reads deployments list and inverts to rollback of the previous version', async () => {
  const runner = fakeRunner({ 'deployments list --name api --json': DEPLOYMENTS });
  const op = w(['deploy', '--name', 'api']);
  const entry = await captureWranglerEntry(runner, noClient, op, PLAN);
  assert.equal(entry.kind, 'worker_deploy');
  assert.equal(entry.invertible, true);
  assert.deepEqual(entry.before, { deployment_id: 'dep-2', versions: [{ version_id: V_PREV, percentage: 100 }] });
  const inverse = inverseForWrangler(entry, { version_id: V_CANARY, events: [] });
  assert.deepEqual(inverse, [w(['rollback', V_PREV, '--name', 'api'])]);
  assertValidWrangler(inverse);
});

test('runner gets project_dir, plan account id and the token from the environment at call time', async (t) => {
  const saved = process.env.CLOUDFLARE_API_TOKEN;
  t.after(() => {
    if (saved === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = saved;
  });
  process.env.CLOUDFLARE_API_TOKEN = 'tok-at-call-time';
  const runner = fakeRunner({ 'deployments list --name api --json': DEPLOYMENTS });
  await captureWranglerEntry(runner, noClient, w(['deploy', '--name', 'api']), PLAN);
  assert.deepEqual(runner.calls[0].opts, { cwd: DIR, token: 'tok-at-call-time', accountId: AID });
});

test('worker name falls back to op.worker, then to the wrangler config', async () => {
  const named = fakeRunner({ 'deployments list --name api --json': DEPLOYMENTS });
  const e1 = await captureWranglerEntry(named, noClient, w(['deploy'], { worker: 'api' }), PLAN);
  assert.deepEqual(inverseForWrangler(e1, { events: [] }), [w(['rollback', V_PREV, '--name', 'api'])]);

  const fromConfig = fakeRunner({ 'deployments list --json': DEPLOYMENTS });
  const e2 = await captureWranglerEntry(fromConfig, noClient, w(['deploy']), PLAN);
  const inverse = inverseForWrangler(e2, { events: [] });
  assert.deepEqual(inverse, [w(['rollback', V_PREV])]);
  assertValidWrangler(inverse);
});

test('--config and --env (and their aliases) carry over to the read and the inverse', async () => {
  const runner = fakeRunner({ 'deployments list --name api --config wrangler.staging.jsonc --env staging --json': DEPLOYMENTS });
  const entry = await captureWranglerEntry(runner, noClient, w(['deploy', '--name', 'api', '-c', 'wrangler.staging.jsonc', '-e', 'staging']), PLAN);
  const inverse = inverseForWrangler(entry, { events: [] });
  assert.deepEqual(inverse, [w(['rollback', V_PREV, '--name', 'api', '--config', 'wrangler.staging.jsonc', '--env', 'staging'])]);
  assertValidWrangler(inverse);
});

test('versions deploy and rollback snapshot the active version and invert to it', async () => {
  for (const args of [['versions', 'deploy', `${V_CANARY}@100%`, '--name', 'api'], ['rollback', V_OLD, '--name', 'api']]) {
    const runner = fakeRunner({ 'deployments list --name api --json': DEPLOYMENTS });
    const entry = await captureWranglerEntry(runner, noClient, w(args), PLAN);
    assert.equal(entry.invertible, true);
    const inverse = inverseForWrangler(entry, { events: [] });
    assert.deepEqual(inverse, [w(['rollback', V_PREV, '--name', 'api'])]);
    assertValidWrangler(inverse);
  }
});

test('a split deployment before the op cannot be restored by rollback', async () => {
  const split = [{ ...DEPLOYMENTS[1], versions: [{ version_id: V_PREV, percentage: 90 }, { version_id: V_OLD, percentage: 10 }] }];
  const runner = fakeRunner({ 'deployments list --name api --json': split });
  const entry = await captureWranglerEntry(runner, noClient, w(['deploy', '--name', 'api']), PLAN);
  assert.throws(() => inverseForWrangler(entry, { events: [] }), (err) => err.code === 'rollback_ambiguous');
});

test('a worker with no deployments yet has nothing to roll back to', async () => {
  const runner = fakeRunner({ 'deployments list --name api --json': [] });
  const entry = await captureWranglerEntry(runner, noClient, w(['deploy', '--name', 'api']), PLAN);
  assert.equal(entry.invertible, false);
  assert.deepEqual(inverseForWrangler(entry, { events: [] }), []);
});

test('pages deploy snapshots the current production deployment and inverts to the REST rollback', async () => {
  const runner = fakeRunner({ 'pages deployment list --project-name site --environment production --json': PAGES_DEPLOYMENTS });
  const entry = await captureWranglerEntry(runner, noClient, w(['pages', 'deploy', 'dist', '--project-name', 'site']), PLAN);
  assert.equal(entry.kind, 'pages_deploy');
  assert.deepEqual(entry.before, { deployment_id: '0a1b2c3d-1111-2222-3333-444455556666' });
  const inverse = inverseForWrangler(entry, { events: [] });
  assert.deepEqual(inverse, [
    { method: 'POST', path: `/accounts/${AID}/pages/projects/site/deployments/0a1b2c3d-1111-2222-3333-444455556666/rollback` },
  ]);
  assert.doesNotThrow(() => validateOpTargets(inverse, PLAN));
});

test('pages deploy without a live production deployment is not invertible', async () => {
  const runner = fakeRunner({ 'pages deployment list --project-name site --environment production --json': [PAGES_DEPLOYMENTS[0]] });
  const entry = await captureWranglerEntry(runner, noClient, w(['pages', 'deploy', 'dist', '--project-name', 'site']), PLAN);
  assert.equal(entry.invertible, false);
  assert.deepEqual(inverseForWrangler(entry, { events: [] }), []);
});

test('pages deploy without --project-name cannot be snapshotted', async () => {
  const runner = fakeRunner({});
  await assert.rejects(
    captureWranglerEntry(runner, noClient, w(['pages', 'deploy', 'dist']), PLAN),
    (err) => err.code === 'snapshot_failed' && /--project-name/.test(err.message),
  );
  assert.equal(runner.calls.length, 0);
});

test('d1 migrations apply snapshots the Time Travel bookmark and inverts to a restore', async () => {
  // Shape from wrangler 4.152 source: prints the API result { bookmark }.
  const runner = fakeRunner({ 'd1 time-travel info app-db --json': { bookmark: BOOKMARK } });
  const entry = await captureWranglerEntry(runner, noClient, w(['d1', 'migrations', 'apply', 'app-db', '--remote']), PLAN);
  assert.equal(entry.kind, 'd1_migrations_apply');
  assert.deepEqual(entry.before, { bookmark: BOOKMARK });
  const inverse = inverseForWrangler(entry, { events: [] });
  assert.deepEqual(inverse, [w(['d1', 'time-travel', 'restore', 'app-db', '--bookmark', BOOKMARK])]);
  assertValidWrangler(inverse);
});

test('d1 time-travel restore inverts to the bookmark current before it', async () => {
  const runner = fakeRunner({ 'd1 time-travel info app-db --json': { bookmark: BOOKMARK } });
  const op = w(['d1', 'time-travel', 'restore', 'app-db', '--bookmark', '00000001-00000001-00000001-aaaa']);
  const entry = await captureWranglerEntry(runner, noClient, op, PLAN);
  assert.equal(entry.kind, 'd1_restore');
  const inverse = inverseForWrangler(entry, { events: [] });
  assert.deepEqual(inverse, [w(['d1', 'time-travel', 'restore', 'app-db', '--bookmark', BOOKMARK])]);
  assertValidWrangler(inverse);
});

test('a time-travel info answer without a bookmark aborts the snapshot', async () => {
  const runner = fakeRunner({ 'd1 time-travel info app-db --json': {} });
  await assert.rejects(
    captureWranglerEntry(runner, noClient, w(['d1', 'migrations', 'apply', 'app-db', '--remote']), PLAN),
    (err) => err.code === 'snapshot_failed',
  );
});

test('creates take no snapshot and invert to the matching delete with confirm_name and an emptiness pre-check', async () => {
  const cases = [
    [['d1', 'create', 'app-db'], { events: [] }, w(['d1', 'delete', 'app-db'], { confirm_name: 'app-db', precheck: 'empty' })],
    [['r2', 'bucket', 'create', 'assets'], { events: [] }, w(['r2', 'bucket', 'delete', 'assets'], { confirm_name: 'assets', precheck: 'empty' })],
    [
      ['r2', 'bucket', 'create', 'assets-eu', '--jurisdiction', 'eu'],
      { events: [] },
      w(['r2', 'bucket', 'delete', 'assets-eu', '--jurisdiction', 'eu'], { confirm_name: 'assets-eu', precheck: 'empty' }),
    ],
    [['queues', 'create', 'jobs'], { events: [] }, w(['queues', 'delete', 'jobs'], { confirm_name: 'jobs', precheck: 'empty' })],
    [
      ['kv', 'namespace', 'create', 'CACHE'],
      { resource_id: KV_ID, events: [] },
      w(['kv', 'namespace', 'delete', '--namespace-id', KV_ID], { confirm_name: KV_ID, precheck: 'empty' }),
    ],
  ];
  for (const [args, result, expected] of cases) {
    const runner = fakeRunner({});
    const entry = await captureWranglerEntry(runner, noClient, w(args), PLAN);
    assert.equal(entry.kind, 'resource_create');
    assert.equal(entry.before, null);
    assert.equal(entry.invertible, true);
    assert.equal(runner.calls.length, 0);
    const inverse = inverseForWrangler(entry, result);
    assert.deepEqual(inverse, [expected], args.join(' '));
    assertValidWrangler(inverse);
  }
});

test('kv namespace create without a resource id in the result is ambiguous', async () => {
  const entry = await captureWranglerEntry(fakeRunner({}), noClient, w(['kv', 'namespace', 'create', 'CACHE']), PLAN);
  assert.throws(() => inverseForWrangler(entry, { events: [] }), (err) => err.code === 'rollback_ambiguous');
});

test('deletes, secrets and Worker delete are not invertible and read nothing', async () => {
  const ops = [
    w(['d1', 'delete', 'app-db'], { confirm_name: 'app-db' }),
    w(['r2', 'bucket', 'delete', 'assets'], { confirm_name: 'assets' }),
    w(['kv', 'namespace', 'delete', '--namespace-id', KV_ID], { confirm_name: KV_ID }),
    w(['queues', 'delete', 'jobs'], { confirm_name: 'jobs' }),
    w(['secret', 'put', 'API_KEY', '--name', 'api'], { value_from_env: 'API_KEY' }),
    w(['secret', 'delete', 'API_KEY', '--name', 'api']),
    w(['delete', '--name', 'api'], { confirm_name: 'api' }),
  ];
  for (const op of ops) {
    const runner = fakeRunner({});
    const entry = await captureWranglerEntry(runner, noClient, op, PLAN);
    assert.equal(entry.invertible, false, op.args.join(' '));
    assert.equal(entry.before, null);
    assert.equal(runner.calls.length, 0);
    assert.deepEqual(inverseForWrangler(entry, { events: [] }), []);
  }
});

test('a failed snapshot read aborts with snapshot_failed carrying the wrangler failure message', async () => {
  const runner = fakeRunner({
    'deployments list --name api --json': {
      code: 1,
      stdout: '',
      stderr: 'X [ERROR] noise',
      events: [{ type: 'command-failed', message: 'Authentication error [code: 10000]' }],
    },
  });
  await assert.rejects(
    captureSnapshot(noClient, planWith([w(['deploy', '--name', 'api'])]), { runner }),
    (err) => err.code === 'snapshot_failed' && err.message.includes('Authentication error [code: 10000]'),
  );
});

test('a snapshot read that does not print JSON aborts with snapshot_failed', async () => {
  const runner = fakeRunner({ 'deployments list --name api --json': { code: 0, stdout: 'not json', stderr: '', events: [] } });
  await assert.rejects(
    captureWranglerEntry(runner, noClient, w(['deploy', '--name', 'api']), PLAN),
    (err) => err.code === 'snapshot_failed',
  );
});

test('captureSnapshot dispatches wrangler ops and buildRollbackOps keeps reverse order', async () => {
  const runner = fakeRunner({
    'd1 time-travel info app-db --json': { bookmark: BOOKMARK },
    'deployments list --name api --json': DEPLOYMENTS,
  });
  const plan = planWith([
    w(['kv', 'namespace', 'create', 'CACHE']),
    w(['d1', 'migrations', 'apply', 'app-db', '--remote']),
    w(['secret', 'put', 'API_KEY', '--name', 'api'], { value_from_env: 'API_KEY' }),
    w(['deploy', '--name', 'api']),
    w(['queues', 'create', 'jobs']),
  ]);
  const snap = await captureSnapshot(noClient, plan, { runner });
  assert.equal(snap.plan_id, plan.id);
  assert.deepEqual(
    snap.entries.map((e) => [e.op_index, e.op_kind, e.kind, e.invertible]),
    [
      [0, 'wrangler', 'resource_create', true],
      [1, 'wrangler', 'd1_migrations_apply', true],
      [2, 'wrangler', 'secret_put', false],
      [3, 'wrangler', 'worker_deploy', true],
      [4, 'wrangler', 'resource_create', true],
    ],
  );
  const results = [
    { resource_id: KV_ID, events: [] },
    { events: [] },
    { events: [] },
    { version_id: V_CANARY, events: [] },
    null,
  ];
  const ops = buildRollbackOps(snap, results);
  assert.deepEqual(ops, [
    w(['rollback', V_PREV, '--name', 'api']),
    w(['d1', 'time-travel', 'restore', 'app-db', '--bookmark', BOOKMARK]),
    w(['kv', 'namespace', 'delete', '--namespace-id', KV_ID], { confirm_name: KV_ID, precheck: 'empty' }),
  ]);
  assert.doesNotThrow(() => validateOpTargets(ops, plan));
});
