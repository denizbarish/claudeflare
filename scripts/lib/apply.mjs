// Executes approved plans and builds rollback plans. This is the only module
// that sends write requests to Cloudflare.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CfError } from './errors.mjs';
import { paths } from './paths.mjs';
import { createPlan, planStateName, readPlan, slugify, updatePlan } from './plans.mjs';
import { checkApproval, consumeApproval } from './approvals.mjs';
import { classify, validateOpTargets, validatePlanOps } from './resources.mjs';
import { buildRollbackOps, captureSnapshot } from './snapshot.mjs';
import { classifyProductOp } from './products/index.mjs';
import { assertWranglerOpPaths, classifyWranglerOp, DATA_LOSS_TYPES, SOURCE_KINDS } from './wrangler-ops.mjs';
import { assertWranglerVersion, runWrangler } from './wrangler.mjs';
import { computeSourceHash } from './source-hash.mjs';
import { executeAccountOps } from './wrangler-exec.mjs';
import { assertSecretFieldsEnv, executeRestOps } from './rest-exec.mjs';
import { runHealthCheck } from './health-check.mjs';

// Plans whose applied ops may still be reverted by a rollback plan. After an
// automatic rollback the earlier ops of the plan are still applied.
const ROLLBACK_SOURCE_STATUSES = new Set(['applied', 'partially_applied', 'applied_check_failed', 'rolled_back_auto']);

export function snapshotFile(cwd, plan) {
  return join(paths(cwd).snapshots(planStateName(plan)), `${plan.id}.json`);
}

export function previewSnapshotFile(cwd, plan) {
  return join(paths(cwd).snapshots(planStateName(plan)), `${plan.id}.preview.json`);
}

function writeJson(file, value, flag) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag });
}

