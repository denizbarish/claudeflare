import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertWranglerOpPaths, classifyWranglerOp, validateWranglerOp } from '../scripts/lib/wrangler-ops.mjs';
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

function accepts(op, plan = PLAN) {
  assert.doesNotThrow(() => validateWranglerOp(op, plan), JSON.stringify(op.args));
}

function tempProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'claudeflare-wops-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  return { root, project, plan: { ...PLAN, project_dir: project } };
}

const ACCEPTED = [
  [w(['deploy', '--name', 'api']), 'worker_deploy', { type: 'worker', name: 'api' }, true],
  [w(['deploy', '--name', 'api', '--env', 'production'], { worker: 'api' }), 'worker_deploy', { type: 'worker', name: 'api' }, true],
  [w(['deploy', 'src/index.ts', '--name', 'api', '--assets', 'public', '--minify', '--var', 'A:1', '--var', 'B:2', '-e', 'prod']), 'worker_deploy', { type: 'worker', name: 'api' }, true],
  [w(['deploy', '--name', 'api', '--route', 'example.com/*', '--compatibility-flag', 'nodejs_compat', '--no-bundle']), 'worker_deploy', { type: 'worker', name: 'api' }, true],
  [w(['versions', 'deploy', 'v1@50', 'v2@50', '--name', 'api']), 'worker_versions_deploy', { type: 'worker', name: 'api' }, true],
  [w(['versions', 'upload', '--name', 'api', '--tag', 'v2', '--preview-alias', 'canary']), 'worker_versions_upload', { type: 'worker', name: 'api' }, false],
  [w(['r2', 'bucket', 'dev-url', 'disable', 'b1']), 'r2_dev_url', { type: 'r2', name: 'b1' }, true],
  [w(['r2', 'bucket', 'dev-url', 'enable', 'b1', '-J', 'eu']), 'r2_dev_url', { type: 'r2', name: 'b1' }, false],
  [w(['rollback', 'v-123', '--name', 'api'], { worker: 'api' }), 'worker_rollback', { type: 'worker', name: 'api' }, true],
  [w(['pages', 'deploy', 'dist', '--project-name', 'site', '--branch', 'main']), 'pages_deploy', { type: 'pages', name: 'site' }, true],
  [w(['d1', 'migrations', 'apply', 'db1', '--remote']), 'd1_migrations_apply', { type: 'd1', name: 'db1' }, true],
  [w(['d1', 'migrations', 'apply', '--remote', 'db1']), 'd1_migrations_apply', { type: 'd1', name: 'db1' }, true],
  [w(['d1', 'time-travel', 'restore', 'db1', '--bookmark', 'b-1', '--json']), 'd1_restore', { type: 'd1', name: 'db1' }, true],
  [w(['d1', 'create', 'db1', '--location', 'weur']), 'resource_create', { type: 'd1', name: 'db1' }, true],
  [w(['d1', 'delete', 'db1'], { confirm_name: 'db1' }), 'resource_delete', { type: 'd1', name: 'db1' }, false],
  [w(['r2', 'bucket', 'create', 'b1', '-J', 'eu']), 'resource_create', { type: 'r2', name: 'b1' }, true],
  [w(['r2', 'bucket', 'delete', 'b1'], { confirm_name: 'b1' }), 'resource_delete', { type: 'r2', name: 'b1' }, false],
  [w(['kv', 'namespace', 'create', 'cache']), 'resource_create', { type: 'kv', name: 'cache' }, true],
  [w(['kv', 'namespace', 'delete', '--namespace-id', 'ns1'], { confirm_name: 'ns1' }), 'resource_delete', { type: 'kv', name: 'ns1' }, false],
  [w(['queues', 'create', 'q1']), 'resource_create', { type: 'queue', name: 'q1' }, true],
  [w(['queues', 'delete', 'q1'], { confirm_name: 'q1' }), 'resource_delete', { type: 'queue', name: 'q1' }, false],
  [w(['secret', 'put', 'STRIPE_KEY', '--name', 'api'], { worker: 'api', value_from_env: 'STRIPE_KEY' }), 'secret_put', { type: 'worker', name: 'api' }, false],
  [w(['secret', 'put', 'STRIPE_KEY', '--name', 'api', '--env=production'], { value_from_env: 'STRIPE_KEY' }), 'secret_put', { type: 'worker', name: 'api' }, false],
  [w(['secret', 'delete', 'OLD_KEY', '--name', 'api']), 'secret_delete', { type: 'worker', name: 'api' }, false],
  [w(['delete', '--name', 'api'], { confirm_name: 'api' }), 'worker_delete', { type: 'worker', name: 'api' }, false],
  [w(['delete', '--name', 'api'], { worker: 'api', confirm_name: 'api' }), 'worker_delete', { type: 'worker', name: 'api' }, false],
];

