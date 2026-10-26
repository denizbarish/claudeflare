// Registry of v3 product modules (Access, Tunnel, Gateway, ...). Each module
// lists kind entries; the shared REST engine snapshots, inverts, verifies and
// conflict-checks any op that matches one. Zone kinds of v1 stay in
// resources.mjs.

/**
 * One REST operation shape a product supports.
 * @typedef {object} ProductKind
 * @property {string} kind              Unique kind name (access_app_update).
 * @property {string} product           Owning product (access).
 * @property {'account'|'zone'} scope   Plan scope the kind belongs to.
 * @property {string[]} methods         Uppercase HTTP methods.
 * @property {RegExp} pattern           Matched against the path after baseFor(plan), query
 *   removed; must be anchored with ^ and $ (registerProduct checks).
 * @property {boolean} [allowQuery]     Accept a query string on the op path (none do yet).
 * @property {(m: RegExpExecArray) => ({ type: string, id: string } | null)} resource
 *   Conflict key; null when the op names no existing resource (a create).
 * @property {(m: RegExpExecArray, base: string) => string} [read]        Before-read path.
 * @property {(m: RegExpExecArray, base: string) => string} [collection]  POST path for `recreate`.
 * @property {string[]} readOnlyFields  Fields dropped from `before` when it is sent back.
 * @property {'delete_created'|'put_before'|'patch_before'|'recreate'|'none'|Function} inverse
 *   A function is called as inverse(snapshotEntry, applyResult) and returns ops.
 * @property {boolean} [putFallback]    `patch_before` only: when the op set a key the
 *   resource did not have, roll back with PUT <path> and `before` instead of refusing.
 * @property {boolean} destructive      True when the op needs `confirm_name`.
 * @property {string} [nameField]       Live field `confirm_name` is compared with at preflight.
 * @property {string[]} [secretFields]  Body paths that must come from `secret_fields_from_env`.
 * @property {string[]} [redact]        Response paths redacted before anything is stored.
 * @property {string[]} [secretSink]    Response paths holding a secret the user must fetch out of band.
 * @property {(m: RegExpExecArray) => string} [group]  Dependency group for rollback drift skips.
 * @property {(ctx: object, op: object) => string[]} [notes]  Extra risk lines.
 */

/**
 * One product: its kinds plus the hooks preflight, apply and verify call.
 * @typedef {object} ProductModule
 * @property {string} product
 * @property {ProductKind[]} kinds
 * @property {(client: object, base: string) => Promise<{ ok: boolean, detail: string }>} [entitlement]
 * @property {(base: string) => string} probePath   Cheap GET proving token access.
 * @property {(client: object, base: string, ops: object[]) => Promise<object>} gather
 *   Account reads lockout and dependency checks need.
 * @property {(ctx: object, ops: object[]) => string[]} lockoutRisks  Lines start with `Lockout risk:`.
 * @property {(ctx: object, op: object, entry: ProductKind) => string[]} [dependencies]
 *   Descriptions of what still uses the resource (resource_in_use).
 * @property {(op: object, entry: ProductKind, ctx: object, result: object) => object[]} verifyChecks
 * @property {(ops: object[], classified: (object|null)[]) => void} [conflicts]
 *   Product conflict rules; throws plan_conflict. `classified[i]` is
 *   classifyProductOp(ops[i], plan) or null.
 */

/** @type {ProductModule[]} */
export const PRODUCTS = [];

// Returns a function that removes the module again (tests use it so
// registrations do not leak between files).
// Every kind pattern must be anchored at both ends, or a pattern could match a
// prefix or suffix of a longer path. Throws before anything is registered.
export function registerProduct(module) {
  for (const entry of module?.kinds ?? []) {
    const source = entry?.pattern instanceof RegExp ? entry.pattern.source : '';
    if (!source.startsWith('^') || !source.endsWith('$') || /(?:^|[^\\])(?:\\\\)*\\\$$/.test(source)) {
      throw new TypeError(`Product ${module.product} kind ${entry?.kind} needs a RegExp pattern anchored with ^ and $`);
    }
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
  const method = String(op.method ?? '').toUpperCase();
  const path = String(op.path ?? '');
  const base = baseFor(plan);
  if (!path.startsWith(`${base}/`)) return null;
  // The query never takes part in matching; validateProductFields refuses it
  // unless the kind sets allowQuery.
  const rest = path.split('?')[0].slice(base.length);
  for (const module of PRODUCTS) {
    for (const entry of module.kinds) {
      if (entry.scope !== scope || !entry.methods.includes(method)) continue;
      const match = entry.pattern.exec(rest);
      if (match) return { entry, module, match, base };
    }
  }
  return null;
}
