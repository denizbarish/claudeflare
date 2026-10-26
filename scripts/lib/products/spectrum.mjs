// Cloudflare Spectrum product module (spec 5.6). Spectrum apps are zone
// resources (/zones/<id>/spectrum/apps[/<id>]) written with POST, PUT and
// DELETE only. The engine snapshots, inverts and redacts; this module adds
// body validation, the plan entitlement check (spec 2 protocol table), the
// delete note and verification (read-back plus a TCP connect).
//
// Protocols per plan (spec 2, owner table): Free none; Pro the named apps
// minecraft and ssh; Business adds rdp; Enterprise everything. The API has no
// protocol name: a named app is a single-port TCP app on the port of that
// protocol (ssh tcp/22, minecraft tcp/25565, rdp tcp/3389) whose body sets
// only the pay-as-you-go fields (dns, protocol, origin_direct) and otherwise
// default values, so an app body read back from the API (which may list the
// defaults) still counts as named. Any other body is a generic TCP/UDP app and
// needs Enterprise (unverified, spike skipped).

import { CfError } from '../errors.mjs';
import { listAll } from '../paginate.mjs';
import { matchKind, opTarget } from './match.mjs';
import { readbackCheck, tcpOpenCheck } from '../verify.mjs';

const ID = '([0-9a-f]{32})';

// Fields the API sets: dropped from restore bodies and from drift comparisons.
const APP_READ_ONLY = ['id', 'created_on', 'modified_on'];

const PROTOCOL = /^(tcp|udp)\/(\d{1,5})(?:-(\d{1,5}))?$/;
const PROXY_PROTOCOLS = ['off', 'v1', 'v2', 'simple'];
const TLS_MODES = ['off', 'flexible', 'full', 'strict'];
const TRAFFIC_TYPES = ['direct', 'http', 'https', 'worker'];
const DNS_TYPES = ['CNAME', 'ADDRESS'];
const EDGE_IP_TYPES = ['dynamic', 'static'];

// Named apps (spec 2) and the TCP port the API writes them as.
export const NAMED_APPS = { ssh: 22, minecraft: 25565, rdp: 3389 };
// Body keys of a pay-as-you-go (named) app, and the default values other keys
// may carry in a named app.
const PAYGO_KEYS = new Set(['dns', 'protocol', 'origin_direct']);
const NAMED_DEFAULTS = {
  traffic_type: (v) => v === 'direct',
  proxy_protocol: (v) => v === 'off',
  tls: (v) => v === 'off',
  ip_firewall: (v) => v === false,
  argo_smart_routing: (v) => v === false,
  edge_ips: (v) => isPlainObject(v) && v.type === 'dynamic' && (v.connectivity ?? 'all') === 'all' && Object.keys(v).every((k) => k === 'type' || k === 'connectivity'),
};

// Spec 2 table: what each zone plan may create. `generic` covers every TCP
// and UDP app that is not a named app.
export const PLAN_PROTOCOLS = {
  free: [],
  pro: ['minecraft', 'ssh'],
  business: ['minecraft', 'ssh', 'rdp'],
  enterprise: ['minecraft', 'ssh', 'rdp', 'generic'],
};

// Token template permissions (spec 12).
const PERM = { read: 'Zone Settings Read', edit: 'Zone Settings Edit', zone: 'Zone Read' };

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';
const list = (items) => items.join(', ');

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

// { transport, from, to } of a protocol string, or null when it is not
// tcp/<port>, udp/<port> or a <from>-<to> range of valid ports.
export function parseProtocol(protocol) {
  const m = PROTOCOL.exec(typeof protocol === 'string' ? protocol.trim().toLowerCase() : '');
  if (!m) return null;
  const from = Number(m[2]);
  const to = m[3] === undefined ? from : Number(m[3]);
  if (from < 1 || to > 65535 || to < from) return null;
  return { transport: m[1], from, to };
}

// The protocol name a body asks for: ssh, minecraft or rdp for a named app,
// generic for anything else, null when the protocol cannot be read.
export function appProtocol(body) {
  const p = parseProtocol(body?.protocol);
  if (!p) return null;
  const paygo = isPlainObject(body) && Object.entries(body).every(([key, value]) => PAYGO_KEYS.has(key) || NAMED_DEFAULTS[key]?.(value) === true);
  if (paygo && p.transport === 'tcp' && p.from === p.to) {
    const named = Object.entries(NAMED_APPS).find(([, port]) => port === p.from);
    if (named) return named[0];
  }
  return 'generic';
}

// free, pro, business or enterprise from the zone read; null when unknown.
export function zonePlan(zone) {
  const legacy = String(zone?.plan?.legacy_id ?? '').toLowerCase();
  if (legacy in PLAN_PROTOCOLS) return legacy;
  const name = String(zone?.plan?.name ?? '').toLowerCase();
  return Object.keys(PLAN_PROTOCOLS).find((plan) => new RegExp(`\\b${plan}\\b`).test(name)) ?? null;
}

