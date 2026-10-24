import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../scripts/lib/paths.mjs';
import {
  makePlanId,
  hashOps,
  createPlan,
  readPlan,
  listPlans,
  updatePlan,
} from '../scripts/lib/plans.mjs';
import { CfError } from '../scripts/lib/errors.mjs';

const NOW = new Date('2026-10-24T14:30:00Z');
const ZID = '0123456789abcdef0123456789abcdef';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'claudeflare-plans-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function samplePlan(overrides = {}) {
  return {
    zone_id: ZID,
    zone_name: 'example.com',
    summary: 'Set SSL mode to Full (strict)',
    risk: '526 if origin cert is invalid',
    ops: [{ method: 'PATCH', path: '/zones/{zone_id}/settings/ssl', body: { value: 'strict' } }],
    slug: 'SSL Strict!',
    ...overrides,
  };
}

test('paths resolves the state layout under <cwd>/.claudeflare', () => {
  const p = paths('/work');
  assert.equal(p.root, join('/work', '.claudeflare'));
  assert.equal(p.plans, join('/work', '.claudeflare', 'plans'));
  assert.equal(p.approvals, join('/work', '.claudeflare', 'approvals'));
  assert.equal(p.snapshots('example.com'), join('/work', '.claudeflare', 'snapshots', 'example.com'));
  assert.equal(p.reports('example.com'), join('/work', '.claudeflare', 'reports', 'example.com'));
});

test('makePlanId("example.com","SSL Strict!", 2026-10-24T14:30:00Z) === "examplecom-20261024-143000-ssl-strict"', () => {
  assert.equal(makePlanId('example.com', 'SSL Strict!', NOW), 'examplecom-20261024-143000-ssl-strict');
});

test('slug truncated to 40 chars', () => {
  const id = makePlanId('example.com', 'a'.repeat(60), NOW);
  const slug = id.slice('examplecom-20261024-143000-'.length);
  assert.equal(slug, 'a'.repeat(40));
  const dashed = makePlanId('example.com', `${'b'.repeat(39)} tail`, NOW);
  assert.match(dashed, /^[a-z0-9-]+$/);
  assert.ok(!dashed.endsWith('-'));
});

test('hashOps is sha256: + hex of JSON.stringify(ops)', () => {
  const h = hashOps([{ method: 'GET', path: '/x' }]);
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
  assert.equal(h, hashOps([{ method: 'GET', path: '/x' }]));
  assert.notEqual(h, hashOps([{ method: 'GET', path: '/y' }]));
});

test('createPlan resolves {zone_id} and sets ops_hash = hashOps(resolved ops)', (t) => {
  const cwd = tempDir(t);
  const plan = createPlan(
    cwd,
    samplePlan({
      ops: [
        { method: 'PATCH', path: '/zones/{zone_id}/settings/ssl', body: { value: 'strict' } },
        { method: 'GET', path: '/zones/{zone_id}/x/{zone_id}' },
      ],
    }),
    NOW,
  );
  assert.equal(plan.id, 'examplecom-20261024-143000-ssl-strict');
  assert.equal(plan.status, 'draft');
  assert.equal(plan.created_at, '2026-10-24T14:30:00Z');
  assert.deepEqual(plan.ops, [
    { method: 'PATCH', path: `/zones/${ZID}/settings/ssl`, body: { value: 'strict' } },
    { method: 'GET', path: `/zones/${ZID}/x/${ZID}` },
  ]);
  assert.equal(plan.ops_hash, hashOps(plan.ops));
  const file = join(paths(cwd).plans, `${plan.id}.json`);
  const raw = readFileSync(file, 'utf8');
  assert.equal(raw, `${JSON.stringify(plan, null, 2)}\n`);
  assert.deepEqual(readPlan(cwd, plan.id), plan);
});

test('createPlan refuses to overwrite an existing plan', (t) => {
  const cwd = tempDir(t);
  createPlan(cwd, samplePlan(), NOW);
  assert.throws(() => createPlan(cwd, samplePlan(), NOW), (e) => e instanceof CfError && e.code === 'plan_exists');
});

