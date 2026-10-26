// Cloudflare WARP devices product module (spec 5.4): the default and custom
// device profiles, their split tunnel include and exclude lists, their local
// domain fallback lists, and device posture rules. All kinds are account
// scoped under /accounts/<id>/devices. The engine snapshots, inverts and
// redacts; this module adds body validation, the split tunnel mode conflict
// rule (spec 4.5), the account reads lockout and dependency checks need,
// risk notes and verification.
//
// Split tunnel mode: a profile is in include mode when it carries an
// `include` list and in exclude mode (the WARP default) when it carries
// `exclude`. A profile PATCH whose body sets `include` (or `exclude`) sets
// that list and switches the mode; the API refuses both in one request.

import { CfError } from '../errors.mjs';
import { LOCKOUT_PREFIX } from '../lockout-text.mjs';
import { listAll } from '../paginate.mjs';
import { omitPaths } from './fields.mjs';
import { idpHosts } from './gateway.mjs';
import { matchKind, opTarget } from './match.mjs';
import { readbackCheck, teamDomainOf } from '../verify.mjs';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

// Path segment rest-exec.mjs (CREATED_ID) fills with the id an earlier
// rollback op created. Kept as a literal: importing rest-exec here would
// close an import cycle through the product registry.
const CREATED_ID = '{created_id}';

const MODE_KEYS = ['include', 'exclude'];
const LIST_KEYS = ['include', 'exclude', 'fallback_domains'];

// Fields Cloudflare sets on a profile. `lists` is claudeflare's own record of
// the list endpoints (snapshot and post state), never sent back. Which list
// fields a profile's drift precheck compares is decided per op
// (profileDriftIgnore).
const PROFILE_READ_ONLY = ['policy_id', 'id', 'default', 'gateway_unique_id', 'target_tests', 'created_at', 'updated_at', 'lists'];
const POSTURE_READ_ONLY = ['id', 'created_at', 'updated_at'];

const HONESTY = 'device behavior is only verified on a device';
const ROLLBACK_HINT = 'If it happens, roll this plan back with claudeflare rollback from a machine that does not depend on this profile.';

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

const setsMode = (body) => isPlainObject(body) && MODE_KEYS.some((key) => key in body);

// ---------- validation (Ruling 15) ----------

// Messages name field paths, never values.
function splitEntryProblems(entries, field) {
  if (!Array.isArray(entries)) return [`${field} must be an array of { "address": "<cidr>" } or { "host": "<domain>" } entries`];
  const problems = [];
  entries.forEach((entry, i) => {
    const has = (key) => isPlainObject(entry) && nonEmpty(entry[key]);
    if (has('address') === has('host')) problems.push(`${field}.${i} needs exactly one of address or host`);
    if (isPlainObject(entry) && 'description' in entry && typeof entry.description !== 'string') problems.push(`${field}.${i}.description must be a string`);
  });
  return problems;
}

function fallbackProblems(entries, field) {
  if (!Array.isArray(entries)) return [`${field} must be an array of { "suffix": "<domain>" } entries`];
  const problems = [];
  entries.forEach((entry, i) => {
    if (!isPlainObject(entry) || !nonEmpty(entry.suffix)) problems.push(`${field}.${i} needs a string suffix`);
    else if ('dns_server' in entry && (!Array.isArray(entry.dns_server) || !entry.dns_server.every(nonEmpty))) {
      problems.push(`${field}.${i}.dns_server must be an array of server addresses`);
    }
  });
  return problems;
}