// ---------- validation (Ruling 15) ----------

// Messages name field paths, never values.
function validateApp(op) {
  const body = op.body;
  if (!isPlainObject(body)) return ['needs a body { "protocol", "dns": { "name" }, "origin_direct" or "origin_dns", ... }; PUT replaces the whole app'];
  const problems = APP_READ_ONLY.filter((key) => key in body).map((key) => `${key} is set by Cloudflare and cannot be written`);
  if (!parseProtocol(body.protocol)) problems.push('protocol must be tcp/<port>, udp/<port> or a port range such as tcp/1000-2000 (ports 1 to 65535)');
  if (!isPlainObject(body.dns) || !nonEmpty(body.dns.name)) problems.push('dns must be { "type", "name" } with a non-empty name (the hostname clients connect to)');
  else if ('type' in body.dns && !DNS_TYPES.includes(body.dns.type)) problems.push(`dns.type must be one of ${list(DNS_TYPES)}`);
  const origins = ['origin_direct', 'origin_dns', 'origin_worker_id'].filter((key) => key in body);
  if (!origins.length) problems.push('needs an origin: origin_direct, origin_dns (with origin_port) or origin_worker_id');
  if ('origin_direct' in body && !(Array.isArray(body.origin_direct) && body.origin_direct.length && body.origin_direct.every(nonEmpty))) {
    problems.push('origin_direct must be a non-empty array of origin URIs such as tcp://192.0.2.1:22');
  }
  if ('origin_dns' in body && !(isPlainObject(body.origin_dns) && nonEmpty(body.origin_dns.name))) problems.push('origin_dns must be { "name" } with a non-empty name');
  if ('proxy_protocol' in body && !PROXY_PROTOCOLS.includes(body.proxy_protocol)) problems.push(`proxy_protocol must be one of ${list(PROXY_PROTOCOLS)}`);
  if ('tls' in body && !TLS_MODES.includes(body.tls)) problems.push(`tls must be one of ${list(TLS_MODES)}`);
  if ('traffic_type' in body && !TRAFFIC_TYPES.includes(body.traffic_type)) problems.push(`traffic_type must be one of ${list(TRAFFIC_TYPES)}`);
  for (const key of ['ip_firewall', 'argo_smart_routing']) {
    if (key in body && typeof body[key] !== 'boolean') problems.push(`${key} must be true or false`);
  }
  if ('edge_ips' in body && !(isPlainObject(body.edge_ips) && EDGE_IP_TYPES.includes(body.edge_ips.type))) {
    problems.push(`edge_ips must be an object with type ${list(EDGE_IP_TYPES)}`);
  }
  return problems;
}

// ---------- kinds ----------

const zone = { product: 'spectrum', scope: 'zone', destructive: false };
const COLLECTION = '/spectrum/apps';
const ONE = new RegExp(`^${COLLECTION}/${ID}$`);
const resource = (m) => ({ type: 'spectrum_app', id: m[1] });

// create (delete_created), update (PUT, put_before), delete (re-created on
// rollback with a new id). All three inverses get a drift baseline from the
// engine's post read (Ruling 8). confirm_name is the app's hostname.
const KINDS = [
  {
    ...zone, kind: 'spectrum_app_create', methods: ['POST'], pattern: new RegExp(`^${COLLECTION}$`), resource: () => null,
    readOnlyFields: APP_READ_ONLY, inverse: 'delete_created', validate: validateApp,
  },
  {
    ...zone, kind: 'spectrum_app_update', methods: ['PUT'], pattern: ONE, resource,
    readOnlyFields: APP_READ_ONLY, inverse: 'put_before', validate: validateApp,
  },
  {
    ...zone, kind: 'spectrum_app_delete', methods: ['DELETE'], pattern: ONE, resource,
    readOnlyFields: APP_READ_ONLY, inverse: 'recreate', destructive: true, nameField: 'dns.name', notes: (ctx, op) => notesDelete(ctx, op),
  },
];

// { kind, id } of a Spectrum op from its path alone (notes get no plan);
// null for any other op.
function parse(op) {
  const target = opTarget(op);
  const hit = target && matchKind(KINDS, op.method, target.scope, target.rest);
  return hit ? { kind: hit.entry.kind, id: hit.match[1] ?? null } : null;
}

function summarizeApp(app) {
  return {
    name: nonEmpty(app?.dns?.name) ? app.dns.name : null,
    protocol: typeof app?.protocol === 'string' ? app.protocol : null,
    edge_ips: isPlainObject(app?.edge_ips) && typeof app.edge_ips.type === 'string' ? app.edge_ips.type : null,
  };
}

// ---------- entitlement (spec 9) ----------

