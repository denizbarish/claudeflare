// Classifies a concrete plan op (no {zone_id} placeholders) into a resource
// kind that the snapshot module knows how to capture and invert.

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
