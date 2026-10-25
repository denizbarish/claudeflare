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
import { classifyWranglerOp, DATA_LOSS_TYPES } from './wrangler-ops.mjs';

const ROLLBACK_SOURCE_STATUSES = new Set(['applied', 'partially_applied']);

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
  if (kind === 'resource_delete' && DATA_LOSS_TYPES.has(resource?.type)) {
    lines.push(`Data loss: ${resource.type} ${resource.name} and all its contents are deleted permanently.`);
  }
  return lines;
}

// Appends one "Not reversible" line per op that rollback cannot undo, plus a
// "Data loss" line for KV, Queue and D1 deletes.
export function withIrreversibleRisk(risk, ops) {
  const lines = ops.flatMap((op) => {
    if (op?.kind === 'wrangler') return wranglerRiskLines(op);
    return classify(op).invertible ? [] : [`Not reversible: ${op.method} ${op.path}`];
  });
  return [risk, ...lines].filter((line) => typeof line === 'string' && line !== '').join('\n');
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

async function executeOps(client, ops) {
  const results = ops.map(() => null);
  for (let i = 0; i < ops.length; i++) {
    const { method, path, body } = ops[i];
    try {
      results[i] = (await client.request(method, path, { body })) ?? true;
    } catch (err) {
      const error = { op_index: i, code: err?.code || 'internal', message: String(err?.message ?? err) };
      return { status: i === 0 ? 'failed' : 'partially_applied', results, error };
    }
  }
  return { status: 'applied', results };
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

// Wrangler execution is not available yet; refuse before any approval or API use.
function assertNoWranglerOps(plan) {
  if ((plan.ops ?? []).some((op) => op?.kind === 'wrangler')) {
    throw new CfError('not_supported', `Plan ${plan.id} contains wrangler ops, which this version cannot apply yet`);
  }
}

// The plan is read exactly once; that object is approval-checked and executed.
export async function applyPlan(cwd, client, id, now = new Date()) {
  const plan = readPlan(cwd, id);
  assertDraft(plan);
  assertNoWranglerOps(plan);
  if (plan.rollback_of) {
    assertRollbackSourceCurrent(cwd, plan);
  } else {
    validateOpTargets(plan.ops, plan);
    validatePlanOps(plan.ops);
  }
  assertApproved(cwd, plan, now);
  // Snapshot failures abort before any write and keep the approval.
  const snapshot = await captureSnapshot(client, plan);
  const file = writeApplySnapshot(cwd, plan, snapshot);

  // Consumed before the first write so the approval cannot be reused mid-run.
  // executeOps records op failures instead of throwing.
  consumeQuietly(cwd, id);
  const outcome = await executeOps(client, plan.ops ?? []);
  const patch = {
    status: outcome.status,
    results: outcome.results,
    snapshot_file: file,
    applied_at: now.toISOString(),
    error: outcome.error ?? null,
  };
  const updated = updatePlan(cwd, id, patch);
  if (outcome.status === 'applied' && plan.rollback_of) {
    updatePlan(cwd, plan.rollback_of, { status: 'rolled_back' });
  }
  return updated;
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
    throw new CfError('not_applied', `Plan ${id} has status ${plan.status}; only applied or partially applied plans can be rolled back`);
  }
  const ops = buildRollbackOps(readSnapshot(cwd, plan), plan.results ?? []);
  if (!ops.length) {
    throw new CfError('nothing_to_rollback', `Plan ${id} has no applied ops that can be reversed`);
  }
  const slug = slugify(`rollback-${plan.slug || 'plan'}`);
  const created = createPlan(
    cwd,
    {
      zone_id: plan.zone_id,
      zone_name: plan.zone_name,
      summary: `Rollback of ${id}`,
      risk: withIrreversibleRisk(`Restores the state captured before ${id} was applied.`, ops),
      ops,
      slug,
    },
    now,
  );
  return updatePlan(cwd, created.id, { slug, rollback_of: id });
}
