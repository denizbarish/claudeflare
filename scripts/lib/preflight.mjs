// Preflight for plan drafts: validates ops and, for account plans, checks
// wrangler, account access, config bindings, a dry-run build, pending D1
// migrations and the source hash. Writes nothing to Cloudflare, but the
// dry-run runs the project's own build locally. `plan new` runs the same
// checks and stores the returned ops (with source_hash, source_paths and
// pending_migrations embedded) in the plan.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CfError } from './errors.mjs';
import { validateOpTargets, validatePlanOps } from './resources.mjs';
import { assertAccountAccess } from './apply.mjs';
import { computeSourceHash } from './source-hash.mjs';
import { assertWranglerVersion, failureMessage, runWrangler } from './wrangler.mjs';
import { applyEnv, configBindings, readWranglerConfig } from './wrangler-config.mjs';
import { parseWranglerOp, SOURCE_KINDS } from './wrangler-ops.mjs';

const KV_ID = /^[0-9a-f]{32}$/;
const D1_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SQL_CHARS = 4000;

function errorText(err) {
  if (err instanceof CfError) return `${err.code}: ${err.message}`;
  throw err;
}

// Plan new recomputes these; a draft never supplies them.
function stripComputed(op) {
  if (op?.kind !== 'wrangler') return op;
  const { source_hash: _hash, source_paths: _paths, pending_migrations: _pending, ...rest } = op;
  return rest;
}

async function exists(client, path, query) {
  try {
    await client.request('GET', path, query ? { query } : undefined);
    return true;
  } catch (err) {
    if (err instanceof CfError && err.code === 'not_found') return false;
    throw err;
  }
}

function createdInDraft(ops) {
  const created = new Set();
  for (const op of ops) {
    const parsed = op?.kind === 'wrangler' ? parseWranglerOp(op) : null;
    if (parsed?.kind === 'resource_create' && parsed.name) created.add(`${parsed.type}:${parsed.name}`);
  }
  return created;
}

// Returns a list of problems; resources created earlier in the same draft
// are skipped (KV bindings entirely, since a new namespace id is unknown).
async function bindingProblems(client, accountId, config, ops) {
  const base = `/accounts/${accountId}`;
  const created = createdInDraft(ops);
  const kvCreated = [...created].some((key) => key.startsWith('kv:'));
  const { kv, r2, d1, queue } = configBindings(config);
  const problems = [];
  if (!kvCreated) {
    for (const b of kv) {
      if (!b.id || !KV_ID.test(b.id)) problems.push(`KV binding ${b.binding} has no valid namespace id`);
      else if (!(await exists(client, `${base}/storage/kv/namespaces/${b.id}`))) problems.push(`KV namespace ${b.id} (binding ${b.binding}) does not exist`);
    }
  }
  for (const b of r2) {
    if (!b.name) problems.push(`R2 binding ${b.binding} has no bucket_name`);
    else if (!created.has(`r2:${b.name}`) && !(await exists(client, `${base}/r2/buckets/${encodeURIComponent(b.name)}`))) {
      problems.push(`R2 bucket ${b.name} (binding ${b.binding}) does not exist`);
    }
  }
  for (const b of d1) {
    if (b.name && created.has(`d1:${b.name}`)) continue;
    if (b.id && D1_UUID.test(b.id)) {
      if (!(await exists(client, `${base}/d1/database/${b.id}`))) problems.push(`D1 database ${b.id} (binding ${b.binding}) does not exist`);
    } else if (b.name) {
      const list = await client.request('GET', `${base}/d1/database`, { query: { name: b.name } });
      if (!(Array.isArray(list) ? list : []).some((db) => db?.name === b.name)) problems.push(`D1 database ${b.name} (binding ${b.binding}) does not exist`);
    } else {
      problems.push(`D1 binding ${b.binding} has neither database_id nor database_name`);
    }
  }
  const queueNames = queue.filter((b) => b.name && !created.has(`queue:${b.name}`));
  if (queueNames.length) {
    const list = await client.request('GET', `${base}/queues`);
    const names = new Set((Array.isArray(list) ? list : []).map((q) => q?.queue_name));
    for (const b of queueNames) if (!names.has(b.name)) problems.push(`Queue ${b.name} (binding ${b.binding}) does not exist`);
  }
  for (const b of queue) if (!b.name) problems.push(`Queue binding ${b.binding} has no queue name`);
  return problems;
}

