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