test('every allowlisted subcommand is accepted and classified', () => {
  for (const [op, kind, resource, invertible] of ACCEPTED) {
    accepts(op);
    const got = classifyWranglerOp(op);
    assert.equal(got.kind, kind, JSON.stringify(op.args));
    assert.deepEqual(got.resource, resource, JSON.stringify(op.args));
    assert.equal(got.invertible, invertible, JSON.stringify(op.args));
  }
});

test('deploy ops accept a https health check and on_failed_check rollback', () => {
  accepts(w(['deploy', '--name', 'api'], { worker: 'api', health_check: { url: 'https://api.example.com/health', expect_status: 200 }, on_failed_check: 'rollback' }));
});

test('subcommands outside the allowlist are rejected (exact, case-sensitive, leading words)', () => {
  for (const args of [
    ['publish'], ['tail'], ['Deploy'], ['d1', 'execute', 'db', '--remote'], ['kv', 'key', 'put', 'k', 'v'],
    ['r2', 'object', 'delete', 'b/k'], ['pages', 'project', 'delete', 'site'], ['secret', 'bulk'],
    ['versions', 'view'], ['r2', 'bucket', 'dev-url', 'get', 'b1'], ['--env', 'production', 'deploy'], ['d1'], ['r2', 'bucket'],
  ]) {
    rejects(w(args), /not allowlisted/);
  }
});

test('flags not on the subcommand allowlist are rejected', () => {
  for (const args of [
    ['deploy', '--dry-run'], ['deploy', '--dry-run=true'], ['deploy', '--dryRun'], ['deploy', '--outdir', 'out'],
    ['deploy', '--outdir=out'], ['deploy', '--outfile', 'x.js'], ['deploy', '--metafile'], ['deploy', '--secrets-file', 's.json'],
    ['deploy', '--cwd', '/'], ['deploy', '--env-file', '.env.prod'], ['deploy', '--envFile=.env'], ['deploy', '--profile', 'p'],
    ['deploy', '--install-skills'], ['deploy', '--zone', 'example.com'], ['deploy', '--bogus'], ['deploy', '--no-minify'],
    ['deploy', '-yc', 'x'], ['deploy', '-h'], ['deploy', '-v'], ['versions', 'deploy', '--dry-run'],
    ['d1', 'migrations', 'apply', 'db1', '--remote', '--local'], ['d1', 'migrations', 'apply', 'db1', '--remote', '--no-remote'],
    ['d1', 'migrations', 'apply', 'db1', '--remote', '--persist-to', 'x'], ['d1', 'migrations', 'apply', 'db1', '--remote', '--preview'],
    ['d1', 'time-travel', 'restore', 'db1', '--bookmark', 'b', '--remote'], ['d1', 'time-travel', 'restore', 'db1', '--bookmark', 'b', '--timestamp', '1'],
    ['d1', 'create', 'db1', '--update-config'], ['r2', 'bucket', 'create', 'b1', '--binding', 'B'],
  ]) {
    rejects(w(args, { worker: 'api' }), /must not use/);
  }
});

test('deploy rejects --dispatch-namespace (Workers for Platforms is out of scope)', () => {
  rejects(w(['deploy', '--name', 'api', '--dispatch-namespace', 'customers']), /must not use --dispatch-namespace/);
  rejects(w(['deploy', '--name', 'api', '--dispatch-namespace=customers']), /must not use --dispatch-namespace/);
});