function insideRel(projectDir, path) {
  const rel = relative(projectDir, resolve(projectDir, path));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CfError('invalid_input', `deploy input is outside the project directory: ${path}`);
  }
  return rel.split(sep).join('/');
}

function d1Entry(config, name) {
  return configBindings(config).d1.find((b) => b.name === name || b.binding === name);
}

// Files an op uploads beyond the tracked source: config, entry point, assets,
// Pages output and D1 migrations. Hashed even when gitignored.
export function deployInputs(projectDir, configFile, config, op) {
  const parsed = parseWranglerOp(op);
  const flag = (name) => parsed.flags.get(name)?.[0];
  const candidates = configFile ? [configFile] : [];
  if (parsed.kind === 'worker_deploy') {
    candidates.push(parsed.positionals[0] ?? config.main, flag('--assets') ?? config.assets?.directory, flag('--site') ?? config.site?.bucket);
  } else if (parsed.kind === 'pages_deploy') {
    candidates.push(parsed.positionals[0] ?? config.pages_build_output_dir);
  } else if (parsed.kind === 'd1_migrations_apply') {
    candidates.push(d1Entry(config, parsed.name)?.migrations_dir ?? 'migrations');
  }
  // Inputs that do not exist yet are hashed as missing, so one that appears
  // before apply changes the hash.
  const rels = candidates.filter((p) => typeof p === 'string' && p).map((p) => insideRel(projectDir, p));
  return [...new Set(rels)].sort();
}

const targetFlags = (parsed) => ['--config', '--env'].flatMap((name) => (parsed.flags.get(name) ?? []).flatMap((v) => [name, v]));

// Config the op's wrangler run sees: its --config file (or the default one)
// with its --env section applied.
export function opConfig(projectDir, op) {
  const parsed = parseWranglerOp(op);
  const configFlag = parsed.flags.get('--config')?.[0];
  const { file, config } = readWranglerConfig(projectDir, configFlag === undefined ? undefined : insideRel(projectDir, configFlag));
  return { file, config: applyEnv(config, parsed.flags.get('--env')?.[0], file) };
}

