// Executes approved plans and builds rollback plans. This is the only module
// that sends write requests to Cloudflare.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CfError } from './errors.mjs';
import { paths } from './paths.mjs';
import { createPlan, readPlan, updatePlan } from './plans.mjs';
import { checkApproval, consumeApproval } from './approvals.mjs';
import { classify } from './resources.mjs';
import { buildRollbackOps, captureSnapshot } from './snapshot.mjs';

const ROLLBACK_SOURCE_STATUSES = new Set(['applied', 'partially_applied']);

export function snapshotFile(cwd, plan) {
  return join(paths(cwd).snapshots(plan.zone_name), `${plan.id}.json`);
}

export function writeSnapshot(cwd, plan, snapshot) {
  const file = snapshotFile(cwd, plan);
  mkdirSync(paths(cwd).snapshots(plan.zone_name), { recursive: true });
  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  return file;
}

// Appends one "Not reversible" line per op that rollback cannot undo.
export function withIrreversibleRisk(risk, ops) {
  const lines = ops
    .filter((op) => !classify(op).invertible)
    .map((op) => `Not reversible: ${op.method} ${op.path}`);
  return [risk, ...lines].filter((line) => typeof line === 'string' && line !== '').join('\n');
}

function assertApproved(cwd, id, now) {
  let check;
  try {
    check = checkApproval(cwd, id, now);
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

export async function applyPlan(cwd, client, id, now = new Date()) {
  const plan = readPlan(cwd, id);
  assertApproved(cwd, id, now);
  // A snapshot failure aborts before any write and keeps the approval.
  const snapshot = await captureSnapshot(client, plan);
  const file = writeSnapshot(cwd, plan, snapshot);

  let outcome;
  try {
    outcome = await executeOps(client, plan.ops ?? []);
  } finally {
    consumeApproval(cwd, id);
  }
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
  const slug = `rollback-${plan.slug || 'plan'}`;
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