test('experimental flags are never allowed', () => {
  rejects(w(['deploy', '--name', 'api', '--experimental-x']), /experimental/);
  rejects(w(['deploy', '--name', 'api', '--x-provision']), /experimental/);
  rejects(w(['deploy', '--name', 'api', '--experimental-route-zones']), /experimental/);
  rejects(w(['kv', 'namespace', 'create', 'c', '--x-mode', 'instant']), /experimental/);
  rejects(w(['deploy', '--name', 'api', '--experimentalFoo']), /experimental/);
});

test('executor-owned confirmation flags are rejected in drafts', () => {
  for (const args of [
    ['rollback', 'v1', '--yes'], ['rollback', 'v1', '-y'], ['rollback', 'v1', '--y'], ['rollback', 'v1', '--message', 'm'],
    ['rollback', 'v1', '--message=m'], ['rollback', 'v1', '-m', 'm'], ['versions', 'deploy', '--name', 'api', '--yes'],
    ['d1', 'delete', 'db1', '-y'], ['d1', 'delete', 'db1', '--skip-confirmation'], ['deploy', '--message', 'x'],
    ['kv', 'namespace', 'delete', '--namespace-id', 'ns1', '-y'], ['kv', 'namespace', 'delete', '--namespace-id', 'ns1', '--skipConfirmation'],
  ]) {
    const name = args.includes('db1') ? 'db1' : args.includes('ns1') ? 'ns1' : undefined;
    rejects(w(args, { worker: 'api', confirm_name: name }), /executor/);
  }
});

test('single-letter double-dash flags are read as their short forms', () => {
  accepts(w(['deploy', '--name', 'api', '--e', 'production']));
  accepts(w(['deploy', '--name', 'api', '--c', 'wrangler.toml']));
  rejects(w(['deploy', '--name', 'api', '--c', '../x.toml']), /--config/);
  rejects(w(['deploy', '--name', 'api', '--h']), /must not use/);
});

test('flag values: bools are bare, strings need a value, singles may not repeat', () => {
  rejects(w(['d1', 'migrations', 'apply', 'db1', '--remote=false']), /bare flag/);
  rejects(w(['d1', 'migrations', 'apply', 'db1', '--remote', 'false']), /positional/);
  rejects(w(['d1', 'migrations', 'apply', 'db1', '--remote', 'true']), /positional/);
  rejects(w(['deploy', '--name']), /needs a value/);
  rejects(w(['deploy', '--name', 'api', '--name=']), /needs a value/);
  rejects(w(['deploy', '--name', '--minify']), /needs a value/);
  rejects(w(['deploy', '--name', 'a', '--name', 'b']), /more than once/);
  rejects(w(['deploy', '--name', 'api', 'a.js', 'b.js']), /positional/);
  accepts(w(['deploy', '--name', 'api', '--var', 'A:1', '--var', 'B:2']));
});

test('a positional right after a list flag value is rejected', () => {
  rejects(w(['deploy', '--name', 'api', '--var', 'A:1', 'B:2']), /positional after a list flag/);
  rejects(w(['deploy', '--name', 'api', '--var=A:1', 'src/index.ts']), /positional after a list flag/);
  rejects(w(['versions', 'deploy', '--version-id', 'v1', 'v2@50', '--name', 'api']), /positional after a list flag/);
  accepts(w(['deploy', '--name', 'api', 'src/index.ts', '--var', 'A:1', '--minify']));
  accepts(w(['deploy', '--var', 'A:1', '--name', 'api', 'src/index.ts']));
});

test('flag names must be lowercase (camelCase normalizes, uppercase is rejected)', () => {
  for (const flag of ['--Name', '--NAME', '--name-X', '--nAME']) {
    rejects(w(['deploy', flag, 'api']), /lowercase flag names/);
  }
  accepts(w(['deploy', '--name', 'api', '--keepVars']));
  accepts(w(['r2', 'bucket', 'create', 'b1', '-J', 'eu']));
});

test('--alias is not allowed and --define needs KEY:VALUE with an identifier key', () => {
  rejects(w(['deploy', '--name', 'api', '--alias', 'node:fs:/etc/passwd']), /must not use --alias/);
  accepts(w(['deploy', '--name', 'api', '--define', 'DEBUG:false', '--define', 'process.env.MODE:"prod"', '--define', '$x:1']));
  for (const bad of ['DEBUG', ':x', '1A:x', 'a/b:x', 'a-b:x', '../x:y']) {
    rejects(w(['deploy', '--name', 'api', '--define', bad]), /--define values/);
  }
});