async function dryRun(runner, projectDir, op) {
  const outdir = mkdtempSync(join(tmpdir(), 'claudeflare-dry-run-'));
  try {
    const result = await runner([...op.args, '--dry-run', '--outdir', outdir], { cwd: projectDir });
    if (result.code !== 0) return { ok: false, detail: `dry-run build failed: ${failureMessage(result)}` };
    const size = /Total Upload:\s*([^\n]+)/.exec(`${result.stdout}\n${result.stderr}`)?.[1]?.trim();
    return { ok: true, detail: size ? `dry-run build passed (${size})` : 'dry-run build passed', size };
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

function readSql(dir, name) {
  try {
    const sql = readFileSync(join(dir, name), 'utf8');
    return sql.length > MAX_SQL_CHARS ? { name, sql: sql.slice(0, MAX_SQL_CHARS), truncated: true } : { name, sql };
  } catch {
    return { name, sql: null };
  }
}

// A database created earlier in the same draft has every local migration
// pending; otherwise `d1 migrations list --remote` names them.
async function pendingMigrations(runner, target, config, op, created) {
  const parsed = parseWranglerOp(op);
  const dir = join(target.project_dir, d1Entry(config, parsed.name)?.migrations_dir ?? 'migrations');
  let names;
  // The op may name the binding; creates name the database.
  const database = d1Entry(config, parsed.name)?.name ?? parsed.name;
  if (created.has(`d1:${database}`)) {
    try {
      names = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    } catch {
      names = [];
    }
  } else {
    const result = await runner(['d1', 'migrations', 'list', parsed.name, '--remote', ...targetFlags(parsed)], {
      cwd: target.project_dir,
      token: process.env.CLOUDFLARE_API_TOKEN,
      accountId: target.account_id,
    });
    if (result.code !== 0) throw new CfError('wrangler_failed', `d1 migrations list failed: ${failureMessage(result)}`);
    names = [...new Set(result.stdout.match(/[\w.-]+\.sql\b/g) ?? [])];
  }
  return { database: parsed.name, files: names.map((name) => readSql(dir, name)) };
}

// target: { scope, zone_id } or { scope: 'account', account_id, project_dir }.
// ops: draft ops with {zone_id} already resolved.
export async function runPreflight(target, draftOps, { client, runner = runWrangler } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const result = { ok: false, checks };
  const ops = (draftOps ?? []).map(stripComputed);
  try {
    validateOpTargets(ops, target);
    validatePlanOps(ops);
    add('ops', true, `${ops.length} op(s) valid`);
  } catch (err) {
    add('ops', false, errorText(err));
    return result;
  }
  if (target.scope !== 'account') {
    result.ok = true;
    result.ops = ops;
    return result;
  }

  const wranglerOps = ops.filter((op) => op?.kind === 'wrangler');
  if (wranglerOps.length) {
    try {
      add('wrangler', true, `wrangler ${await assertWranglerVersion(target.project_dir, { runner })}`);
    } catch (err) {
      add('wrangler', false, errorText(err));
      return result;
    }
  }
  try {
    await assertAccountAccess(client, target);
    add('account', true, `token can read account ${target.account_id}`);
  } catch (err) {
    add('account', false, errorText(err));
  }

  const sourceOps = wranglerOps.filter((op) => SOURCE_KINDS.has(parseWranglerOp(op).kind));
  if (!sourceOps.length) {
    result.ok = checks.every((c) => c.ok);
    result.ops = ops;
    return result;
  }
  const configs = new Map();
  try {
    for (const op of sourceOps) {
      const loaded = opConfig(target.project_dir, op);
      configs.set(op, loaded);
    }
    const files = [...new Set([...configs.values()].map((c) => c.file ?? 'no wrangler config file'))];
    add('config', true, `read ${files.join(', ')}`);
  } catch (err) {
    add('config', false, errorText(err));
    return result;
  }

  const created = createdInDraft(ops);
  const deploys = sourceOps.filter((op) => parseWranglerOp(op).kind === 'worker_deploy');
  for (const op of deploys) {
    try {
      const problems = await bindingProblems(client, target.account_id, configs.get(op).config, ops);
      add('bindings', problems.length === 0, problems.length ? problems.join('; ') : 'all bindings exist');
    } catch (err) {
      add('bindings', false, `could not verify bindings: ${errorText(err)}`);
    }
    const built = await dryRun(runner, target.project_dir, op);
    add('build', built.ok, built.detail);
    if (built.size) result.upload_size = built.size;
  }

  const pending = new Map();
  for (const op of sourceOps.filter((o) => parseWranglerOp(o).kind === 'd1_migrations_apply')) {
    try {
      const entry = await pendingMigrations(runner, target, configs.get(op).config, op, created);
      pending.set(op, entry);
      const names = entry.files.map((f) => f.name);
      add('migrations', true, names.length ? `pending on ${entry.database}: ${names.join(', ')}` : `no pending migrations on ${entry.database}`);
    } catch (err) {
      add('migrations', false, errorText(err));
    }
  }
  if (pending.size) result.pending_migrations = [...pending.values()];

  // Hashed after the dry-run, so build output it writes into the project is included.
  const hashes = new Set();
  try {
    result.ops = ops.map((op) => {
      if (!configs.has(op)) return op;
      const { file, config } = configs.get(op);
      const extraPaths = deployInputs(target.project_dir, file, config, op);
      const hash = computeSourceHash(target.project_dir, { extraPaths });
      hashes.add(hash);
      const out = { ...op, source_hash: hash, source_paths: extraPaths };
      if (pending.has(op)) out.pending_migrations = pending.get(op).files;
      return out;
    });
    add('source', true, [...hashes].join(', '));
    if (hashes.size === 1) result.source_hash = [...hashes][0];
  } catch (err) {
    delete result.ops;
    add('source', false, errorText(err));
  }
  result.ok = checks.every((c) => c.ok);
  return result;
}

// Risk line naming the pending migrations a plan will apply.
export function migrationRisk(pending = []) {
  const lines = pending
    .filter((p) => p.files.length)
    .map((p) => `Pending migrations on ${p.database}: ${p.files.map((f) => f.name).join(', ')}.`);
  return lines.join(' ');
}
