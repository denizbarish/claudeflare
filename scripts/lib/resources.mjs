// Classifies a concrete plan op (no {zone_id} placeholders) into a resource
// kind that the snapshot module knows how to capture and invert.

import { CfError } from './errors.mjs';
import { classifyWranglerOp, DELETE_KINDS, DEPLOY_KINDS, isReservedEnvName, RESERVED_ENV_PREFIXES, validateWranglerOp } from './wrangler-ops.mjs';
import { classifyProductOp } from './products/index.mjs';
import { getPath } from './products/fields.mjs';

const ID = '[A-Za-z0-9]+';
// Setting ids and phase names contain underscores (always_use_https,
// http_request_firewall_custom), so they get a wider segment.
const NAME = '[A-Za-z0-9_]+';

// One entry per kind. `read` builds the before-read path from the regex
// match; kinds without `read` need no single before-read.
export const RESOURCE_KINDS = [
  {
    kind: 'zone_setting',
    methods: ['PATCH'],
    pattern: new RegExp(`^/zones/${ID}/settings/${NAME}$`),
    invertible: true,
    read: (m) => m[0],
  },
  {
    kind: 'zone_settings_bulk',
    methods: ['PATCH'],
    pattern: new RegExp(`^/zones/${ID}/settings$`),
    invertible: true,
  },
  {
    kind: 'dns_create',
    methods: ['POST'],
    pattern: new RegExp(`^/zones/${ID}/dns_records$`),
    invertible: true,
  },
  {
    kind: 'dns_update',
    methods: ['PUT', 'PATCH'],
    pattern: new RegExp(`^/zones/${ID}/dns_records/${ID}$`),
    invertible: true,
    read: (m) => m[0],
  },
  {
    kind: 'dns_delete',
    methods: ['DELETE'],
    pattern: new RegExp(`^/zones/${ID}/dns_records/${ID}$`),
    invertible: true,
    read: (m) => m[0],
  },
  {
    kind: 'rule_create',
    methods: ['POST'],
    pattern: new RegExp(`^(/zones/${ID}/rulesets/${ID})/rules$`),
    invertible: true,
    read: (m) => m[1],
  },
  {
    kind: 'rule_update',
    methods: ['PATCH'],
    pattern: new RegExp(`^(/zones/${ID}/rulesets/${ID})/rules/${ID}$`),
    invertible: true,
    read: (m) => m[1],
  },
  {
    kind: 'rule_delete',
    methods: ['DELETE'],
    pattern: new RegExp(`^(/zones/${ID}/rulesets/${ID})/rules/${ID}$`),
    invertible: true,
    read: (m) => m[1],
  },
  {
    kind: 'phase_entrypoint_put',
    methods: ['PUT'],
    pattern: new RegExp(`^/zones/${ID}/rulesets/phases/${NAME}/entrypoint$`),
    invertible: true,
    read: (m) => m[0],
  },
  {
    kind: 'purge_cache',
    methods: ['POST'],
    pattern: new RegExp(`^/zones/${ID}/purge_cache$`),
    invertible: false,
  },
];

export function classify(op) {
  const method = String(op?.method ?? '').toUpperCase();
  const path = String(op?.path ?? '');
  for (const entry of RESOURCE_KINDS) {
    if (!entry.methods.includes(method)) continue;
    const match = entry.pattern.exec(path);
    if (!match) continue;
    const result = { kind: entry.kind, invertible: entry.invertible };
    if (entry.read) result.readPath = entry.read(match);
    return result;
  }
  return { kind: 'unknown', invertible: false };
}

// Kinds whose before-snapshot would be stale if a second op in the same plan
// targeted the same resource. The op path identifies the resource.
const EXCLUSIVE_TARGET = {
  dns_update: 'DNS record',
  dns_delete: 'DNS record',
  rule_update: 'rule',
  rule_delete: 'rule',
  phase_entrypoint_put: 'phase entrypoint',
};