test('args must be printable ASCII without control characters', () => {
  for (const bad of ['prod\nuction', 'tab\there', 'nul\u0000', 'del\u007f', 'café', '‮evil']) {
    rejects(w(['deploy', '--name', 'api', '--env', bad]), /printable ASCII/);
  }
});

test('--config / -c must resolve inside project_dir', () => {
  for (const args of [
    ['deploy', '--name', 'api', '--config', 'wrangler.toml'], ['deploy', '--name', 'api', '-c', 'sub/wrangler.jsonc'], ['deploy', '--name', 'api', '--config=./a/../wrangler.toml'],
  ]) {
    accepts(w(args));
  }
  for (const args of [
    ['deploy', '--name', 'api', '--config', '../other/wrangler.toml'], ['deploy', '--name', 'api', '-c', '/etc/wrangler.toml'], ['deploy', '--name', 'api', '--config=..'],
    ['deploy', '--name', 'api', '-c=sub/../../x.toml'], ['deploy', '--name', 'api', '--config'], ['deploy', '--name', 'api', '--config', 'a', '--config', 'b'],
  ]) {
    rejects(w(args), /config/);
  }
  rejects(w(['deploy', '--name', 'api', '--config', 'wrangler.toml']), /config/, { ...PLAN, project_dir: '.' });
});

test('path args (script, --assets, --site, --tsconfig, pages directory) must resolve inside project_dir', () => {
  for (const args of [
    ['deploy', '--name', 'api', '../outside/index.js'], ['deploy', '--name', 'api', '/etc/passwd'], ['deploy', '--name', 'api', '--assets', '../public'],
    ['deploy', '--name', 'api', '--site=/srv/site'], ['deploy', '--name', 'api', '--tsconfig', '../tsconfig.json'],
    ['pages', 'deploy', '../outside', '--project-name', 'site'], ['pages', 'deploy', '/tmp/dist', '--project-name', 'site'],
  ]) {
    rejects(w(args), /inside project_dir/);
  }
  accepts(w(['deploy', '--name', 'api', 'src/index.ts', '--assets', './public', '--tsconfig', 'tsconfig.json']));
  accepts(w(['pages', 'deploy', 'dist', '--project-name', 'site']));
  rejects(w(['pages', 'deploy', 'dist', '--project-name', 'site']), /project_dir/, { ...PLAN, project_dir: 'rel' });
});

test('path args through a symlink that leaves project_dir are rejected', (t) => {
  const { root, project, plan } = tempProject(t);
  writeFileSync(join(root, 'outside.toml'), 'name = "x"\n');
  mkdirSync(join(root, 'outside-dir'));
  symlinkSync(join(root, 'outside.toml'), join(project, 'link.toml'));
  symlinkSync(join(root, 'outside-dir'), join(project, 'dist'));
  writeFileSync(join(project, 'wrangler.toml'), 'name = "x"\n');
  mkdirSync(join(project, 'public'));
  rejects(w(['deploy', '--name', 'api', '--config', 'link.toml']), /inside project_dir/, plan);
  rejects(w(['pages', 'deploy', 'dist', '--project-name', 'site']), /inside project_dir/, plan);
  // A path that does not exist yet is checked through its nearest existing ancestor.
  rejects(w(['deploy', '--name', 'api', '--assets', 'dist/not-yet/built']), /inside project_dir/, plan);
  accepts(w(['deploy', '--name', 'api', '--config', 'wrangler.toml', '--assets', 'public', 'src/missing.ts']), plan);
});