// The apply snapshot is the rollback baseline: it is written once, never replaced.
function writeApplySnapshot(cwd, plan, snapshot) {
  const file = snapshotFile(cwd, plan);
  mkdirSync(paths(cwd).snapshots(planStateName(plan)), { recursive: true });
  try {
    writeJson(file, snapshot, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') throw new CfError('snapshot_exists', `Snapshot already exists for plan ${plan.id}`);
    throw err;
  }
  return file;
}

// Preview snapshots (claudeflare snapshot) are for draft plans and never touch
// the apply snapshot.
export function writePreviewSnapshot(cwd, plan, snapshot) {
  const file = previewSnapshotFile(cwd, plan);
  mkdirSync(paths(cwd).snapshots(planStateName(plan)), { recursive: true });
  writeJson(file, snapshot);
  return file;
}

export function assertDraft(plan) {
  if (plan.status !== 'draft') {
    throw new CfError('not_draft', `Plan ${plan.id} has status ${plan.status}; only draft plans can be applied or snapshotted`, {
      hint: 'Create a new plan for further changes',
    });
  }
}

function wranglerRiskLines(op) {
  const { kind, invertible, resource } = classifyWranglerOp(op);
  if (invertible) return [];
  const lines = [`Not reversible: wrangler ${op.args.join(' ')}`];
  if (kind !== 'resource_delete') return lines;
  // Rollback deletes of created resources: the executor checks emptiness first.
  if (op.precheck === 'empty') {
    lines.push(['d1', 'queue'].includes(resource?.type)
      ? `Not deleted automatically: ${resource.type} ${resource.name} cannot be verified as empty; delete it by hand if it holds nothing.`
      : `Deleted only if ${resource?.type} ${resource?.name} is still empty; otherwise it is skipped.`);
  } else if (DATA_LOSS_TYPES.has(resource?.type)) {
    lines.push(`Data loss: ${resource.type} ${resource.name} and all its contents are deleted permanently.`);
  }
  return lines;
}

// Appends one "Not reversible" line per op that rollback cannot undo, plus a
// "Data loss" line for KV, Queue and D1 deletes. With the plan (or its
// target), product ops are classified by their kind and the kinds' notes
// lines follow the "Not reversible" lines. Without it, product ops are
// unknown and therefore not reversible, as in 0.2.x.
export function withIrreversibleRisk(risk, ops, plan) {
  const notes = [];
  const lines = ops.flatMap((op) => {
    if (op?.kind === 'wrangler') return wranglerRiskLines(op);
    const product = plan ? classifyProductOp(op, plan) : null;
    if (product) {
      notes.push(...(product.entry.notes?.({}, op) ?? []));
      return product.entry.inverse === 'none' ? [`Not reversible: ${op.method} ${op.path}`] : [];
    }
    return classify(op).invertible ? [] : [`Not reversible: ${op.method} ${op.path}`];
  });
  return [risk, ...lines, ...notes].filter((line) => typeof line === 'string' && line !== '').join('\n');
}

function assertApproved(cwd, plan, now) {
  const id = plan.id;
  let check;
  try {
    check = checkApproval(cwd, id, now, { plan });
  } catch (err) {
    check = { ok: false, reason: err?.code || 'error' };
  }
  if (!check.ok) {
    throw new CfError('not_approved', `Plan ${id} is not approved (${check.reason})`, {
      hint: `Ask the user to run /claudeflare:approve ${id}`,
    });
  }
}

function consumeQuietly(cwd, id) {
  try {
    consumeApproval(cwd, id);
  } catch {
    // The outcome must still be recorded; a leftover approval cannot re-apply
    // because the plan is no longer a draft afterwards.
  }
}

// A rollback plan is only valid while its source is still applied or partially
// applied; once another rollback ran, its inverse ops are stale.
function assertRollbackSourceCurrent(cwd, plan) {
  let source = null;
  try {
    source = readPlan(cwd, plan.rollback_of);
  } catch (err) {
    if (!(err instanceof CfError)) throw err;
  }
  if (!source || !ROLLBACK_SOURCE_STATUSES.has(source.status)) {
    throw new CfError('rollback_stale', `Rollback plan ${plan.id} is stale: source plan ${plan.rollback_of} has status ${source?.status ?? 'missing'}`, {
      hint: 'Read the current state and create a fresh plan if a change is still needed',
    });
  }
}

function hasWranglerOps(plan) {
  return (plan.ops ?? []).some((op) => op?.kind === 'wrangler');
}

// Ends the v1 flow and the wrangler flow alike: records the outcome and marks
// the source of a fully applied rollback plan as rolled back.
function recordOutcome(cwd, plan, outcome, file, now, extra = {}) {
  const patch = {
    status: outcome.status,
    results: outcome.results,
    snapshot_file: file,
    applied_at: now.toISOString(),
    error: outcome.error ?? null,
    ...extra,
  };
  const updated = updatePlan(cwd, plan.id, patch);
  if (outcome.status === 'applied' && plan.rollback_of) {
    updatePlan(cwd, plan.rollback_of, { status: 'rolled_back' });
  }
  return updated;
}

// The token must be able to read the plan's account: GET /accounts/{account_id}.
export async function assertAccountAccess(client, plan) {
  let account;
  try {
    account = await client.request('GET', `/accounts/${plan.account_id}`);
  } catch (err) {
    if (err instanceof CfError && (err.code === 'permission' || err.code === 'not_found')) {
      throw new CfError('account_mismatch', `The API token cannot access account ${plan.account_id} (${err.code})`, {
        hint: 'Use a token for the account the plan was made for',
      });
    }
    throw err;
  }
  if (account?.id !== plan.account_id) {
    throw new CfError('account_mismatch', `The API returned account ${account?.id ?? 'without an id'} for plan account ${plan.account_id}`);
  }
}

function assertSourceUnchanged(plan) {
  for (const [index, op] of (plan.ops ?? []).entries()) {
    if (op?.kind !== 'wrangler') continue;
    if (op.source_hash === undefined) {
      if (!SOURCE_KINDS.has(classifyWranglerOp(op).kind)) continue;
      throw new CfError('source_hash_missing', `Op ${index} (wrangler ${op.args.slice(0, 2).join(' ')}) uploads project files but carries no source_hash`, {
        hint: 'Create the plan with claudeflare plan new so the source hash is embedded, then approve it again',
      });
    }
    const extraPaths = op.source_paths ?? [];
    if (!Array.isArray(extraPaths) || !extraPaths.every((p) => typeof p === 'string')) {
      throw new CfError('invalid_op', `Op ${index} (wrangler) source_paths must be an array of strings`);
    }
    const current = computeSourceHash(plan.project_dir, { extraPaths });
    if (current !== op.source_hash) {
      throw new CfError('source_changed', `Op ${index}: the project source changed after the plan was approved`, {
        hint: 'Create and approve a new plan for the current source',
      });
    }
  }
}

function assertSecretEnv(plan) {
  for (const op of plan.ops ?? []) {
    if (op?.kind !== 'wrangler' || op.value_from_env === undefined) continue;
    const value = process.env[op.value_from_env];
    if (typeof value !== 'string' || value === '') {
      throw new CfError('secret_env_missing', `Environment variable ${op.value_from_env} is not set`, {
        hint: `Ask the user to export ${op.value_from_env} in the shell that runs claudeflare apply`,
      });
    }
  }
}

// Account plans with wrangler ops. Every refusal happens before the snapshot,
// so a refused apply keeps its approval and runs nothing.
async function applyWranglerPlan(cwd, client, plan, now, { runner, sleep, fetchImpl }) {
  if (plan.rollback_of) assertRollbackSourceCurrent(cwd, plan);
  validateOpTargets(plan.ops, plan);
  if (!plan.rollback_of) validatePlanOps(plan.ops, plan);
  assertApproved(cwd, plan, now);
  await assertWranglerVersion(plan.project_dir, { runner });
  await assertAccountAccess(client, plan);
  assertSourceUnchanged(plan);
  assertSecretEnv(plan);
  for (const op of plan.ops) {
    if (op?.kind === 'wrangler') assertWranglerOpPaths(op, plan);
  }
  const snapshot = await captureSnapshot(client, plan, { runner });
  const file = writeApplySnapshot(cwd, plan, snapshot);

  consumeQuietly(cwd, plan.id);
  const healthCheck = (check) => runHealthCheck(check, { fetchImpl, sleep });
  const outcome = await executeAccountOps({ client, plan, runner, snapshot, healthCheck });
  const extra = outcome.notes.length ? { risk_notes: [...(plan.risk_notes ?? []), ...outcome.notes] } : {};
  return recordOutcome(cwd, plan, outcome, file, now, extra);
}

// The plan is read exactly once; that object is approval-checked and executed.
// deps.runner runs wrangler, deps.fetchImpl and deps.sleep drive health checks,
// deps.env supplies secret_fields_from_env values.
export async function applyPlan(cwd, client, id, now = new Date(), { runner = runWrangler, sleep, fetchImpl, env = process.env } = {}) {
  const plan = readPlan(cwd, id);
  assertDraft(plan);
  if (hasWranglerOps(plan)) return applyWranglerPlan(cwd, client, plan, now, { runner, sleep, fetchImpl });
  if (plan.rollback_of) {
    assertRollbackSourceCurrent(cwd, plan);
  } else {
    validateOpTargets(plan.ops, plan);
    validatePlanOps(plan.ops, plan);
  }
  assertApproved(cwd, plan, now);
  // A missing secret env var refuses before any request, keeping the approval.
  assertSecretFieldsEnv(plan, env);
  // Snapshot failures abort before any write and keep the approval.
  const snapshot = await captureSnapshot(client, plan);
  const file = writeApplySnapshot(cwd, plan, snapshot);

  // Consumed before the first write so the approval cannot be reused mid-run.
  // executeRestOps records op failures instead of throwing. Its `post` states
  // are not part of the plan record.
  consumeQuietly(cwd, id);
  const outcome = await executeRestOps({ client, plan, cwd, env });
  return recordOutcome(cwd, plan, outcome, file, now);
}

function readSnapshot(cwd, plan) {
  try {
    return JSON.parse(readFileSync(snapshotFile(cwd, plan), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new CfError('snapshot_missing', `No snapshot found for plan ${plan.id}`);
    }
    throw err;
  }
}

export function createRollbackPlan(cwd, id, now = new Date()) {
  const plan = readPlan(cwd, id);
  if (!ROLLBACK_SOURCE_STATUSES.has(plan.status)) {
    throw new CfError('not_applied', `Plan ${id} has status ${plan.status}; only plans with applied ops can be rolled back`);
  }
  // Ops that were rolled back automatically or skipped are not applied.
  const results = (plan.results ?? []).map((r) => (r?.auto_rolled_back || r?.skipped ? null : r));
  const unresolved = [];
  const ops = buildRollbackOps(readSnapshot(cwd, plan), results, { unresolved });
  if (!ops.length) {
    const why = unresolved.length ? ` (${unresolved.join('; ')})` : '';
    throw new CfError('nothing_to_rollback', `Plan ${id} has no applied ops that can be reversed${why}`);
  }
  const notes = unresolved.map((reason) => `Not rolled back: ${reason}`);
  const slug = slugify(`rollback-${plan.slug || 'plan'}`);
  const target = plan.scope === 'account'
    ? { scope: 'account', account_id: plan.account_id, account_name: plan.account_name, project_dir: plan.project_dir }
    : { zone_id: plan.zone_id, zone_name: plan.zone_name };
  const created = createPlan(
    cwd,
    {
      ...target,
      summary: `Rollback of ${id}`,
      risk: withIrreversibleRisk([`Restores the state captured before ${id} was applied.`, ...notes].join(' '), ops, { scope: plan.scope, ...target }),
      ops,
      slug,
    },
    now,
  );
  return updatePlan(cwd, created.id, { slug, rollback_of: id });
}
