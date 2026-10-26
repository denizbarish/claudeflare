// Cloudflare Load Balancing product module (spec 5.5). Monitors and pools are
// account resources (/accounts/<id>/load_balancers/monitors|pools); load
// balancers are zone resources (/zones/<id>/load_balancers). A plan holds one
// scope, so account plans change monitors and pools and zone plans change load
// balancers. The engine snapshots, inverts and redacts; this module adds body
// validation, the reads lockout and dependency checks need, the pool preview,
// risk notes and verification.
//
// Pool preview: preflight sends POST .../pools/<id>/preview (the monitor's
// settings as the body), then reads GET .../load_balancers/preview/<id> once.
// It is the only non-GET call a preflight sends, it is advisory, and any
// failure becomes a "preview skipped: <reason>" note; it never blocks a plan.

import { CfError } from '../errors.mjs';
import { LOCKOUT_PREFIX } from '../lockout-text.mjs';
import { listAll } from '../paginate.mjs';
import { omitPaths } from './fields.mjs';
import { matchKind, opTarget } from './match.mjs';
import { poolHealthyCheck, readbackCheck } from '../verify.mjs';

const ID = '([0-9a-f]{32})';
const ID_ONLY = /^[0-9a-f]{32}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

// Fields the API sets: dropped from restore bodies and from drift comparisons.
const MONITOR_READ_ONLY = ['id', 'created_on', 'modified_on'];
const POOL_READ_ONLY = ['id', 'created_on', 'modified_on', 'disabled_at', 'origins.*.disabled_at'];
const LB_READ_ONLY = ['id', 'created_on', 'modified_on'];

const MONITOR_TYPES = ['http', 'https', 'tcp', 'udp_icmp', 'icmp_ping', 'smtp'];
const MONITOR_NUMBERS = ['interval', 'timeout', 'retries', 'port', 'consecutive_up', 'consecutive_down'];

// Token template permissions (spec 12).
const PERM = {
  read: 'Load Balancing: Monitors and Pools Read',
  edit: 'Load Balancing: Monitors and Pools Edit',
  lbRead: 'Load Balancers Read',
  lbEdit: 'Load Balancers Edit',
  zone: 'Zone Read',
};

const HINT = 'If it happens, roll this plan back with claudeflare rollback.';
const NOT_ENTITLED = 'Load Balancing is not enabled on this account; it is a paid add-on (dashboard: Traffic, Load Balancing)';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';
const list = (items) => items.join(', ');
const isZone = (base) => String(base).startsWith('/zones/');

async function withPermission(permission, path, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CfError && err.code === 'permission') {
      throw new CfError('permission', `the token cannot read ${path}; it needs "${permission}"`, { status: err.status });
    }
    throw err;
  }
}

// ---------- validation (Ruling 15) ----------

// Messages name field paths, never values.
function readOnlyProblems(body, fields) {
  return fields.filter((key) => key in body).map((key) => `${key} is set by Cloudflare and cannot be written`);
}

function validateMonitor(op) {
  const body = op.body;
  if (!isPlainObject(body)) return ['needs a body with the monitor settings ({ "type", "path", "interval", ... }); PUT replaces the whole monitor'];
  const problems = readOnlyProblems(body, MONITOR_READ_ONLY);
  if ('type' in body && !MONITOR_TYPES.includes(body.type)) problems.push(`type must be one of ${list(MONITOR_TYPES)}`);
  for (const key of MONITOR_NUMBERS) {
    if (key in body && !(Number.isInteger(body[key]) && body[key] >= 0)) problems.push(`${key} must be a whole number`);
  }
  return problems;
}

