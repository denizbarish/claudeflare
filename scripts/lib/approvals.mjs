import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CfError } from './errors.mjs';
import { paths } from './paths.mjs';
import { assertPlanId, hashOps, readPlan } from './plans.mjs';

const DEFAULT_TTL_SECONDS = 1800;

function approvalFile(cwd, planId) {
  return join(paths(cwd).approvals, `${assertPlanId(planId)}.json`);
}

function ttlSeconds() {
  const raw = process.env.CLAUDEFLARE_APPROVAL_TTL;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TTL_SECONDS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_TTL_SECONDS;
}

function readApproval(cwd, planId) {
  try {
    return JSON.parse(readFileSync(approvalFile(cwd, planId), 'utf8'));
  } catch (err) {
    if (err instanceof CfError) throw err;
    return null;
  }
}

function tryReadPlan(cwd, planId) {
  try {
    return readPlan(cwd, planId);
  } catch (err) {
    if (err instanceof CfError && err.code === 'plan_missing') return null;
    throw err;
  }
}

export function writeApproval(cwd, { plan_id, session_id }, now = new Date()) {
  const file = approvalFile(cwd, plan_id);
  const plan = readPlan(cwd, plan_id);
  const approval = {
    plan_id,
    ops_hash: hashOps(plan.ops),
    approved_at: now.toISOString(),
    session_id,
  };
  mkdirSync(paths(cwd).approvals, { recursive: true });
  writeFileSync(file, `${JSON.stringify(approval, null, 2)}\n`);
  return approval;
}

export function checkApproval(cwd, plan_id, now = new Date()) {
  assertPlanId(plan_id);
  const approval = readApproval(cwd, plan_id);
  if (!approval || approval.plan_id !== plan_id) return { ok: false, reason: 'missing' };
  const plan = tryReadPlan(cwd, plan_id);
  if (!plan) return { ok: false, reason: 'plan_missing' };
  const ageMs = now.getTime() - new Date(approval.approved_at).getTime();
  if (!Number.isFinite(ageMs) || ageMs > ttlSeconds() * 1000) return { ok: false, reason: 'expired' };
  if (approval.ops_hash !== hashOps(plan.ops)) return { ok: false, reason: 'hash_mismatch' };
  return { ok: true };
}

export function consumeApproval(cwd, plan_id) {
  rmSync(approvalFile(cwd, plan_id), { force: true });
}
