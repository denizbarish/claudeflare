// Cloudflare Gateway product module (spec 5.3): DNS, HTTP and network
// rules, lists, DNS locations and the account configuration. All kinds are
// account scoped. The engine snapshots, inverts and redacts; this module adds
// body validation, the precedence conflict rule, the account reads lockout
// and dependency checks need, a small traffic expression matcher (spec 13),
// risk notes and verification.

import { CfError } from '../errors.mjs';
import { LOCKOUT_PREFIX } from '../lockout-text.mjs';
import { listAll } from '../paginate.mjs';
import { omitPaths } from './fields.mjs';
import { matchKind, opTarget } from './match.mjs';
import { readbackCheck } from '../verify.mjs';

// Rule and list ids are UUIDs; location ids are 32 hex characters.
const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})';

// Standard plan limit per list (spec 2).
export const MAX_LIST_ITEMS = 1000;

// Fields the API sets: dropped from restore bodies and from drift
// comparisons. Rules: spec 2. Locations: the DoH subdomain and the addresses
// are assigned by Cloudflare and change on re-create. A list's `count` stays
// in drift comparisons on purpose: a list GET may not hold the items, and
// count is then the only sign that they changed; list restore bodies are
// built field by field, so it is never sent back.
// phase_precedence (snapshot) and phase_rules (post state) are claudeflare's
// own records of the other rules of the phase (Ruling 22), never sent back.
const RULE_READ_ONLY = [
  'id', 'created_at', 'updated_at', 'deleted_at', 'version', 'read_only', 'source_account', 'warning_status', 'phase_precedence', 'phase_rules',
];
const RULE_ID = new RegExp(`^${ID}$`);
const LIST_READ_ONLY = ['id', 'created_at', 'updated_at', 'items.*.created_at'];
const LOCATION_READ_ONLY = ['id', 'created_at', 'updated_at', 'doh_subdomain', 'ip', 'ipv4_destination', 'ipv4_destination_backup'];
const CONFIG_READ_ONLY = ['created_at', 'updated_at'];

// Wirefilter expressions the API reformats (spec 2).
const EXPRESSION_FIELDS = ['traffic', 'identity', 'device_posture'];

const HONESTY = 'filtering itself is only verified from a device behind Gateway';
const ROLLBACK_HINT = 'If it happens, roll this plan back with claudeflare rollback from a machine that is not behind Gateway.';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';

function list(items) {
  return items.join(', ');
}

function parentPath(path) {
  return path.slice(0, path.lastIndexOf('/'));
}

// ---------- validation (Ruling 15) ----------

// Body checks run on `plan new`, `claudeflare preflight` and again at apply
// (validateProductFields). Messages name field paths, never values.
function validateRule(op) {
  const body = op.body;
  if (!isPlainObject(body)) return ['needs a body { "name", "action", "filters": ["dns"], "traffic", "precedence" }'];
  const problems = [];
  if (!nonEmpty(body.name)) problems.push('needs a non-empty string name');
  if (!nonEmpty(body.action)) problems.push('needs a non-empty string action (block, allow, ...)');
  if (!Array.isArray(body.filters) || body.filters.length === 0 || !body.filters.every(nonEmpty)) {
    problems.push('filters must be a non-empty array naming the phase (dns, http, l4, egress)');
  }
  for (const field of EXPRESSION_FIELDS) {
    if (field in body && typeof body[field] !== 'string') problems.push(`${field} must be a string expression`);
  }
  if ('precedence' in body && !Number.isInteger(body.precedence)) problems.push('precedence must be an integer');
  if ('enabled' in body && typeof body.enabled !== 'boolean') problems.push('enabled must be true or false');
  return problems;
}

// A list is written whole (spec 5.3): list PATCH is not an op. More than
// MAX_LIST_ITEMS items is too_large, not invalid_op.
function listValidator(kind) {
  return (op) => {
    const body = op.body;
    if (!isPlainObject(body)) return ['needs a body { "name", "type", "items": [{ "value": "..." }] }'];
    if (Array.isArray(body.items) && body.items.length > MAX_LIST_ITEMS) {
      throw new CfError('too_large', `Gateway list body has ${body.items.length} items; a list holds at most ${MAX_LIST_ITEMS} (Standard plan). Split it into several lists.`);
    }
    const problems = [];
    if (!nonEmpty(body.name)) problems.push('needs a non-empty string name');
    if (kind === 'create' && !nonEmpty(body.type)) problems.push('needs a non-empty string type (DOMAIN, IP, URL, EMAIL, SERIAL, ...)');
    if ('items' in body) {
      if (!Array.isArray(body.items)) {
        problems.push('items must be an array of { "value": "..." } objects');
      } else {
        body.items.forEach((item, i) => {
          if (!isPlainObject(item) || !nonEmpty(item.value)) problems.push(`items.${i} needs a string value`);
        });
        if (kind === 'update' && body.items.length === 0) {
          problems.push('items must not be empty: a PUT with empty items leaves the list unchanged; delete and re-create the list to empty it');
        }
      }
    }
    return problems;
  };
}

function validateLocation(op) {
  const body = op.body;
  if (!isPlainObject(body)) return ['needs a body { "name", ... }'];
  return nonEmpty(body.name) ? [] : ['needs a non-empty string name'];
}

function validateConfig(op) {
  const body = op.body;
  if (!isPlainObject(body) || !isPlainObject(body.settings)) return ['needs a body { "settings": { ... } } with the subcollections to change'];
  const extra = Object.keys(body).filter((key) => key !== 'settings');
  return extra.length ? [`body may hold only settings, not ${list(extra)}`] : [];
}

// ---------- snapshot and inverses ----------

// A list GET may not carry its items; they have their own paged endpoint,
// which some API versions answer as a nested array.
async function captureList(client, readPath) {
  const current = await withPermission(PERM.gateway, readPath, () => client.request('GET', readPath));
  const itemsPath = `${readPath}/items`;
  const items = (await withPermission(PERM.gateway, itemsPath, () => listAll(client, itemsPath))).flat();
  return { ...current, items: items.map(itemBody) };
}