function validatePool(op) {
  const body = op.body;
  if (!isPlainObject(body)) return ['needs a body { "name", "origins": [...], "monitor", ... }; PUT replaces the whole pool'];
  const problems = readOnlyProblems(body, ['id', 'created_on', 'modified_on', 'disabled_at']);
  if (!nonEmpty(body.name)) problems.push('needs a non-empty string name');
  if (!Array.isArray(body.origins) || body.origins.length === 0) {
    problems.push('origins must be a non-empty array of { "name", "address" } entries');
  } else {
    body.origins.forEach((origin, i) => {
      if (!isPlainObject(origin) || !nonEmpty(origin.address)) {
        problems.push(`origins.${i} needs a string address`);
        return;
      }
      if ('enabled' in origin && typeof origin.enabled !== 'boolean') problems.push(`origins.${i}.enabled must be true or false`);
      if ('weight' in origin && !(typeof origin.weight === 'number' && origin.weight >= 0 && origin.weight <= 1)) problems.push(`origins.${i}.weight must be a number from 0 to 1`);
      if ('disabled_at' in origin) problems.push(`origins.${i}.disabled_at is set by Cloudflare and cannot be written`);
    });
  }
  if ('enabled' in body && typeof body.enabled !== 'boolean') problems.push('enabled must be true or false');
  if ('minimum_origins' in body && !(Number.isInteger(body.minimum_origins) && body.minimum_origins >= 1)) problems.push('minimum_origins must be a whole number of at least 1');
  if ('monitor' in body && body.monitor !== null && !(typeof body.monitor === 'string' && ID_ONLY.test(body.monitor))) {
    problems.push('monitor must be a monitor id (32 hex characters) or null');
  }
  return problems;
}

function validateLb(op) {
  const body = op.body;
  if (!isPlainObject(body)) return ['needs a body { "name", "default_pools", "fallback_pool", ... }; PUT replaces the whole load balancer'];
  const problems = readOnlyProblems(body, LB_READ_ONLY);
  if (!nonEmpty(body.name)) problems.push('needs a non-empty string name (the hostname it serves)');
  if (!Array.isArray(body.default_pools) || body.default_pools.length === 0) {
    problems.push('default_pools must be a non-empty array of pool ids');
  } else {
    body.default_pools.forEach((id, i) => {
      if (typeof id !== 'string' || !ID_ONLY.test(id)) problems.push(`default_pools.${i} must be a pool id (32 hex characters)`);
    });
  }
  if (typeof body.fallback_pool !== 'string' || !ID_ONLY.test(body.fallback_pool)) problems.push('fallback_pool must be a pool id (32 hex characters)');
  if ('enabled' in body && typeof body.enabled !== 'boolean') problems.push('enabled must be true or false');
  return problems;
}

// ---------- kinds ----------

const account = { product: 'load_balancing', scope: 'account', destructive: false };
const zone = { product: 'load_balancing', scope: 'zone', destructive: false };

// create (delete_created), update (PUT, put_before), delete (re-created on
// rollback with a new id). All three inverses get a drift baseline from the
// engine's post read (Ruling 8).
function crud(shared, { prefix, collection, type, readOnlyFields, validate, nameField, notes = {} }) {
  const one = new RegExp(`^${collection}/${ID}$`);
  const resource = (m) => ({ type, id: m[1] });
  return [
    {
      ...shared, kind: `${prefix}_create`, methods: ['POST'], pattern: new RegExp(`^${collection}$`), resource: () => null,
      readOnlyFields, inverse: 'delete_created', validate, ...(notes.create ? { notes: notes.create } : {}),
    },
    {
      ...shared, kind: `${prefix}_update`, methods: ['PUT'], pattern: one, resource,
      readOnlyFields, inverse: 'put_before', validate, ...(notes.update ? { notes: notes.update } : {}),
    },
    {
      ...shared, kind: `${prefix}_delete`, methods: ['DELETE'], pattern: one, resource,
      readOnlyFields, inverse: 'recreate', destructive: true, nameField, ...(notes.delete ? { notes: notes.delete } : {}),
    },
  ];
}