test('symlinks are followed component by component, including dangling links and chains', (t) => {
  const { root, project, plan } = tempProject(t);
  mkdirSync(join(root, 'outside'));
  mkdirSync(join(project, 'build'));
  // Dangling link pointing outside: the target does not exist yet.
  symlinkSync(join(root, 'not-there'), join(project, 'dangling-out'));
  // Dangling link pointing inside: still rejected, it cannot be resolved.
  symlinkSync(join(project, 'not-built'), join(project, 'dangling-in'));
  // Chain: a -> b -> outside.
  symlinkSync(join(root, 'outside'), join(project, 'b'));
  symlinkSync('b', join(project, 'a'));
  // Chain that stays inside: c -> d -> build.
  symlinkSync('build', join(project, 'd'));
  symlinkSync('d', join(project, 'c'));
  // Loop.
  symlinkSync('loop2', join(project, 'loop1'));
  symlinkSync('loop1', join(project, 'loop2'));
  rejects(w(['deploy', '--name', 'api', '--assets', 'dangling-out']), /cannot be resolved/, plan);
  rejects(w(['deploy', '--name', 'api', '--assets', 'dangling-out/sub']), /cannot be resolved/, plan);
  rejects(w(['deploy', '--name', 'api', '--assets', 'dangling-in']), /cannot be resolved/, plan);
  rejects(w(['pages', 'deploy', 'a', '--project-name', 'site']), /inside project_dir/, plan);
  rejects(w(['deploy', '--name', 'api', 'a/x/index.js']), /inside project_dir/, plan);
  rejects(w(['deploy', '--name', 'api', '--assets', 'loop1']), /cannot be resolved/, plan);
  accepts(w(['pages', 'deploy', 'c', '--project-name', 'site']), plan);
  accepts(w(['deploy', '--name', 'api', 'c/missing/index.js']), plan);
});

test('assertWranglerOpPaths re-runs path containment on its own', (t) => {
  const { root, project, plan } = tempProject(t);
  const op = w(['pages', 'deploy', 'dist', '--project-name', 'site']);
  mkdirSync(join(project, 'dist'));
  assert.doesNotThrow(() => assertWranglerOpPaths(op, plan));
  rmSync(join(project, 'dist'), { recursive: true });
  mkdirSync(join(root, 'elsewhere'));
  symlinkSync(join(root, 'elsewhere'), join(project, 'dist'));
  assert.throws(() => assertWranglerOpPaths(op, plan), (err) => err.code === 'invalid_op' && /inside project_dir/.test(err.message));
  assert.throws(() => assertWranglerOpPaths(w(['publish']), plan), (err) => err.code === 'invalid_op');
});

test('delete ops need confirm_name equal to the resource name', () => {
  rejects(w(['d1', 'delete', 'db1']), /confirm_name/);
  rejects(w(['d1', 'delete', 'db1'], { confirm_name: 'db2' }), /confirm_name/);
  rejects(w(['r2', 'bucket', 'delete', 'b1'], { confirm_name: 'B1' }), /confirm_name/);
  rejects(w(['queues', 'delete', 'q1']), /confirm_name/);
  rejects(w(['kv', 'namespace', 'delete', '--namespace-id', 'ns1'], { confirm_name: 'cache' }), /confirm_name/);
  rejects(w(['delete', '--name', 'api'], { confirm_name: 'web' }), /confirm_name/);
  rejects(w(['delete', '--name', 'api'], { worker: 'api' }), /confirm_name/);
});

test('deploy, versions deploy and rollback need --name in args matching op.worker', () => {
  rejects(w(['deploy']), /must include --name/);
  rejects(w(['deploy'], { worker: 'api' }), /must include --name/);
  rejects(w(['versions', 'deploy', 'v1@100%']), /must include --name/);
  rejects(w(['rollback', 'v1'], { worker: 'api' }), /must include --name/);
  rejects(w(['rollback', 'v1', '--name', 'api'], { worker: 'web' }), /worker does not match/);
  accepts(w(['rollback', 'v1', '--name', 'api'], { worker: 'api' }));
});

test('ops that name a resource need it in the expected place', () => {
  rejects(w(['d1', 'delete'], { confirm_name: 'x' }), /d1 name/);
  rejects(w(['r2', 'bucket', 'create']), /r2 name/);
  rejects(w(['d1', 'migrations', 'apply', '--remote']), /d1 name/);
  rejects(w(['deploy', '--name', 'api'], { worker: 'web' }), /worker does not match/);
});

