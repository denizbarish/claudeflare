// Cloudflare Tunnel product module (spec 5.2): remote-managed tunnels, their
// ingress configuration and connections, private network routes and virtual
// networks. All kinds are account scoped. The engine snapshots, inverts and
// redacts; this module adds body validation, conflict rules, the account
// reads lockout and dependency checks need, risk notes and verification.

import { CfError } from '../errors.mjs';
import { LOCKOUT_PREFIX } from '../lockout-text.mjs';
import { listAll } from '../paginate.mjs';
import { matchKind, opTarget } from './match.mjs';
import { readbackCheck, tunnelServingCheck } from '../verify.mjs';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const UUID_ONLY = new RegExp(`^${UUID}$`);
const TUNNEL_PATH = new RegExp(`^.*/cfd_tunnel/${UUID}`);
const CNAME_SUFFIX = '.cfargotunnel.com';

// Fields the API sets: dropped from restore bodies and from drift
// comparisons. Tunnel status and connections change whenever a connector
// starts or stops, which is not drift.
const TUNNEL_READ_ONLY = [
  'id', 'account_tag', 'created_at', 'deleted_at', 'connections', 'conns_active_at', 'conns_inactive_at',
  'status', 'tun_type', 'metadata', 'remote_config',
];
const CONFIG_READ_ONLY = ['account_id', 'tunnel_id', 'version', 'source', 'created_at'];
const TEAMNET_READ_ONLY = ['id', 'created_at', 'deleted_at'];