const KINDS = [
  // A monitor has no name; its description is what the dashboard lists.
  ...crud(account, {
    prefix: 'lb_monitor', collection: '/load_balancers/monitors', type: 'lb_monitor', readOnlyFields: MONITOR_READ_ONLY,
    validate: validateMonitor, nameField: 'description', notes: { delete: (ctx, op) => notesMonitorDelete(ctx, op) },
  }),
  ...crud(account, {
    prefix: 'lb_pool', collection: '/load_balancers/pools', type: 'lb_pool', readOnlyFields: POOL_READ_ONLY,
    validate: validatePool, nameField: 'name',
    notes: { create: () => notesPoolCreate(), update: (ctx, op) => notesPoolUpdate(ctx, op), delete: (ctx, op) => notesPoolDelete(ctx, op) },
  }),
  ...crud(zone, {
    prefix: 'lb', collection: '/load_balancers', type: 'lb', readOnlyFields: LB_READ_ONLY, validate: validateLb, nameField: 'name',
    notes: { create: (ctx, op) => notesLbWrite(ctx, op), update: (ctx, op) => notesLbWrite(ctx, op), delete: (ctx, op) => notesLbDelete(ctx, op) },
  }),
];

// { kind, id } of a Load Balancing op from its path alone (lockoutRisks and
// notes get no plan); null for any other op.
function parse(op) {
  const target = opTarget(op);
  const hit = target && matchKind(KINDS, op.method, target.scope, target.rest);
  return hit ? { kind: hit.entry.kind, id: hit.match[1] ?? null } : null;
}

// ---------- pool state helpers ----------

function summarizePool(pool, id = pool?.id) {
  const origins = Array.isArray(pool?.origins) ? pool.origins : [];
  return {
    id: id ?? null,
    name: nonEmpty(pool?.name) ? pool.name : (id ?? 'new pool'),
    enabled: pool?.enabled !== false,
    origins: origins.map((o) => ({ name: o?.name ?? o?.address ?? '?', enabled: o?.enabled !== false })),
    minimum_origins: Number.isInteger(pool?.minimum_origins) ? pool.minimum_origins : 1,
    monitor: nonEmpty(pool?.monitor) ? pool.monitor : null,
  };
}

const enabledOrigins = (pool) => pool.origins.filter((o) => o.enabled).length;

// A pool can serve when it is enabled and enough origins are enabled for
// minimum_origins.
function usable(pool) {
  return pool.enabled && enabledOrigins(pool) >= Math.max(1, pool.minimum_origins);
}

// Every pool a load balancer body names, in order, without repeats.
function lbPools(body) {
  const ids = [...(Array.isArray(body?.default_pools) ? body.default_pools : []), body?.fallback_pool];
  for (const field of ['region_pools', 'pop_pools', 'country_pools']) {
    for (const value of Object.values(isPlainObject(body?.[field]) ? body[field] : {})) if (Array.isArray(value)) ids.push(...value);
  }
  return [...new Set(ids.filter((id) => typeof id === 'string' && ID_ONLY.test(id)))];
}

function poolLabel(ctx, id, fallback) {
  const name = ctx?.pools?.[id]?.name ?? fallback;
  return name && name !== id ? `${name} (${id})` : id;
}

// ---------- gather ----------

// What references a monitor or pool: only `referrer` entries (and `*`), so a
// pool's own monitor (a `referral`) never counts as a user.
async function readReferrers(client, path) {
  const refs = await withPermission(PERM.read, path, () => client.request('GET', path));
  if (refs === null || refs === undefined) return [];
  if (!Array.isArray(refs)) throw new CfError('api', `${path} did not return a list`);
  return refs
    .filter((r) => r?.reference_type === 'referrer' || r?.reference_type === '*')
    .map((r) => ({ type: r.resource_type ?? 'resource', id: r.resource_id ?? null, name: r.resource_name ?? r.resource_id ?? 'unnamed' }));
}

function failureReasons(result) {
  const reasons = new Set();
  for (const origin of Array.isArray(result?.origins) ? result.origins : []) {
    const entries = isPlainObject(origin) && 'healthy' in origin ? [origin] : Object.values(isPlainObject(origin) ? origin : {});
    for (const e of entries) if (e?.healthy === false && nonEmpty(e.failure_reason)) reasons.add(e.failure_reason);
  }
  return [...reasons].slice(0, 3);
}

