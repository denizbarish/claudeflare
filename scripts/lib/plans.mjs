import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CfError } from './errors.mjs';
import { paths } from './paths.mjs';

const ID_PATTERN = /^[a-z0-9-]+$/;
const SLUG_MAX = 40;
const ZONE_ID_PATTERN = /^[a-f0-9]{32}$/;

export function assertPlanId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new CfError('invalid_id', `Invalid plan id: ${JSON.stringify(id)}`);
  }
  return id;
}

function planFile(cwd, id) {
  return join(paths(cwd).plans, `${assertPlanId(id)}.json`);
}

function toJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isoSeconds(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
}

export function makePlanId(zoneName, slug, now) {
  const zoneShort = String(zoneName).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!zoneShort) throw new CfError('invalid_zone', `Invalid zone name: ${JSON.stringify(zoneName)}`);
  const stamp = isoSeconds(now).replace(/[-:]/g, '').replace('T', '-').replace('Z', '');
  return [zoneShort, stamp, slugify(slug)].filter(Boolean).join('-');
}

export function hashOps(ops) {
  return `sha256:${createHash('sha256').update(JSON.stringify(ops)).digest('hex')}`;
}

function resolveOps(ops, zoneId) {
  return ops.map((op) => ({ ...op, path: op.path.split('{zone_id}').join(zoneId) }));
}

export function createPlan(cwd, { zone_id, zone_name, summary, risk, ops, slug }, now = new Date()) {
  if (typeof zone_id !== 'string' || !ZONE_ID_PATTERN.test(zone_id)) {
    throw new CfError('invalid_zone', `Invalid zone id: ${JSON.stringify(zone_id)}`);
  }
  const id = assertPlanId(makePlanId(zone_name, slug, now));
  const resolved = resolveOps(ops, zone_id);
  const plan = {
    id,
    zone_id,
    zone_name,
    created_at: isoSeconds(now),
    summary,
    risk,
    ops: resolved,
    ops_hash: hashOps(resolved),
    status: 'draft',
  };
  mkdirSync(paths(cwd).plans, { recursive: true });
  try {
    writeFileSync(planFile(cwd, id), toJson(plan), { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') throw new CfError('plan_exists', `Plan already exists: ${id}`);
    throw err;
  }
  return plan;
}

export function readPlan(cwd, id) {
  const file = planFile(cwd, id);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new CfError('plan_missing', `Plan not found: ${id}`);
    throw err;
  }
  return JSON.parse(raw);
}

export function listPlans(cwd) {
  let names;
  try {
    names = readdirSync(paths(cwd).plans);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter((name) => name.endsWith('.json') && ID_PATTERN.test(name.slice(0, -5)))
    .map((name) => readPlan(cwd, name.slice(0, -5)))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
}

export function updatePlan(cwd, id, patch) {
  const plan = readPlan(cwd, id);
  const updated = { ...plan, ...patch, id: plan.id };
  writeFileSync(planFile(cwd, id), toJson(updated));
  return updated;
}
