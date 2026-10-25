import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyWranglerOp, validateWranglerOp } from '../scripts/lib/wrangler-ops.mjs';
import { validateOpTargets, validatePlanOps } from '../scripts/lib/resources.mjs';
import { withIrreversibleRisk } from '../scripts/lib/apply.mjs';

const AID = 'abcdef0123456789abcdef0123456789';
const DIR = '/work/app';
const PLAN = { scope: 'account', account_id: AID, project_dir: DIR };

const w = (args, extra = {}) => ({ kind: 'wrangler', args, ...extra });

function rejects(op, pattern, plan = PLAN) {
  assert.throws(
    () => validateWranglerOp(op, plan),
    (err) => err.code === 'invalid_op' && (!pattern || pattern.test(err.message)),
    JSON.stringify(op.args),
  );
}

const ACCEPTED = [
  [w(['deploy']), 'worker_deploy', undefined, true],
  [w(['deploy', '--env', 'production'], { worker: 'api' }), 'worker_deploy', { type: 'worker', name: 'api' }, true],
  [w(['versions', 'deploy', '--name', 'api']), 'worker_versions_deploy', { type: 'worker', name: 'api' }, true],
  [w(['rollback', 'v-123'], { worker: 'api' }), 'worker_rollback', { type: 'worker', name: 'api' }, true],
  [w(['pages', 'deploy', 'dist', '--project-name', 'site']), 'pages_deploy', { type: 'pages', name: 'site' }, true],
  [w(['d1', 'migrations', 'apply', 'db1', '--remote']), 'd1_migrations_apply', { type: 'd1', name: 'db1' }, true],
  [w(['d1', 'time-travel', 'restore', 'db1', '--remote', '--bookmark', 'b-1']), 'd1_restore', { type: 'd1', name: 'db1' }, true],
  [w(['d1', 'create', 'db1']), 'resource_create', { type: 'd1', name: 'db1' }, true],
  [w(['d1', 'delete', 'db1'], { confirm_name: 'db1' }), 'resource_delete', { type: 'd1', name: 'db1' }, false],
  [w(['r2', 'bucket', 'create', 'b1']), 'resource_create', { type: 'r2', name: 'b1' }, true],
  [w(['r2', 'bucket', 'delete', 'b1'], { confirm_name: 'b1' }), 'resource_delete', { type: 'r2', name: 'b1' }, false],
  [w(['kv', 'namespace', 'create', 'cache']), 'resource_create', { type: 'kv', name: 'cache' }, true],
  [w(['kv', 'namespace', 'delete', '--namespace-id', 'ns1'], { confirm_name: 'ns1' }), 'resource_delete', { type: 'kv', name: 'ns1' }, false],
  [w(['queues', 'create', 'q1']), 'resource_create', { type: 'queue', name: 'q1' }, true],
  [w(['queues', 'delete', 'q1'], { confirm_name: 'q1' }), 'resource_delete', { type: 'queue', name: 'q1' }, false],
  [w(['secret', 'put', 'STRIPE_KEY'], { worker: 'api', value_from_env: 'STRIPE_KEY' }), 'secret_put', { type: 'worker', name: 'api' }, false],
  [w(['secret', 'put', 'STRIPE_KEY', '--name', 'api', '--env=production'], { value_from_env: 'MY_VAR_2' }), 'secret_put', { type: 'worker', name: 'api' }, false],
  [w(['secret', 'delete', 'OLD_KEY'], { worker: 'api' }), 'secret_delete', { type: 'worker', name: 'api' }, false],
  [w(['delete', '--name', 'api'], { confirm_name: 'api' }), 'worker_delete', { type: 'worker', name: 'api' }, false],
  [w(['delete'], { worker: 'api', confirm_name: 'api' }), 'worker_delete', { type: 'worker', name: 'api' }, false],
];

test('every allowlisted subcommand is accepted and classified', () => {
  for (const [op, kind, resource, invertible] of ACCEPTED) {
    assert.doesNotThrow(() => validateWranglerOp(op, PLAN), JSON.stringify(op.args));
    const got = classifyWranglerOp(op);
    assert.equal(got.kind, kind, JSON.stringify(op.args));
    assert.deepEqual(got.resource, resource, JSON.stringify(op.args));
    assert.equal(got.invertible, invertible, JSON.stringify(op.args));
  }
});