function itemBody(item) {
  return nonEmpty(item?.description) ? { value: item.value, description: item.description } : { value: item?.value };
}

function ambiguous(message) {
  return new CfError('rollback_ambiguous', message);
}

function requireBefore(entry) {
  if (!isPlainObject(entry.before)) throw ambiguous(`No before state recorded for ${entry.path}`);
  return entry.before;
}

const isRuleWrite = (p) => p?.kind === 'gateway_rule_create' || p?.kind === 'gateway_rule_update';

// Spec 5.3 and Ruling 22: a rule write may make the API renumber other rules
// of its phase. The snapshot keeps { id, precedence } of the rules of the
// phase that no rule op of the plan targets. Only the plan's last rule write
// per phase records them: its post state shows every move the plan caused.
async function captureRule(client, readPath, op, plan) {
  const create = String(op?.method).toUpperCase() === 'POST';
  const current = create ? {} : await withPermission(PERM.gateway, readPath, () => client.request('GET', readPath));
  const phases = [...new Set([current?.filters?.[0], op?.body?.filters?.[0]].filter(nonEmpty))];
  const out = create ? { phase: phases[0] ?? null } : { ...current };
  out.phase_precedence = [];
  const ops = Array.isArray(plan?.ops) ? plan.ops : [op];
  const index = ops.indexOf(op);
  const later = index < 0 ? [] : ops.slice(index + 1);
  const watched = phases.filter((phase) => !later.some((o) => isRuleWrite(parse(o)) && o.body?.filters?.[0] === phase));
  if (!watched.length) return out;
  const touched = new Set(ops.map(parse).filter((p) => p?.kind.startsWith('gateway_rule_') && p.id).map((p) => p.id));
  const collection = create ? readPath : parentPath(readPath);
  const rules = await withPermission(PERM.gateway, collection, () => listAll(client, collection));
  out.phase_precedence = rules
    .filter((r) => watched.includes(r?.filters?.[0]) && !touched.has(r.id) && r.id !== current?.id && Number.isInteger(r.precedence))
    .map((r) => ({ id: r.id, precedence: r.precedence }));
  return out;
}

// Post state of a rule write: the rule plus the other rules of its phase.
async function capturePostRule(client, readPath) {
  const rule = await client.request('GET', readPath);
  const phase = rule?.filters?.[0];
  const rules = nonEmpty(phase) ? await listAll(client, parentPath(readPath)) : [];
  return { ...rule, phase_rules: rules.filter((r) => r?.id !== rule?.id && r?.filters?.[0] === phase) };
}

// Rules the API moved during apply, put back at their snapshot precedence.
// Each restore checks its own rule for drift first: a rule someone moved
// after apply is skipped with rollback_drift, never overwritten.
function shiftedRestores(entry, record, collection) {
  const snapshot = entry.before?.phase_precedence;
  const after = record?.state?.phase_rules;
  if (!Array.isArray(snapshot) || !Array.isArray(after)) return [];
  return snapshot.flatMap(({ id, precedence }) => {
    const now = after.find((r) => r?.id === id);
    if (!isPlainObject(now) || now.precedence === precedence || !RULE_ID.test(String(id))) return [];
    const path = `${collection}/${id}`;
    return [{ method: 'PUT', path, body: { ...omitPaths(now, RULE_READ_ONLY), precedence }, drift: { read: path, expect: now } }];
  });
}

// Precedence restores of one phase skip together on drift (spec 4.4).
function phaseGroup(phase) {
  return nonEmpty(phase) ? `gateway-phase:${phase}` : undefined;
}

function grouped(ops, group) {
  return group ? ops.map((op) => ({ ...op, group })) : ops;
}

// PUT back the rule as it was, precedence included, then every other rule
// of the phase the API moved.
function restoreRule(entry, applyResult, record) {
  const before = requireBefore(entry);
  const own = { method: 'PUT', path: entry.path, body: omitPaths(before, RULE_READ_ONLY) };
  return grouped([own, ...shiftedRestores(entry, record, parentPath(entry.path))], phaseGroup(before.filters?.[0]));
}

// Delete the created rule, then put back the rules the API moved for it.
function deleteCreatedRule(entry, applyResult, record) {
  const id = applyResult?.id;
  if (!RULE_ID.test(String(id ?? ''))) throw ambiguous(`No usable rule id in apply result for ${entry.path}`);
  const ops = [{ method: 'DELETE', path: `${entry.path}/${id}` }, ...shiftedRestores(entry, record, entry.path)];
  return grouped(ops, phaseGroup(entry.before?.phase));
}

// Re-create a deleted rule at its old precedence (new id).
function recreateRule(entry) {
  const before = requireBefore(entry);
  return grouped([{ method: 'POST', path: parentPath(entry.path), body: omitPaths(before, RULE_READ_ONLY) }], phaseGroup(before.filters?.[0]));
}

// Configuration subcollections with a documented plain off state. Restoring
// one that was absent before the op turns it off; any other absent
// subcollection cannot be removed by PATCH.
const CONFIG_OFF = {
  tls_decrypt: { enabled: false },
  protocol_detection: { enabled: false },
  block_page: { enabled: false },
  antivirus: { enabled_download_phase: false, enabled_upload_phase: false, fail_closed: false },
  fips: { tls: false },
};

// Snapshot of only the subcollections the PATCH sets; null marks one the
// account did not have.
async function captureConfig(client, readPath, op) {
  const current = await withPermission(PERM.gateway, readPath, () => client.request('GET', readPath));
  const subs = Object.keys(isPlainObject(op?.body?.settings) ? op.body.settings : {});
  return { settings: Object.fromEntries(subs.map((sub) => [sub, current?.settings?.[sub] ?? null])) };
}

