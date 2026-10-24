import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CfError } from './errors.mjs';
import { paths } from './paths.mjs';
import { assertPlanId, hashOps, readPlan } from './plans.mjs';
import { getApprovalKey } from './approval-key.mjs';

const DEFAULT_TTL_SECONDS = 1800;
const MAX_CLOCK_SKEW_MS = 60_000;
const MAC_PATTERN = /^[0-9a-f]{64}$/;

// The project directory is part of the MAC, so an approval copied into
// another project with an identical plan file does not verify there.
function computeMac(key, { plan_id, ops_hash, approved_at, session_id }, cwd) {
  return createHmac('sha256', key)
    .update(JSON.stringify([plan_id, ops_hash, approved_at, session_id, realpathSync(cwd)]))
    .digest('hex');
}

function hasValidMac(approval, cwd) {
  const key = getApprovalKey({ create: false });
  if (!key || typeof approval.mac !== 'string' || !MAC_PATTERN.test(approval.mac)) return false;
  const expected = Buffer.from(computeMac(key, approval, cwd), 'hex');
  const actual = Buffer.from(approval.mac, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

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
  approval.mac = computeMac(getApprovalKey({ create: true }), approval, cwd);
  mkdirSync(paths(cwd).approvals, { recursive: true });
  writeFileSync(file, `${JSON.stringify(approval, null, 2)}\n`);
  return approval;
}

// options.plan: an already-read plan object to verify against (the caller then
// executes exactly that object); otherwise the plan is read from disk.
export function checkApproval(cwd, plan_id, now = new Date(), { plan: givenPlan } = {}) {
  assertPlanId(plan_id);
  const approval = readApproval(cwd, plan_id);
  if (!approval || approval.plan_id !== plan_id) return { ok: false, reason: 'missing' };
  if (!hasValidMac(approval, cwd)) return { ok: false, reason: 'bad_signature' };
  const ageMs = now.getTime() - new Date(approval.approved_at).getTime();
  if (!Number.isFinite(ageMs) || ageMs > ttlSeconds() * 1000 || ageMs < -MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: 'expired' };
  }
  const plan = givenPlan ?? tryReadPlan(cwd, plan_id);
  if (!plan || plan.id !== plan_id) return { ok: false, reason: 'plan_missing' };
  if (approval.ops_hash !== hashOps(plan.ops)) return { ok: false, reason: 'hash_mismatch' };
  return { ok: true };
}

export function consumeApproval(cwd, plan_id) {
  rmSync(approvalFile(cwd, plan_id), { force: true });
}
