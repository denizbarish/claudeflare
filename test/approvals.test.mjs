import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../scripts/lib/paths.mjs';
import { createPlan, readPlan, hashOps } from '../scripts/lib/plans.mjs';
import { writeApproval, checkApproval, consumeApproval } from '../scripts/lib/approvals.mjs';
import { CfError } from '../scripts/lib/errors.mjs';
import { getApprovalKey } from '../scripts/lib/approval-key.mjs';

const T0 = new Date('2026-10-24T14:30:00Z');
const ZID = '0123456789abcdef0123456789abcdef';
const later = (seconds) => new Date(T0.getTime() + seconds * 1000);

function setup(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'claudeflare-approvals-'));
  const keyDir = mkdtempSync(join(tmpdir(), 'claudeflare-key-'));
  const saved = {
    CLAUDEFLARE_APPROVAL_TTL: process.env.CLAUDEFLARE_APPROVAL_TTL,
    CLAUDEFLARE_KEY_DIR: process.env.CLAUDEFLARE_KEY_DIR,
  };
  delete process.env.CLAUDEFLARE_APPROVAL_TTL;
  process.env.CLAUDEFLARE_KEY_DIR = keyDir;
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const plan = createPlan(
    cwd,
    {
      zone_id: ZID,
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

function sign(key, a) {
  return createHmac('sha256', key)
    .update(JSON.stringify([a.plan_id, a.ops_hash, a.approved_at, a.session_id]))
    .digest('hex');
}

function rewriteApproval(cwd, approval, changes, key = getApprovalKey({ create: false })) {
  const next = { ...approval, ...changes };
  next.mac = sign(key, next);
  writeFileSync(approvalFile(cwd, approval.plan_id), JSON.stringify(next, null, 2));
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
    mac: sign(getApprovalKey({ create: false }), approval),
  });
  assert.match(approval.mac, /^[0-9a-f]{64}$/);
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
  rewriteApproval(cwd, approval, { approved_at: 'garbage' });
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

test('approval key is created once with 0600 perms and reused', (t) => {
  setup(t);
  assert.equal(getApprovalKey({ create: false }), null);
  const key = getApprovalKey({ create: true });
  assert.equal(key.length, 32);
  assert.ok(getApprovalKey({ create: true }).equals(key));
  assert.ok(getApprovalKey({ create: false }).equals(key));
  const file = join(process.env.CLAUDEFLARE_KEY_DIR, 'approval.key');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('checkApproval bad_signature for forged approval without mac', (t) => {
  const { cwd, plan } = setup(t);
  getApprovalKey({ create: true });
  mkdirSync(paths(cwd).approvals, { recursive: true });
  writeFileSync(
    approvalFile(cwd, plan.id),
    JSON.stringify({ plan_id: plan.id, ops_hash: plan.ops_hash, approved_at: T0.toISOString(), session_id: 's' }),
  );
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: false, reason: 'bad_signature' });
});

test('checkApproval bad_signature when no key exists', (t) => {
  const { cwd, plan } = setup(t);
  writeApproval(cwd, { plan_id: plan.id, session_id: 's' }, T0);
  rmSync(join(process.env.CLAUDEFLARE_KEY_DIR, 'approval.key'));
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: false, reason: 'bad_signature' });
});

test('checkApproval bad_signature for mac computed with a different key', (t) => {
  const { cwd, plan } = setup(t);
  const approval = writeApproval(cwd, { plan_id: plan.id, session_id: 's' }, T0);
  rewriteApproval(cwd, approval, {}, randomBytes(32));
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: false, reason: 'bad_signature' });
});

test('checkApproval bad_signature when approved_at tampered or mac malformed', (t) => {
  const { cwd, plan } = setup(t);
  const approval = writeApproval(cwd, { plan_id: plan.id, session_id: 's' }, T0);
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: true });
  writeFileSync(approvalFile(cwd, plan.id), JSON.stringify({ ...approval, approved_at: later(1000).toISOString() }));
  assert.deepEqual(checkApproval(cwd, plan.id, later(2000)), { ok: false, reason: 'bad_signature' });
  writeFileSync(approvalFile(cwd, plan.id), JSON.stringify({ ...approval, mac: 'abc' }));
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: false, reason: 'bad_signature' });
});

test('checkApproval treats approved_at more than 60s in the future as expired', (t) => {
  const { cwd, plan } = setup(t);
  writeApproval(cwd, { plan_id: plan.id, session_id: 's' }, later(300));
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: false, reason: 'expired' });
  writeApproval(cwd, { plan_id: plan.id, session_id: 's' }, later(30));
  assert.deepEqual(checkApproval(cwd, plan.id, T0), { ok: true });
});