// Status values that mean a connector is serving (spec 2).
const SERVING = new Set(['healthy', 'degraded']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extraKeys(body, allowed) {
  return Object.keys(body).filter((key) => !allowed.includes(key));
}

// Body checks run on `plan new`, `claudeflare preflight` and again at apply
// (validateProductFields). Messages name field paths, never values: a value
// in a refused field may be a secret.
function validateCreate(op) {
  const body = op.body;
  if (!isPlainObject(body)) return ['needs a body { "name": "...", "config_src": "cloudflare" }'];
  const problems = [];
  if ('tunnel_secret' in body) problems.push('must not carry tunnel_secret; Cloudflare generates the tunnel secret');
  const extra = extraKeys(body, ['name', 'config_src', 'tunnel_secret']);
  if (extra.length) problems.push(`body may hold only name and config_src, not ${extra.join(', ')}`);
  if (typeof body.name !== 'string' || body.name === '') problems.push('needs a non-empty string name');
  if (body.config_src !== 'cloudflare') {
    problems.push('needs config_src "cloudflare" (remote-managed, so claudeflare can snapshot and roll back the config)');
  }
  return problems;
}

function validateRename(op) {
  const body = op.body;
  if (!isPlainObject(body)) return ['needs a body { "name": "..." }'];
  const problems = [];
  if ('tunnel_secret' in body) {
    problems.push('must not carry tunnel_secret; secret rotation is not a claudeflare op (rotate in the dashboard, then run claudeflare tunnel-token)');
  }
  const extra = extraKeys(body, ['name', 'tunnel_secret']);
  if (extra.length) problems.push(`body may hold only name, not ${extra.join(', ')}`);
  if (typeof body.name !== 'string' || body.name === '') problems.push('needs a non-empty string name');
  return problems;
}

// cloudflared matches ingress rules top down; the last rule must match every
// request, or the config is rejected and nothing is served.
function validateConfig(op) {
  const body = op.body;
  if (!isPlainObject(body) || !isPlainObject(body.config)) return ['needs a body { "config": { "ingress": [...] } }'];
  const problems = [];
  const extra = extraKeys(body, ['config']);
  if (extra.length) problems.push(`body may hold only config, not ${extra.join(', ')}`);
  const ingress = body.config.ingress;
  if (!Array.isArray(ingress) || ingress.length === 0) {
    return [...problems, 'config.ingress must be a non-empty array that ends with a catch-all rule'];
  }
  ingress.forEach((rule, i) => {
    if (!isPlainObject(rule) || typeof rule.service !== 'string' || rule.service === '') problems.push(`config.ingress.${i} needs a service`);
  });
  const last = ingress.at(-1);
  if (!isPlainObject(last) || 'hostname' in last || 'path' in last) {
    problems.push('config.ingress must end with a catch-all rule without hostname and path, for example { "service": "http_status:404" }');
  }
  return problems;
}

// Rollback of a create (Ruling 3): connections first, because the API refuses
// to delete a tunnel with active connections, then the tunnel. Both ops share
// the group tunnel:<id>, so a drift skip of one skips the other.
function deleteCreatedTunnel(entry, applyResult) {
  const id = applyResult?.id;
  if (typeof id !== 'string' || !UUID_ONLY.test(id)) {
    throw new CfError('rollback_ambiguous', `No usable tunnel id in apply result for ${entry.path}`);
  }
  const path = `${entry.path}/${id}`;
  const group = `tunnel:${id}`;
  return [
    { method: 'DELETE', path: `${path}/connections`, group },
    { method: 'DELETE', path, group },
  ];
}

function hostMatches(pattern, host) {
  const p = String(pattern).toLowerCase();
  const h = String(host).toLowerCase();
  return p === h || (p.startsWith('*.') && h.endsWith(p.slice(1)) && h.length > p.length - 1);
}

// Only a rule without a path serves the whole host; a path rule serves part of it.
function served(ingress, host) {
  return (Array.isArray(ingress) ? ingress : []).some((rule) => (
    typeof rule?.hostname === 'string' && (rule.path === undefined || rule.path === '') && hostMatches(rule.hostname, host)
  ));
}

function ingressHostnames(ingress) {
  const hosts = (Array.isArray(ingress) ? ingress : []).map((rule) => rule?.hostname).filter((h) => typeof h === 'string' && h !== '');
  return [...new Set(hosts.map((h) => h.toLowerCase()))];
}

function label(ctx, id) {
  const name = ctx?.tunnels?.[id]?.name;
  return name ? `${name} (${id})` : id;
}

function list(items) {
  return items.join(', ');
}

const notesCreate = (ctx, op) => {
  const account = opTarget(op)?.base.split('/')[2] ?? '<account_id>';
  return [
    `After apply, write the connector token with claudeflare tunnel-token --account ${account} --tunnel <new tunnel id> --env-path <file>; claudeflare never prints it.`,
  ];
};

const notesDelete = (ctx, op) => {
  const id = parse(op)?.id;
  const hosts = ctx?.cnames?.[id];
  if (!Array.isArray(hosts)) return [`Hostnames with a CNAME to ${id}${CNAME_SUFFIX} will return error 1016 once tunnel ${id} is deleted.`];
  const lines = hosts.length
    ? [`Deleting tunnel ${label(ctx, id)}: ${list(hosts)} will return error 1016; remove or repoint their CNAME records to ${id}${CNAME_SUFFIX} with a zone plan.`]
    : [`Deleting tunnel ${label(ctx, id)}: no DNS CNAME in this account's zones points at ${id}${CNAME_SUFFIX}.`];
  const connectorIds = ctx.connector_ids?.[id] ?? [];
  if (connectorIds.length) {
    lines.push(`Tunnel ${label(ctx, id)} has ${connectorIds.length} active connector(s) (${list(connectorIds)}); stop cloudflared on each host first, or they reconnect.`);
  }
  const routes = (ctx.routes ?? []).filter((r) => r.tunnel_id === id).map((r) => r.network);
  if (routes.length) lines.push(`Private network routes ${list(routes)} use tunnel ${label(ctx, id)} and stop working.`);
  return lines;
};

const notesConnections = (ctx, op) => {
  const id = parse(op)?.id;
  const count = ctx?.connectors?.[id];
  const now = typeof count === 'number' ? ` (${count} now)` : '';
  return [`Connectors of tunnel ${label(ctx, id)}${now} reconnect unless cloudflared is stopped first; stop them before a tunnel delete.`];
};

// New hostnames need a proxied CNAME to the tunnel; DNS is a zone op, and v3
// does not mix scopes, so the note points to a separate zone plan.
const notesConfig = (ctx, op) => {
  const id = parse(op)?.id;
  const cnames = ctx?.cnames?.[id];
  if (!Array.isArray(cnames)) return [];
  return ingressHostnames(op.body?.config?.ingress)
    .filter((host) => !host.includes('*') && !cnames.some((name) => hostMatches(name, host)))
    .map((host) => `${host} has no CNAME to ${id}${CNAME_SUFFIX} in this account's zones; add one with a zone plan: POST /zones/<zone_id>/dns_records with { "type": "CNAME", "name": "${host}", "content": "${id}${CNAME_SUFFIX}", "proxied": true }.`);
};

const account = { product: 'tunnel', scope: 'account', destructive: false };

const KINDS = [
  {
    ...account,
    kind: 'tunnel_create',
    methods: ['POST'],
    pattern: /^\/cfd_tunnel$/,
    resource: () => null,
    readOnlyFields: TUNNEL_READ_ONLY,
    inverse: deleteCreatedTunnel,
    redact: ['token', 'credentials_file', 'tunnel_secret'],
    validate: validateCreate,
    notes: notesCreate,
  },
  {
    ...account,
    kind: 'tunnel_rename',
    methods: ['PATCH'],
    pattern: new RegExp(`^/cfd_tunnel/${UUID}$`),
    resource: (m) => ({ type: 'tunnel', id: m[1] }),
    readOnlyFields: TUNNEL_READ_ONLY,
    inverse: 'patch_before',
    validate: validateRename,
  },
  {
    ...account,
    kind: 'tunnel_delete',
    methods: ['DELETE'],
    pattern: new RegExp(`^/cfd_tunnel/${UUID}$`),
    resource: (m) => ({ type: 'tunnel', id: m[1] }),
    readOnlyFields: TUNNEL_READ_ONLY,
    inverse: 'none',
    destructive: true,
    nameField: 'name',
    notes: notesDelete,
  },
  {
    ...account,
    kind: 'tunnel_config_put',
    methods: ['PUT'],
    pattern: new RegExp(`^/cfd_tunnel/${UUID}/configurations$`),
    resource: (m) => ({ type: 'tunnel_config', id: m[1] }),
    readOnlyFields: CONFIG_READ_ONLY,
    inverse: 'put_before',
    validate: validateConfig,
    notes: notesConfig,
  },
  {
    ...account,
    kind: 'tunnel_connections_delete',
    methods: ['DELETE'],
    pattern: new RegExp(`^/cfd_tunnel/${UUID}/connections$`),
    resource: (m) => ({ type: 'tunnel_connections', id: m[1] }),
    readOnlyFields: [],
    inverse: 'none',
    notes: notesConnections,
  },
  ...teamnetKinds('route', 'routes', 'tunnel_route', 'network'),
  ...teamnetKinds('vnet', 'virtual_networks', 'tunnel_vnet', 'name'),
];

// Private network routes and virtual networks share one shape: create,
// update (PATCH), delete (re-created on rollback with a new id).
function teamnetKinds(prefix, collection, type, nameField) {
  const one = new RegExp(`^/teamnet/${collection}/${UUID}$`);
  const shared = { ...account, readOnlyFields: TEAMNET_READ_ONLY };
  return [
    { ...shared, kind: `${prefix}_create`, methods: ['POST'], pattern: new RegExp(`^/teamnet/${collection}$`), resource: () => null, inverse: 'delete_created' },
    { ...shared, kind: `${prefix}_update`, methods: ['PATCH'], pattern: one, resource: (m) => ({ type, id: m[1] }), inverse: 'patch_before' },
    {
      ...shared, kind: `${prefix}_delete`, methods: ['DELETE'], pattern: one, resource: (m) => ({ type, id: m[1] }),
      inverse: 'recreate', destructive: true, nameField,
    },
  ];
}

// { kind, id } of a tunnel op from its path alone (lockoutRisks and notes get
// no plan); null for any other op.
function parse(op) {
  const target = opTarget(op);
  const hit = target && matchKind(KINDS, op.method, target.scope, target.rest);
  return hit ? { kind: hit.entry.kind, id: hit.match[1] ?? null } : null;
}

const TOUCHES_TUNNEL = new Set(['tunnel_rename', 'tunnel_delete', 'tunnel_config_put', 'tunnel_connections_delete']);
const NEEDS_CNAMES = new Set(['tunnel_delete', 'tunnel_config_put']);

// Account reads for lockout analysis, dependencies, notes and verification.
// Every list is read to the last page, so a CNAME or route on page two still
// counts (Review Focus 1).
async function gather(client, base, ops) {
  const items = ops.map((op, index) => ({ ...parse(op), index })).filter((p) => p.kind);
  const ctx = { tunnels: {}, connectors: {}, connector_ids: {}, configs: {}, cnames: {}, routes: [], vnets: [], cleared_routes: {} };
  const ids = (kinds) => [...new Set(items.filter((p) => kinds.has(p.kind)).map((p) => p.id))];

  for (const id of ids(TOUCHES_TUNNEL)) {
    const tunnel = await client.request('GET', `${base}/cfd_tunnel/${id}`);
    ctx.tunnels[id] = { name: tunnel?.name ?? null, status: tunnel?.status ?? null };
    const connectors = await client.request('GET', `${base}/cfd_tunnel/${id}/connections`);
    const running = Array.isArray(connectors) ? connectors : [];
    ctx.connectors[id] = running.length;
    ctx.connector_ids[id] = running.map((c) => String(c?.id ?? '')).filter(Boolean);
  }
  for (const id of ids(new Set(['tunnel_config_put']))) {
    const current = await client.request('GET', `${base}/cfd_tunnel/${id}/configurations`);
    ctx.configs[id] = current?.config ?? null;
  }

  const cnameIds = ids(NEEDS_CNAMES);
  if (cnameIds.length) {
    const accountId = base.split('/')[2];
    const zones = await listAll(client, '/zones', { query: { 'account.id': accountId } });
    for (const id of cnameIds) {
      const names = [];
      for (const zone of zones) {
        const records = await listAll(client, `/zones/${zone.id}/dns_records`, { query: { type: 'CNAME', content: `${id}${CNAME_SUFFIX}` } });
        names.push(...records.map((r) => String(r.name).toLowerCase()));
      }
      ctx.cnames[id] = [...new Set(names)].sort();
    }
  }

  const teamnet = items.some((p) => p.kind === 'tunnel_delete' || /^(route|vnet)_/.test(p.kind));
  if (teamnet) {
    const routes = await listAll(client, `${base}/teamnet/routes`, { query: { is_deleted: false } });
    ctx.routes = routes.map((r) => ({ id: r.id, network: r.network, tunnel_id: r.tunnel_id, virtual_network_id: r.virtual_network_id }));
  }
  if (items.some((p) => p.kind.startsWith('vnet_'))) {
    const vnets = await listAll(client, `${base}/teamnet/virtual_networks`, { query: { is_deleted: false } });
    ctx.vnets = vnets.map((v) => ({ id: v.id, name: v.name, is_default: v.is_default_network === true || v.is_default === true }));
    // Routes this plan deletes before a virtual network delete no longer hold it.
    for (const del of items.filter((p) => p.kind === 'vnet_delete')) {
      ctx.cleared_routes[del.id] = items.filter((p) => p.kind === 'route_delete' && p.index < del.index).map((p) => p.id);
    }
  }
  return ctx;
}

// resource_in_use: a virtual network that routes still use, or the account's
// default network, cannot be deleted (spec 5.2).
function dependencies(ctx, op, entry) {
  if (entry.kind !== 'vnet_delete') return [];
  const id = parse(op)?.id;
  const users = [];
  const vnet = (ctx.vnets ?? []).find((v) => v.id === id);
  if (vnet && (vnet.is_default || vnet.name === 'default')) users.push('the account as its default virtual network, which cannot be deleted');
  const cleared = new Set(ctx.cleared_routes?.[id] ?? []);
  for (const route of ctx.routes ?? []) {
    if (route.virtual_network_id === id && !cleared.has(route.id)) users.push(`route ${route.network} (${route.id})`);
  }
  return users;
}

// Spec 6 item 10 and 5.2. A missing catch-all never reaches here:
// validateConfig refuses it. Every hostname whose CNAME sends traffic to the
// tunnel but that no rule of the new config serves gets a line, whether the
// config drops its rule or it had none before: it will answer 404.
function lockoutRisks(ctx, ops) {
  const lines = [];
  for (const op of ops) {
    const p = parse(op);
    if (p?.kind !== 'tunnel_config_put') continue;
    const before = ctx.configs?.[p.id]?.ingress;
    const after = op.body?.config?.ingress;
    const unserved = (ctx.cnames?.[p.id] ?? []).filter((host) => !served(after, host));
    if (!unserved.length) continue;
    const dropped = unserved.filter((host) => served(before, host));
    const never = unserved.filter((host) => !served(before, host));
    const parts = [
      dropped.length ? `drops ${list(dropped)}` : '',
      never.length ? `${dropped.length ? 'and ' : ''}still has no rule for ${list(never)}` : '',
    ].filter(Boolean).join(' ');
    lines.push(
      `${LOCKOUT_PREFIX} the new config of tunnel ${label(ctx, p.id)} ${parts}, which ${unserved.length === 1 ? 'has a CNAME' : 'have CNAMEs'} to ${p.id}${CNAME_SUFFIX}; requests fall through to the catch-all rule (usually 404). If it happens, roll this plan back with claudeflare rollback or add the rule.`,
    );
  }
  return lines;
}

// Ruling 3 order and spec 4.5: a tunnel delete needs its connections cleared
// earlier in the same plan, and a config PUT plus a delete of one tunnel
// conflict.
function conflicts(ops, classified) {
  const mine = classified
    .map((c, index) => (c?.module?.product === 'tunnel' ? { kind: c.entry.kind, id: c.match[1], index } : null))
    .filter(Boolean);
  for (const del of mine.filter((x) => x.kind === 'tunnel_delete')) {
    const config = mine.find((x) => x.kind === 'tunnel_config_put' && x.id === del.id);
    if (config) {
      throw new CfError('plan_conflict', `Ops ${Math.min(config.index, del.index)} and ${Math.max(config.index, del.index)} put the configuration of tunnel ${del.id} and delete it; drop the configuration op`);
    }
    if (!mine.some((x) => x.kind === 'tunnel_connections_delete' && x.id === del.id && x.index < del.index)) {
      throw new CfError('plan_conflict', `Op ${del.index} deletes tunnel ${del.id} without an earlier DELETE .../cfd_tunnel/${del.id}/connections in this plan; stop cloudflared, then add that op before the delete`);
    }
  }
}

function skipped(name, detail) {
  return { name, once: true, run: async () => ({ ok: true, detail }) };
}

function tunnelStatusCheck(client, path, id) {
  return {
    name: `tunnel_status ${id}`,
    run: async () => {
      if (!client) return { ok: false, detail: 'no API client to read the tunnel status' };
      const tunnel = await client.request('GET', path);
      const status = tunnel?.status ?? 'unknown';
      return SERVING.has(status) ? { ok: true, detail: `status ${status}` } : { ok: false, detail: `status ${status}, expected healthy or degraded` };
    },
  };
}

// Spec 8: read-back for every changed resource (deletes leave nothing to
// read), tunnel_serving for each hostname of a new config that already had a
// CNAME to the tunnel at preflight (Ruling 18; a new hostname has no DNS until
// its zone plan runs, wildcards cannot be fetched), and the tunnel status when
// it had connectors before the change.
function verifyChecks(op, entry, ctx, result, post, deps) {
  if (String(op.method).toUpperCase() === 'DELETE') return [];
  // config_src is not echoed by every API version; the name is still compared.
  const checks = [readbackCheck(post, op.body, entry.kind === 'tunnel_create' ? ['config_src'] : [])];
  const id = parse(op)?.id;
  if (entry.kind === 'tunnel_config_put') {
    const cnames = ctx?.cnames?.[id];
    for (const host of ingressHostnames(op.body?.config?.ingress)) {
      if (host.includes('*')) continue;
      if (Array.isArray(cnames) && cnames.some((name) => hostMatches(name, host))) {
        checks.push(tunnelServingCheck(`https://${host}/`, { fetchImpl: deps?.fetchImpl }));
      } else {
        checks.push(skipped(`tunnel_serving https://${host}/`, Array.isArray(cnames) ? 'skipped: no DNS record yet' : 'skipped: no preflight context'));
      }
    }
  }
  if ((entry.kind === 'tunnel_rename' || entry.kind === 'tunnel_config_put') && ctx?.connectors?.[id] > 0) {
    checks.push(tunnelStatusCheck(deps?.client, TUNNEL_PATH.exec(String(op.path))[0], id));
  }
  return checks;
}

/** @type {import('./index.mjs').ProductModule} */
export const TUNNEL = {
  product: 'tunnel',
  kinds: KINDS,
  permission: { read: 'Cloudflare Tunnel Read', edit: 'Cloudflare Tunnel Edit' },
  probePath: (base) => `${base}/cfd_tunnel`,
  gather,
  dependencies,
  lockoutRisks,
  conflicts,
  verifyChecks,
};
