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
import { baseFor, classifyProductOp } from './products/index.mjs';
import { driftDetail, productReadPath } from './rest-engine.mjs';
import { assertWranglerOpPaths, classifyWranglerOp, DATA_LOSS_TYPES, SOURCE_KINDS } from './wrangler-ops.mjs';
import { assertWranglerVersion, runWrangler } from './wrangler.mjs';
import { computeSourceHash } from './source-hash.mjs';
import { executeAccountOps } from './wrangler-exec.mjs';
import { assertSecretFieldsEnv, executeRestOps, readSecretEnv } from './rest-exec.mjs';
import { runHealthCheck } from './health-check.mjs';
import { hasProductOps, LOCKOUT_PREFIX, runProductPreflight } from './product-preflight.mjs';

// Plans whose applied ops may still be reverted by a rollback plan. After an
// automatic rollback the earlier ops of the plan are still applied.
const ROLLBACK_SOURCE_STATUSES = new Set(['applied', 'partially_applied', 'applied_check_failed', 'rolled_back_auto']);

export function snapshotFile(cwd, plan) {
  return join(paths(cwd).snapshots(planStateName(plan)), `${plan.id}.json`);
}

// Post-apply states of a product plan's ops, the baseline of its rollback's
// drift prechecks (spec 4.4). Kept apart from the snapshot, which is written
// before any op runs.
export function postFile(cwd, plan) {
  return join(paths(cwd).snapshots(planStateName(plan)), `${plan.id}.post.json`);
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

// One record per product op that ran: { op_index, read, state }. state is the
// redacted read after the op, { absent: true } after a DELETE, or null when
// the read failed (the rollback then fails closed). Written once (wx); a
// failed write only loses the baseline, so it never fails the apply.
function writePostFile(cwd, plan, outcome) {
  const ops = plan.ops ?? [];
  const records = ops.map((op, i) => {
    const classified = classifyProductOp(op, plan);
    const result = outcome.results?.[i];
    if (!classified || result === null || result === undefined || result?.skipped) return null;
    const deleted = String(op.method).toUpperCase() === 'DELETE';
    const read = productReadPath(op, classified, result) ?? null;
    return { op_index: i, read, state: deleted ? { absent: true } : (outcome.post?.[i] ?? null) };
  });
  if (!ops.some((op) => classifyProductOp(op, plan))) return;
  try {
    writeJson(postFile(cwd, plan), { plan_id: plan.id, ops: records }, 'wx');
  } catch {
    // createRollbackPlan treats a missing post file as an unknown baseline.
  }
}

function readPostOps(cwd, plan) {
  try {
    const ops = JSON.parse(readFileSync(postFile(cwd, plan), 'utf8'))?.ops;
    return Array.isArray(ops) ? ops : null;
  } catch {
    return null;
  }
}

// Rollback ops with a drift precheck re-read their resource first. A mismatch
// skips the op and every later op of the same group (spec 4.4).
function driftGuard(client, plan) {
  const base = baseFor(plan);
  const drifted = new Map();
  return async (op) => {
    const precheck = op?.precheck;
    if (precheck?.kind !== 'drift') return null;
    const group = typeof precheck.group === 'string' ? precheck.group : null;
    const detail = group !== null && drifted.has(group)
      ? `group ${group} skipped: ${drifted.get(group)}`
      : await driftDetail(client, precheck, { base });
    if (detail === null) return null;
    if (group !== null && !drifted.has(group)) drifted.set(group, detail);
    return { skipped: true, reason: 'rollback_drift', detail };
  };
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
// unknown and therefore not reversible, as in 0.2.x. ctxByProduct holds the
// product preflight reads the kinds' notes see.
export function withIrreversibleRisk(risk, ops, plan, ctxByProduct = {}) {
  const notes = [];
  const lines = ops.flatMap((op) => {
    if (op?.kind === 'wrangler') return wranglerRiskLines(op);
    const product = plan ? classifyProductOp(op, plan) : null;
    if (product) {
      notes.push(...(product.entry.notes?.(ctxByProduct[product.module.product] ?? {}, op) ?? []));
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

// Product preflight again on fresh reads (spec 6). A failed check stops with
// its own code; a lockout line the plan did not show stops with risk_changed,
// because approval binds only to the ops hash and the user never saw that
// line. Lines that disappeared do not stop apply. Plans without lockout_risks
// (0.2.x, hand-made) and rollback plans skip this.
async function assertProductPreflight(client, plan) {
  if (plan.rollback_of || !Array.isArray(plan.lockout_risks) || !hasProductOps(plan)) return;
  const report = await runProductPreflight(client, plan, plan.ops);
  const failedCheck = report.checks.find((c) => !c.ok);
  if (failedCheck) {
    throw new CfError(failedCheck.code ?? 'preflight_failed', `Plan ${plan.id}: ${failedCheck.detail}`, {
      hint: 'Nothing was written and the approval is unused; fix the cause or create a new plan',
    });
  }
  const shown = new Set(plan.lockout_risks);
  const added = report.lockout_risks.filter((line) => !shown.has(line));
  if (added.length) {
    throw new CfError('risk_changed', `Plan ${plan.id}: new lockout risk found since the plan was made:\n${added.join('\n')}`, {
      hint: 'Nothing was written; create a new plan with claudeflare plan new so the user approves with these lines in view',
    });
  }
}

// Rollback plans skip product preflight at apply, so their lockout lines are
// computed once here, stored and appended to risk. A failed analysis becomes
// a lockout line itself: the rollback stays available, the user is warned.
export async function addRollbackLockout(cwd, plan, client) {
  if (!hasProductOps(plan)) return plan;
  let lines;
  try {
    const report = await runProductPreflight(client, plan, plan.ops);
    const blocked = report.checks.filter((c) => !c.ok && ['entitlement', 'permission', 'gather'].includes(c.name));
    lines = [
      ...report.lockout_risks,
      ...blocked.map((c) => `${LOCKOUT_PREFIX} lockout analysis could not run (${c.detail}); review the ops before approving.`),
    ];
  } catch (err) {
    lines = [`${LOCKOUT_PREFIX} lockout analysis could not run (${err?.message ?? err}); review the ops before approving.`];
  }
  const base = String(plan.risk ?? '').split('\n').filter((line) => line && !line.startsWith(LOCKOUT_PREFIX));
  return updatePlan(cwd, plan.id, { lockout_risks: lines, risk: [...base, ...lines].join('\n') });
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
    readSecretEnv(op.value_from_env, process.env);
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
  // A missing or unsafe secret env var refuses before any request, keeping the approval.
  assertSecretFieldsEnv(plan, env);
  // Refusals here also keep the approval: nothing has been written yet.
  await assertProductPreflight(client, plan);
  // Snapshot failures abort before any write and keep the approval.
  const snapshot = await captureSnapshot(client, plan);
  const file = writeApplySnapshot(cwd, plan, snapshot);

  // Consumed before the first write so the approval cannot be reused mid-run.
  // executeRestOps records op failures instead of throwing. Its `post` states
  // go to the post file, not the plan record.
  consumeQuietly(cwd, id);
  const beforeOp = plan.rollback_of ? driftGuard(client, plan) : undefined;
  const outcome = await executeRestOps({ client, plan, cwd, env, beforeOp });
  writePostFile(cwd, plan, outcome);
  // A drift skip leaves part of the rollback undone.
  if (outcome.status === 'applied' && outcome.results.some((r) => r?.skipped)) outcome.status = 'partially_applied';
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
  const snapshot = readSnapshot(cwd, plan);
  // Only product (v3) entries get a drift baseline; v1 and v2 rollbacks are unchanged.
  const post = snapshot.entries.some((e) => e?.op_kind === 'product') ? { post: readPostOps(cwd, plan) } : {};
  const ops = buildRollbackOps(snapshot, results, { unresolved, ...post });
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
