// Registry of v3 product modules (Access, Tunnel, Gateway, ...). Each module
// lists kind entries; the shared REST engine snapshots, inverts, verifies and
// conflict-checks any op that matches one. Zone kinds of v1 stay in
// resources.mjs.

import { matchKind } from './match.mjs';
import { ACCESS } from './access.mjs';
import { DEVICES } from './devices.mjs';
import { GATEWAY } from './gateway.mjs';
import { LOAD_BALANCING } from './load-balancing.mjs';
import { SPECTRUM } from './spectrum.mjs';
import { TUNNEL } from './tunnel.mjs';

/**
 * One REST operation shape a product supports.
 * @typedef {object} ProductKind
 * @property {string} kind              Unique kind name (access_app_update).
 * @property {string} product           Owning product (access).
 * @property {'account'|'zone'} scope   Plan scope the kind belongs to.
 * @property {string[]} methods         Uppercase HTTP methods.
 * @property {RegExp} pattern           Matched against the path after baseFor(plan), query
 *   removed; must be anchored with ^ and $ (registerProduct checks).
 * @property {(m: RegExpExecArray) => ({ type: string, id: string } | null)} resource
 *   Conflict key; null when the op names no existing resource (a create).
 * @property {(m: RegExpExecArray, base: string) => string} [read]        Before-read path.
 * @property {(m: RegExpExecArray, base: string) => string} [collection]  POST path for `recreate`.
 * @property {(client: object, readPath: string, op: object, plan: object) => Promise<object>} [capture]
 *   Builds the before state when one GET of readPath does not hold it all (a Gateway list
 *   and its items, the rules of a phase); the engine then always takes a snapshot.
 * @property {(client: object, readPath: string, op: object) => Promise<object>} [capturePost]
 *   Builds the post-apply state instead of a plain GET of readPath (a Gateway rule plus the
 *   other rules of its phase). Drift prechecks still re-read with a plain GET, so the extra
 *   fields must be in readOnlyFields.
 * @property {string} [idField]       Apply result field holding a created resource's id when
 *   it is not `id` (a device profile answers `policy_id`); used by `delete_created` and the
 *   post read of a create.
 * @property {string[]} readOnlyFields  Fields dropped from `before` when it is sent back.
 * @property {string[]|((entry: object, applied: object[]) => string[])} [driftIgnore]
 *   Fields left out of drift prechecks only, because other kinds write them and have their
 *   own baselines (a device profile's split tunnel lists); unlike readOnlyFields they stay
 *   writable in bodies. A function gets the snapshot entry and the snapshot entries of the
 *   source plan's ops that ran.
 * @property {'delete_created'|'put_before'|'patch_before'|'recreate'|'none'|Function} inverse
 *   A function is called as inverse(snapshotEntry, applyResult, postRecord) and returns ops
 *   (postRecord is { read, state } or null). An op may carry `group` when its drift group
 *   depends on the apply result (a created id), and an op after the first may carry
 *   `drift: { read, expect }` to be checked against its own resource; the engine moves both
 *   into the drift precheck. An op may also target a resource an earlier inverse op re-creates:
 *   its path holds one `{created_id}` segment and `created_id_from: n` names the op n places
 *   earlier whose result id fills it at apply (rest-exec.mjs resolveCreatedId). A drift state
 *   may be an array (a whole list resource).
 * @property {boolean} destructive      True when the op needs `confirm_name`.
 * @property {string|((before: object) => string)} [nameField]  Live field `confirm_name` is
 *   compared with at preflight, or a function of the live resource (a monitor without a
 *   description is confirmed by its id).
 * @property {string[]} [secretFields]  Body paths that must come from `secret_fields_from_env`.
 * @property {string[]} [redact]        Response paths redacted before anything is stored.
 * @property {string[]} [secretSink]    Response paths holding a secret the user must fetch out of band.
 * @property {(m: RegExpExecArray) => string} [group]  Dependency group for rollback drift skips.
 * @property {(ctx: object, op: object) => string[]} [notes]  Extra risk lines.
 * @property {(op: object) => string[]} [validate]  Body problems; any one makes the op
 *   invalid_op at plan new, preflight and apply. Messages name field paths, never values.
 *   It may instead throw a CfError with a code of its own (too_large for a Gateway list).
 */