// `plan` is optional: without it product ops are not classified (0.2.x
// behavior). With it, product ops claim their resource key, never share a plan
// with wrangler ops and then go through each module's own conflict rules.
export function validatePlanOps(ops, plan) {
  const seen = new Map();
  const claim = (key, index, what) => {
    if (seen.has(key)) {
      throw new CfError(
        'plan_conflict',
        `Ops ${seen.get(key)} and ${index} both target ${what}; split them into separate plans`,
      );
    }
    seen.set(key, index);
  };
  const resources = new Map();
  const claimWrangler = (op, index) => {
    const { kind, resource } = classifyWranglerOp(op);
    // A deploy without a worker name targets the worker in the wrangler config.
    if (DEPLOY_KINDS.has(kind)) claim(`deploy ${resource?.name ?? ''}`, index, `deploys of the same worker (${resource?.name ?? 'from wrangler config'})`);
    if (!resource) return;
    const key = `${resource.type} ${resource.name}`;
    const isDelete = DELETE_KINDS.has(kind);
    const prior = resources.get(key);
    if (prior && (prior.isDelete || isDelete)) {
      throw new CfError('plan_conflict', `Ops ${prior.index} and ${index} both target ${key} and one deletes it; split them into separate plans`);
    }
    if (!prior || isDelete) resources.set(key, { index, isDelete });
  };
  const list = ops ?? [];
  const classified = list.map(() => null);
  let firstWrangler = -1;
  let firstProduct = -1;
  list.forEach((op, index) => {
    if (op?.kind === 'wrangler') {
      if (firstWrangler === -1) firstWrangler = index;
      claimWrangler(op, index);
      return;
    }
    const product = classifyProductOp(op, plan);
    if (product) {
      classified[index] = product;
      if (firstProduct === -1) firstProduct = index;
      // Any second op on the key conflicts, so a delete plus any op does too.
      const key = product.entry.resource(product.match);
      if (key) claim(`${key.type} ${key.id}`, index, `${key.type} ${key.id}`);
      return;
    }
    const { kind, readPath } = classify(op);
    const label = EXCLUSIVE_TARGET[kind];
    if (!label) return;
    claim(`${label} ${op.path}`, index, `the same ${label} (${op.path})`);
    // Restore positions are captured against the original ruleset, so only
    // one rule_delete per ruleset can be rolled back to the right position.
    if (kind === 'rule_delete') {
      claim(`rule_delete ${readPath}`, index, `rule deletes in the same ruleset (${readPath})`);
    }
  });
  if (firstWrangler !== -1 && firstProduct !== -1) {
    throw new CfError(
      'plan_conflict',
      `Ops ${Math.min(firstWrangler, firstProduct)} and ${Math.max(firstWrangler, firstProduct)} mix a product REST op with a wrangler op; split them into separate plans`,
    );
  }
  for (const module of new Set(classified.filter(Boolean).map((c) => c.module))) {
    module.conflicts?.(list, classified);
  }
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const PLACEHOLDER = /\{[^}]*\}/;
const PLACEHOLDER_SEGMENT = /^[A-Z][A-Z_]{2,}_ID$/;
const UNSAFE_CHARS = /[\u0000-\u001f\u007f\s#]/;
const PAGE_RULES = /\/pagerules(?:\/|$)/;

// URL parsing resolves "." and ".." (also percent-encoded), turns backslashes
// into slashes and reads "//" as a host. A path that does not survive parsing
// unchanged could reach a different resource than the one checked here.
function isNormalPath(path) {
  try {
    return new URL(path, 'https://x/').pathname === path.split('?')[0];
  } catch {
    return false;
  }
}

// Account plans accept product kinds (products/index.mjs) plus this Pages
// rollback write from 0.2.x (relative to /accounts/<id>).
const PAGES_ROLLBACK = /^\/pages\/projects\/[A-Za-z0-9-]+\/deployments\/[A-Za-z0-9-]+\/rollback$/;

function isPagesRollback(method, path, accountId) {
  const prefix = `/accounts/${accountId}`;
  return method === 'POST' && path.startsWith(`${prefix}/`) && PAGES_ROLLBACK.test(path.slice(prefix.length));
}

// Zero Trust lives on the account; the zone form of Access is refused. The
// test runs on the decoded, lowercased path part with empty segments
// collapsed, so %61ccess, Access and //access cannot slip past it. A path
// that does not decode counts as Access (refused).
const ZONE_ACCESS = /^\/zones\/[^/]+\/access(?:\/|$)/;

function isZoneAccess(path) {
  let decoded;
  try {
    decoded = decodeURIComponent(path.split('?')[0]);
  } catch {
    return true;
  }
  return ZONE_ACCESS.test(decoded.toLowerCase().replace(/\/{2,}/g, '/'));
}

const PRODUCT_FIELDS = ['confirm_name', 'verify', 'secret_fields_from_env'];
const VERIFY_KEYS = new Set(['expect', 'url']);
const VERIFY_EXPECT = /^(?:access_login|tunnel_serving|pool_healthy|tcp_open|status:[1-5][0-9]{2})$/;
const VERIFY_NEEDS_URL = /^(?:access_login|tcp_open|status:)/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

// Credentials in the URL would land in the plan file.
function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

function assertVerify(verify, reject) {
  if (!verify || typeof verify !== 'object' || Array.isArray(verify)) reject('verify must be an object { expect, url }');
  const unknown = Object.keys(verify).filter((key) => !VERIFY_KEYS.has(key));
  if (unknown.length) reject(`verify has unknown keys ${JSON.stringify(unknown)} (only expect and url)`);
  if (typeof verify.expect !== 'string' || !VERIFY_EXPECT.test(verify.expect)) {
    reject('verify.expect must be access_login, status:<100-599>, tunnel_serving, pool_healthy or tcp_open');
  }
  if ('url' in verify && !isHttpUrl(verify.url)) reject('verify.url must be an http or https URL without credentials');
  if (VERIFY_NEEDS_URL.test(verify.expect) && !('url' in verify)) reject(`verify.expect ${verify.expect} needs verify.url`);
}

// Error messages name field paths only, never body values: a literal there
// may be the secret itself.
function assertSecretFields(op, secretFields, reject) {
  for (const path of secretFields) {
    const value = getPath(op.body, path);
    const literal = path.split('.').includes('*') ? value.some((v) => v !== undefined) : value !== undefined;
    if (literal) reject(`carries a literal value at ${path}; leave it out of the body and map it in secret_fields_from_env`);
  }
  if (!('secret_fields_from_env' in op)) return;
  const map = op.secret_fields_from_env;
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    reject('secret_fields_from_env must be an object of body field path to env var name');
  }
  for (const [path, env] of Object.entries(map)) {
    // One secret must not fan out into every element of an array.
    if (path.split('.').includes('*')) {
      reject(`secret_fields_from_env names ${JSON.stringify(path)}; a path with * would copy one secret into every array element, so name one field`);
    }
    if (!secretFields.includes(path)) {
      reject(`secret_fields_from_env names ${JSON.stringify(path)}, which is not a secret field of this kind (${secretFields.join(', ') || 'none'})`);
    }
    if (typeof env !== 'string' || !ENV_NAME.test(env)) {
      reject(`secret_fields_from_env maps ${path} to an invalid env var name (must match ${ENV_NAME})`);
    }
    if (isReservedEnvName(env)) {
      reject(`secret_fields_from_env maps ${path} to ${env}; env names starting with ${RESERVED_ENV_PREFIXES.join(', ')} are claudeflare's own and cannot be sent`);
    }
  }
}

