// Captures the before-state of every resource a plan touches and builds the
// inverse ops used by rollback. No filesystem I/O here.

import { classify } from './resources.mjs';
import { CfError } from './errors.mjs';

const DNS_FIELDS = ['type', 'name', 'content', 'ttl', 'proxied', 'priority', 'comment', 'tags'];
const RULE_FIELDS = ['expression', 'action', 'action_parameters', 'description', 'enabled'];

function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source?.[field] !== undefined) out[field] = source[field];
  }
  return out;
}

function lastSegment(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

function parentPath(path) {
  return path.slice(0, path.lastIndexOf('/'));
}

function ruleIds(ruleset) {
  return Array.isArray(ruleset?.rules) ? ruleset.rules.map((r) => r?.id) : [];
}

async function readRule(client, readPath, ruleId) {
  const ruleset = await client.request('GET', readPath);
  const rule = (ruleset?.rules ?? []).find((r) => r?.id === ruleId);
  if (!rule) {
    throw new CfError('not_found', `Rule ${ruleId} not found in ruleset ${readPath}`, { status: 404 });
  }
  return rule;
}

// Before-readers per kind. Kinds absent here take no snapshot (before = null).
const READERS = {
  zone_setting: (client, op, readPath) => client.request('GET', readPath),
  zone_settings_bulk: async (client, op) => {
    const items = [];
    for (const item of op.body?.items ?? []) {
      if (!/^[A-Za-z0-9_]+$/.test(String(item?.id))) {
        throw new CfError('api', `Invalid setting id in bulk op: ${JSON.stringify(item?.id)}`);
      }
      const setting = await client.request('GET', `${op.path}/${item.id}`);
      items.push({ id: item.id, value: setting?.value });
    }
    return { items };
  },
  dns_update: (client, op, readPath) => client.request('GET', readPath),
  dns_delete: (client, op, readPath) => client.request('GET', readPath),
  rule_create: async (client, op, readPath) => ({
    rule_ids: ruleIds(await client.request('GET', readPath)),
  }),
  rule_update: (client, op, readPath) => readRule(client, readPath, lastSegment(op.path)),
  rule_delete: (client, op, readPath) => readRule(client, readPath, lastSegment(op.path)),
  phase_entrypoint_put: async (client, op, readPath) => {
    try {
      return await client.request('GET', readPath);
    } catch (err) {
      if (err instanceof CfError && err.code === 'not_found') return { rules: [] };
      throw err;
    }
  },
};

// Any read error propagates so the caller aborts before any write.
export async function captureSnapshot(client, plan) {
  const entries = [];
  const ops = plan.ops ?? [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const { kind, invertible, readPath } = classify(op);
    const reader = READERS[kind];
    const before = reader ? await reader(client, op, readPath) : null;
    entries.push({ op_index: i, kind, before, invertible, path: op.path });
  }
  return { plan_id: plan.id, taken_at: new Date().toISOString(), entries };
}

function ambiguous(message) {
  return new CfError('rollback_ambiguous', message);
}

const INVERTERS = {
  zone_setting: ({ path, before }) => [{ method: 'PATCH', path, body: { value: before.value } }],
  zone_settings_bulk: ({ path, before }) => [{ method: 'PATCH', path, body: { items: before.items } }],
  dns_create: ({ path }, applyResult) => {
    if (!applyResult?.id) throw ambiguous(`No record id in apply result for ${path}`);
    return [{ method: 'DELETE', path: `${path}/${applyResult.id}` }];
  },
  dns_update: ({ path, before }) => [{ method: 'PUT', path, body: pick(before, DNS_FIELDS) }],
  dns_delete: ({ path, before }) => [
    { method: 'POST', path: parentPath(path), body: pick(before, DNS_FIELDS) },
  ],
  rule_create: ({ path, before }, applyResult) => {
    const known = new Set(before.rule_ids);
    const added = ruleIds(applyResult).filter((id) => !known.has(id));
    if (added.length !== 1) {
      throw ambiguous(`Expected exactly one new rule in ${path}, found ${added.length}`);
    }
    return [{ method: 'DELETE', path: `${path}/${added[0]}` }];
  },
  rule_update: ({ path, before }) => [{ method: 'PATCH', path, body: pick(before, RULE_FIELDS) }],
  rule_delete: ({ path, before }) => [
    { method: 'POST', path: parentPath(path), body: pick(before, RULE_FIELDS) },
  ],
  phase_entrypoint_put: ({ path, before }) => [{ method: 'PUT', path, body: { rules: before.rules } }],
};

export function inverseFor(entry, applyResult) {
  const inverter = INVERTERS[entry.kind];
  if (!entry.invertible || !inverter) return [];
  return inverter(entry, applyResult);
}

// results[i] is the apply result of op i, or null/undefined if it was not applied.
export function buildRollbackOps(snapshot, results) {
  const ops = [];
  for (const entry of [...snapshot.entries].reverse()) {
    const result = results[entry.op_index];
    if (result === null || result === undefined) continue;
    ops.push(...inverseFor(entry, result));
  }
  return ops;
}