function profileValidator(kind) {
  return (op) => {
    const body = op.body;
    if (!isPlainObject(body) || (kind === 'patch' && Object.keys(body).length === 0)) {
      return [kind === 'create' ? 'needs a body { "name", "match", "precedence", ... }' : 'needs a body with the profile settings to change'];
    }
    const problems = [];
    for (const key of PROFILE_READ_ONLY) if (key in body) problems.push(`${key} is set by Cloudflare and cannot be written`);
    if ('include' in body && 'exclude' in body) problems.push('sets both include and exclude; a profile has one split tunnel mode');
    for (const key of MODE_KEYS) if (key in body) problems.push(...splitEntryProblems(body[key], key));
    if ('fallback_domains' in body) problems.push('fallback_domains is written with PUT .../fallback_domains, not in the profile body');
    if ('switch_locked' in body && typeof body.switch_locked !== 'boolean') problems.push('switch_locked must be true or false');
    if (kind === 'create' || 'name' in body) if (!nonEmpty(body.name)) problems.push('needs a non-empty string name');
    if (kind === 'create' || 'match' in body) if (!nonEmpty(body.match)) problems.push('needs a non-empty string match expression');
    if (kind === 'create' || 'precedence' in body) if (!Number.isInteger(body.precedence)) problems.push('precedence must be an integer');
    return problems;
  };
}

function listValidator(name) {
  return (op) => (name === 'fallback_domains' ? fallbackProblems(op.body, 'body') : splitEntryProblems(op.body, 'body'));
}

function validatePosture(op) {
  const body = op.body;
  if (!isPlainObject(body)) return ['needs a body { "name", "type", "match", "input" }'];
  const problems = [];
  if (!nonEmpty(body.name)) problems.push('needs a non-empty string name');
  if (!nonEmpty(body.type)) problems.push('needs a non-empty string type (disk_encryption, firewall, os_version, ...)');
  return problems;
}

// ---------- gather helpers ----------