function restoreConfig(entry) {
  const before = requireBefore(entry);
  const settings = {};
  for (const [sub, value] of Object.entries(isPlainObject(before.settings) ? before.settings : {})) {
    if (value !== null && value !== undefined) settings[sub] = value;
    else if (CONFIG_OFF[sub]) settings[sub] = structuredClone(CONFIG_OFF[sub]);
    else throw ambiguous(`PATCH ${entry.path} added settings.${sub}, absent before; it has no documented off value, so a rollback cannot remove it`);
  }
  return Object.keys(settings).length ? [{ method: 'PATCH', path: entry.path, body: { settings } }] : [];
}

function listBody(before, withType) {
  const body = { name: before.name };
  if (typeof before.description === 'string') body.description = before.description;
  if (withType && nonEmpty(before.type)) body.type = before.type;
  return body;
}

// A list PUT replaces the items only when items is non-empty, so a list
// that was empty before an op that filled it cannot be restored with PUT.
function restoreList(entry) {
  const before = requireBefore(entry);
  const body = listBody(before, false);
  if ((entry.op_body_keys ?? []).includes('items')) {
    if (!Array.isArray(before.items)) throw new CfError('rollback_ambiguous', `No items recorded for ${entry.path}`);
    if (before.items.length === 0) {
      throw new CfError('rollback_ambiguous', `List ${entry.path} was empty before; a PUT cannot empty it again (delete and re-create the list instead)`);
    }
    body.items = before.items.map(itemBody);
  }
  return [{ method: 'PUT', path: entry.path, body }];
}

function recreateList(entry) {
  const before = requireBefore(entry);
  const body = listBody(before, true);
  if (Array.isArray(before.items) && before.items.length) body.items = before.items.map(itemBody);
  return [{ method: 'POST', path: parentPath(entry.path), body }];
}

// ---------- kinds ----------

const account = { product: 'gateway', scope: 'account', destructive: false };
const one = (collection) => new RegExp(`^/gateway/${collection}/${ID}$`);
const key = (type) => (m) => ({ type, id: m[1] });

const KINDS = [
  {
    ...account, kind: 'gateway_rule_create', methods: ['POST'], pattern: /^\/gateway\/rules$/, resource: () => null,
    readOnlyFields: RULE_READ_ONLY, capture: captureRule, capturePost: capturePostRule, inverse: deleteCreatedRule, validate: validateRule,
  },
  {
    ...account, kind: 'gateway_rule_update', methods: ['PUT'], pattern: one('rules'), resource: key('gateway_rule'),
    read: (m, base) => `${base}/gateway/rules/${m[1]}`, readOnlyFields: RULE_READ_ONLY, capture: captureRule, capturePost: capturePostRule,
    inverse: restoreRule, validate: validateRule,
  },
  {
    ...account, kind: 'gateway_rule_delete', methods: ['DELETE'], pattern: one('rules'), resource: key('gateway_rule'),
    read: (m, base) => `${base}/gateway/rules/${m[1]}`, readOnlyFields: RULE_READ_ONLY, inverse: recreateRule,
    destructive: true, nameField: 'name', notes: (ctx, op) => notesRuleDelete(ctx, op),
  },
  {
    ...account, kind: 'gateway_list_create', methods: ['POST'], pattern: /^\/gateway\/lists$/, resource: () => null,
    readOnlyFields: LIST_READ_ONLY, inverse: 'delete_created', validate: listValidator('create'),
  },
  {
    ...account, kind: 'gateway_list_update', methods: ['PUT'], pattern: one('lists'), resource: key('gateway_list'),
    readOnlyFields: LIST_READ_ONLY, capture: captureList, inverse: restoreList, validate: listValidator('update'),
  },
  {
    ...account, kind: 'gateway_list_delete', methods: ['DELETE'], pattern: one('lists'), resource: key('gateway_list'),
    readOnlyFields: LIST_READ_ONLY, capture: captureList, inverse: recreateList, destructive: true, nameField: 'name',
    notes: (ctx, op) => notesListDelete(ctx, op),
  },
  {
    ...account, kind: 'gateway_location_create', methods: ['POST'], pattern: /^\/gateway\/locations$/, resource: () => null,
    readOnlyFields: LOCATION_READ_ONLY, inverse: 'delete_created', validate: validateLocation,
  },
  {
    ...account, kind: 'gateway_location_update', methods: ['PUT'], pattern: one('locations'), resource: key('gateway_location'),
    readOnlyFields: LOCATION_READ_ONLY, inverse: 'put_before', validate: validateLocation,
  },
  {
    ...account, kind: 'gateway_location_delete', methods: ['DELETE'], pattern: one('locations'), resource: key('gateway_location'),
    readOnlyFields: LOCATION_READ_ONLY, inverse: 'recreate', destructive: true, nameField: 'name',
    notes: (ctx, op) => notesLocationDelete(ctx, op),
  },
  {
    ...account, kind: 'gateway_config_patch', methods: ['PATCH'], pattern: /^\/gateway\/configuration$/,
    resource: () => ({ type: 'gateway_config', id: 'configuration' }), readOnlyFields: CONFIG_READ_ONLY,
    capture: captureConfig, inverse: restoreConfig, validate: validateConfig, notes: (ctx, op) => notesConfig(ctx, op),
  },
];

// { kind, id } of a Gateway op from its path alone (lockoutRisks and notes
// get no plan); null for any other op.
function parse(op) {
  const target = opTarget(op);
  const hit = target && matchKind(KINDS, op.method, target.scope, target.rest);
  return hit ? { kind: hit.entry.kind, id: hit.match[1] ?? null } : null;
}

// ---------- traffic expression matcher (spec 13) ----------

// Splits an expression on top-level `or`. Null when it holds a top-level
// `and`, `not` or anything else that narrows or negates: the matcher then
// reports it as not analyzable instead of guessing.
function splitOr(text) {
  const parts = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') quote = true;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (depth === 0) {
      const rest = text.slice(i);
      if (/^(&&|and\s|not[\s(]|!)/.test(rest) && /(^|[\s)])$/.test(text.slice(0, i))) return null;
      const or = /^(\|\||or\s)/.exec(rest);
      if (or && /(^|[\s)])$/.test(text.slice(0, i))) {
        parts.push(text.slice(start, i));
        i += or[0].length - 1;
        start = i + 1;
      }
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim());
}

