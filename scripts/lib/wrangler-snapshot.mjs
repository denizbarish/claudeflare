// Snapshots and inverses for `wrangler` plan ops (spec 3.6). Before apply runs
// an op, captureWranglerEntry records what is needed to undo it; at rollback
// inverseForWrangler turns that entry plus the op's apply result
// ({ version_id?, resource_id?, events }) into canonical draft ops. Inverse
// wrangler ops never carry --yes or --message: the executor adds them.

import { failureMessage } from './wrangler.mjs';
import { parseWranglerOp } from './wrangler-ops.mjs';
import { CfError } from './errors.mjs';

// Flags that select which Worker or database a command targets; they carry
// over from the op to its snapshot read and its inverse.
const TARGET_FLAGS = ['--config', '--env'];
// Cloudflare API code for a Worker that does not exist yet; matched only as
// the error code, never by wording.
const WORKER_NOT_FOUND = /\b10007\b/;
const WORKER_KINDS = new Set(['worker_deploy', 'worker_versions_deploy', 'worker_rollback']);
const D1_KINDS = new Set(['d1_migrations_apply', 'd1_restore']);

function snapshotFailed(message) {
  return new CfError('snapshot_failed', message);
}

function ambiguous(message) {
  return new CfError('rollback_ambiguous', message);
}

function flagArgs(flags, names) {
  const out = [];
  for (const name of names) {
    for (const value of flags.get(name) ?? []) out.push(name, value);
  }
  return out;
}

function targetOf(op, plan) {
  const parsed = parseWranglerOp(op);
  if (!parsed) return { kind: 'unknown' };
  const target = { kind: parsed.kind, type: parsed.type, target_args: flagArgs(parsed.flags, TARGET_FLAGS) };
  if (parsed.name) target.name = parsed.name;
  const jurisdiction = parsed.flags.get('--jurisdiction')?.[0];
  if (typeof jurisdiction === 'string' && jurisdiction) target.jurisdiction = jurisdiction;
  if (parsed.kind === 'pages_deploy') {
    target.account_id = plan.account_id;
    const branch = parsed.flags.get('--branch')?.[0];
    if (typeof branch === 'string' && branch) target.branch = branch;
  }
  return target;
}

// Key shared by a create and later ops on the same resource.
function resourceKey(target) {
  return target.name ? `${target.type} ${target.name}` : null;
}

function notInvertible(before, reason) {
  return { before, invertible: false, reason };
}