// The pool preview (spec 5.5): advisory, so every API failure becomes a
// skip reason. Errors that are not CfErrors are bugs and propagate.
async function runPreview(client, acc, poolId, monitorId) {
  if (!monitorId) return { skipped: 'the pool has no monitor to probe with' };
  try {
    const monitor = await client.request('GET', `${acc}/load_balancers/monitors/${monitorId}`);
    const started = await client.request('POST', `${acc}/load_balancers/pools/${poolId}/preview`, { body: omitPaths(monitor ?? {}, MONITOR_READ_ONLY) });
    const previewId = started?.preview_id;
    if (typeof previewId !== 'string' || !SAFE_SEGMENT.test(previewId)) return { skipped: 'Cloudflare returned no preview id' };
    const results = await client.request('GET', `${acc}/load_balancers/preview/${previewId}`);
    const own = results?.[poolId];
    if (typeof own?.healthy !== 'boolean') return { skipped: 'no result yet (the preview runs asynchronously)' };
    return { healthy: own.healthy, reasons: failureReasons(own) };
  } catch (err) {
    if (!(err instanceof CfError)) throw err;
    if (err.code === 'permission') return { skipped: `the token cannot run it; it needs "${PERM.edit}"` };
    return { skipped: `the API answered ${err.code}` };
  }
}

async function gatherAccount(client, base, items) {
  const get = (path, permission = PERM.read) => withPermission(permission, path, () => client.request('GET', path));
  const ctx = { scope: 'account', pools: {}, monitors: {}, referrers: {}, cleared: {}, lb_backups: {}, preview: {} };
  const ids = (kinds) => [...new Set(items.filter((p) => kinds.includes(p.kind)).map((p) => p.id))];

  for (const id of ids(['lb_pool_update', 'lb_pool_delete'])) {
    ctx.pools[id] = summarizePool(await get(`${base}/load_balancers/pools/${id}`), id);
    ctx.referrers[id] = await readReferrers(client, `${base}/load_balancers/pools/${id}/references`);
  }
  for (const id of ids(['lb_monitor_update', 'lb_monitor_delete'])) {
    const monitor = await get(`${base}/load_balancers/monitors/${id}`);
    ctx.monitors[id] = { description: nonEmpty(monitor?.description) ? monitor.description : null, interval: monitor?.interval ?? null };
  }
  for (const id of ids(['lb_monitor_delete'])) {
    ctx.referrers[id] = await readReferrers(client, `${base}/load_balancers/monitors/${id}/references`);
    // Pools this plan deletes, or moves to another monitor, before the
    // monitor delete no longer use it.
    const at = items.find((p) => p.kind === 'lb_monitor_delete' && p.id === id).index;
    ctx.cleared[id] = items
      .filter((p) => p.index < at && (p.kind === 'lb_pool_delete' || (p.kind === 'lb_pool_update' && p.op.body?.monitor !== id)))
      .map((p) => p.id);
  }

  // A pool update that leaves the pool unable to serve: which load balancers
  // keep another usable pool. Every pool is read, to the last page.
  const updates = items.filter((p) => p.kind === 'lb_pool_update');
  const broken = new Set(updates.filter((p) => !usable(summarizePool(p.op.body, p.id))).map((p) => p.id));
  const strandable = [...broken].some((id) => ctx.referrers[id]?.some((r) => r.type === 'load_balancer'));
  if (strandable) {
    const planned = new Map(updates.map((p) => [p.id, summarizePool(p.op.body, p.id)]));
    const all = await withPermission(PERM.read, `${base}/load_balancers/pools`, () => listAll(client, `${base}/load_balancers/pools`));
    for (const pool of all) {
      if (!nonEmpty(pool?.id) || broken.has(pool.id)) continue;
      if (!usable(planned.get(pool.id) ?? summarizePool(pool))) continue;
      for (const ref of await readReferrers(client, `${base}/load_balancers/pools/${pool.id}/references`)) {
        if (ref.type !== 'load_balancer' || !ref.id) continue;
        (ctx.lb_backups[ref.id] ??= []).push(pool.name ?? pool.id);
      }
    }
    for (const id of broken) {
      for (const ref of ctx.referrers[id] ?? []) if (ref.type === 'load_balancer' && ref.id) ctx.lb_backups[ref.id] ??= [];
    }
  }

  for (const p of updates) {
    if (p.id in ctx.preview) continue;
    const monitor = 'monitor' in (p.op.body ?? {}) ? p.op.body.monitor : ctx.pools[p.id]?.monitor;
    ctx.preview[p.id] = await runPreview(client, base, p.id, nonEmpty(monitor) ? monitor : null);
  }
  return ctx;
}