// Token template permissions (spec 12). Device reads name the Zero Trust
// one; the Access reads name the ones they actually need.
const PERM = {
  devices: 'Zero Trust Edit',
  apps: 'Access: Apps and Policies Read',
  org: 'Access: Organizations, Identity Providers, and Groups Read',
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

// A whole list endpoint: null means an empty list; anything but an array
// fails closed, so a snapshot never records a list it could not read.
async function readList(client, path) {
  const value = await withPermission(PERM.devices, path, () => client.request('GET', path));
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new CfError('api', `${path} did not return a list`);
  return value;
}

async function readLists(client, profilePath) {
  const out = {};
  for (const key of LIST_KEYS) out[key] = await readList(client, `${profilePath}/${key}`);
  return out;
}

// A recorded list of a profile: the list endpoint read, else the profile's
// own field. Null when neither was recorded.
function recorded(profile, key) {
  if (Array.isArray(profile?.lists?.[key])) return profile.lists[key];
  return Array.isArray(profile?.[key]) ? profile[key] : null;
}

function modeOf(profile) {
  const own = (key) => Array.isArray(profile?.[key]);
  if (own('include') !== own('exclude')) return own('include') ? 'include' : 'exclude';
  const include = recorded(profile, 'include') ?? [];
  const exclude = recorded(profile, 'exclude') ?? [];
  return include.length > 0 && exclude.length === 0 ? 'include' : 'exclude';
}

// ---------- snapshot and inverses ----------

// The profile, plus its list endpoints when the op switches mode or deletes
// the profile (spec 5.4: the delete snapshot holds the lists).
async function captureProfile(client, readPath, op) {
  const current = await withPermission(PERM.devices, readPath, () => client.request('GET', readPath));
  const needsLists = String(op?.method).toUpperCase() === 'DELETE' || setsMode(op?.body);
  return needsLists ? { ...current, lists: await readLists(client, readPath) } : current;
}

// Post state of a profile write; the lists are read when the op set one, so
// read-back can compare them even if the profile GET leaves them out.
async function capturePostProfile(client, readPath, op) {
  const current = await client.request('GET', readPath);
  return setsMode(op?.body) ? { ...current, lists: await readLists(client, readPath) } : current;
}

// A list endpoint as one snapshot: null becomes [], so put_before semantics
// hold for a list that was empty.
async function captureList(client, readPath) {
  return readList(client, readPath);
}

function ambiguous(message) {
  return new CfError('rollback_ambiguous', message);
}

function requireBefore(entry) {
  if (!isPlainObject(entry.before)) throw ambiguous(`No before state recorded for ${entry.path}`);
  return entry.before;
}

// PATCH back the keys the op set. A mode change goes back by PATCHing the old
// mode's list, which switches the mode back with the saved entries. That list
// is inactive after apply, so the profile's drift precheck leaves it out; its
// post-apply content (record) becomes a second baseline (`drift` on the first
// op), so a hand edit of it is never overwritten silently.
function restoreProfile(entry, _applyResult, record = null) {
  const before = requireBefore(entry);
  const keys = entry.op_body_keys ?? [];
  const body = {};
  for (const key of keys.filter((k) => !MODE_KEYS.includes(k))) {
    if (!Object.hasOwn(before, key) || before[key] === undefined) {
      throw ambiguous(`PATCH ${entry.path} set ${key}, absent before; it cannot be restored with PATCH`);
    }
    body[key] = before[key];
  }
  if (keys.some((k) => MODE_KEYS.includes(k))) {
    const mode = modeOf(before);
    const saved = recorded(before, mode);
    if (!saved) throw ambiguous(`No ${mode} list recorded for ${entry.path}`);
    body[mode] = saved;
    return [{ method: 'PATCH', path: entry.path, body, drift: { read: `${entry.path}/${mode}`, expect: record?.state?.lists?.[mode], list: true } }];
  }
  return Object.keys(body).length ? [{ method: 'PATCH', path: entry.path, body }] : [];
}

// Re-create the profile (new id), then PUT its saved lists to the new id:
// the inactive split tunnel list only when it held entries, then the active
// one (so the mode ends as it was even if a PUT switches it), then the
// fallback domains. Every op shares the group profile:<old id>.
function recreateProfile(entry) {
  const before = requireBefore(entry);
  const collection = parentPath(entry.path);
  const mode = modeOf(before);
  const other = mode === 'include' ? 'exclude' : 'include';
  const body = omitPaths(before, [...PROFILE_READ_ONLY, ...LIST_KEYS]);
  if (mode === 'include' && recorded(before, 'include')) body.include = recorded(before, 'include');
  const ops = [{ method: 'POST', path: collection, body }];
  const puts = [];
  if (recorded(before, other)?.length) puts.push(other);
  if (recorded(before, mode)) puts.push(mode);
  if (recorded(before, 'fallback_domains')) puts.push('fallback_domains');
  for (const key of puts) {
    ops.push({ method: 'PUT', path: `${collection}/${CREATED_ID}/${key}`, body: recorded(before, key), created_id_from: ops.length });
  }
  return ops;
}

// Profile list fields left out of the drift precheck of a profile write.
// The inverse never restores fallback_domains or the inactive mode list from
// live state, so they are always left out. The mode list the op itself set is
// compared, unless a later applied op of the plan PUT that same list of this
// profile: that op's rollback runs first with its own baseline and shares
// the group profile:<id>, so a hand edit still skips both.
function profileDriftIgnore(entry, applied = []) {
  const set = MODE_KEYS.filter((key) => (entry.op_body_keys ?? []).includes(key));
  const ignore = LIST_KEYS.filter((key) => !set.includes(key));
  for (const key of set) {
    const listPath = `${entry.path}/${key}`;
    if (applied.some((e) => e?.op_index > entry.op_index && e.kind === `device_split_${key}_put` && e.path === listPath)) ignore.push(key);
  }
  return ignore;
}

// put_before for a whole list (an array `before`, which the engine's
// put_before refuses).
function restoreList(entry) {
  if (!Array.isArray(entry.before)) throw ambiguous(`No list recorded for ${entry.path}`);
  return [{ method: 'PUT', path: entry.path, body: entry.before }];
}

// ---------- kinds ----------

const account = { product: 'devices', scope: 'account', destructive: false };
const profileId = (m) => m[1] ?? 'default';
const profileGroup = (m) => `profile:${profileId(m)}`;
const profileRead = (m, base) => (m[1] ? `${base}/devices/policy/${m[1]}` : `${base}/devices/policy`);
const ONE_PROFILE = new RegExp(`^/devices/policy/${UUID}$`);
const ONE_POSTURE = new RegExp(`^/devices/posture/${UUID}$`);
const listPattern = (name) => new RegExp(`^/devices/policy(?:/${UUID})?/${name}$`);

function listKind(kind, name, type) {
  return {
    ...account, kind, methods: ['PUT'], pattern: listPattern(name), resource: (m) => ({ type, id: profileId(m) }),
    readOnlyFields: [], capture: captureList, inverse: restoreList, group: profileGroup, validate: listValidator(name),
  };
}

const KINDS = [
  {
    ...account, kind: 'device_default_profile_patch', methods: ['PATCH'], pattern: /^\/devices\/policy$/,
    resource: () => ({ type: 'device_profile', id: 'default' }), read: profileRead, readOnlyFields: PROFILE_READ_ONLY, driftIgnore: profileDriftIgnore,
    capture: captureProfile, capturePost: capturePostProfile, inverse: restoreProfile, group: profileGroup, validate: profileValidator('patch'),
  },
  {
    ...account, kind: 'device_profile_create', methods: ['POST'], pattern: /^\/devices\/policy$/, resource: () => null,
    idField: 'policy_id', readOnlyFields: PROFILE_READ_ONLY, capturePost: capturePostProfile, inverse: 'delete_created',
    validate: profileValidator('create'),
  },
  {
    ...account, kind: 'device_profile_patch', methods: ['PATCH'], pattern: ONE_PROFILE, resource: (m) => ({ type: 'device_profile', id: m[1] }),
    read: profileRead, readOnlyFields: PROFILE_READ_ONLY, driftIgnore: profileDriftIgnore, capture: captureProfile, capturePost: capturePostProfile,
    inverse: restoreProfile, group: profileGroup, validate: profileValidator('patch'),
  },
  {
    ...account, kind: 'device_profile_delete', methods: ['DELETE'], pattern: ONE_PROFILE, resource: (m) => ({ type: 'device_profile', id: m[1] }),
    read: profileRead, readOnlyFields: PROFILE_READ_ONLY, driftIgnore: profileDriftIgnore, capture: captureProfile, inverse: recreateProfile, group: profileGroup,
    destructive: true, nameField: 'name', notes: (ctx, op) => notesProfileDelete(ctx, op),
  },
  listKind('device_split_include_put', 'include', 'device_split_include'),
  listKind('device_split_exclude_put', 'exclude', 'device_split_exclude'),
  listKind('device_fallback_put', 'fallback_domains', 'device_fallback'),
  {
    ...account, kind: 'device_posture_create', methods: ['POST'], pattern: /^\/devices\/posture$/, resource: () => null,
    readOnlyFields: POSTURE_READ_ONLY, inverse: 'delete_created', validate: validatePosture,
  },
  {
    ...account, kind: 'device_posture_update', methods: ['PUT'], pattern: ONE_POSTURE, resource: (m) => ({ type: 'device_posture', id: m[1] }),
    readOnlyFields: POSTURE_READ_ONLY, inverse: 'put_before', validate: validatePosture,
  },
  {
    ...account, kind: 'device_posture_delete', methods: ['DELETE'], pattern: ONE_POSTURE, resource: (m) => ({ type: 'device_posture', id: m[1] }),
    readOnlyFields: POSTURE_READ_ONLY, inverse: 'recreate', destructive: true, nameField: 'name',
    notes: (ctx, op) => notesPostureDelete(ctx, op),
  },
];

const PROFILE_PATCHES = new Set(['device_default_profile_patch', 'device_profile_patch']);
const SPLIT_PUTS = { device_split_include_put: 'include', device_split_exclude_put: 'exclude' };

// { kind, id } of a devices op from its path alone (lockoutRisks and notes
// get no plan); id is the profile id ('default' for the default profile) or
// the posture rule id. Null for any other op.
function parse(op) {
  const target = opTarget(op);
  const hit = target && matchKind(KINDS, op.method, target.scope, target.rest);
  if (!hit) return null;
  const { kind } = hit.entry;
  const id = kind.startsWith('device_posture_') ? (hit.match[1] ?? null) : kind === 'device_profile_create' ? null : profileId(hit.match);
  return { kind, id };
}

// ---------- conflicts (spec 4.5) ----------

// A mode change resets the profile's lists, so a list PUT before it in the
// same plan would be lost. A profile delete with any write to its lists makes
// no sense either.
function conflicts(ops, classified) {
  const items = [];
  classified.forEach((c, index) => {
    if (c?.module?.product !== 'devices') return;
    const p = parse(ops[index]);
    if (p) items.push({ ...p, index, op: ops[index] });
  });
  for (const patch of items.filter((p) => PROFILE_PATCHES.has(p.kind) && setsMode(p.op.body))) {
    const earlier = items.find((p) => p.index < patch.index && p.id === patch.id && SPLIT_PUTS[p.kind]);
    if (earlier) {
      throw new CfError('plan_conflict', `Ops ${earlier.index} and ${patch.index}: op ${patch.index} changes the split tunnel mode of device profile ${patch.id}, which resets its lists, after op ${earlier.index} wrote its ${SPLIT_PUTS[earlier.kind]} list; put the mode change first`);
    }
  }
  for (const del of items.filter((p) => p.kind === 'device_profile_delete')) {
    const other = items.find((p) => p !== del && p.id === del.id && !p.kind.startsWith('device_posture_'));
    if (other) throw new CfError('plan_conflict', `Ops ${Math.min(del.index, other.index)} and ${Math.max(del.index, other.index)} both touch device profile ${del.id}, and op ${del.index} deletes it; split them into separate plans`);
  }
}

// ---------- gather ----------

// Posture rule ids an Access policy requires, includes or excludes.
function postureRefs(policy) {
  const out = new Set();
  for (const field of ['include', 'exclude', 'require']) {
    for (const rule of Array.isArray(policy?.[field]) ? policy[field] : []) {
      const uid = rule?.device_posture?.integration_uid;
      if (nonEmpty(uid)) out.add(uid.toLowerCase());
    }
  }
  return [...out];
}

function summarizeProfile(profile, id) {
  return {
    id,
    name: nonEmpty(profile?.name) ? profile.name : (id === 'default' ? 'Default' : id),
    mode: modeOf(profile),
    switch_locked: profile?.switch_locked === true,
  };
}

// Profiles whose lists the analysis and notes need: those the plan touches.
function touchedProfiles(ops) {
  return [...new Set(ops.map(parse).filter((p) => p?.id && !p.kind.startsWith('device_posture_')).map((p) => p.id))];
}

// Account reads for lockout analysis, dependencies, notes and verification.
// Every collection is read to the last page, so an Access policy on page two
// still counts (Review Focus 1). auth_domain sits at the top of ctx, where
// verify.mjs teamDomainOf reads it.
async function gather(client, base, ops) {
  const get = (path, permission = PERM.devices) => withPermission(permission, path, () => client.request('GET', path));
  const all = (path, permission = PERM.devices) => withPermission(permission, path, () => listAll(client, path));
  const org = await get(`${base}/access/organizations`, PERM.org);
  const defaultProfile = await get(`${base}/devices/policy`);
  const custom = await all(`${base}/devices/policies`);
  const settings = await get(`${base}/devices/settings`);
  const posture = await all(`${base}/devices/posture`);
  const policies = await all(`${base}/access/policies`, PERM.apps);
  const apps = await all(`${base}/access/apps`, PERM.apps);
  const idps = await all(`${base}/access/identity_providers`, PERM.org);

  const raw = new Map([['default', defaultProfile], ...custom.filter((p) => nonEmpty(p?.policy_id)).map((p) => [p.policy_id, p])]);
  for (const id of touchedProfiles(ops)) {
    if (!raw.has(id)) continue;
    const path = id === 'default' ? `${base}/devices/policy` : `${base}/devices/policy/${id}`;
    raw.set(id, { ...raw.get(id), lists: await readLists(client, path) });
  }
  const users = new Map();
  for (const p of policies) users.set(p.id, { label: `Access policy ${p.name ?? p.id} (${p.id})`, name: p.name ?? p.id, refs: postureRefs(p) });
  for (const app of apps) {
    for (const p of Array.isArray(app?.policies) ? app.policies : []) {
      if (!users.has(p.id)) users.set(p.id, { label: `Access policy ${p.name ?? p.id} (${p.id}) in app ${app.name ?? app.id}`, name: p.name ?? p.id, refs: postureRefs(p) });
    }
  }
  const ctx = {
    auth_domain: nonEmpty(org?.auth_domain) ? org.auth_domain.toLowerCase() : null,
    profiles: Object.fromEntries([...raw].map(([id, p]) => [id, summarizeProfile(p, id)])),
    override: Number(settings?.disable_for_time) > 0,
    idp_hosts: idps.flatMap(idpHosts),
    posture: posture.map((p) => ({ id: p.id, name: p.name ?? p.id, type: p.type ?? null })),
    posture_users: [...users.values()].filter((u) => u.refs.length),
  };
  ctx.in_use = Object.fromEntries(ops.map(parse).filter((p) => p?.kind === 'device_posture_delete')
    .map((p) => [p.id.toLowerCase(), ctx.posture_users.filter((u) => u.refs.includes(p.id.toLowerCase())).map((u) => u.label)]));
  return ctx;
}

// resource_in_use only (Ruling 15). Preflight refuses by itself (spec 9,
// owner decision on the skipped spike): it does not rely on the API.
function dependencies(ctx, op, entry) {
  if (entry.kind !== 'device_posture_delete') return [];
  return ctx?.in_use?.[String(parse(op)?.id).toLowerCase()] ?? [];
}

// ---------- lockout analysis (spec 6 items 7 to 9) ----------

const clean = (host) => String(host).toLowerCase().replace(/\.$/, '');

// Include check: only an exact host or a wildcard over it surely routes it.
function surelyCovers(entryHost, target) {
  const h = clean(entryHost);
  return h === target || (h.startsWith('*.') && target.endsWith(h.slice(1)));
}

// Exclude check: a parent domain may take its subdomains along too.
function mayCover(entryHost, target) {
  const h = clean(entryHost).replace(/^\*\./, '');
  return h === target || target.endsWith(`.${h}`);
}

// Hosts the Zero Trust login path needs: the team domain and the identity
// provider login hosts.
function ztHosts(ctx) {
  const team = teamDomainOf(ctx);
  const hosts = team ? [{ host: clean(team), owner: 'the team domain where Access logins happen' }] : [];
  for (const idp of ctx?.idp_hosts ?? []) if (!hosts.some((h) => h.host === idp.host)) hosts.push({ host: clean(idp.host), owner: idp.owner });
  return hosts;
}

const hostsOf = (entries) => (Array.isArray(entries) ? entries.map((e) => e?.host).filter(nonEmpty) : []);

function lockoutRisks(ctx, ops) {
  const lines = [];
  const required = ztHosts(ctx);
  const state = new Map();
  const stateOf = (id) => {
    if (!state.has(id)) {
      const known = ctx?.profiles?.[id];
      state.set(id, { label: `device profile ${known?.name ?? id}`, mode: known?.mode ?? 'exclude', locked: known?.switch_locked === true, include: null, exclude: null });
    }
    return state.get(id);
  };
  const lockLine = (s, body) => {
    if (body?.switch_locked !== true || s.locked || ctx?.override) return;
    lines.push(`${LOCKOUT_PREFIX} ${s.label} sets switch_locked: true while admin override codes are off (devices/settings disable_for_time is 0); users cannot turn WARP off, so if WARP breaks their connection they stay offline until an admin changes the profile. Turn on admin override codes first. ${ROLLBACK_HINT}`);
    s.locked = true;
  };
  ops.forEach((op, index) => {
    const p = parse(op);
    if (!p) return;
    const body = op.body;
    if (p.kind === 'device_profile_create') {
      const s = stateOf(`new:${index}`);
      s.label = `new device profile ${body?.name ?? `(op ${index})`}`;
      s.mode = Array.isArray(body?.include) ? 'include' : 'exclude';
      s.locked = false;
      if (Array.isArray(body?.include)) s.include = body.include;
      if (Array.isArray(body?.exclude)) s.exclude = body.exclude;
      lockLine(s, body);
      return;
    }
    if (PROFILE_PATCHES.has(p.kind)) {
      const s = stateOf(p.id);
      for (const to of MODE_KEYS.filter((key) => Array.isArray(body?.[key]))) {
        if (s.mode !== to) {
          const path = p.id === 'default' ? '/devices/policy' : `/devices/policy/${p.id}`;
          lines.push(`${LOCKOUT_PREFIX} ${s.label} switches split tunnel mode from ${s.mode} to ${to}; the switch resets the ${s.mode} list to its defaults, and devices on this profile route by the new ${to} list at once, so private routes, local networks or Access logins can stop working. Check that the new ${to} list holds every entry devices need, or add a PUT of ${path}/${to} after the mode change in this plan. ${ROLLBACK_HINT}`);
        }
        s.mode = to;
        s[to] = body[to];
      }
      if (body?.switch_locked === false) s.locked = false;
      lockLine(s, body);
      return;
    }
    if (SPLIT_PUTS[p.kind]) stateOf(p.id)[SPLIT_PUTS[p.kind]] = body;
  });

  const postureUsers = (ctx?.posture_users ?? []).map((u) => u.name);
  for (const s of state.values()) {
    // Item 7: an include list the plan writes must route the Zero Trust hosts.
    // A PUT of the include list of a profile in exclude mode is checked too:
    // the API may switch the mode with it.
    if (Array.isArray(s.include)) {
      const missing = required.filter((r) => !hostsOf(s.include).some((h) => surelyCovers(h, r.host)));
      if (missing.length) {
        lines.push(`${LOCKOUT_PREFIX} ${s.label} uses include mode and its include list lacks ${list(missing.map((m) => `${m.host} (${m.owner})`))}; only listed traffic goes through WARP, so Access logins and device posture checks through WARP fail. Add them as host entries. ${ROLLBACK_HINT}`);
      }
    }
    // Item 9: excluding the Zero Trust hosts while Access requires posture.
    if (Array.isArray(s.exclude) && postureUsers.length) {
      const hit = required.filter((r) => hostsOf(s.exclude).some((h) => mayCover(h, r.host)));
      if (hit.length) {
        lines.push(`${LOCKOUT_PREFIX} ${s.label} excludes ${list(hit.map((h) => h.host))} from WARP while Access policies require device posture (${list(postureUsers.slice(0, 3))}${postureUsers.length > 3 ? ', ...' : ''}); logins to those hosts bypass WARP, the posture check fails and users are denied. Remove those hosts from the exclude list. ${ROLLBACK_HINT}`);
      }
    }
  }
  return lines;
}

// ---------- notes ----------

function notesProfileDelete(ctx, op) {
  const id = parse(op)?.id;
  const name = ctx?.profiles?.[id]?.name;
  return [`Deleting device profile ${name ? `${name} (${id})` : id}: devices it matches fall back to the next matching profile or the default profile until a rollback re-creates it. A rollback re-creates the profile with a new id and puts its saved include, exclude and fallback lists on the new id.`];
}

function notesPostureDelete(ctx, op) {
  const id = parse(op)?.id;
  const name = (ctx?.posture ?? []).find((p) => p.id === id)?.name;
  return [`A rollback re-creates posture rule ${name ? `${name} (${id})` : id} with a new id; Access policies and Gateway rules written later must use the new id.`];
}

// ---------- verification (spec 8) ----------

const DETAIL = `check on one enrolled device of this profile with warp-cli settings; ${HONESTY}`;

// One list entry in a comparable form: hosts and suffixes lowercased without
// a trailing dot, a bare IP given its implicit /32 or /128, an empty
// description dropped. Unknown fields stay as they are.
function normalizeEntry(entry) {
  if (!isPlainObject(entry)) return entry;
  const out = { ...entry };
  for (const key of ['host', 'suffix']) if (typeof out[key] === 'string') out[key] = clean(out[key]);
  if (typeof out.address === 'string') {
    const address = out.address.trim().toLowerCase();
    out.address = address.includes('/') ? address : `${address}/${address.includes(':') ? 128 : 32}`;
  }
  if (out.description === '' || out.description === null) delete out.description;
  return out;
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Lists compare as multisets: order does not count, and each sent entry
// matches one read entry that holds every sent field (the API may add
// defaults such as an empty dns_server).
function sameList(sent, got) {
  if (!Array.isArray(got) || got.length !== sent.length) return false;
  const left = got.map(normalizeEntry);
  return sent.map(normalizeEntry).every((want) => {
    const at = left.findIndex((have) => (isPlainObject(want) && isPlainObject(have)
      ? Object.keys(want).every((key) => sameValue(want[key], have[key]))
      : sameValue(want, have)));
    if (at === -1) return false;
    left.splice(at, 1);
    return true;
  });
}

// Profile lists are compared against the profile's own field, else the list
// endpoints read after the op.
function compareLists(op, post) {
  for (const key of MODE_KEYS) {
    if (!Array.isArray(op.body?.[key])) continue;
    const got = Array.isArray(post?.[key]) ? post[key] : (post?.lists?.[key] ?? null);
    if (!sameList(op.body[key], got)) return { ok: false, detail: `read-back differs at ${key}` };
  }
  return null;
}

function readback(op, entry, post) {
  const isProfile = entry.kind.startsWith('device_profile_') || entry.kind === 'device_default_profile_patch';
  const isList = Array.isArray(op.body);
  const ignore = isProfile ? [...entry.readOnlyFields, ...MODE_KEYS] : entry.readOnlyFields;
  const inner = readbackCheck(post, op.body, ignore);
  return {
    name: 'readback',
    once: true,
    run: async () => {
      let out;
      if (isList) {
        out = post === null || post === undefined
          ? { ok: false, detail: 'no post-apply read to compare' }
          : sameList(op.body, post) ? { ok: true, detail: 'read-back matches the sent list' } : { ok: false, detail: 'read-back differs at the list entries' };
      } else {
        out = await inner.run();
        if (out.ok && isProfile) out = compareLists(op, post) ?? out;
      }
      return { ok: out.ok, detail: `${out.detail}; ${DETAIL}` };
    },
  };
}

// Read-back for every changed resource (deletes leave nothing to read). The
// detail always ends with the note that device behavior is only verified on
// a device.
function verifyChecks(op, entry, ctx, result, post) {
  if (String(op.method).toUpperCase() === 'DELETE') return [];
  return [readback(op, entry, post)];
}

// ---------- entitlement ----------

const NO_ORG = { ok: false, detail: 'no Zero Trust organization on this account; create one in the Zero Trust dashboard first' };

// WARP device settings need a Zero Trust organization (spec 9).
async function entitlement(client, base) {
  const path = `${base}/access/organizations`;
  let org;
  try {
    org = await withPermission(PERM.org, path, () => client.request('GET', path));
  } catch (err) {
    if (err instanceof CfError && err.code === 'not_found') return NO_ORG;
    throw err;
  }
  return nonEmpty(org?.auth_domain) ? { ok: true, detail: `Zero Trust organization ${org.auth_domain}` } : NO_ORG;
}

/** @type {import('./index.mjs').ProductModule} */
export const DEVICES = {
  product: 'devices',
  kinds: KINDS,
  permission: { read: 'Zero Trust Read', edit: PERM.devices },
  probePath: (base) => `${base}/devices/policy`,
  entitlement,
  gather,
  dependencies,
  lockoutRisks,
  conflicts,
  verifyChecks,
};