test('deploy ops accept a https health check and on_failed_check rollback', () => {
  const op = w(['deploy'], { worker: 'api', health_check: { url: 'https://api.example.com/health', expect_status: 200 }, on_failed_check: 'rollback' });
  assert.doesNotThrow(() => validateWranglerOp(op, PLAN));
});

test('subcommands outside the allowlist are rejected (exact, case-sensitive, leading words)', () => {
  for (const args of [
    ['publish'], ['tail'], ['Deploy'], ['d1', 'execute', 'db', '--remote'], ['kv', 'key', 'put', 'k', 'v'],
    ['r2', 'object', 'delete', 'b/k'], ['pages', 'project', 'delete', 'site'], ['secret', 'bulk'],
    ['versions', 'upload'], ['--env', 'production', 'deploy'], ['d1'], ['r2', 'bucket'],
  ]) {
    rejects(w(args), /not allowlisted/);
  }
});

test('forbidden flags are rejected anywhere in args', () => {
  for (const args of [
    ['deploy', '--dry-run'], ['deploy', '--dry-run=true'], ['deploy', '--dryRun'], ['deploy', '--outdir', 'out'],
    ['deploy', '--outdir=out'], ['deploy', '--x-provision'], ['deploy', '--experimental-x', '--x-auto-create'],
    ['deploy', '--cwd', '/'], ['deploy', '--env-file', '.env.prod'], ['deploy', '--envFile=.env'],
    ['rollback', 'v1', '--yes'], ['rollback', 'v1', '-y'], ['rollback', 'v1', '--message', 'm'], ['rollback', 'v1', '--message=m'],
    ['d1', 'delete', 'db1', '-y'], ['kv', 'namespace', 'delete', '--namespace-id', 'ns1', '-y'], ['deploy', '-yc', 'x'],
  ]) {
    const name = args.includes('db1') ? 'db1' : args.includes('ns1') ? 'ns1' : undefined;
    rejects(w(args, { worker: 'api', confirm_name: name }), /must not use|short flag/);
  }
});

test('--config / -c must resolve inside project_dir', () => {
  for (const args of [
    ['deploy', '--config', 'wrangler.toml'], ['deploy', '-c', 'sub/wrangler.jsonc'], ['deploy', '--config=./a/../wrangler.toml'],
  ]) {
    assert.doesNotThrow(() => validateWranglerOp(w(args), PLAN), JSON.stringify(args));
  }
  for (const args of [
    ['deploy', '--config', '../other/wrangler.toml'], ['deploy', '-c', '/etc/wrangler.toml'], ['deploy', '--config=..'],
    ['deploy', '-c=sub/../../x.toml'], ['deploy', '--config'], ['deploy', '--config', 'a', '--config', 'b'],
  ]) {
    rejects(w(args), /config/);
  }
  rejects(w(['deploy', '--config', 'wrangler.toml']), /config/, { ...PLAN, project_dir: '.' });
});

test('--config through a symlink that leaves project_dir is rejected', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'claudeflare-wops-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(join(root, 'outside.toml'), 'name = "x"\n');
  symlinkSync(join(root, 'outside.toml'), join(project, 'link.toml'));
  writeFileSync(join(project, 'wrangler.toml'), 'name = "x"\n');
  const plan = { ...PLAN, project_dir: project };
  rejects(w(['deploy', '--config', 'link.toml']), /config/, plan);
  assert.doesNotThrow(() => validateWranglerOp(w(['deploy', '--config', 'wrangler.toml']), plan));
});

test('args must be printable ASCII without control characters', () => {
  for (const bad of ['prod\nuction', 'tab\there', 'nul\u0000', 'del\u007f', 'café', '‮evil']) {
    rejects(w(['deploy', '--env', bad]), /printable ASCII/);
  }
});