/**
 * One product: its kinds plus the hooks preflight, apply and verify call.
 * @typedef {object} ProductModule
 * @property {string} product
 * @property {ProductKind[]} kinds
 * @property {(client: object, base: string, ops: object[], opts: { rollback: boolean }) => Promise<{ ok: boolean, detail: string }>} [entitlement]
 *   ops are the plan's ops of this product, in plan order (Spectrum checks each app's protocol
 *   against the zone plan); the fourth argument is { rollback } (true for a rollback plan).
 * @property {{ read: string, edit: string }|((base: string) => { read: string, edit: string })} [permission]
 *   Token template permission names, or a function of the plan base for a product with kinds
 *   in both scopes (Load Balancing); a 403 on the probe names `edit` (then `read`, then the
 *   product) in missing_permission.
 * @property {(base: string) => string} probePath   Cheap GET proving token access.
 * @property {(client: object, base: string, ops: object[]) => Promise<object>} gather
 *   Account reads lockout and dependency checks need.
 * @property {(ctx: object, ops: object[]) => (string|{ line: string, advisory: true })[]} lockoutRisks
 *   Lines start with `Lockout risk:`. A line that rests on an asynchronous read (the Load
 *   Balancing pool preview) may appear at apply without having been shown at plan new; the
 *   module returns it as { line, advisory: true }, and apply records it instead of stopping
 *   with risk_changed.
 * @property {(ctx: object, op: object, entry: ProductKind) => string[]} [dependencies]
 *   Descriptions of what still uses the resource (resource_in_use).
 * @property {(op: object, entry: ProductKind, ctx: object, result: object, post: (object|null), deps: object) => object[]} verifyChecks
 *   Default post-apply checks (verify.mjs Check: { name, run, once? }) for one op that ran.
 *   ctx is the module's apply-time preflight ctx; rollback plans have none and pass {}, so a
 *   check that needs ctx is omitted or returns { ok: true, detail: 'skipped: no preflight
 *   context' } (read-back still runs). result is the stored apply result, post the redacted
 *   state read after the op (null when unread or deleted), deps { client, fetchImpl, connect,
 *   readPath }. Op `verify` checks are added by opVerifyChecks; read-back is the module's own.
 * @property {(ops: object[], classified: (object|null)[]) => void} [conflicts]
 *   Product conflict rules; throws plan_conflict. `classified[i]` is
 *   classifyProductOp(ops[i], plan) or null.
 */

/** @type {ProductModule[]} */
export const PRODUCTS = [];

const SECRET_PATH_LISTS = ['secretFields', 'redact', 'secretSink'];

// omitPaths and redactPaths cannot remove a value whose last path segment is
// `*` or an array index, so such a path would leave the secret in place.
// Redaction never touches `id`: delete_created inverses read it from results.
function assertSecretPaths(module, entry) {
  const fail = (why) => {
    throw new TypeError(`Product ${module.product} kind ${entry?.kind} ${why}`);
  };
  for (const list of SECRET_PATH_LISTS) {
    const value = entry?.[list];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every((p) => typeof p === 'string' && p !== '')) fail(`${list} must be an array of field paths`);
    for (const path of value) {
      const last = path.split('.').pop();
      if (last === '*' || /^\d+$/.test(last)) fail(`${list} path ${path}: the last segment must be a field name, not * or an index`);
      if (list !== 'secretFields' && path === 'id') fail(`${list} must not name id (rollback reads it from the apply result)`);
    }
  }
}

// Returns a function that removes the module again (tests use it so
// registrations do not leak between files).
// Every kind pattern must be anchored at both ends, or a pattern could match a
// prefix or suffix of a longer path. Kind names must be unique across all
// modules, because rollback resolves a snapshot entry's kind by name. Throws
// before anything is registered.
export function registerProduct(module) {
  const names = new Set();
  for (const entry of module?.kinds ?? []) {
    if (names.has(entry?.kind) || kindByName(entry?.kind)) {
      throw new TypeError(`Product ${module.product} kind ${entry?.kind} is already registered`);
    }
    names.add(entry?.kind);
    const source = entry?.pattern instanceof RegExp ? entry.pattern.source : '';
    if (!source.startsWith('^') || !source.endsWith('$') || /(?:^|[^\\])(?:\\\\)*\\\$$/.test(source)) {
      throw new TypeError(`Product ${module.product} kind ${entry?.kind} needs a RegExp pattern anchored with ^ and $`);
    }
    assertSecretPaths(module, entry);
  }
  PRODUCTS.push(module);
  return () => {
    const at = PRODUCTS.indexOf(module);
    if (at !== -1) PRODUCTS.splice(at, 1);
  };
}