async function gatherZone(client, base, items) {
  const zoneRead = await withPermission(PERM.zone, base, () => client.request('GET', base));
  const accountId = zoneRead?.account?.id;
  if (typeof accountId !== 'string' || !ID_ONLY.test(accountId)) throw new CfError('api', `${base} did not name its account`);
  const acc = `/accounts/${accountId}`;
  const lbs = await withPermission(PERM.lbRead, `${base}/load_balancers`, () => listAll(client, `${base}/load_balancers`));
  const pools = await withPermission(PERM.read, `${acc}/load_balancers/pools`, () => listAll(client, `${acc}/load_balancers/pools`));
  const ctx = {
    scope: 'zone',
    account_base: acc,
    lbs: Object.fromEntries(lbs.filter((lb) => nonEmpty(lb?.id)).map((lb) => [lb.id, { name: lb.name ?? lb.id, pools: lbPools(lb), enabled: lb.enabled !== false }])),
    pools: Object.fromEntries(pools.filter((p) => nonEmpty(p?.id)).map((p) => [p.id, summarizePool(p)])),
    preview: {},
  };
  // Preview the pools a load balancer write adds; a load balancer with a
  // single pool gets that pool previewed even when it is not new.
  for (const p of items.filter((i) => i.kind === 'lb_create' || i.kind === 'lb_update')) {
    const refs = lbPools(p.op.body);
    const current = p.kind === 'lb_update' ? (ctx.lbs[p.id]?.pools ?? []) : [];
    const wanted = refs.length === 1 ? refs : refs.filter((id) => !current.includes(id));
    for (const id of wanted) {
      if (id in ctx.preview) continue;
      ctx.preview[id] = ctx.pools[id]
        ? await runPreview(client, acc, id, ctx.pools[id].monitor)
        : { skipped: 'the pool is not in this account' };
    }
  }
  return ctx;
}

// Reads for lockout analysis, dependencies, notes and verification.
async function gather(client, base, ops) {
  const items = ops.map((op, index) => ({ ...parse(op), op, index })).filter((p) => p.kind);
  return isZone(base) ? gatherZone(client, base, items) : gatherAccount(client, base, items);
}

// resource_in_use only (Ruling 15): a monitor or pool that something still
// references cannot be deleted (spec 5.5). Preflight checks this itself.
function dependencies(ctx, op, entry) {
  if (entry.kind !== 'lb_pool_delete' && entry.kind !== 'lb_monitor_delete') return [];
  const id = parse(op)?.id;
  const cleared = new Set(ctx?.cleared?.[id] ?? []);
  return (ctx?.referrers?.[id] ?? []).filter((r) => !cleared.has(r.id)).map((r) => `${String(r.type).replace(/_/g, ' ')} ${r.name}${r.id && r.id !== r.name ? ` (${r.id})` : ''}`);
}

// ---------- lockout analysis (spec 6 item 11, spec 5.5) ----------

function poolLines(ctx, p, body) {
  const after = summarizePool(body, p.id);
  if (usable(after)) return [];
  const label = poolLabel(ctx, p.id, after.name);
  const lbs = (ctx?.referrers?.[p.id] ?? []).filter((r) => r.type === 'load_balancer');
  const users = lbs.length ? `load balancers ${list(lbs.map((r) => r.name))} use it` : 'no load balancer uses it now';
  const n = enabledOrigins(after);
  const lines = [];
  if (after.origins.length && n === 0) {
    lines.push(`${LOCKOUT_PREFIX} pool ${label} would have no enabled origin (every origin has enabled: false), so the pool goes critical; ${users}, and they send its traffic to their other pools or fail when it was their last one. Enable at least one origin. ${HINT}`);
  } else if (after.enabled && after.minimum_origins > n) {
    lines.push(`${LOCKOUT_PREFIX} pool ${label} sets minimum_origins ${after.minimum_origins} above its ${n} enabled origin(s), so the pool goes critical; ${users}. Lower minimum_origins or enable more origins. ${HINT}`);
  }
  const stranded = lbs.filter((r) => Array.isArray(ctx?.lb_backups?.[r.id]) && ctx.lb_backups[r.id].length === 0).map((r) => r.name);
  if (stranded.length) {
    lines.push(`${LOCKOUT_PREFIX} pool ${label} is the last usable pool of load balancer${stranded.length > 1 ? 's' : ''} ${list(stranded)}; after this change ${stranded.length > 1 ? 'they have' : 'it has'} no enabled pool with enabled origins and visitors get errors. Keep this pool serving, or enable another pool first. ${HINT}`);
  }
  return lines;
}