test('delete ops need confirm_name equal to the resource name', () => {
  rejects(w(['d1', 'delete', 'db1']), /confirm_name/);
  rejects(w(['d1', 'delete', 'db1'], { confirm_name: 'db2' }), /confirm_name/);
  rejects(w(['r2', 'bucket', 'delete', 'b1'], { confirm_name: 'B1' }), /confirm_name/);
  rejects(w(['queues', 'delete', 'q1']), /confirm_name/);
  rejects(w(['kv', 'namespace', 'delete', '--namespace-id', 'ns1'], { confirm_name: 'cache' }), /confirm_name/);
  rejects(w(['delete', '--name', 'api'], { confirm_name: 'web' }), /confirm_name/);
  rejects(w(['delete'], { worker: 'api' }), /confirm_name/);
});

test('ops that name a resource need it in the expected place', () => {
  rejects(w(['d1', 'delete', '--remote'], { confirm_name: '--remote' }), /name/);
  rejects(w(['r2', 'bucket', 'create']), /name/);
  rejects(w(['d1', 'migrations', 'apply', '--remote']), /name/);
  rejects(w(['kv', 'namespace', 'delete'], { confirm_name: 'x' }), /namespace-id/);
  rejects(w(['kv', 'namespace', 'delete', '--namespace-id'], { confirm_name: 'x' }), /namespace-id/);
  rejects(w(['delete'], { confirm_name: 'api' }), /Worker/);
  rejects(w(['delete', 'api'], { worker: 'api', confirm_name: 'api' }), /--name/);
  rejects(w(['deploy', '--name', 'api'], { worker: 'web' }), /worker/);
  rejects(w(['delete', '--name', 'api', '--name', 'web'], { confirm_name: 'api' }), /more than once/);
});

test('d1 migrations apply and time-travel restore must be remote; restore needs a bookmark', () => {
  rejects(w(['d1', 'migrations', 'apply', 'db1']), /--remote/);
  rejects(w(['d1', 'migrations', 'apply', 'db1', '--remote', '--local']), /--local/);
  rejects(w(['d1', 'migrations', 'apply', 'db1', '--remote=false']), /--remote/);
  rejects(w(['d1', 'migrations', 'apply', 'db1', '--remote', '--no-remote']), /--no-remote/);
  rejects(w(['d1', 'time-travel', 'restore', 'db1', '--bookmark', 'b']), /--remote/);
  rejects(w(['d1', 'time-travel', 'restore', 'db1', '--remote']), /--bookmark/);
  rejects(w(['d1', 'time-travel', 'restore', 'db1', '--remote', '--bookmark']), /--bookmark/);
});

test('secret put needs value_from_env, a worker and no value-looking extra arg', () => {
  const ok = { worker: 'api', value_from_env: 'STRIPE_KEY' };
  rejects(w(['secret', 'put', 'STRIPE_KEY'], { worker: 'api' }), /value_from_env/);
  for (const bad of ['stripe_key', '1KEY', 'KEY-1', '', 'A B']) {
    rejects(w(['secret', 'put', 'STRIPE_KEY'], { worker: 'api', value_from_env: bad }), /value_from_env/);
  }
  rejects(w(['secret', 'put', 'STRIPE_KEY'], { value_from_env: 'STRIPE_KEY' }), /worker/);
  rejects(w(['secret', 'put'], ok), /name/);
  rejects(w(['secret', 'put', 'STRIPE_KEY', 'sk_live_abc123'], ok), /extra argument/);
  rejects(w(['secret', 'put', 'STRIPE_KEY', '--env', 'production', 'sk_live_abc123'], ok), /extra argument/);
  rejects(w(['secret', 'put', 'STRIPE_KEY', '--value', 'sk_live_abc123'], ok), /extra argument/);
  rejects(w(['secret', 'put', 'STRIPE_KEY', '--name'], ok), /extra argument|value/);
});

test('secret put rejection messages never echo the extra argument', () => {
  try {
    validateWranglerOp(w(['secret', 'put', 'STRIPE_KEY', 'sk_live_abc123'], { worker: 'api', value_from_env: 'STRIPE_KEY' }), PLAN);
    assert.fail('should throw');
  } catch (err) {
    assert.equal(err.code, 'invalid_op');
    assert.doesNotMatch(err.message, /sk_live_abc123/);
  }
});