// Optional v3 op fields on an op that matched a product kind. confirm_name is
// only checked for shape here; preflight compares it with the live name.
export function validateProductFields(op, entry, index) {
  const reject = (why) => {
    throw new CfError('invalid_op', `Op ${index} (${entry.kind}) ${why}`);
  };
  // Kinds classify on the path without its query, so a query or an encoded
  // byte could reach a different resource than the one matched.
  const [pathPart, query] = String(op.path ?? '').split(/\?(.*)/s);
  if (pathPart.includes('%')) reject('must not contain percent-encoding in its path');
  if (query !== undefined && !entry.allowQuery) reject('must not carry a query string');
  if (entry.destructive || 'confirm_name' in op) {
    if (typeof op.confirm_name !== 'string' || op.confirm_name === '') {
      reject(entry.destructive ? 'is destructive and needs confirm_name equal to the resource name' : 'confirm_name must be a non-empty string');
    }
  }
  if ('verify' in op) assertVerify(op.verify, reject);
  assertSecretFields(op, entry.secretFields ?? [], reject);
  const problems = entry.validate?.(op) ?? [];
  if (problems.length) reject(problems.join('; '));
}

// Structural check; subcommand and flag rules live in wrangler-ops.mjs.
function assertWranglerOpShape(op, index) {
  const reject = (why) => {
    throw new CfError('invalid_op', `Op ${index} (wrangler) ${why}`);
  };
  if ('method' in op || 'path' in op || 'body' in op) reject('must not carry method, path or body');
  if (!Array.isArray(op.args) || op.args.length === 0) reject('needs a non-empty args array');
  if (!op.args.every((arg) => typeof arg === 'string')) reject('args must all be strings');
}