function lbLines(ctx, p, body) {
  const name = nonEmpty(body?.name) ? body.name : (ctx?.lbs?.[p.id]?.name ?? p.id ?? 'new load balancer');
  const refs = lbPools(body);
  const lines = [];
  const known = refs.filter((id) => ctx?.pools?.[id]);
  if (refs.length && known.length === refs.length && known.every((id) => !usable(ctx.pools[id]))) {
    lines.push(`${LOCKOUT_PREFIX} load balancer ${name} would have no usable pool: ${list(known.map((id) => poolLabel(ctx, id)))} ${known.length > 1 ? 'are' : 'is'} disabled or without enough enabled origins, so ${name} fails for every visitor. Enable a pool or its origins first. ${HINT}`);
  }
  const only = refs.length === 1 ? ctx?.preview?.[refs[0]] : null;
  if (only?.healthy === false) {
    const why = only.reasons?.length ? ` (${list(only.reasons)})` : '';
    lines.push(`${LOCKOUT_PREFIX} load balancer ${name} has one pool, ${poolLabel(ctx, refs[0])}, and the preview found it critical${why}; ${name} fails for every visitor while it is. Fix the origins or add a healthy pool. ${HINT}`);
  }
  return lines;
}

function lockoutRisks(ctx, ops) {
  const lines = [];
  for (const op of ops) {
    const p = parse(op);
    if (p?.kind === 'lb_pool_update') lines.push(...poolLines(ctx, p, op.body));
    if (p?.kind === 'lb_create' || p?.kind === 'lb_update') lines.push(...lbLines(ctx, p, op.body));
  }
  return lines;
}

// ---------- notes ----------

function previewLine(ctx, id) {
  const label = poolLabel(ctx, id);
  const result = ctx?.preview?.[id];
  if (!result) return null;
  if (result.skipped) return `Pool ${label}: preview skipped: ${result.skipped}.`;
  if (result.healthy) return `Pool ${label}: the preview found it healthy.`;
  return `Pool ${label}: the preview found it critical${result.reasons?.length ? ` (${list(result.reasons)})` : ''}.`;
}

function notesPoolCreate() {
  return ['New pool: preview skipped: a pool has no id until apply. Verification waits for Healthy when the pool has a monitor and an enabled origin.'];
}

function notesPoolUpdate(ctx, op) {
  const id = parse(op)?.id;
  const line = previewLine(ctx, id);
  return line ? [`${line} The preview probes the origins the pool has now with the monitor it will use.`] : [];
}

function notesPoolDelete(ctx, op) {
  const id = parse(op)?.id;
  return [`A rollback re-creates pool ${poolLabel(ctx, id)} with a new id; load balancers written later must use the new id.`];
}

function notesMonitorDelete(ctx, op) {
  const id = parse(op)?.id;
  const description = ctx?.monitors?.[id]?.description;
  return [`A rollback re-creates monitor ${description ? `${description} (${id})` : id} with a new id; pools written later must use the new id.`];
}

function notesLbWrite(ctx, op) {
  const lines = lbPools(op.body).map((id) => previewLine(ctx, id)).filter(Boolean);
  if (op.body?.enabled === false) {
    lines.push(`Load balancer ${op.body?.name ?? parse(op)?.id} is disabled by this change: ${op.body?.name ?? 'its hostname'} no longer resolves through it.`);
  }
  return lines;
}