test('kv namespace delete is identified only by --namespace-id', () => {
  rejects(w(['kv', 'namespace', 'delete'], { confirm_name: 'x' }), /--namespace-id/);
  rejects(w(['kv', 'namespace', 'delete', '--namespace-id'], { confirm_name: 'x' }), /--namespace-id/);
  rejects(w(['kv', 'namespace', 'delete', 'cache', '--namespace-id', 'ns1'], { confirm_name: 'ns1' }), /positional/);
  rejects(w(['kv', 'namespace', 'delete', '--binding', 'CACHE', '--namespace-id', 'ns1'], { confirm_name: 'ns1' }), /--binding/);
  rejects(w(['kv', 'namespace', 'delete', '--namespace-id', 'ns1', '--preview'], { confirm_name: 'ns1' }), /--preview/);
});

test('worker delete and secret ops need --name in args matching op.worker', () => {
  rejects(w(['delete'], { worker: 'api', confirm_name: 'api' }), /--name/);
  rejects(w(['delete', 'api'], { worker: 'api', confirm_name: 'api' }), /positional/);
  rejects(w(['delete', '--name', 'api', '--force'], { confirm_name: 'api' }), /--force/);
  rejects(w(['delete', '--name', 'api', '--name', 'web'], { confirm_name: 'api' }), /more than once/);
  rejects(w(['delete', '--name', 'api'], { worker: 'web', confirm_name: 'api' }), /worker does not match/);
  rejects(w(['secret', 'put', 'K'], { worker: 'api', value_from_env: 'K' }), /--name/);
  rejects(w(['secret', 'put', 'K', '--name', 'api'], { worker: 'web', value_from_env: 'K' }), /worker does not match/);
  rejects(w(['secret', 'delete', 'K'], { worker: 'api' }), /--name/);
  rejects(w(['secret', 'delete', 'K', '--name', 'api'], { worker: 'web' }), /worker does not match/);
});

test('d1 migrations apply requires --remote; time-travel restore requires --bookmark', () => {
  rejects(w(['d1', 'migrations', 'apply', 'db1']), /--remote/);
  rejects(w(['d1', 'time-travel', 'restore', 'db1']), /--bookmark/);
  rejects(w(['d1', 'time-travel', 'restore', 'db1', '--bookmark']), /--bookmark/);
  rejects(w(['d1', 'time-travel', 'restore', 'db1', '--json']), /--bookmark/);
});

test('secret put needs value_from_env, a worker and no value-looking extra arg', () => {
  const ok = { value_from_env: 'STRIPE_KEY' };
  rejects(w(['secret', 'put', 'STRIPE_KEY', '--name', 'api']), /value_from_env/);
  for (const bad of ['stripe_key', '1KEY', 'KEY-1', '', 'A B', 'OTHER_KEY']) {
    rejects(w(['secret', 'put', 'STRIPE_KEY', '--name', 'api'], { value_from_env: bad }), /value_from_env equal to the secret name/);
  }
  for (const name of ['stripe_key', '1KEY', 'KEY-1']) {
    rejects(w(['secret', 'put', name, '--name', 'api'], { value_from_env: name }), /secret name matching/);
  }
  rejects(w(['secret', 'put', '--name', 'api'], ok), /secret/);
  rejects(w(['secret', 'put', 'STRIPE_KEY', '--name', 'api', 'sk_live_abc123'], ok), /positional/);
  rejects(w(['secret', 'put', 'STRIPE_KEY', '--name', 'api', '--env', 'production', 'sk_live_abc123'], ok), /positional/);
  rejects(w(['secret', 'put', 'STRIPE_KEY', '--name', 'api', '--value', 'sk_live_abc123'], ok), /must not use/);
  rejects(w(['secret', 'put', 'STRIPE_KEY', '--name'], ok), /needs a value/);
});

test('secret names (and so value_from_env) must not name credential or claudeflare variables', () => {
  for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'WRANGLER_OUTPUT_FILE_PATH', 'CLAUDEFLARE_WRANGLER', 'ANTHROPIC_API_KEY']) {
    rejects(w(['secret', 'put', name, '--name', 'api'], { value_from_env: name }), /must not start/);
    rejects(w(['secret', 'put', 'K', '--name', 'api'], { value_from_env: name }), /equal to the secret name/);
  }
  accepts(w(['secret', 'put', 'MY_CLOUDFLARE_KEY', '--name', 'api'], { value_from_env: 'MY_CLOUDFLARE_KEY' }));
});