test('listPlans returns all plans; empty when no directory', (t) => {
  const cwd = tempDir(t);
  assert.deepEqual(listPlans(cwd), []);
  const a = createPlan(cwd, samplePlan({ slug: 'one' }), NOW);
  const b = createPlan(cwd, samplePlan({ slug: 'two' }), new Date('2026-10-24T15:00:00Z'));
  assert.deepEqual(listPlans(cwd).map((p) => p.id), [a.id, b.id]);
});

test('updatePlan merges patch, keeps id, persists', (t) => {
  const cwd = tempDir(t);
  const plan = createPlan(cwd, samplePlan(), NOW);
  const updated = updatePlan(cwd, plan.id, { status: 'applied', id: 'other' });
  assert.equal(updated.status, 'applied');
  assert.equal(updated.id, plan.id);
  assert.deepEqual(readPlan(cwd, plan.id), updated);
});

test('readPlan throws plan_missing for unknown id', (t) => {
  const cwd = tempDir(t);
  assert.throws(() => readPlan(cwd, 'nope'), (e) => e instanceof CfError && e.code === 'plan_missing');
});

test('readPlan rejects ids with path separators or ..', (t) => {
  const cwd = tempDir(t);
  for (const bad of ['../x', 'a/b', 'a\\b', '..', '', 'UPPER', 'a.json', undefined]) {
    assert.throws(() => readPlan(cwd, bad), (e) => e instanceof CfError && e.code === 'invalid_id', String(bad));
    assert.throws(() => updatePlan(cwd, bad, {}), (e) => e instanceof CfError && e.code === 'invalid_id');
  }
  assert.ok(!existsSync(paths(cwd).root));
});

test('paths rejects unsafe zone names for snapshots and reports', () => {
  const p = paths('/work');
  const isInvalid = (e) => e instanceof CfError && e.code === 'invalid_zone';
  for (const bad of ['..', '../etc', 'a/b', 'a\\b', 'ex..ample.com', '', 'a b', undefined]) {
    assert.throws(() => p.snapshots(bad), isInvalid, String(bad));
    assert.throws(() => p.reports(bad), isInvalid, String(bad));
  }
  assert.equal(p.snapshots('Sub-1.Example.com'), join('/work', '.claudeflare', 'snapshots', 'Sub-1.Example.com'));
});

test('createPlan rejects zone_id that is not 32 lowercase hex chars', (t) => {
  const cwd = tempDir(t);
  const isInvalid = (e) => e instanceof CfError && e.code === 'invalid_zone';
  for (const bad of ['zone123', '', undefined, ZID.toUpperCase(), `${ZID}0`, '../x']) {
    assert.throws(() => createPlan(cwd, samplePlan({ zone_id: bad }), NOW), isInvalid, String(bad));
  }
  assert.ok(!existsSync(paths(cwd).root));
});

test('makePlanId and createPlan reject a zone name with no alphanumerics', (t) => {
  const cwd = tempDir(t);
  const isInvalid = (e) => e instanceof CfError && e.code === 'invalid_zone';
  assert.throws(() => makePlanId('...', 'x', NOW), isInvalid);
  assert.throws(() => createPlan(cwd, samplePlan({ zone_name: '-.-' }), NOW), isInvalid);
});

test('createPlan validates zone_name like paths() before writing anything', (t) => {
  const cwd = tempDir(t);
  const isInvalid = (e) => e instanceof CfError && e.code === 'invalid_zone';
  const missing = samplePlan();
  delete missing.zone_name;
  assert.throws(() => createPlan(cwd, missing, NOW), isInvalid, 'missing');
  for (const bad of ['.', '..', 'a/b', 'ex..ample.com', '']) {
    assert.throws(() => createPlan(cwd, samplePlan({ zone_name: bad }), NOW), isInvalid, bad);
  }
  assert.ok(!existsSync(paths(cwd).root));
  assert.equal(createPlan(cwd, samplePlan({ zone_name: 'Sub-1.Example.com' }), NOW).zone_name, 'Sub-1.Example.com');
});