// Snapshot entries name their kind, so rollback can resolve it without the
// plan. Null when no registered module has that kind.
export function kindByName(name) {
  for (const module of PRODUCTS) {
    const entry = module.kinds.find((k) => k.kind === name);
    if (entry) return entry;
  }
  return null;
}

export function baseFor(plan) {
  return plan?.scope === 'account' ? `/accounts/${plan.account_id}` : `/zones/${plan?.zone_id}`;
}

// First kind whose scope, method and pattern match; null without a plan or a
// match. Paths outside the plan's own base never match.
export function classifyProductOp(op, plan) {
  if (!plan || !op || typeof op !== 'object' || 'kind' in op) return null;
  const scope = plan.scope === 'account' ? 'account' : 'zone';
  const path = String(op.path ?? '');
  const base = baseFor(plan);
  if (!path.startsWith(`${base}/`)) return null;
  // The query never takes part in matching; validateProductFields refuses it.
  const rest = path.split('?')[0].slice(base.length);
  for (const module of PRODUCTS) {
    const hit = matchKind(module.kinds, op.method, scope, rest);
    if (hit) return { ...hit, module, base };
  }
  return null;
}

// First path segment a kind's pattern fixes (`load_balancers` for
// /^\/load_balancers\/([0-9a-f]{32})$/); null when it starts with a group.
export function ownedCollection(entry) {
  const m = /^\^\/([A-Za-z0-9_-]+)(?:\\?\/|\$|\(|\?)/.exec(entry.pattern.source.replace(/\\\//g, '/'));
  return m ? m[1].toLowerCase() : null;
}

// A path segment belongs to a collection when it is the collection, or the
// collection followed by a character outside [a-z0-9_] (`load_balancers;x`,
// `load_balancers.json`, `load_balancers,`), so `load_balancers_custom` stays
// open. resources.mjs uses it for the zone Access refusal too.
export function segmentOwned(segment, collection) {
  if (typeof segment !== 'string' || segment === '') return false;
  if (segment === collection) return true;
  return segment.startsWith(collection) && !/[a-z0-9_]/.test(segment[collection.length]);
}

// Deliberately three rounds: enough for double and triple encoding
// (%25256c is l), bounded so a crafted path cannot loop.
const DECODE_ROUNDS = 3;

// Tolerant percent-decoding: each valid %XX becomes its byte as a character
// and an invalid escape (%ZZ, a lone %) stays as it is, so one bad escape
// elsewhere in the path cannot stop the decoding of the segment that matters.
const decodeEscapes = (text) => text.replace(/%[0-9a-f]{2}/gi, (hex) => String.fromCharCode(parseInt(hex.slice(1), 16)));

// Path canonical for ownership checks: decoded until it stops changing (at
// most DECODE_ROUNDS rounds), lowercased, no repeated or trailing slashes.
// base is the plan base to strip ('' keeps the whole path).
export function canonicalRest(path, base = '') {
  let decoded = String(path).split('?')[0].slice(base.length);
  for (let round = 0; round < DECODE_ROUNDS; round++) {
    const next = decodeEscapes(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  return decoded.toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '');
}

// Zone plans accept other zone writes under the v1 open policy (spec 4.3),
// but a collection a zone product kind owns (its first path segment, such as
// load_balancers) is written only through those kinds (Ruling 26). Returns
// { product, collection, methods } for a non-GET zone op inside such a
// collection that matches no kind exactly (another method, a trailing slash,
// an uppercase or percent-encoded segment, an extra subpath), else null.
export function zoneProductPathOwner(op, plan) {
  if (!plan || plan.scope === 'account' || !op || typeof op !== 'object' || 'kind' in op) return null;
  if (String(op.method ?? '').toUpperCase() === 'GET' || classifyProductOp(op, plan)) return null;
  const path = String(op.path ?? '');
  const base = baseFor(plan);
  if (!path.startsWith(`${base}/`)) return null;
  const rest = canonicalRest(path, base);
  const first = rest.split('/')[1];
  if (!first) return null;
  for (const module of PRODUCTS) {
    const owners = module.kinds.filter((k) => {
      const collection = k.scope === 'zone' ? ownedCollection(k) : null;
      return collection !== null && segmentOwned(first, collection);
    });
    if (owners.length) return { product: module.product, collection: ownedCollection(owners[0]), methods: [...new Set(owners.flatMap((k) => k.methods))] };
  }
  return null;
}

// Product modules shipped with claudeflare.
registerProduct(TUNNEL);
registerProduct(ACCESS);
registerProduct(GATEWAY);
registerProduct(DEVICES);
registerProduct(LOAD_BALANCING);
registerProduct(SPECTRUM);
