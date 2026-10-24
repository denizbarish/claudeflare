// Classifies a concrete plan op (no {zone_id} placeholders) into a resource
// kind that the snapshot module knows how to capture and invert.

import { CfError } from './errors.mjs';

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

export function validatePlanOps(ops) {
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
  (ops ?? []).forEach((op, index) => {
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

// Plan ops (after {zone_id} resolution) must stay inside the plan's own zone,
// use a plain HTTP method, carry no leftover placeholders and never create a
// Page Rule. Runs on `plan new` and again in applyPlan on the exact ops sent.
export function validateOpTargets(ops, zoneId) {
  const prefix = `/zones/${zoneId}/`;
  (ops ?? []).forEach((op, index) => {
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
    if (!path.startsWith(prefix)) reject(`must target this plan's zone (${prefix}...)`);
    if (method === 'POST' && PAGE_RULES.test(path)) reject('would create a Page Rule; use the modern rule types');
  });
}