test('rejection messages never echo a misplaced secret value', () => {
  for (const args of [
    ['secret', 'put', 'STRIPE_KEY', '--name', 'api', 'sk_live_abc123'],
    ['secret', 'put', 'STRIPE_KEY', '--name', 'api', '--sk_live_abc123'],
    ['secret', 'put', 'STRIPE_KEY', '--name', 'api', '--value=sk_live_abc123'],
  ]) {
    assert.throws(
      () => validateWranglerOp(w(args, { value_from_env: 'STRIPE_KEY' }), PLAN),
      (err) => err.code === 'invalid_op' && !/sk_live_abc123/.test(err.message),
      JSON.stringify(args),
    );
  }
});

test('on_failed_check other than rollback and non-https health checks are rejected', () => {
  rejects(w(['deploy', '--name', 'api'], { on_failed_check: 'ignore' }), /on_failed_check/);
  rejects(w(['deploy', '--name', 'api'], { on_failed_check: '' }), /on_failed_check/);
  rejects(w(['deploy', '--name', 'api'], { health_check: { url: 'http://api.example.com/health' } }), /health_check/);
  rejects(w(['deploy', '--name', 'api'], { health_check: { url: 'not a url' } }), /health_check/);
  rejects(w(['deploy', '--name', 'api'], { health_check: 'https://api.example.com/health' }), /health_check/);
  rejects(w(['deploy', '--name', 'api'], { health_check: {} }), /health_check/);
});

test('validateOpTargets runs wrangler op validation for account plans', () => {
  assert.throws(() => validateOpTargets([w(['publish'])], PLAN), (err) => err.code === 'invalid_op' && /^Op 0 /.test(err.message));
  assert.throws(() => validateOpTargets([w(['deploy', '--name', 'api']), w(['deploy', '--name', 'api', '--dry-run'])], PLAN), (err) => err.code === 'invalid_op' && /^Op 1 /.test(err.message));
  assert.doesNotThrow(() => validateOpTargets([w(['deploy', '--name', 'api'], { worker: 'api' })], PLAN));
});

test('validatePlanOps rejects two deploy ops for the same worker', () => {
  for (const pair of [
    [w(['deploy', '--name', 'api'], { worker: 'api' }), w(['versions', 'deploy', '--name', 'api'])],
    [w(['deploy', '--name', 'api'], { worker: 'api' }), w(['rollback'], { worker: 'api' })],
    [w(['deploy', '--name', 'api']), w(['deploy', '--name', 'api', '--env', 'staging'])],
  ]) {
    assert.throws(() => validatePlanOps(pair), (err) => err.code === 'plan_conflict', JSON.stringify(pair));
  }
  assert.doesNotThrow(() => validatePlanOps([w(['deploy', '--name', 'api'], { worker: 'api' }), w(['deploy', '--name', 'web'], { worker: 'web' })]));
});

test('validatePlanOps rejects two ops on one resource when one is a delete', () => {
  for (const pair of [
    [w(['d1', 'migrations', 'apply', 'db1', '--remote']), w(['d1', 'delete', 'db1'], { confirm_name: 'db1' })],
    [w(['r2', 'bucket', 'create', 'b1']), w(['r2', 'bucket', 'delete', 'b1'], { confirm_name: 'b1' })],
    [w(['secret', 'put', 'K', '--name', 'api'], { value_from_env: 'K' }), w(['delete', '--name', 'api'], { confirm_name: 'api' })],
    [w(['queues', 'delete', 'q1'], { confirm_name: 'q1' }), w(['queues', 'delete', 'q1'], { confirm_name: 'q1' })],
  ]) {
    assert.throws(() => validatePlanOps(pair), (err) => err.code === 'plan_conflict', JSON.stringify(pair));
  }
  assert.doesNotThrow(() =>
    validatePlanOps([
      w(['d1', 'create', 'db1']),
      w(['d1', 'migrations', 'apply', 'db1', '--remote']),
      w(['secret', 'delete', 'OLD', '--name', 'api']),
      w(['secret', 'put', 'NEW', '--name', 'api'], { value_from_env: 'NEW' }),
      w(['d1', 'delete', 'db2'], { confirm_name: 'db2' }),
    ]),
  );
});