function stripParens(text) {
  let s = text.trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      if (depth === 0) {
        wraps = false;
        break;
      }
    }
    if (!wraps) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

const QUOTED = /^"((?:[^"\\]|\\.)*)"$/;
const LIST_REF = /^\$([0-9a-f-]{32,36})$/i;
const TRIVIAL_ALL = new Set(['.*', '.+', '^.*$', '^.+$', '.', '^.*', '.*$']);
const SELECTORS = {
  'dns.domains': 'domain',
  'dns.fqdn': 'host',
  'http.request.host': 'host',
  'net.dst.ip': 'ip',
};

const cleanHost = (value) => String(value).toLowerCase().replace(/\.$/, '').replace(/^\*\./, '');

// Values of a set `{...}`, a quoted string, a bare IP or a list reference.
function operandValues(operand, resolveList) {
  const s = operand.trim();
  const ref = LIST_REF.exec(s);
  if (ref) return resolveList(ref[1].toLowerCase());
  if (s.startsWith('{') && s.endsWith('}')) {
    const tokens = s.slice(1, -1).match(/"(?:[^"\\]|\\.)*"|[^\s",]+/g) ?? [];
    return tokens.map((t) => (QUOTED.test(t) ? QUOTED.exec(t)[1] : t));
  }
  const quoted = QUOTED.exec(s);
  if (quoted) return [quoted[1]];
  return /^[0-9a-f.:/]+$/i.test(s) ? [s] : null;
}

// Atoms of one selector comparison; null when not analyzable.
function parseAtom(text, resolveList) {
  const m = /^any\(\s*(dns\.domains)\[\*\]\s*(==|in|matches|~)\s*(.+?)\s*\)$/s.exec(text)
    ?? /^(dns\.fqdn|http\.request\.host|net\.dst\.ip)\s*(==|in|matches|~)\s*(.+)$/s.exec(text);
  if (!m) return null;
  const kind = SELECTORS[m[1]];
  const [, , operator, operand] = m;
  if (operator === 'matches' || operator === '~') {
    const quoted = QUOTED.exec(operand.trim());
    if (!quoted || kind === 'ip') return null;
    if (TRIVIAL_ALL.has(quoted[1])) return [{ kind: 'all' }];
    try {
      return [{ kind: 'regex', on: kind, re: new RegExp(quoted[1], 'i'), value: quoted[1] }];
    } catch {
      return null;
    }
  }
  if (operator === '==' && LIST_REF.test(operand.trim())) return null;
  const found = operandValues(operand, resolveList);
  if (!Array.isArray(found)) return null;
  return found.map((value) => {
    if (kind === 'ip') return value === '0.0.0.0/0' || value === '::/0' ? { kind: 'all' } : { kind, value: String(value).toLowerCase() };
    return { kind, value: cleanHost(value) };
  });
}

// { all, atoms } for an expression, or null when it cannot be analyzed.
// Empty traffic matches every request of the rule's phase.
function analyze(expr, resolveList) {
  const text = String(expr ?? '').trim();
  if (text === '') return { all: true, atoms: [{ kind: 'all' }] };
  const parts = splitOr(stripParens(text));
  if (!parts) return null;
  const atoms = [];
  for (const part of parts) {
    const inner = stripParens(part);
    if (inner !== part.trim() && splitOr(inner)?.length > 1) {
      const nested = analyze(inner, resolveList);
      if (!nested) return null;
      atoms.push(...nested.atoms);
      continue;
    }
    const parsed = parseAtom(inner, resolveList);
    if (!parsed) return null;
    atoms.push(...parsed);
  }
  return { all: atoms.some((a) => a.kind === 'all'), atoms };
}

const within = (host, domain) => host === domain || host.endsWith(`.${domain}`);

// Protected hosts an atom matches.
function atomHits(atom, hosts) {
  return hosts.filter(({ host }) => {
    if (atom.kind === 'domain') return within(host, atom.value) || within(atom.value, host);
    if (atom.kind === 'host') return within(atom.value, host);
    if (atom.kind === 'regex') return atom.re.test(host);
    return false;
  });
}

function ipv4Range(value) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(value);
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  const bits = m[5] === undefined ? 32 : Number(m[5]);
  if (octets.some((o) => o > 255) || bits > 32) return null;
  const ip = octets.reduce((acc, o) => acc * 256 + o, 0);
  const size = 2 ** (32 - bits);
  const start = Math.floor(ip / size) * size;
  return [start, start + size - 1];
}

function atomsOverlap(a, b) {
  if (a.kind === 'all' || b.kind === 'all') return true;
  if (a.kind === 'regex' && b.kind === 'regex') return true;
  if (a.kind === 'regex' || b.kind === 'regex') {
    const [re, other] = a.kind === 'regex' ? [a, b] : [b, a];
    return other.kind !== 'ip' && re.re.test(other.value);
  }
  if (a.kind === 'ip' || b.kind === 'ip') {
    if (a.kind !== b.kind) return false;
    const [ra, rb] = [ipv4Range(a.value), ipv4Range(b.value)];
    return ra && rb ? ra[0] <= rb[1] && rb[0] <= ra[1] : a.value === b.value;
  }
  if (a.kind === 'domain' && b.kind === 'domain') return within(a.value, b.value) || within(b.value, a.value);
  if (a.kind === 'host' && b.kind === 'host') return a.value === b.value;
  const [host, domain] = a.kind === 'host' ? [a, b] : [b, a];
  return within(host.value, domain.value);
}

// First overlapping value of two analyzed expressions, or null.
function overlap(x, y) {
  for (const a of x.atoms) {
    for (const b of y.atoms) {
      if (atomsOverlap(a, b)) return a.kind === 'all' ? (b.value ?? 'all traffic') : (a.value ?? 'all traffic');
    }
  }
  return null;
}