test('on_failed_check other than rollback and non-https health checks are rejected', () => {
  rejects(w(['deploy'], { on_failed_check: 'ignore' }), /on_failed_check/);
  rejects(w(['deploy'], { on_failed_check: '' }), /on_failed_check/);
  rejects(w(['deploy'], { health_check: { url: 'http://api.example.com/health' } }), /health_check/);
  rejects(w(['deploy'], { health_check: { url: 'not a url' } }), /health_check/);
  rejects(w(['deploy'], { health_check: 'https://api.example.com/health' }), /health_check/);
  rejects(w(['deploy'], { health_check: {} }), /health_check/);
});

test('validateOpTargets runs wrangler op validation for account plans', () => {
  assert.throws(() => validateOpTargets([w(['publish'])], PLAN), (err) => err.code === 'invalid_op' && /^Op 0 /.test(err.message));
  assert.throws(() => validateOpTargets([w(['deploy']), w(['deploy', '--dry-run'])], PLAN), (err) => err.code === 'invalid_op' && /^Op 1 /.test(err.message));
  assert.doesNotThrow(() => validateOpTargets([w(['deploy'], { worker: 'api' })], PLAN));
});

test('validatePlanOps rejects two deploy ops for the same worker', () => {
  for (const pair of [
    [w(['deploy'], { worker: 'api' }), w(['versions', 'deploy', '--name', 'api'])],
    [w(['deploy'], { worker: 'api' }), w(['rollback'], { worker: 'api' })],
    [w(['deploy']), w(['deploy', '--env', 'staging'])],
  ]) {
    assert.throws(() => validatePlanOps(pair), (err) => err.code === 'plan_conflict', JSON.stringify(pair));
  }
  assert.doesNotThrow(() => validatePlanOps([w(['deploy'], { worker: 'api' }), w(['deploy'], { worker: 'web' })]));
});

test('validatePlanOps rejects two ops on one resource when one is a delete', () => {
  for (const pair of [
    [w(['d1', 'migrations', 'apply', 'db1', '--remote']), w(['d1', 'delete', 'db1'], { confirm_name: 'db1' })],
    [w(['r2', 'bucket', 'create', 'b1']), w(['r2', 'bucket', 'delete', 'b1'], { confirm_name: 'b1' })],
    [w(['secret', 'put', 'K'], { worker: 'api', value_from_env: 'K' }), w(['delete'], { worker: 'api', confirm_name: 'api' })],
    [w(['queues', 'delete', 'q1'], { confirm_name: 'q1' }), w(['queues', 'delete', 'q1'], { confirm_name: 'q1' })],
  ]) {
    assert.throws(() => validatePlanOps(pair), (err) => err.code === 'plan_conflict', JSON.stringify(pair));
  }
  assert.doesNotThrow(() =>
    validatePlanOps([
      w(['d1', 'create', 'db1']),
      w(['d1', 'migrations', 'apply', 'db1', '--remote']),
      w(['secret', 'delete', 'OLD'], { worker: 'api' }),
      w(['secret', 'put', 'NEW'], { worker: 'api', value_from_env: 'NEW' }),
      w(['d1', 'delete', 'db2'], { confirm_name: 'db2' }),
    ]),
  );
});

test('withIrreversibleRisk names non-invertible wrangler ops', () => {
  const ops = [
    w(['deploy'], { worker: 'api' }),
    w(['d1', 'create', 'db1']),
    w(['r2', 'bucket', 'delete', 'b1'], { confirm_name: 'b1' }),
    w(['secret', 'put', 'STRIPE_KEY'], { worker: 'api', value_from_env: 'STRIPE_KEY' }),
    w(['secret', 'delete', 'OLD'], { worker: 'api' }),
    w(['delete', '--name', 'api'], { confirm_name: 'api' }),
  ];
  assert.equal(
    withIrreversibleRisk('Deploys api.', ops),
    [
      'Deploys api.',
      'Not reversible: wrangler r2 bucket delete b1',
      'Not reversible: wrangler secret put STRIPE_KEY',
      'Not reversible: wrangler secret delete OLD',
      'Not reversible: wrangler delete --name api',
    ].join('\n'),
  );
});