function notesLbDelete(ctx, op) {
  const id = parse(op)?.id;
  const name = ctx?.lbs?.[id]?.name;
  const host = name ?? `the hostname of load balancer ${id}`;
  return [`Deleting load balancer ${name ? `${name} (${id})` : id}: ${host} stops resolving through the load balancer; it answers only from a DNS record of the same name, if one exists. A rollback re-creates it with a new id.`];
}

// ---------- verification (spec 8) ----------

function skipped(name, detail) {
  return { name, once: true, run: async () => ({ ok: true, detail }) };
}

// Ruling 18: no Healthy wait that can only fail.
function healthSkip(state, preview) {
  const pool = summarizePool(state);
  if (!pool.monitor) return 'the pool has no monitor, so Cloudflare reports no health for it';
  if (!pool.enabled) return 'the pool is disabled';
  if (enabledOrigins(pool) === 0) return 'every origin is disabled';
  if (pool.minimum_origins > enabledOrigins(pool)) return 'minimum_origins is above the enabled origins';
  if (preview?.healthy === false) return 'the preflight preview found the pool critical; fix the origins, then check the pool health';
  return null;
}

// Read-back for every changed resource (deletes leave nothing to read), plus
// a wait for the pool to report Healthy on created or updated pools.
function verifyChecks(op, entry, ctx, result, post, deps) {
  if (String(op.method).toUpperCase() === 'DELETE') return [];
  const checks = [readbackCheck(post, op.body, entry.readOnlyFields)];
  if (entry.kind !== 'lb_pool_create' && entry.kind !== 'lb_pool_update') return checks;
  const readPath = deps?.readPath;
  const name = `pool_healthy ${readPath ?? op.path}`;
  const id = entry.kind === 'lb_pool_update' ? parse(op)?.id : null;
  const skip = healthSkip(isPlainObject(post) ? post : op.body, id ? ctx?.preview?.[id] : null);
  if (skip) checks.push(skipped(name, `skipped: ${skip}`));
  else if (deps?.client && readPath) checks.push(poolHealthyCheck(deps.client, readPath));
  else checks.push({ name, once: true, run: async () => ({ ok: false, detail: 'pool path unknown' }) });
  return checks;
}

// ---------- entitlement ----------

// The add-on is enabled when the pools list is readable and, for a zone plan,
// the zone's load balancer list is reachable (spec 5.5).
async function entitlement(client, base) {
  try {
    if (isZone(base)) {
      const zoneRead = await withPermission(PERM.zone, base, () => client.request('GET', base));
      const accountId = zoneRead?.account?.id;
      if (typeof accountId !== 'string' || !ID_ONLY.test(accountId)) throw new CfError('api', `${base} did not name its account`);
      await withPermission(PERM.read, `/accounts/${accountId}/load_balancers/pools`, () => client.request('GET', `/accounts/${accountId}/load_balancers/pools`));
      await withPermission(PERM.lbRead, `${base}/load_balancers`, () => client.request('GET', `${base}/load_balancers`));
      return { ok: true, detail: 'pools readable and the zone load balancer list reachable' };
    }
    await withPermission(PERM.read, `${base}/load_balancers/pools`, () => client.request('GET', `${base}/load_balancers/pools`));
    return { ok: true, detail: 'pools readable' };
  } catch (err) {
    if (err instanceof CfError && (err.code === 'plan' || err.code === 'not_found')) return { ok: false, detail: NOT_ENTITLED };
    throw err;
  }
}

/** @type {import('./index.mjs').ProductModule} */
export const LOAD_BALANCING = {
  product: 'load_balancing',
  kinds: KINDS,
  permission: (base) => (isZone(base) ? { read: PERM.lbRead, edit: PERM.lbEdit } : { read: PERM.read, edit: PERM.edit }),
  probePath: (base) => (isZone(base) ? `${base}/load_balancers` : `${base}/load_balancers/monitors`),
  entitlement,
  gather,
  dependencies,
  lockoutRisks,
  verifyChecks,
};