// ---------- protected hosts ----------

const CLOUDFLARE_HOSTS = [
  { host: 'cloudflareaccess.com', owner: 'Cloudflare Access logins' },
  { host: 'cloudflare.com', owner: 'Cloudflare dashboard and API' },
  { host: 'cloudflareclient.com', owner: 'WARP client' },
];

// Login hosts of identity provider types whose config holds no URL.
const IDP_TYPE_HOSTS = {
  github: ['github.com'],
  google: ['accounts.google.com'],
  'google-apps': ['accounts.google.com'],
  azureAD: ['login.microsoftonline.com'],
  linkedin: ['www.linkedin.com'],
  facebook: ['www.facebook.com'],
};

const HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

// Hosts from an IdP config: every http(s) URL value, plus bare host names in
// *_account and *domain keys. Never other config values. Devices reuses it.
export function idpHosts(idp) {
  const hosts = new Set(IDP_TYPE_HOSTS[idp?.type] ?? []);
  for (const [field, value] of Object.entries(isPlainObject(idp?.config) ? idp.config : {})) {
    if (/secret/i.test(field)) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item !== 'string' || item === '') continue;
      if (/^https?:\/\//i.test(item)) {
        try {
          hosts.add(new URL(item).hostname.toLowerCase());
        } catch {
          // not a URL after all
        }
      } else if (/(_account|domain)$/.test(field) && HOSTNAME.test(item)) {
        hosts.add(item.toLowerCase());
      }
    }
  }
  return [...hosts].map((host) => ({ host, owner: `login host of identity provider ${idp?.name ?? idp?.id}` }));
}

// ---------- gather ----------

// Token template permissions (spec 12). Gateway reads name the Zero Trust
// one; the identity provider read names the Access one it actually needs.
const PERM = {
  gateway: 'Zero Trust Edit',
  idps: 'Access: Organizations, Identity Providers, and Groups Read',
};

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

function summarizeRule(rule) {
  const out = {
    id: rule?.id,
    name: rule?.name ?? rule?.id ?? 'unnamed rule',
    action: rule?.action ?? null,
    enabled: rule?.enabled !== false,
    phase: Array.isArray(rule?.filters) && nonEmpty(rule.filters[0]) ? rule.filters[0] : null,
    precedence: Number.isFinite(Number(rule?.precedence)) ? Number(rule.precedence) : null,
  };
  for (const field of EXPRESSION_FIELDS) out[field] = typeof rule?.[field] === 'string' ? rule[field] : '';
  return out;
}

const LIST_REFS = /\$([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})/gi;

function refsOf(rule) {
  return EXPRESSION_FIELDS.flatMap((field) => [...String(rule?.[field] ?? '').matchAll(LIST_REFS)].map((m) => m[1].toLowerCase()));
}

function mentions(rule, id) {
  const needle = String(id).toLowerCase();
  return EXPRESSION_FIELDS.some((field) => typeof rule?.[field] === 'string' && rule[field].toLowerCase().includes(needle));
}

// Rule state after the plan's rule ops, keyed by id (`new:<index>` for creates).
function rulesAfter(ctx, ops) {
  const state = new Map((ctx.rules ?? []).map((r) => [r.id, r]));
  ops.forEach((op, index) => {
    const p = parse(op);
    if (p?.kind === 'gateway_rule_create') state.set(`new:${index}`, summarizeRule({ ...op.body, id: `new:${index}` }));
    if (p?.kind === 'gateway_rule_update') state.set(p.id, summarizeRule({ ...op.body, id: p.id }));
    if (p?.kind === 'gateway_rule_delete') state.delete(p.id);
  });
  return state;
}

// Items each list update in the plan writes (a PUT with items replaces them).
function updatedItems(ops) {
  const out = new Map();
  for (const op of ops) {
    const p = parse(op);
    if (p?.kind === 'gateway_list_update' && Array.isArray(op.body?.items) && op.body.items.length) {
      out.set(p.id.toLowerCase(), op.body.items.map((i) => String(i?.value ?? '')));
    }
  }
  return out;
}

// Lists whose items lockout analysis needs: those the plan's rule bodies use
// and those of enabled allow and block rules in the phases the plan touches
// or that use a list the plan updates.
function listsToRead(ctx, ops) {
  const after = rulesAfter(ctx, ops);
  const before = new Map((ctx.rules ?? []).map((r) => [r.id, r]));
  const phases = new Set();
  const ids = new Set();
  ops.forEach((op, index) => {
    const p = parse(op);
    if (!p?.kind.startsWith('gateway_rule_')) return;
    for (const rule of [before.get(p.id), after.get(p.kind === 'gateway_rule_create' ? `new:${index}` : p.id)]) {
      if (!rule) continue;
      if (rule.phase) phases.add(rule.phase);
      refsOf(rule).forEach((id) => ids.add(id));
    }
  });
  const updated = updatedItems(ops);
  for (const rule of [...before.values(), ...after.values()]) {
    if (!rule.enabled || (rule.action !== 'allow' && rule.action !== 'block')) continue;
    const refs = refsOf(rule);
    if (phases.has(rule.phase) || refs.some((id) => updated.has(id))) refs.forEach((id) => ids.add(id));
  }
  return [...ids];
}