// Returns the parsed JSON, or calls onFailure(message) for a non-zero exit
// (it may return a value; otherwise the read aborts with snapshot_failed).
async function readJson(runner, args, plan, onFailure = () => undefined) {
  const command = `wrangler ${args.join(' ')}`;
  const result = await runner([...args, '--json'], {
    cwd: plan.project_dir,
    token: process.env.CLOUDFLARE_API_TOKEN,
    accountId: plan.account_id,
  });
  if (result.code !== 0) {
    const message = failureMessage(result);
    const handled = onFailure(message);
    if (handled !== undefined) return handled;
    throw snapshotFailed(`Snapshot read failed (${command}): ${message}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw snapshotFailed(`Snapshot read (${command}) did not print JSON`);
  }
}

const NO_WORKER = Symbol('no worker');

// before = { deployment_id, versions: [{ version_id, percentage }] } of the
// active deployment (latest created_on), or { exists: false } for a Worker
// that does not exist yet (the inverse deletes it).
async function readWorker(runner, target, plan) {
  const deployments = await readJson(runner, ['deployments', 'list', '--name', target.name, ...target.target_args], plan, (message) =>
    WORKER_NOT_FOUND.test(message) ? NO_WORKER : undefined,
  );
  if (deployments === NO_WORKER) return { before: { exists: false }, invertible: true };
  if (!Array.isArray(deployments)) throw snapshotFailed('Snapshot read (wrangler deployments list) did not return a list');
  let active = null;
  for (const deployment of deployments) {
    if (!active || String(deployment?.created_on ?? '') > String(active.created_on ?? '')) active = deployment;
  }
  const versions = (Array.isArray(active?.versions) ? active.versions : []).map((v) => {
    if (typeof v?.version_id !== 'string' || !v.version_id) {
      throw snapshotFailed('Snapshot read (wrangler deployments list) returned a version without a version_id');
    }
    return { version_id: v.version_id, percentage: v.percentage };
  });
  if (versions.length > 1 && !versions.every((v) => typeof v.percentage === 'number')) {
    throw snapshotFailed('Snapshot read (wrangler deployments list) returned a split deployment without percentages');
  }
  return { before: { deployment_id: active?.id ?? null, versions }, invertible: versions.length > 0 };
}

// before = { deployment_id, production_branch } from the project's canonical
// (live production) deployment.
async function readPages(client, target) {
  if (!target.name) throw snapshotFailed('pages deploy needs --project-name so its current production deployment can be snapshotted');
  let project;
  try {
    project = await client.request('GET', `/accounts/${target.account_id}/pages/projects/${target.name}`);
  } catch (err) {
    if (err instanceof CfError && err.code === 'not_found') return notInvertible({ exists: false }, 'project created by this deploy');
    throw err;
  }
  const productionBranch = project?.production_branch ?? null;
  const id = project?.canonical_deployment?.id;
  const before = { deployment_id: typeof id === 'string' && id ? id : null, production_branch: productionBranch };
  if (target.branch && target.branch !== productionBranch) return notInvertible(before, 'preview deployment');
  if (!before.deployment_id) return notInvertible(before, 'no production deployment yet');
  return { before, invertible: true };
}

// before = { bookmark } current before the op.
async function readD1(runner, target, plan) {
  const info = await readJson(runner, ['d1', 'time-travel', 'info', target.name, ...target.target_args], plan);
  if (typeof info?.bookmark !== 'string' || !info.bookmark) {
    throw snapshotFailed(`Snapshot read (wrangler d1 time-travel info ${target.name}) returned no bookmark`);
  }
  return { before: { bookmark: info.bookmark }, invertible: true };
}

// `client` is the REST client (Pages project read). options.created holds
// resourceKey()s created by earlier ops of the same plan: those resources do
// not exist yet, so nothing is read and the create's delete covers rollback.
// Read failures abort before any write.
export async function captureWranglerEntry(runner, client, op, plan, { created = new Set() } = {}) {
  const target = targetOf(op, plan);
  const { kind } = target;
  let state = { before: null, invertible: false };
  const key = resourceKey(target);
  if (kind === 'resource_create') state = { before: null, invertible: true };
  else if (key && created.has(key)) state = notInvertible({ exists: false }, 'created earlier in this plan');
  else if (WORKER_KINDS.has(kind)) state = await readWorker(runner, target, plan);
  else if (kind === 'pages_deploy') state = await readPages(client, target);
  else if (D1_KINDS.has(kind)) state = await readD1(runner, target, plan);
  const entry = { kind, before: state.before, invertible: state.invertible, target };
  if (state.reason) entry.reason = state.reason;
  return entry;
}

// Records the resource an entry creates, for captureWranglerEntry's options.
export function noteCreated(created, entry) {
  const key = entry.kind === 'resource_create' ? resourceKey(entry.target) : null;
  if (key) created.add(key);
}

const wrangler = (args, extra = {}) => ({ kind: 'wrangler', args, ...extra });

// A new Worker is deleted, but only while its deployments hold nothing but
// the version this plan created (precheck run by the executor); a single
// version is rolled back to; a split deployment is restored with
// `versions deploy <id>@<pct>% ...`. Deploy ops always carry --name.
function invertWorker({ before, target }, result) {
  if (before?.exists === false) {
    const versionId = result?.version_id;
    if (typeof versionId !== 'string' || !versionId) {
      throw ambiguous(`No version id in apply result for the first deploy of Worker ${target.name}`);
    }
    return [
      wrangler(['delete', '--name', target.name, ...target.target_args], {
        confirm_name: target.name,
        precheck: 'only_plan_versions',
        expected_versions: [versionId],
      }),
    ];
  }
  const versions = before?.versions ?? [];
  if (versions.length === 0) return [];
  const name = ['--name', target.name];
  if (versions.length > 1) {
    const specs = versions.map((v) => `${v.version_id}@${v.percentage}%`);
    return [wrangler(['versions', 'deploy', ...specs, ...name, ...target.target_args])];
  }
  return [wrangler(['rollback', versions[0].version_id, ...name, ...target.target_args])];
}

function invertPages({ before, target }) {
  if (!before?.deployment_id) return [];
  return [
    {
      method: 'POST',
      path: `/accounts/${target.account_id}/pages/projects/${target.name}/deployments/${before.deployment_id}/rollback`,
    },
  ];
}

function invertD1({ before, target }) {
  return [wrangler(['d1', 'time-travel', 'restore', target.name, '--bookmark', before.bookmark, '--json', ...target.target_args])];
}

// precheck 'empty': the executor deletes only if the resource is still empty.
function invertCreate({ target }, result) {
  const deleteOp = (args, name) => [wrangler([...args, ...target.target_args], { confirm_name: name, precheck: 'empty' })];
  switch (target.type) {
    case 'd1':
      return deleteOp(['d1', 'delete', target.name], target.name);
    case 'r2': {
      const jurisdiction = target.jurisdiction ? ['--jurisdiction', target.jurisdiction] : [];
      return deleteOp(['r2', 'bucket', 'delete', target.name, ...jurisdiction], target.name);
    }
    case 'queue':
      return deleteOp(['queues', 'delete', target.name], target.name);
    case 'kv': {
      const id = result?.resource_id;
      if (typeof id !== 'string' || !id) throw ambiguous(`No namespace id in apply result for kv namespace create ${target.name}`);
      return deleteOp(['kv', 'namespace', 'delete', '--namespace-id', id], id);
    }
    default:
      throw ambiguous(`No inverse for creating a ${target.type} resource`);
  }
}

export function inverseForWrangler(entry, result) {
  if (!entry.invertible) return [];
  if (WORKER_KINDS.has(entry.kind)) return invertWorker(entry, result);
  if (entry.kind === 'pages_deploy') return invertPages(entry);
  if (D1_KINDS.has(entry.kind)) return invertD1(entry);
  if (entry.kind === 'resource_create') return invertCreate(entry, result);
  return [];
}
