// Runs the ops of an approved account plan that contains wrangler ops: one op
// at a time, with the executor-only confirmation flags, inverse prechecks,
// health checks and automatic rollback. applyPlan does every refusal check
// (approval, account, source hash, secret env, paths) before calling in here.
// Secret values go to wrangler's stdin only and are redacted from its output.

import { CfError } from './errors.mjs';
import { failureMessage } from './wrangler.mjs';
import { parseWranglerOp } from './wrangler-ops.mjs';
import { inverseFor } from './snapshot.mjs';

const ACCOUNT_ID = /^[a-f0-9]{32}$/;
const R2_BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const KV_NAMESPACE_ID = /^[a-f0-9]{32}$/;
const TARGET_FLAGS = ['--config', '--env'];
const VERSION_EVENT_TYPES = new Set(['deploy', 'version-deploy', 'version-upload']);

function runOptions(plan) {
  return { cwd: plan.project_dir, token: process.env.CLOUDFLARE_API_TOKEN, accountId: plan.account_id };
}

function flagValue(parsed, name) {
  const value = parsed?.flags.get(name)?.[0];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function targetArgs(parsed) {
  const out = [];
  for (const name of TARGET_FLAGS) {
    for (const value of parsed.flags.get(name) ?? []) out.push(name, value);
  }
  return out;
}

// Flags the executor adds at run time; drafts never contain them.
export function executorArgs(op, planId) {
  const parsed = parseWranglerOp(op);
  if (parsed?.kind === 'worker_rollback') return [...op.args, '--yes', '--message', `claudeflare ${planId}`];
  if (parsed?.kind === 'resource_delete' && (parsed.type === 'kv' || parsed.type === 'd1')) return [...op.args, '-y'];
  if (parsed?.kind === 'r2_dev_url') return [...op.args, '--force'];
  return [...op.args];
}

// Emptiness probes. Each returns { empty: true | false | null, reason? };
// null means the API gives no reliable answer. API errors propagate.
//
// R2: GET /accounts/{account_id}/r2/buckets/{bucket_name}/objects?per_page=1.
// Jurisdiction buckets need the cf-r2-jurisdiction header, which the client
// does not send, so they are not verifiable.
async function r2Empty(client, accountId, name, jurisdiction) {
  if (jurisdiction) return { empty: null, reason: `R2 bucket ${name} is in jurisdiction ${jurisdiction}` };
  if (!R2_BUCKET_NAME.test(name)) return { empty: null, reason: `R2 bucket name ${JSON.stringify(name)} is not a valid bucket name` };
  const objects = await client.request('GET', `/accounts/${accountId}/r2/buckets/${name}/objects`, { query: { per_page: 1 } });
  if (!Array.isArray(objects)) return { empty: null, reason: `object list for R2 bucket ${name} was not a list` };
  return { empty: objects.length === 0 };
}

// KV: GET /accounts/{account_id}/storage/kv/namespaces/{namespace_id}/keys?limit=10 (API minimum).
async function kvEmpty(client, accountId, id) {
  if (!KV_NAMESPACE_ID.test(id)) return { empty: null, reason: `KV namespace id ${JSON.stringify(id)} is not a namespace id` };
  const keys = await client.request('GET', `/accounts/${accountId}/storage/kv/namespaces/${id}/keys`, { query: { limit: 10 } });
  if (!Array.isArray(keys)) return { empty: null, reason: `key list for KV namespace ${id} was not a list` };
  return { empty: keys.length === 0 };
}

async function probeEmpty(client, plan, parsed) {
  const accountId = plan.account_id;
  switch (parsed?.type) {
    case 'r2':
      return r2Empty(client, accountId, parsed.name, flagValue(parsed, '--jurisdiction'));
    case 'kv':
      return kvEmpty(client, accountId, parsed.name);
    case 'd1':
      return { empty: null, reason: `the API has no reliable emptiness signal for D1 database ${parsed.name} (num_tables is deprecated)` };
    case 'queue':
      return { empty: null, reason: `the API has no reliable emptiness signal for queue ${parsed.name}` };
    default:
      return { empty: null, reason: 'unknown resource type' };
  }
}

// `plan new` refuses R2 bucket deletes unless the bucket is verifiably empty.
export async function assertR2DeletesEmpty(client, plan) {
  if (typeof plan.account_id !== 'string' || !ACCOUNT_ID.test(plan.account_id)) {
    throw new CfError('invalid_account', `Invalid account id: ${JSON.stringify(plan.account_id)}`);
  }
  for (const op of plan.ops ?? []) {
    if (op?.kind !== 'wrangler') continue;
    const parsed = parseWranglerOp(op);
    if (parsed?.kind !== 'resource_delete' || parsed.type !== 'r2') continue;
    const { empty, reason } = await probeEmpty(client, plan, parsed);
    if (empty === true) continue;
    const why = empty === false ? `R2 bucket ${parsed.name} is not empty` : `Cannot verify that R2 bucket ${parsed.name} is empty (${reason})`;
    throw new CfError('resource_not_empty', why, { hint: 'Empty the bucket first, then create the plan again' });
  }
}

function skipped(notes, code, message) {
  notes.push(`${code}: ${message}`);
  return { skipped: code, message };
}

// precheck 'empty': delete only a resource that is verifiably empty.
async function checkEmpty(client, plan, op, notes) {
  const parsed = parseWranglerOp(op);
  let probe;
  try {
    probe = await probeEmpty(client, plan, parsed);
  } catch (err) {
    if (!(err instanceof CfError)) throw err;
    probe = { empty: null, reason: `emptiness check failed (${err.code})` };
  }
  if (probe.empty === true) return null;
  const what = `${parsed?.type ?? 'resource'} ${parsed?.name ?? ''}`.trim();
  const detail = probe.empty === false ? 'is not empty' : `cannot be verified as empty: ${probe.reason}`;
  return skipped(notes, 'rollback_not_empty', `Skipped wrangler ${op.args.join(' ')}: ${what} ${detail}; it was left in place`);
}

// precheck 'only_plan_versions': delete a Worker only while every version in
// its deployments is one this plan created.
async function checkOnlyPlanVersions(runner, plan, op, notes) {
  const parsed = parseWranglerOp(op);
  const expected = new Set(Array.isArray(op.expected_versions) ? op.expected_versions : []);
  const skip = (why) => skipped(notes, 'rollback_ambiguous', `Skipped wrangler ${op.args.join(' ')}: ${why}; the Worker was left in place`);
  if (!parsed?.name || expected.size === 0) return skip('no Worker name or expected versions');
  const result = await runner(['deployments', 'list', '--name', parsed.name, ...targetArgs(parsed), '--json'], runOptions(plan));
  if (result.code !== 0) return skip(`deployments list failed: ${failureMessage(result)}`);
  let deployments;
  try {
    deployments = JSON.parse(result.stdout);
  } catch {
    return skip('deployments list did not print JSON');
  }
  if (!Array.isArray(deployments)) return skip('deployments list did not return a list');
  const versions = deployments.flatMap((d) => (Array.isArray(d?.versions) ? d.versions : [null]));
  if (versions.length === 0) return skip(`Worker ${parsed.name} lists no deployed versions`);
  const foreign = versions.some((v) => typeof v?.version_id !== 'string' || !expected.has(v.version_id));
  return foreign ? skip(`Worker ${parsed.name} has versions this plan did not create`) : null;
}

function lastVersionId(events) {
  let id = null;
  for (const event of events) {
    if (VERSION_EVENT_TYPES.has(event?.type) && typeof event.version_id === 'string' && event.version_id) id = event.version_id;
  }
  return id;
}

// wrangler prefixes the title with "<env>-" and suffixes "_preview" (4.152
// kv namespace create); only that exact title is accepted, so an older
// namespace with the bare name is never mistaken for the new one.
function kvTitle(parsed) {
  const env = flagValue(parsed, '--env');
  const preview = parsed.flags.has('--preview') ? '_preview' : '';
  return `${env ? `${env}-` : ''}${parsed.name}${preview}`;
}

// `kv namespace list` always prints JSON (it has no --json flag).
async function findKvNamespaceId(runner, plan, parsed) {
  const result = await runner(['kv', 'namespace', 'list'], runOptions(plan));
  if (result.code !== 0) return null;
  let list;
  try {
    list = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const title = kvTitle(parsed);
  const matches = (Array.isArray(list) ? list : []).filter((ns) => ns?.title === title && typeof ns.id === 'string');
  return matches.length === 1 ? matches[0].id : null;
}

function secretValue(op) {
  if (parseWranglerOp(op)?.kind !== 'secret_put') return undefined;
  const value = process.env[op.value_from_env];
  if (typeof value !== 'string' || value === '') {
    throw new CfError('secret_env_missing', `Environment variable ${op.value_from_env} is not set`);
  }
  return value;
}

async function runWranglerOp(ctx, op) {
  const { client, plan, runner, notes } = ctx;
  if (op.precheck === 'empty') {
    const skip = await checkEmpty(client, plan, op, notes);
    if (skip) return skip;
  } else if (op.precheck === 'only_plan_versions') {
    const skip = await checkOnlyPlanVersions(runner, plan, op, notes);
    if (skip) return skip;
  } else if (op.precheck !== undefined) {
    throw new CfError('invalid_op', 'Unknown precheck on wrangler op');
  }
  const secret = secretValue(op);
  const opts = { ...runOptions(plan) };
  if (secret !== undefined) {
    opts.stdin = secret;
    opts.secrets = [secret];
  }
  const result = await runner(executorArgs(op, plan.id), opts);
  if (result.code !== 0) {
    throw new CfError('wrangler_failed', `wrangler ${op.args.slice(0, 2).join(' ')} failed: ${failureMessage(result)}`);
  }
  const events = Array.isArray(result.events) ? result.events : [];
  const out = { events };
  const versionId = lastVersionId(events);
  if (versionId) out.version_id = versionId;
  const previewUrl = events.findLast((e) => e?.type === 'version-upload')?.preview_url;
  if (typeof previewUrl === 'string' && previewUrl) out.preview_url = previewUrl;
  const parsed = parseWranglerOp(op);
  if (parsed?.kind === 'resource_create' && parsed.type === 'kv') {
    out.resource_id = await findKvNamespaceId(runner, plan, parsed);
    if (out.resource_id === null) {
      ctx.notes.push(`kv_id_unknown: the id of new KV namespace ${kvTitle(parsed)} could not be found; rollback cannot delete it`);
    }
  }
  return out;
}

async function runOp(ctx, op) {
  if (op?.kind === 'wrangler') return runWranglerOp(ctx, op);
  return (await ctx.client.request(op.method, op.path, { body: op.body })) ?? true;
}

function opError(index, err) {
  return { op_index: index, code: err?.code || 'internal', message: String(err?.message ?? err) };
}

// Runs the inverse of op `index` right away. Returns { ok, results?, message? }.
async function autoRollback(ctx, snapshot, index, result) {
  const entry = (snapshot?.entries ?? []).find((e) => e.op_index === index);
  let inverse;
  try {
    inverse = entry ? inverseFor(entry, result) : [];
  } catch (err) {
    // Ops already ran and the approval is consumed: record, never rethrow.
    return { ok: false, message: String(err?.message ?? err) };
  }
  if (!inverse.length) return { ok: false, message: 'the op has no inverse' };
  const results = [];
  for (const op of inverse) {
    try {
      results.push(await runOp(ctx, op));
    } catch (err) {
      return { ok: false, results, message: String(err?.message ?? err) };
    }
    if (results.at(-1)?.skipped) return { ok: false, results, message: results.at(-1).message };
  }
  return { ok: true, results };
}

function checkFailure(index, check, health) {
  const seen = health.status ?? 'no response';
  return {
    op_index: index,
    code: 'check_failed',
    message: `Health check failed: GET ${check.url} returned ${seen}${health.location ? ` (redirect to ${health.location}; redirects are not followed)` : ''} after ${health.attempts} attempt(s), expected ${check.expect_status ?? 200}`,
  };
}

// deps: { client, plan, runner, snapshot, healthCheck(check) -> { ok, status, attempts } }.
// Returns { status, results, error?, notes }. Op failures are recorded, not thrown.
export async function executeAccountOps({ client, plan, runner, snapshot, healthCheck }) {
  const ops = plan.ops ?? [];
  const results = ops.map(() => null);
  const notes = [];
  const ctx = { client, plan, runner, notes };
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    try {
      results[i] = await runOp(ctx, op);
    } catch (err) {
      return { status: i === 0 ? 'failed' : 'partially_applied', results, error: opError(i, err), notes };
    }
    if (op?.kind !== 'wrangler' || !op.health_check || results[i]?.skipped) continue;
    const health = await healthCheck(op.health_check);
    results[i] = { ...results[i], health_check: { ok: health.ok, status: health.status ?? null, attempts: health.attempts } };
    if (health.ok) continue;
    const error = checkFailure(i, op.health_check, health);
    if (op.on_failed_check !== 'rollback') return { status: 'applied_check_failed', results, error, notes };
    const auto = await autoRollback(ctx, snapshot, i, results[i]);
    if (!auto.ok) {
      results[i] = { ...results[i], auto_rollback: auto.results ?? [] };
      return { status: 'applied_check_failed', results, error: { ...error, rollback_error: auto.message }, notes };
    }
    results[i] = { ...results[i], auto_rolled_back: true, auto_rollback: auto.results };
    return { status: 'rolled_back_auto', results, error, notes };
  }
  return { status: 'applied', results, notes };
}