// Account reads for lockout analysis, dependencies, notes and verification.
// Every list is read to the last page, so a rule on page two still counts
// (Review Focus 1).
async function gather(client, base, ops) {
  const read = (path, permission, fn) => withPermission(permission, path, fn);
  const all = (path, permission = PERM.gateway) => read(path, permission, () => listAll(client, path));
  const rules = await all(`${base}/gateway/rules`);
  const lists = await all(`${base}/gateway/lists`);
  const locations = await all(`${base}/gateway/locations`);
  const configuration = await read(`${base}/gateway/configuration`, PERM.gateway, () => client.request('GET', `${base}/gateway/configuration`));
  const idps = await all(`${base}/access/identity_providers`, PERM.idps);
  const ctx = {
    rules: rules.map(summarizeRule),
    lists: Object.fromEntries(lists.map((l) => [String(l.id).toLowerCase(), { id: l.id, name: l.name ?? l.id, type: l.type ?? null, count: l.count ?? null }])),
    locations: locations.map((l) => ({
      id: l.id, name: l.name ?? l.id, doh_subdomain: l.doh_subdomain ?? null, ip: l.ip ?? null,
      ipv4_destination: l.ipv4_destination ?? null, ipv4_destination_backup: l.ipv4_destination_backup ?? null,
    })),
    tls_decrypt: configuration?.settings?.tls_decrypt?.enabled === true,
    settings_keys: Object.keys(isPlainObject(configuration?.settings) ? configuration.settings : {}),
    protected_hosts: [...CLOUDFLARE_HOSTS, ...idps.flatMap(idpHosts)],
  };
  for (const id of listsToRead(ctx, ops)) {
    if (!ctx.lists[id]) continue;
    const path = `${base}/gateway/lists/${ctx.lists[id].id}/items`;
    const items = (await all(path)).flat();
    ctx.lists[id].items = items.map((i) => String(i?.value ?? '')).filter(Boolean);
  }
  ctx.in_use = inUse(ctx, ops);
  return ctx;
}

// Rules that still mention each list a delete in this plan removes, after
// the plan's earlier rule ops ran (spec 5.3: preflight refuses, it does not
// rely on the API).
function inUse(ctx, ops) {
  const items = ops.map((op, index) => ({ ...parse(op), op, index })).filter((p) => p.kind);
  const out = {};
  for (const del of items.filter((p) => p.kind === 'gateway_list_delete')) {
    const users = new Map();
    for (const rule of ctx.rules ?? []) if (mentions(rule, del.id)) users.set(rule.id, `Gateway rule ${rule.name} (${rule.id})`);
    for (const p of items.filter((x) => x.index < del.index)) {
      const body = p.op.body;
      if (p.kind === 'gateway_rule_delete') users.delete(p.id);
      if (p.kind === 'gateway_rule_update') {
        if (mentions(body, del.id)) users.set(p.id, `Gateway rule ${body?.name ?? p.id} (${p.id})`);
        else users.delete(p.id);
      }
      if (p.kind === 'gateway_rule_create' && mentions(body, del.id)) users.set(`new:${p.index}`, `new Gateway rule ${body?.name ?? ''} (op ${p.index})`);
    }
    out[del.id.toLowerCase()] = [...users.values()];
  }
  return out;
}

// resource_in_use only (Ruling 15).
function dependencies(ctx, op, entry) {
  if (entry.kind !== 'gateway_list_delete') return [];
  return ctx?.in_use?.[String(parse(op)?.id).toLowerCase()] ?? [];
}

// ---------- lockout analysis (spec 6 items 5 and 6) ----------

function unanalyzableLine(name) {
  return `${LOCKOUT_PREFIX} could not analyze traffic expression of rule ${name}; check it does not block Cloudflare or IdP domains`;
}

function narrowed(rule) {
  return nonEmpty(rule.identity) || nonEmpty(rule.device_posture) ? ' (for the users and devices its identity and device posture expressions select)' : '';
}

function phaseLabel(phase) {
  return phase ? `${String(phase).toUpperCase()} ` : '';
}

// Item 5 for one block rule as it will be after the plan.
function blockLines(rule, selector, suffix = '') {
  if (!selector) return [unanalyzableLine(rule.name)];
  if (selector.all) {
    return [`${LOCKOUT_PREFIX} Gateway block rule ${rule.name} matches all ${phaseLabel(rule.phase)}traffic${narrowed(rule)}${suffix}; every device behind Gateway loses access, including to Cloudflare and identity provider logins. ${ROLLBACK_HINT}`];
  }
  return [];
}

function protectedLines(rule, selector, hosts, suffix = '') {
  if (!selector || selector.all) return [];
  // Name the narrower of the two: dash.cloudflare.com for a host atom, the
  // protected host for a broad domain such as com.
  const hits = new Map();
  for (const atom of selector.atoms) {
    for (const hit of atomHits(atom, hosts)) {
      const shown = atom.kind !== 'regex' && within(atom.value, hit.host) ? atom.value : hit.host;
      hits.set(shown, `${shown} (${hit.owner})`);
    }
  }
  if (!hits.size) return [];
  const named = [...hits.values()];
  return [`${LOCKOUT_PREFIX} Gateway block rule ${rule.name} matches ${list(named)}${narrowed(rule)}${suffix}; devices behind Gateway cannot sign in to Access, reach the Cloudflare dashboard or keep WARP connected. ${ROLLBACK_HINT}`];
}

const isBlock = (rule) => rule?.enabled && rule.action === 'block';
const isAllow = (rule) => rule?.enabled && rule.action === 'allow';