// Plan ops (after {zone_id} resolution) must stay inside the plan's own zone
// (zone plans, never its Access paths) or match a product kind or the Pages
// rollback (account plans), use a plain HTTP method, carry no leftover
// placeholders and never create a Page Rule. Product ops get their v3 fields
// checked; other REST ops may not carry them. Account plans also take
// `wrangler` ops. Runs on `plan new` and again in applyPlan on the exact ops
// sent.
export function validateOpTargets(ops, plan) {
  const account = plan?.scope === 'account';
  const prefix = `/zones/${plan?.zone_id}/`;
  (ops ?? []).forEach((op, index) => {
    if (op && typeof op === 'object' && 'kind' in op) {
      if (!account || op.kind !== 'wrangler') {
        throw new CfError('invalid_op', `Op ${index} has unsupported kind ${JSON.stringify(op.kind)} on ${account ? 'account' : 'zone'} plans`);
      }
      assertWranglerOpShape(op, index);
      validateWranglerOp(op, plan, index);
      return;
    }
    const { method, path } = op ?? {};
    const reject = (why) => {
      throw new CfError('invalid_op', `Op ${index} (${JSON.stringify(method)} ${JSON.stringify(path)}) ${why}`);
    };
    if (!HTTP_METHODS.has(method)) reject('must use one of GET, POST, PUT, PATCH, DELETE (uppercase)');
    if (typeof path !== 'string') reject('needs a string path');
    if (UNSAFE_CHARS.test(path)) reject('must not contain whitespace, control characters or #');
    if (PLACEHOLDER.test(path) || path.split('?')[0].split('/').some((s) => PLACEHOLDER_SEGMENT.test(s))) {
      reject('still contains a placeholder; put the real id into the path');
    }
    if (!isNormalPath(path)) reject('must be a normalized path (no . or .. segments, backslashes or encoded dots)');
    // Drift prechecks are built by rollback from recorded post-apply states;
    // a draft cannot supply one.
    if ('precheck' in op) reject('carries precheck, which only rollback plans build');
    if ('created_id_from' in op) reject('carries created_id_from, which only rollback plans build');
    if (path.split('?')[0].includes('//')) reject('must not contain an empty segment (//)');
    const product = classifyProductOp(op, plan);
    if (account) {
      if (!product && !isPagesRollback(method, path, plan.account_id)) {
        reject('is not allowed on account plans (no product kind matches it and it is not POST /accounts/<account_id>/pages/projects/<project>/deployments/<id>/rollback)');
      }
    } else if (isZoneAccess(path)) {
      reject('targets zone-scoped Access; use the account form /accounts/<account_id>/access/... on an account plan');
    } else if (!path.startsWith(prefix)) {
      reject(`must target this plan's zone (${prefix}...)`);
    }
    if (method === 'POST' && PAGE_RULES.test(path)) reject('would create a Page Rule; use the modern rule types');
    if (product) {
      validateProductFields(op, product.entry, index);
    } else if (PRODUCT_FIELDS.some((field) => field in op)) {
      reject('carries confirm_name, verify or secret_fields_from_env, which only product ops take');
    }
  });
}
