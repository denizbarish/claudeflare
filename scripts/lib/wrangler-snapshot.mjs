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
// Title-cased Pages stage statuses of deployments that are not live. A
// finished successful deployment shows a relative time instead.
const PAGES_NOT_LIVE = new Set(['Idle', 'Active', 'Failure', 'Canceled', 'Skipped']);
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
  if (parsed.kind === 'pages_deploy') target.account_id = plan.account_id;
  return target;
}

async function readJson(runner, args, plan) {
  const command = `wrangler ${args.join(' ')}`;
  const result = await runner([...args, '--json'], {
    cwd: plan.project_dir,
    token: process.env.CLOUDFLARE_API_TOKEN,
    accountId: plan.account_id,
  });
  if (result.code !== 0) throw snapshotFailed(`Snapshot read failed (${command}): ${failureMessage(result)}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw snapshotFailed(`Snapshot read (${command}) did not print JSON`);
  }
}

// before = { deployment_id, versions: [{ version_id, percentage }] } of the
// active (latest) deployment; wrangler prints deployments oldest first.
async function readWorker(runner, target, plan) {
  const name = target.name ? ['--name', target.name] : [];
  const deployments = await readJson(runner, ['deployments', 'list', ...name, ...target.target_args], plan);
  if (!Array.isArray(deployments)) throw snapshotFailed('Snapshot read (wrangler deployments list) did not return a list');
  const active = deployments[deployments.length - 1];
  const versions = (Array.isArray(active?.versions) ? active.versions : []).map((v) => ({
    version_id: v?.version_id,
    percentage: v?.percentage,
  }));
  return { before: { deployment_id: active?.id ?? null, versions }, invertible: versions.length > 0 };
}

// before = { deployment_id } of the newest live production deployment.
async function readPages(runner, target, plan) {
  if (!target.name) throw snapshotFailed('pages deploy needs --project-name so its current production deployment can be snapshotted');
  const args = ['pages', 'deployment', 'list', '--project-name', target.name, '--environment', 'production'];
  const deployments = await readJson(runner, args, plan);
  if (!Array.isArray(deployments)) throw snapshotFailed('Snapshot read (wrangler pages deployment list) did not return a list');
  const live = deployments.find((d) => typeof d?.Id === 'string' && !PAGES_NOT_LIVE.has(d?.Status));
  const id = live?.Id ?? null;
  return { before: { deployment_id: id }, invertible: id !== null };
}

// before = { bookmark } current before the op.
async function readD1(runner, target, plan) {
  const info = await readJson(runner, ['d1', 'time-travel', 'info', target.name, ...target.target_args], plan);
  if (typeof info?.bookmark !== 'string' || !info.bookmark) {
    throw snapshotFailed(`Snapshot read (wrangler d1 time-travel info ${target.name}) returned no bookmark`);
  }
  return { before: { bookmark: info.bookmark }, invertible: true };
}

// `client` is the REST client, unused by the current readers (spec 3.6 reads
// go through wrangler). Read failures abort before any write.
export async function captureWranglerEntry(runner, client, op, plan) {
  const target = targetOf(op, plan);
  const { kind } = target;
  let state = { before: null, invertible: false };
  if (WORKER_KINDS.has(kind)) state = await readWorker(runner, target, plan);
  else if (kind === 'pages_deploy') state = await readPages(runner, target, plan);
  else if (D1_KINDS.has(kind)) state = await readD1(runner, target, plan);
  else if (kind === 'resource_create') state = { before: null, invertible: true };
  return { kind, before: state.before, invertible: state.invertible, target };
}

const wrangler = (args, extra = {}) => ({ kind: 'wrangler', args, ...extra });

function invertWorker({ before, target }) {
  const versions = before?.versions ?? [];
  if (versions.length === 0) return [];
  if (versions.length > 1) {
    const split = versions.map((v) => `${v.version_id}@${v.percentage}%`).join(', ');
    throw ambiguous(`Worker ${target.name ?? '(from wrangler config)'} was on a split deployment (${split}); rollback restores one version, use a versions deploy plan instead`);
  }
  const name = target.name ? ['--name', target.name] : [];
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
  return [wrangler(['d1', 'time-travel', 'restore', target.name, '--bookmark', before.bookmark, ...target.target_args])];
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
  if (WORKER_KINDS.has(entry.kind)) return invertWorker(entry);
  if (entry.kind === 'pages_deploy') return invertPages(entry);
  if (D1_KINDS.has(entry.kind)) return invertD1(entry);
  if (entry.kind === 'resource_create') return invertCreate(entry, result);
  return [];
}
