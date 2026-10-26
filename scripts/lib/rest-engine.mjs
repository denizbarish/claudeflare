// Shared REST engine for v3 product kinds (products/index.mjs): takes the
// before-snapshot of a product op and builds its rollback inverse from the
// kind's `inverse` (spec 4.4). Snapshot entries are self-contained, because
// rollback runs without the plan.

import { CfError } from './errors.mjs';
import { kindByName } from './products/index.mjs';
import { omitPaths } from './products/fields.mjs';

const READ_BEFORE = new Set(['put_before', 'patch_before', 'recreate']);
// Ids from apply results become a path segment of the DELETE inverse and of
// the post read.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function ambiguous(message) {
  return new CfError('rollback_ambiguous', message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parentPath(path) {
  return path.slice(0, path.lastIndexOf('/'));
}

// classified is classifyProductOp(op, plan). The default inverses that send
// `before` back read the resource; `none` and function inverses read only when
// the kind names a read path. Any read error propagates so apply aborts before
// any write.
export async function captureProductEntry(client, op, classified, plan) {
  const { entry, match, base } = classified;
  const path = String(op.path);
  const capture = typeof entry.capture === 'function' ? entry.capture : null;
  const wantsRead = READ_BEFORE.has(entry.inverse) || capture !== null || (typeof entry.read === 'function' && entry.inverse !== 'delete_created');
  const readPath = entry.read ? entry.read(match, base) : path.split('?')[0];
  // Snapshots store only non-secret fields (spec 5.1): secret and redacted
  // paths are omitted, so default inverse bodies never carry them either. A
  // kind whose state spans more than one read (a Gateway list and its items)
  // supplies its own capture; it also gets the op and the plan.
  const read = wantsRead ? await (capture ? capture(client, readPath, op, plan) : client.request('GET', readPath)) : null;
  const before = read === null ? null : omitPaths(read, [...(entry.secretFields ?? []), ...(entry.redact ?? [])]);
  const out = {
    product: entry.product,
    kind: entry.kind,
    path,
    before,
    invertible: entry.inverse !== 'none',
    op_body_keys: isPlainObject(op.body) ? Object.keys(op.body) : [],
  };
  // Field paths only, never values: a function inverse can tell that the op
  // sent a secret it cannot restore (an IdP client secret).
  if (isPlainObject(op.secret_fields_from_env)) out.secret_fields = Object.keys(op.secret_fields_from_env);
  if (entry.group) out.group = entry.group(match);
  if (entry.inverse === 'recreate') out.collection = entry.collection ? entry.collection(match, base) : parentPath(path.split('?')[0]);
  return out;
}

function putBefore(entry, kind) {
  if (!isPlainObject(entry.before)) throw ambiguous(`No before state recorded for ${entry.path}`);
  return [{ method: 'PUT', path: entry.path, body: omitPaths(entry.before, kind.readOnlyFields) }];
}

const INVERSES = {
  delete_created: (entry, kind, applyResult) => {
    const id = applyResult?.id;
    if ((typeof id !== 'string' && typeof id !== 'number') || !SAFE_ID.test(String(id))) {
      throw ambiguous(`No usable id in apply result for ${entry.path}`);
    }
    return [{ method: 'DELETE', path: `${entry.path}/${id}` }];
  },
  put_before: (entry, kind) => putBefore(entry, kind),
  // Restores only the top-level keys the op body set. A key the resource did
  // not have cannot be unset by PATCH.
  patch_before: (entry, kind) => {
    const before = isPlainObject(entry.before) ? entry.before : {};
    const keys = entry.op_body_keys ?? [];
    const missing = keys.filter((key) => !Object.hasOwn(before, key) || before[key] === undefined);
    if (missing.length) {
      if (kind.putFallback) return putBefore(entry, kind);
      throw ambiguous(`PATCH ${entry.path} set ${missing.join(', ')}, absent before; it cannot be restored with PATCH`);
    }
    const body = {};
    for (const key of keys) body[key] = before[key];
    return [{ method: 'PATCH', path: entry.path, body }];
  },
  recreate: (entry, kind) => {
    if (!isPlainObject(entry.before)) throw ambiguous(`No before state recorded for ${entry.path}`);
    if (typeof entry.collection !== 'string') throw ambiguous(`No collection path recorded for ${entry.path}`);
    return [{ method: 'POST', path: entry.collection, body: omitPaths(entry.before, kind.readOnlyFields) }];
  },
  none: () => [],
};

// Path the drift baseline of a product op is read from: the created resource
// for a create (id from the apply result; undefined without a usable id),
// otherwise the kind's read path or the op path. A DELETE gets the path of the
// resource it removed; executeRestOps does not read it after apply.
export function productReadPath(op, classified, result) {
  const { entry, match, base } = classified;
  const path = String(op.path).split('?')[0];
  if (String(op.method).toUpperCase() !== 'DELETE' && entry.resource(match) === null) {
    const id = result?.id;
    return (typeof id === 'string' || typeof id === 'number') && SAFE_ID.test(String(id)) ? `${path}/${id}` : undefined;
  }
  return entry.read ? entry.read(match, base) : path;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

// Deep equality independent of key order; array order counts. `ignore` holds
// field paths (fields.mjs syntax) left out of both sides.
export function stableEqual(a, b, ignore = []) {
  const strip = (value) => (isPlainObject(value) && ignore.length ? omitPaths(value, ignore) : value);
  return JSON.stringify(canonical(strip(a))) === JSON.stringify(canonical(strip(b)));
}

const POST_UNKNOWN = 'post-apply state unknown';

// Drift prechecks for the inverse ops of one product snapshot entry (spec 4.4).
// record is the entry's post file record { read, state } or null; state
// { absent: true } marks a deleted resource. Only the first op re-reads the
// resource: later ops of the same source would see the first op's own write,
// so they carry just the group and skip together with it, unless an op names
// a baseline of its own in `drift`.
export function withDriftPrecheck(entry, ops, record) {
  if (!ops.length) return ops;
  const kind = kindByName(entry.kind);
  // A function inverse may tag its ops with a group known only after apply.
  const tagged = ops.find((op) => typeof op.group === 'string')?.group;
  const group = entry.group ?? tagged ?? (ops.length > 1 ? `op-${entry.op_index}` : undefined);
  const grouped = group === undefined ? {} : { group };
  const state = record?.state;
  // Read-only and secret fields never take part in the comparison.
  const ignore = kind ? [...new Set([...(kind.readOnlyFields ?? []), ...(kind.secretFields ?? []), ...(kind.redact ?? []), ...(kind.secretSink ?? [])])] : [];
  let first;
  if (!kind || !isPlainObject(state) || typeof record.read !== 'string' || record.op_index !== entry.op_index) {
    first = { kind: 'drift', unknown: true, ...grouped };
  } else {
    const expect = state.absent === true ? { absent: true } : omitPaths(state, ignore);
    first = { kind: 'drift', read: record.read, expect, ignore, ...grouped };
  }
  // A later op on another resource may name its own baseline in `drift`
  // ({ read, expect }: a Gateway rule the API moved during apply).
  const own = (drift) => {
    if (!kind || !isPlainObject(drift) || typeof drift.read !== 'string' || !isPlainObject(drift.expect)) return { kind: 'drift', ...grouped };
    return { kind: 'drift', read: drift.read, expect: omitPaths(drift.expect, ignore), ignore, ...grouped };
  };
  return ops.map(({ group: _tag, drift, ...op }, i) => ({ ...op, precheck: i === 0 ? first : own(drift) }));
}

// Runs one drift precheck before its rollback op. Null when the op may run,
// otherwise the reason it is skipped. Fails closed: an unknown baseline, a
// read path outside the plan's base or any read error is drift; only an
// expected absence accepts not_found.
export async function driftDetail(client, precheck, { base } = {}) {
  if (precheck?.unknown) return POST_UNKNOWN;
  if (typeof precheck?.read !== 'string') return null;
  const { read, expect } = precheck;
  if (typeof base !== 'string' || !read.startsWith(`${base}/`)) return `${read} is outside the plan's account or zone`;
  const absent = expect?.absent === true;
  let live;
  try {
    live = await client.request('GET', read);
  } catch (err) {
    if (absent && err instanceof CfError && err.code === 'not_found') return null;
    return `${read} could not be read (${err?.code || 'internal'})`;
  }
  if (absent) return `${read} exists again after apply`;
  return stableEqual(live, expect, precheck.ignore ?? []) ? null : `${read} changed after apply`;
}

// entry is a snapshot entry from captureProductEntry. A kind that is no longer
// registered, or an inverse that cannot be built, throws rollback_ambiguous.
// record is the op's post file record ({ read, state }) or null; function
// inverses get it to undo side effects the API made during apply.
export function inverseForProduct(entry, applyResult, record = null) {
  const kind = kindByName(entry.kind);
  if (!kind) throw ambiguous(`Unknown product kind ${entry.kind} for ${entry.path}`);
  if (typeof kind.inverse === 'function') return kind.inverse(entry, applyResult, record);
  if (!entry.invertible) return [];
  const inverter = INVERSES[kind.inverse];
  if (!inverter) throw ambiguous(`Kind ${entry.kind} has no known inverse ${JSON.stringify(kind.inverse)}`);
  return inverter(entry, kind, applyResult);
}