// Item 6: traffic an allow rule let through before the plan that a block
// rule catches after it, because the block now runs first, the allow moved
// below it or the allow is gone.
function orderLines(ctx, ops, resolveBefore, resolveAfter) {
  const before = new Map((ctx.rules ?? []).map((r) => [r.id, r]));
  const after = rulesAfter(ctx, ops);
  const changed = (a, b) => !b || a.precedence !== b.precedence || a.phase !== b.phase || a.enabled !== b.enabled || a.action !== b.action;
  const lines = [];
  for (const allow of [...before.values()].filter(isAllow)) {
    const allowAfter = after.get(allow.id);
    for (const block of [...after.values()].filter((r) => isBlock(r) && r.phase === allow.phase && r.id !== allow.id)) {
      const blockBefore = before.get(block.id);
      if (block.precedence === null || allow.precedence === null || allowAfter?.precedence === null) {
        // Without a precedence the order after apply is unknown.
        if (block === blockBefore && allowAfter === allow) continue;
        const allowSel = analyze(allow.traffic, resolveBefore);
        const blockSel = analyze(block.traffic, resolveAfter);
        const shared = allowSel && blockSel ? overlap(allowSel, blockSel) : undefined;
        if (shared === null) continue;
        const why = shared === undefined ? 'one of their traffic expressions could not be analyzed' : `both match ${shared}`;
        lines.push(`${LOCKOUT_PREFIX} Gateway block rule ${block.name} has no precedence, so it may run before allow rule ${allow.name}, and ${why}; set precedence so the allow rule keeps running first. ${ROLLBACK_HINT}`);
        continue;
      }
      const shieldedBefore = !(isBlock(blockBefore) && blockBefore.phase === allow.phase) || allow.precedence < blockBefore.precedence;
      const shieldedAfter = isAllow(allowAfter) && allowAfter.phase === block.phase && allowAfter.precedence < block.precedence;
      if (!shieldedBefore || shieldedAfter) continue;
      const allowSel = analyze(allow.traffic, resolveBefore);
      const blockSel = analyze(block.traffic, resolveAfter);
      const shared = allowSel && blockSel ? overlap(allowSel, blockSel) : undefined;
      if (shared === null) continue;
      // The sentence names the rule that changed first: a new or moved block
      // rule, or an allow rule that moved down or is deleted.
      const allowMoved = !allowAfter || changed(allowAfter, allow);
      let line;
      if (!allowAfter) line = `${LOCKOUT_PREFIX} deleting Gateway allow rule ${allow.name} leaves block rule ${block.name} in charge`;
      else if (allowMoved) line = `${LOCKOUT_PREFIX} Gateway allow rule ${allow.name} now runs after block rule ${block.name}`;
      else line = `${LOCKOUT_PREFIX} Gateway block rule ${block.name} now runs before allow rule ${allow.name}`;
      if (shared === undefined) {
        const unknownIsObject = allowMoved ? !blockSel : !allowSel;
        const unknown = !blockSel ? `block rule ${block.name}` : `allow rule ${allow.name}`;
        line += unknownIsObject ? ', whose traffic expression could not be analyzed' : `, and the traffic expression of ${unknown} could not be analyzed`;
        line += '; check they do not overlap, or traffic the allow rule let through is blocked.';
      } else {
        line += `, and both match ${shared}; traffic the allow rule let through is now blocked.`;
      }
      lines.push(`${line} ${ROLLBACK_HINT}`);
    }
  }
  return lines;
}

function lockoutRisks(ctx, ops) {
  const lists = ctx?.lists ?? {};
  const updated = updatedItems(ops);
  const resolveBefore = (id) => lists[id]?.items ?? null;
  const resolveAfter = (id) => updated.get(id) ?? resolveBefore(id);
  const hosts = ctx?.protected_hosts ?? CLOUDFLARE_HOSTS;
  const lines = [];
  ops.forEach((op, index) => {
    const p = parse(op);
    if (p?.kind === 'gateway_rule_create' || p?.kind === 'gateway_rule_update') {
      const rule = summarizeRule({ ...op.body, id: p.id ?? `new:${index}` });
      if (!isBlock(rule)) return;
      const selector = analyze(rule.traffic, resolveAfter);
      lines.push(...blockLines(rule, selector), ...protectedLines(rule, selector, hosts));
    }
    if (p?.kind === 'gateway_list_update' && updated.has(p.id.toLowerCase())) {
      const name = lists[p.id.toLowerCase()]?.name ?? p.id;
      const suffix = ` after ${op.method} ${op.path} changes list ${name}`;
      for (const rule of rulesAfter(ctx, ops).values()) {
        if (!isBlock(rule) || !refsOf(rule).includes(p.id.toLowerCase())) continue;
        const selector = analyze(rule.traffic, resolveAfter);
        lines.push(...blockLines(rule, selector, suffix), ...protectedLines(rule, selector, hosts, suffix));
      }
    }
  });
  lines.push(...orderLines(ctx ?? {}, ops, resolveBefore, resolveAfter));
  // Spec 5.3 (Ruling 20): TLS decryption turned on is a lockout line.
  for (const op of ops) {
    if (parse(op)?.kind !== 'gateway_config_patch' || op.body?.settings?.tls_decrypt?.enabled !== true || ctx?.tls_decrypt === true) continue;
    lines.push(`${LOCKOUT_PREFIX} turning on TLS decryption breaks apps that use certificate pinning and devices without the Cloudflare root certificate: their HTTPS connections through Gateway fail. Add Do Not Inspect rules for them and install the certificate first. ${ROLLBACK_HINT}`);
  }
  return [...new Set(lines)];
}

// ---------- conflicts (spec 4.5) ----------

// Rule ops that set precedence in one phase must run in ascending order:
// the snapshot of each sees the rules the earlier ops already placed.
function conflicts(ops, classified) {
  const last = new Map();
  classified.forEach((c, index) => {
    if (c?.module?.product !== 'gateway') return;
    if (c.entry.kind !== 'gateway_rule_create' && c.entry.kind !== 'gateway_rule_update') return;
    const body = ops[index]?.body;
    if (!Number.isInteger(body?.precedence)) return;
    const phase = Array.isArray(body.filters) && nonEmpty(body.filters[0]) ? body.filters[0] : 'unknown';
    const prev = last.get(phase);
    if (prev && body.precedence <= prev.precedence) {
      throw new CfError('plan_conflict', `Ops ${prev.index} and ${index} change precedence in Gateway phase ${phase} out of ascending order (${prev.precedence}, then ${body.precedence}); order the rule ops of one phase by ascending precedence`);
    }
    last.set(phase, { index, precedence: body.precedence });
  });
}

// ---------- notes ----------

function notesRuleDelete(ctx, op) {
  const id = parse(op)?.id;
  const rule = (ctx?.rules ?? []).find((r) => r.id === id);
  const at = Number.isFinite(rule?.precedence) ? ` at precedence ${rule.precedence}` : ' at its old precedence';
  return [`A rollback re-creates Gateway rule ${rule ? `${rule.name} (${id})` : id} with a new id${at}.`];
}