// Every create or update must ask for a protocol the zone plan allows. A
// delete needs Spectrum on the plan (not Free) and nothing more.
async function entitlement(client, base, ops = []) {
  const zoneRead = await withPermission(PERM.zone, base, () => client.request('GET', base));
  const plan = zonePlan(zoneRead);
  const label = zoneRead?.plan?.name ?? zoneRead?.plan?.legacy_id ?? 'unknown';
  if (!plan) return { ok: false, detail: `the zone plan (${label}) is not one of Free, Pro, Business or Enterprise, so the Spectrum protocols it allows are unknown` };
  const allowed = PLAN_PROTOCOLS[plan];
  if (!allowed.length) return { ok: false, detail: `Spectrum is not available on the ${plan} plan; it needs Pro or Business (SSH, Minecraft, RDP apps, paid add-on) or Enterprise (any TCP or UDP app)` };
  const refused = [];
  for (const op of ops) {
    const kind = parse(op)?.kind;
    if (kind !== 'spectrum_app_create' && kind !== 'spectrum_app_update') continue;
    const protocol = appProtocol(op.body);
    if (protocol && !allowed.includes(protocol)) {
      const what = protocol === 'generic' ? `a generic ${String(op.body.protocol)} app` : `a ${protocol} app`;
      refused.push(`${op.method} ${op.path} asks for ${what}`);
    }
  }
  if (refused.length) {
    const named = allowed.filter((p) => p !== 'generic').map((p) => `${p} (tcp/${NAMED_APPS[p]}; only dns, protocol and origin_direct set)`);
    return { ok: false, detail: `the ${plan} plan allows ${list(named)}; ${refused.join('; ')}. Generic TCP and UDP apps need Enterprise.` };
  }
  return { ok: true, detail: `${plan} plan allows ${list(allowed)}` };
}

// ---------- gather ----------

// Every app of the zone, to the last page (listAll sends page=1, so the API
// returns result_info), keyed by id: names for the notes, edge IP type for
// the delete note.
async function gather(client, base) {
  const path = `${base}${COLLECTION}`;
  const apps = await withPermission(PERM.read, path, () => listAll(client, path));
  return {
    scope: 'zone',
    apps: Object.fromEntries(apps.filter((a) => nonEmpty(a?.id)).map((a) => [a.id, summarizeApp(a)])),
  };
}

// ---------- notes ----------

function notesDelete(ctx, op) {
  const id = parse(op)?.id;
  const app = ctx?.apps?.[id];
  const label = app?.name ? `${app.name} (${id})` : id;
  const host = app?.name ?? `the hostname of app ${id}`;
  const traffic = app?.protocol ? `${app.protocol} traffic` : 'its traffic';
  const ips = app?.edge_ips === 'static'
    ? 'edge_ips.type is static, so the re-created app keeps its IPs'
    : 'edge_ips.type is not static, so the re-created app also gets new anycast IPs; clients and firewall rules that use the old IPs must be updated';
  return [`Deleting Spectrum app ${label}: Cloudflare stops proxying ${traffic} for ${host}. A rollback re-creates it with a new id, and ${ips}.`];
}

// Spectrum has no lockout catalogue item (spec 6).
function lockoutRisks() {
  return [];
}

// ---------- verification (spec 8) ----------

function skipped(name, detail) {
  return { name, once: true, run: async () => ({ ok: true, detail }) };
}

// Ruling 18: a check that cannot be run is skipped with a note, never failed.
function tcpCheck(state, deps) {
  const host = nonEmpty(state?.dns?.name) ? state.dns.name : null;
  const p = parseProtocol(state?.protocol);
  const name = `tcp_open ${host ?? 'unknown host'}${p ? `:${p.from === p.to ? p.from : `${p.from}-${p.to}`}` : ''}`;
  if (!p) return skipped(name, 'skipped: the app protocol is not tcp/<port> or udp/<port>');
  if (p.transport === 'udp') return skipped(name, 'skipped: UDP app; a TCP connect cannot test it');
  if (!host) return skipped(name, 'skipped: the app has no dns.name to connect to');
  if (p.from !== p.to) return skipped(name, `skipped: port range ${p.from}-${p.to}; connect to one port of it by hand`);
  return tcpOpenCheck(host, p.from, deps?.connect ? { connect: deps.connect } : {});
}

// Read-back for every created or updated app (deletes leave nothing to
// read), plus a TCP connect to dns.name on the edge port for TCP apps.
function verifyChecks(op, entry, ctx, result, post, deps) {
  if (String(op.method).toUpperCase() === 'DELETE') return [];
  return [readbackCheck(post, op.body, entry.readOnlyFields), tcpCheck(isPlainObject(post) ? post : op.body, deps)];
}

/** @type {import('./index.mjs').ProductModule} */
export const SPECTRUM = {
  product: 'spectrum',
  kinds: KINDS,
  permission: { read: PERM.read, edit: PERM.edit },
  probePath: (base) => `${base}${COLLECTION}`,
  entitlement,
  gather,
  lockoutRisks,
  verifyChecks,
};