test('withIrreversibleRisk names non-invertible wrangler ops and data loss for KV, Queue and D1 deletes', () => {
  const ops = [
    w(['deploy', '--name', 'api'], { worker: 'api' }),
    w(['d1', 'create', 'db1']),
    w(['r2', 'bucket', 'delete', 'b1'], { confirm_name: 'b1' }),
    w(['kv', 'namespace', 'delete', '--namespace-id', 'ns1'], { confirm_name: 'ns1' }),
    w(['queues', 'delete', 'q1'], { confirm_name: 'q1' }),
    w(['d1', 'delete', 'db2'], { confirm_name: 'db2' }),
    w(['secret', 'put', 'STRIPE_KEY', '--name', 'api'], { value_from_env: 'STRIPE_KEY' }),
    w(['secret', 'delete', 'OLD', '--name', 'api']),
    w(['delete', '--name', 'api'], { confirm_name: 'api' }),
  ];
  assert.equal(
    withIrreversibleRisk('Deploys api.', ops),
    [
      'Deploys api.',
      'Not reversible: wrangler r2 bucket delete b1',
      'Not reversible: wrangler kv namespace delete --namespace-id ns1',
      'Data loss: kv ns1 and all its contents are deleted permanently.',
      'Not reversible: wrangler queues delete q1',
      'Data loss: queue q1 and all its contents are deleted permanently.',
      'Not reversible: wrangler d1 delete db2',
      'Data loss: d1 db2 and all its contents are deleted permanently.',
      'Not reversible: wrangler secret put STRIPE_KEY --name api',
      'Not reversible: wrangler secret delete OLD --name api',
      'Not reversible: wrangler delete --name api',
    ].join('\n'),
  );
});

test('health_check.expect_status must be an integer status code when given', () => {
  for (const expect_status of ['200', 99, 600, 200.5, null]) {
    rejects(w(['deploy', '--name', 'api'], { health_check: { url: 'https://api.example.com/health', expect_status } }), /expect_status/);
  }
  accepts(w(['deploy', '--name', 'api'], { health_check: { url: 'https://api.example.com/health' } }));
});

test('pages deploy needs --project-name, so apply can snapshot the project', () => {
  rejects(w(['pages', 'deploy', 'dist']), /--project-name/);
  accepts(w(['pages', 'deploy', 'dist', '--project-name', 'site']));
});

test('rollback deletes of created resources say they run only when empty, not that data is lost', () => {
  const risk = withIrreversibleRisk('Rollback.', [
    w(['kv', 'namespace', 'delete', '--namespace-id', '0f2ac74b498b48028cb68387c421e279'], { confirm_name: '0f2ac74b498b48028cb68387c421e279', precheck: 'empty' }),
    w(['d1', 'delete', 'app-db'], { confirm_name: 'app-db', precheck: 'empty' }),
  ]);
  assert.doesNotMatch(risk, /Data loss/);
  assert.match(risk, /Deleted only if kv .* is still empty/);
  assert.match(risk, /Not deleted automatically: d1 app-db/);
});

test('versions upload refuses secrets files and build output flags', () => {
  for (const flag of [['--secrets-file', 's.json'], ['--outdir', 'out'], ['--outfile', 'o.js'], ['--dry-run'], ['--alias', 'a:b']]) {
    rejects(w(['versions', 'upload', '--name', 'api', ...flag]));
  }
  rejects(w(['versions', 'upload']), /--name/);
  rejects(w(['r2', 'bucket', 'dev-url', 'disable', 'b1', '--force']));
});

test('only ops that change what serves traffic take a health check', () => {
  const check = { health_check: { url: 'https://api.example.com/health' } };
  rejects(w(['versions', 'upload', '--name', 'api'], check), /takes no health_check/);
  rejects(w(['secret', 'put', 'K', '--name', 'api'], { value_from_env: 'K', ...check }), /takes no health_check/);
  rejects(w(['deploy', '--name', 'api'], { on_failed_check: 'rollback' }), /needs a health_check/);
  accepts(w(['versions', 'deploy', 'v1@100', '--name', 'api'], check));
  accepts(w(['pages', 'deploy', 'dist', '--project-name', 'site'], check));
});
