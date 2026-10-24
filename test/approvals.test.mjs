import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../scripts/lib/paths.mjs';
import { createPlan, readPlan, hashOps } from '../scripts/lib/plans.mjs';
import { writeApproval, checkApproval, consumeApproval } from '../scripts/lib/approvals.mjs';
import { CfError } from '../scripts/lib/errors.mjs';

const T0 = new Date('2026-10-24T14:30:00Z');
const later = (seconds) => new Date(T0.getTime() + seconds * 1000);

function setup(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'claudeflare-approvals-'));
  const saved = process.env.CLAUDEFLARE_APPROVAL_TTL;
  delete process.env.CLAUDEFLARE_APPROVAL_TTL;
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CLAUDEFLARE_APPROVAL_TTL;
    else process.env.CLAUDEFLARE_APPROVAL_TTL = saved;
  });
  const plan = createPlan(
    cwd,
    {
      zone_id: 'zone123',
      zone_name: 'example.com',
      summary: 'Set SSL mode to Full (strict)',
      risk: '526 if origin cert is invalid',
      ops: [{ method: 'PATCH', path: '/zones/{zone_id}/settings/ssl', body: { value: 'strict' } }],
      slug: 'ssl-strict',
    },
    T0,
  );
  return { cwd, plan };
}

const planFile = (cwd, id) => join(paths(cwd).plans, `${id}.json`);
const approvalFile = (cwd, id) => join(paths(cwd).approvals, `${id}.json`);

test('writeApproval stores plan_id, ops_hash, approved_at, session_id', (t) => {
  const { cwd, plan } = setup(t);
  const approval = writeApproval(cwd, { plan_id: plan.id, session_id: 'sess-1' }, T0);
  assert.deepEqual(approval, {
    plan_id: plan.id,
    ops_hash: plan.ops_hash,
    approved_at: T0.toISOString(),
    session_id: 'sess-1',
  });
  assert.equal(readFileSync(approvalFile(cwd, plan.id), 'utf8'), `${JSON.stringify(approval, null, 2)}\n`);
});

test('checkApproval ok right after writeApproval', (t) => {
  const { cwd, plan } = setup(t);
  writeApproval(cwd, { plan_id: plan.id, session_id: 's' }, T0);
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: true });
  assert.deepEqual(checkApproval(cwd, plan.id, later(1800)), { ok: true });
});

test('checkApproval expired after 1801s; respects CLAUDEFLARE_APPROVAL_TTL=60', (t) => {
  const { cwd, plan } = setup(t);
  writeApproval(cwd, { plan_id: plan.id, session_id: 's' }, T0);
  assert.deepEqual(checkApproval(cwd, plan.id, later(1801)), { ok: false, reason: 'expired' });
  process.env.CLAUDEFLARE_APPROVAL_TTL = '60';
  assert.deepEqual(checkApproval(cwd, plan.id, later(60)), { ok: true });
  assert.deepEqual(checkApproval(cwd, plan.id, later(61)), { ok: false, reason: 'expired' });
});

test('checkApproval expired when approved_at is not a valid date', (t) => {
  const { cwd, plan } = setup(t);
  const approval = writeApproval(cwd, { plan_id: plan.id, session_id: 's' }, T0);
  writeFileSync(approvalFile(cwd, plan.id), JSON.stringify({ ...approval, approved_at: 'garbage' }));
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: false, reason: 'expired' });
});

test('checkApproval hash_mismatch after plan ops edited on disk', (t) => {
  const { cwd, plan } = setup(t);
  writeApproval(cwd, { plan_id: plan.id, session_id: 's' }, T0);
  const edited = { ...plan, ops: [{ method: 'DELETE', path: '/zones/zone123' }] };
  edited.ops_hash = hashOps(edited.ops);
  writeFileSync(planFile(cwd, plan.id), JSON.stringify(edited, null, 2));
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: false, reason: 'hash_mismatch' });
});

test('checkApproval hash_mismatch when ops edited but stored ops_hash left untouched', (t) => {
  const { cwd, plan } = setup(t);
  writeApproval(cwd, { plan_id: plan.id, session_id: 's' }, T0);
  const edited = { ...plan, ops: [{ method: 'DELETE', path: '/zones/zone123' }] };
  assert.equal(edited.ops_hash, plan.ops_hash);
  writeFileSync(planFile(cwd, plan.id), JSON.stringify(edited, null, 2));
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: false, reason: 'hash_mismatch' });
});

test('checkApproval missing when no file; plan_missing when plan deleted', (t) => {
  const { cwd, plan } = setup(t);
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: false, reason: 'missing' });
  writeApproval(cwd, { plan_id: plan.id, session_id: 's' }, T0);
  rmSync(planFile(cwd, plan.id));
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: false, reason: 'plan_missing' });
});

test('checkApproval missing when approval file is corrupt or names another plan', (t) => {
  const { cwd, plan } = setup(t);
  const approval = writeApproval(cwd, { plan_id: plan.id, session_id: 's' }, T0);
  writeFileSync(approvalFile(cwd, plan.id), '{not json');
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: false, reason: 'missing' });
  writeFileSync(approvalFile(cwd, plan.id), JSON.stringify({ ...approval, plan_id: 'other-plan' }));
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: false, reason: 'missing' });
});

test('consumeApproval removes file; second check -> missing', (t) => {
  const { cwd, plan } = setup(t);
  writeApproval(cwd, { plan_id: plan.id, session_id: 's' }, T0);
  consumeApproval(cwd, plan.id);
  assert.ok(!existsSync(approvalFile(cwd, plan.id)));
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: false, reason: 'missing' });
  assert.doesNotThrow(() => consumeApproval(cwd, plan.id));
});

test('writeApproval throws plan_missing when the plan does not exist', (t) => {
  const { cwd } = setup(t);
  assert.throws(
    () => writeApproval(cwd, { plan_id: 'examplecom-20261024-143000-nope', session_id: 's' }, T0),
    (e) => e instanceof CfError && e.code === 'plan_missing',
  );
  assert.ok(!existsSync(approvalFile(cwd, 'examplecom-20261024-143000-nope')));
});

test('writeApproval hashes the plan current ops, not the stored ops_hash', (t) => {
  const { cwd, plan } = setup(t);
  const edited = { ...readPlan(cwd, plan.id), ops: [{ method: 'GET', path: '/x' }] };
  writeFileSync(planFile(cwd, plan.id), JSON.stringify(edited, null, 2));
  const approval = writeApproval(cwd, { plan_id: plan.id, session_id: 's' }, T0);
  assert.equal(approval.ops_hash, hashOps(edited.ops));
});

test('approval functions reject invalid ids', (t) => {
  const { cwd } = setup(t);
  const isInvalid = (e) => e instanceof CfError && e.code === 'invalid_id';
  for (const bad of ['../x', 'a/b', '..', 'Bad', '']) {
    assert.throws(() => writeApproval(cwd, { plan_id: bad, session_id: 's' }, T0), isInvalid);
    assert.throws(() => checkApproval(cwd, bad, T0), isInvalid);
    assert.throws(() => consumeApproval(cwd, bad), isInvalid);
  }
});
