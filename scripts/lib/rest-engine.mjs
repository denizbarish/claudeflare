// Shared REST engine for v3 product kinds (products/index.mjs): takes the
// before-snapshot of a product op and builds its rollback inverse from the
// kind's `inverse` (spec 4.4). Snapshot entries are self-contained, because
// rollback runs without the plan.

import { CfError } from './errors.mjs';
import { kindByName } from './products/index.mjs';
import { omitPaths } from './products/fields.mjs';

const READ_BEFORE = new Set(['put_before', 'patch_before', 'recreate']);
// Ids from apply results become a path segment of the DELETE inverse.
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
export async function captureProductEntry(client, op, classified) {
  const { entry, match, base } = classified;
  const path = String(op.path);
  const wantsRead = READ_BEFORE.has(entry.inverse) || (typeof entry.read === 'function' && entry.inverse !== 'delete_created');
  const readPath = entry.read ? entry.read(match, base) : path.split('?')[0];
  const before = wantsRead ? await client.request('GET', readPath) : null;
  const out = {
    product: entry.product,
    kind: entry.kind,
    path,
    before,
    invertible: entry.inverse !== 'none',
    op_body_keys: isPlainObject(op.body) ? Object.keys(op.body) : [],
  };
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

// entry is a snapshot entry from captureProductEntry. A kind that is no longer
// registered, or an inverse that cannot be built, throws rollback_ambiguous.
export function inverseForProduct(entry, applyResult) {
  const kind = kindByName(entry.kind);
  if (!kind) throw ambiguous(`Unknown product kind ${entry.kind} for ${entry.path}`);
  if (typeof kind.inverse === 'function') return kind.inverse(entry, applyResult);
  if (!entry.invertible) return [];
  const inverter = INVERSES[kind.inverse];
  if (!inverter) throw ambiguous(`Kind ${entry.kind} has no known inverse ${JSON.stringify(kind.inverse)}`);
  return inverter(entry, kind, applyResult);
}