function notesListDelete(ctx, op) {
  const id = parse(op)?.id;
  const name = ctx?.lists?.[String(id).toLowerCase()]?.name;
  return [`A rollback re-creates Gateway list ${name ? `${name} (${id})` : id} with its items and a new id; rules written later must use the new id.`];
}

function notesLocationDelete(ctx, op) {
  const id = parse(op)?.id;
  const loc = (ctx?.locations ?? []).find((l) => l.id === id);
  const endpoints = loc
    ? [loc.doh_subdomain && `https://${loc.doh_subdomain}.cloudflare-gateway.com/dns-query`, loc.ipv4_destination, loc.ipv4_destination_backup, loc.ip].filter(Boolean)
    : [];
  const old = endpoints.length ? ` (${list(endpoints)})` : '';
  return [`Deleting Gateway location ${loc ? `${loc.name} (${id})` : id}: devices and routers that send DNS to its endpoints${old} stop being filtered. A rollback re-creates it with a new DoH subdomain and new IPs, so they must be reconfigured either way.`];
}

// A subcollection the account does not have and that has no documented off
// value cannot be removed again by a rollback PATCH.
function notesConfig(ctx, op) {
  const keys = ctx?.settings_keys;
  if (!Array.isArray(keys)) return [];
  return Object.keys(isPlainObject(op?.body?.settings) ? op.body.settings : {})
    .filter((sub) => !keys.includes(sub) && !CONFIG_OFF[sub])
    .map((sub) => `Not reversible: ${op.method} ${op.path} adds settings.${sub}, which this account does not have yet; a rollback cannot remove it (no documented off value).`);
}

// ---------- verification (spec 8) ----------

// Whitespace, comma and && / || spelling differences outside quoted strings
// do not count: the API reformats expressions (Review Focus 3).
export function normalizeExpression(value) {
  return String(value ?? '')
    .split(/("(?:[^"\\]|\\.)*")/)
    .map((part, i) => (i % 2 ? part : part
      .replace(/&&/g, ' and ')
      .replace(/\|\|/g, ' or ')
      .replace(/,/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s*([()[\]{}=!<>~])\s*/g, '$1')))
    .join('')
    .trim();
}

function compareExpressions(body, post) {
  for (const field of EXPRESSION_FIELDS) {
    if (typeof body?.[field] !== 'string') continue;
    const got = typeof post?.[field] === 'string' ? post[field] : '';
    if (normalizeExpression(body[field]) !== normalizeExpression(got)) {
      return { ok: false, detail: `read-back differs at ${field} (compared without formatting)` };
    }
  }
  return null;
}

// A list GET may hold no items; then the count is compared.
function compareItems(body, post) {
  if (!Array.isArray(body?.items)) return null;
  const sent = body.items.map((i) => String(i?.value)).sort();
  if (Array.isArray(post?.items)) {
    const got = post.items.map((i) => String(i?.value)).sort();
    return JSON.stringify(got) === JSON.stringify(sent) ? null : { ok: false, detail: 'read-back differs at items' };
  }
  if (typeof post?.count === 'number' && post.count !== sent.length) {
    return { ok: false, detail: `read-back count is ${post.count}, sent ${sent.length} items` };
  }
  return null;
}

// A name to test with dig: the rule's first domain or host, a list's first
// host-like value, else a placeholder.
function testDomain(op, entry) {
  if (entry.kind.startsWith('gateway_rule_')) {
    const atom = analyze(op.body?.traffic, () => null)?.atoms.find((a) => a.kind === 'domain' || a.kind === 'host');
    if (atom) return atom.value;
  }
  const value = Array.isArray(op.body?.items) ? cleanHost(op.body.items[0]?.value ?? '') : '';
  return HOSTNAME.test(value) ? value : 'example.com';
}

function readback(op, entry, post) {
  const isRule = entry.kind.startsWith('gateway_rule_');
  const isList = entry.kind.startsWith('gateway_list_');
  const ignore = [...entry.readOnlyFields, ...(isRule ? EXPRESSION_FIELDS : []), ...(isList ? ['items'] : [])];
  const inner = readbackCheck(post, op.body, ignore);
  const hint = `test command: dig ${testDomain(op, entry)} +short on a device behind Gateway (0.0.0.0 or the block page address means blocked); ${HONESTY}`;
  return {
    name: 'readback',
    once: true,
    run: async () => {
      let out = await inner.run();
      if (out.ok && isRule) out = compareExpressions(op.body, post) ?? out;
      if (out.ok && isList) out = compareItems(op.body, post) ?? out;
      return { ok: out.ok, detail: `${out.detail}; ${hint}` };
    },
  };
}

// Read-back for every changed resource (deletes leave nothing to read). The
// detail always ends with the dig test and the note that filtering is only
// verified on a device behind Gateway.
function verifyChecks(op, entry, ctx, result, post) {
  if (String(op.method).toUpperCase() === 'DELETE') return [];
  return [readback(op, entry, post)];
}

// ---------- entitlement ----------

const NO_ORG = { ok: false, detail: 'no Zero Trust organization on this account; create one in the Zero Trust dashboard first' };

// Gateway needs a Zero Trust organization (spec 9).
async function entitlement(client, base) {
  const path = `${base}/access/organizations`;
  let org;
  try {
    org = await withPermission(PERM.idps, path, () => client.request('GET', path));
  } catch (err) {
    if (err instanceof CfError && err.code === 'not_found') return NO_ORG;
    throw err;
  }
  return nonEmpty(org?.auth_domain) ? { ok: true, detail: `Zero Trust organization ${org.auth_domain}` } : NO_ORG;
}

/** @type {import('./index.mjs').ProductModule} */
export const GATEWAY = {
  product: 'gateway',
  kinds: KINDS,
  permission: { read: 'Zero Trust Read', edit: PERM.gateway },
  probePath: (base) => `${base}/gateway/rules`,
  entitlement,
  gather,
  dependencies,
  lockoutRisks,
  conflicts,
  verifyChecks,
};
