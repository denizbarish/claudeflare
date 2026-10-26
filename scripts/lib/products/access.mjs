// Cloudflare Access product module (spec 5.1): applications, reusable and
// legacy app-scoped policies, groups, identity providers, service tokens and
// the Zero Trust organization. All kinds are account scoped; the zone form of
// Access is refused by resources.mjs. The engine snapshots, inverts and
// redacts; this module adds body validation, conflict rules, the account
// reads lockout and dependency checks need, risk notes and verification.

import { CfError } from '../errors.mjs';
import { LOCKOUT_PREFIX } from '../lockout-text.mjs';
import { listAll } from '../paginate.mjs';
import { omitPaths } from './fields.mjs';
import { matchKind, opTarget } from './match.mjs';
import { accessLoginCheck, readbackCheck, teamDomainOf } from '../verify.mjs';

// Access ids are UUIDs; identity provider ids also appear as 32 hex characters.
const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})';

// Fields the API sets: dropped from restore bodies and from drift
// comparisons. Embedded policy timestamps change whenever the policy does.
const APP_READ_ONLY = ['id', 'aud', 'created_at', 'updated_at', 'policies.*.created_at', 'policies.*.updated_at', 'policies.*.app_count'];
const POLICY_READ_ONLY = ['id', 'created_at', 'updated_at', 'app_count', 'reusable'];
const GROUP_READ_ONLY = ['id', 'created_at', 'updated_at'];
const IDP_READ_ONLY = ['id', 'created_at', 'updated_at', 'saml_certificate_set', 'scim_config.scim_base_url'];
// last_seen_at changes whenever a client uses the token, which is not drift.
const TOKEN_READ_ONLY = [
  'id', 'client_id', 'created_at', 'updated_at', 'expires_at', 'last_seen_at', 'leak_report_url', 'leak_reported_at', 'leak_reporter',
];
const ORG_READ_ONLY = ['created_at', 'updated_at'];

// Secrets the user supplies (only via secret_fields_from_env) and secrets the
// API generates (redacted). Every OAuth and OIDC identity provider type keeps
// its secret in config.client_secret; scim_config.secret is generated once.
// Apps hold SCIM provisioning credentials (one scheme or a list) and, for
// OIDC SaaS apps, a generated client secret.
const IDP_SECRET_FIELDS = ['config.client_secret'];
const IDP_REDACT = ['scim_config.secret'];
const APP_SECRET_FIELDS = ['client_secret', 'password', 'token'].flatMap((key) => [
  `scim_config.authentication.${key}`, `scim_config.authentication.*.${key}`,
]);
const APP_REDACT = ['saas_app.client_secret'];

const DECISIONS = ['allow', 'deny', 'non_identity', 'bypass'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function list(items) {
  return items.join(', ');
}

const nonEmpty = (value) => typeof value === 'string' && value !== '';

// Body checks run on `plan new`, `claudeflare preflight` and again at apply
// (validateProductFields). Messages name field paths, never values: a value
// in a refused field may be a secret.
function validateApp(op) {
  const body = op.body;
  if (!isPlainObject(body)) return ['needs a body { "name": "...", "type": "self_hosted", "domain": "..." }'];
  const problems = [];
  if (!nonEmpty(body.type)) problems.push('needs a non-empty string type (self_hosted, saas, ...)');
  if (body.type === 'self_hosted' && !nonEmpty(body.domain)) problems.push('a self_hosted app needs a non-empty string domain');
  if ('policies' in body && (!Array.isArray(body.policies) || !body.policies.every((p) => nonEmpty(p) || isPlainObject(p)))) {
    problems.push('policies must be an array of policy ids or { "id", "precedence" } objects');
  }
  if (isPlainObject(body.saas_app) && 'client_secret' in body.saas_app) {
    problems.push('must not carry saas_app.client_secret; Cloudflare generates it');
  }
  return problems;
}

function validatePolicy(op) {
  const body = op.body;
  if (!isPlainObject(body)) return ['needs a body { "name", "decision", "include": [...] }'];
  const problems = [];
  if (!nonEmpty(body.name)) problems.push('needs a non-empty string name');
  if (!DECISIONS.includes(body.decision)) problems.push(`decision must be one of ${list(DECISIONS)}`);
  if (!Array.isArray(body.include)) problems.push('include must be an array of rules');
  for (const key of ['exclude', 'require']) {
    if (key in body && !Array.isArray(body[key])) problems.push(`${key} must be an array of rules`);
  }
  return problems;
}

function validateGroup(op) {
  const body = op.body;
  if (!isPlainObject(body)) return ['needs a body { "name", "include": [...] }'];
  const problems = [];
  if (!nonEmpty(body.name)) problems.push('needs a non-empty string name');
  if (!Array.isArray(body.include)) problems.push('include must be an array of rules');
  return problems;
}

function validateIdp(op) {
  const body = op.body;
  if (!isPlainObject(body)) return ['needs a body { "name", "type", "config": { ... } }'];
  const problems = [];
  if (!nonEmpty(body.name)) problems.push('needs a non-empty string name');
  if (!nonEmpty(body.type)) problems.push('needs a non-empty string type');
  if (!isPlainObject(body.config)) problems.push('needs a config object');
  return problems;
}

// Service token credentials are generated by Cloudflare; rotation
// (client_secret_version) is not a claudeflare op.
function tokenValidator(allowed) {
  return (op) => {
    const body = op.body;
    if (!isPlainObject(body)) return ['needs a body { "name": "...", "duration": "8760h" }'];
    const problems = [];
    for (const key of ['client_id', 'client_secret']) {
      if (key in body) problems.push(`must not carry ${key}; Cloudflare generates it and apply writes it to a secret file`);
    }
    if ('client_secret_version' in body) {
      problems.push('must not carry client_secret_version; it rotates the secret, and rotation is not a claudeflare op (rotate in the dashboard)');
    }
    const extra = Object.keys(body).filter((key) => !allowed.includes(key) && !['client_id', 'client_secret', 'client_secret_version'].includes(key));
    if (extra.length) problems.push(`body may hold only ${list(allowed)}, not ${list(extra)}`);
    if (!nonEmpty(body.name)) problems.push('needs a non-empty string name');
    return problems;
  };
}

function validateOrg(op) {
  const body = op.body;
  if (!isPlainObject(body)) return ['needs a body { "name", "auth_domain", ... } (a PUT replaces the whole organization)'];
  const problems = [];
  if (!nonEmpty(body.name)) problems.push('needs a non-empty string name');
  if (!nonEmpty(body.auth_domain)) problems.push('needs a non-empty string auth_domain (the team domain)');
  return problems;
}

// Update rollback of a resource that holds secrets (IdP client secret, app
// SCIM credentials): the snapshot never holds them, so an update that sent
// one cannot be undone; any other update is put back without the secret
// fields (spec 5.1).
function putWithoutSecrets(omit) {
  return (entry) => {
    if (Array.isArray(entry.secret_fields) && entry.secret_fields.length) return [];
    if (!isPlainObject(entry.before)) throw new CfError('rollback_ambiguous', `No before state recorded for ${entry.path}`);
    return [{ method: 'PUT', path: entry.path, body: omitPaths(entry.before, omit) }];
  };
}

// ---------- account state helpers ----------

const idOf = (ref) => (typeof ref === 'string' ? ref : isPlainObject(ref) && typeof ref.id === 'string' ? ref.id : null);

function appDomains(app) {
  const destinations = (Array.isArray(app?.destinations) ? app.destinations : [])
    .filter((d) => isPlainObject(d) && (d.type === undefined || d.type === 'public'))
    .map((d) => d.uri);
  const all = [app?.domain, ...(Array.isArray(app?.self_hosted_domains) ? app.self_hosted_domains : []), ...destinations];
  return [...new Set(all.filter(nonEmpty).map((d) => d.toLowerCase()))];
}

// { host, path } of an app domain (wiki.example.com/docs) or a login URL.
function splitDomain(value) {
  const s = String(value).toLowerCase().replace(/^https?:\/\//, '');
  const cut = s.indexOf('/');
  const host = (cut < 0 ? s : s.slice(0, cut)).replace(/:\d+$/, '');
  const path = cut < 0 ? '' : s.slice(cut).replace(/\*+$/, '');
  return { host, path: path === '/' ? '' : path };
}

function hostMatches(pattern, host) {
  const p = String(pattern).toLowerCase();
  const h = String(host).toLowerCase();
  return p === h || (p.startsWith('*.') && h.endsWith(p.slice(1)) && h.length > p.length - 1);
}

function covers(domain, target) {
  const d = splitDomain(domain);
  return hostMatches(d.host, target.host) && (d.path === '' || target.path.startsWith(d.path));
}

const HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

// Login hosts of an IdP from its config: every http(s) URL value, plus bare
// host names in *_account and *domain keys (okta_account, ...). Only hosts
// and paths are kept, never other config values.
function loginTargets(config) {
  const out = new Map();
  for (const [key, value] of Object.entries(isPlainObject(config) ? config : {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item !== 'string' || item === '' || /secret/i.test(key)) continue;
      let target = null;
      if (/^https?:\/\//i.test(item)) {
        try {
          const url = new URL(item);
          target = { host: url.hostname.toLowerCase(), path: url.pathname };
        } catch {
          target = null;
        }
      } else if (/(_account|domain)$/.test(key) && HOSTNAME.test(item)) {
        target = { host: item.toLowerCase(), path: '/' };
      }
      if (target && !out.has(target.host)) out.set(target.host, target);
    }
  }
  return [...out.values()];
}

function summarizePolicy(p) {
  // Only fields the source holds: an app GET may list policies as bare
  // { id, precedence } references, which resolveRef then looks up by id.
  const out = { id: p?.id, name: p?.name ?? null };
  if (nonEmpty(p?.decision)) out.decision = p.decision;
  for (const key of ['include', 'exclude', 'require']) if (Array.isArray(p?.[key])) out[key] = p[key];
  if (typeof p?.reusable === 'boolean') out.reusable = p.reusable;
  return out;
}

function summarizeApp(app) {
  return {
    id: app.id,
    name: app.name ?? null,
    type: app.type ?? null,
    domains: appDomains(app),
    allowed_idps: Array.isArray(app.allowed_idps) ? app.allowed_idps : [],
    policies: (Array.isArray(app.policies) ? app.policies : []).map((p) => (typeof p === 'string' ? { id: p } : summarizePolicy(p))),
  };
}

function appLabel(app) {
  if (!app) return 'unknown app';
  return `${app.name ?? app.id} (${app.domains?.length ? list(app.domains) : app.id})`;
}

// Every rule of a policy body: include, exclude and require.
function rulesOf(policy) {
  return ['include', 'exclude', 'require'].flatMap((key) => (Array.isArray(policy?.[key]) ? policy[key] : []));
}

const REFS = {
  group: (rule) => rule?.group?.id,
  service_token: (rule) => rule?.service_token?.token_id,
};

function refersTo(policy, refKind, id) {
  return rulesOf(policy).some((rule) => REFS[refKind](rule) === id);
}

function reusableIds(ctx) {
  return new Set((ctx.policies ?? []).map((p) => p.id));
}

// Full policy for a reference in an app's policy list: a reusable policy by
// id, else the app's own (legacy) policy, else what the reference holds.
function resolveRef(ctx, app, ref) {
  const id = idOf(ref);
  if (isPlainObject(ref) && ref.decision != null) return ref;
  const reusable = id && (ctx.policies ?? []).find((p) => p.id === id);
  if (reusable) return reusable;
  const own = id && (app?.policies ?? []).find((p) => p.id === id && p.decision != null);
  return own ?? (isPlainObject(ref) ? ref : { id });
}

function usableAllow(policy) {
  return policy?.decision === 'allow' && Array.isArray(policy.include) && policy.include.length > 0;
}

// Policies the account holds that may reference groups and tokens: reusable
// ones and every app's legacy (app-scoped) ones.
function policyHolders(ctx) {
  const reusable = reusableIds(ctx);
  const holders = (ctx.policies ?? []).map((p) => ({ key: `p:${p.id}`, label: `policy ${p.name ?? p.id} (${p.id})`, policy: p, app: null }));
  for (const app of ctx.apps ?? []) {
    for (const p of app.policies ?? []) {
      if (reusable.has(p.id) || p.reusable === true || p.decision == null) continue;
      holders.push({ key: `l:${app.id}/${p.id}`, label: `policy ${p.name ?? p.id} (${p.id}) of app ${app.name ?? app.id}`, policy: p, app: app.id });
    }
  }
  return holders;
}

// ---------- kinds ----------

const account = { product: 'access', scope: 'account', destructive: false };

function crud({ prefix, collection, type, readOnly, validate, create = {}, update = {}, remove = {} }) {
  const one = new RegExp(`^/access/${collection}/${ID}$`);
  const shared = { ...account, readOnlyFields: readOnly };
  return [
    {
      ...shared, kind: `${prefix}_create`, methods: ['POST'], pattern: new RegExp(`^/access/${collection}$`), resource: () => null,
      inverse: 'delete_created', validate, ...create,
    },
    { ...shared, kind: `${prefix}_update`, methods: ['PUT'], pattern: one, resource: (m) => ({ type, id: m[1] }), inverse: 'put_before', validate, ...update },
    {
      ...shared, kind: `${prefix}_delete`, methods: ['DELETE'], pattern: one, resource: (m) => ({ type, id: m[1] }),
      inverse: 'recreate', destructive: true, nameField: 'name', ...remove,
    },
  ];
}

const KINDS = [
  ...crud({
    prefix: 'access_app', collection: 'apps', type: 'access_app', readOnly: APP_READ_ONLY, validate: validateApp,
    create: { secretFields: APP_SECRET_FIELDS, redact: APP_REDACT },
    update: {
      secretFields: APP_SECRET_FIELDS, redact: APP_REDACT, inverse: putWithoutSecrets([...APP_READ_ONLY, ...APP_SECRET_FIELDS, ...APP_REDACT]),
      read: (m, base) => `${base}/access/apps/${m[1]}`, notes: (ctx, op) => notesSecretUpdate(op),
    },
    // secretFields here keep SCIM credentials out of the snapshot and so out of the re-create body.
    remove: { secretFields: APP_SECRET_FIELDS, redact: APP_REDACT, notes: (ctx, op) => notesAppDelete(ctx, op) },
  }),
  ...crud({
    prefix: 'access_policy', collection: 'policies', type: 'access_policy', readOnly: POLICY_READ_ONLY, validate: validatePolicy,
    remove: { notes: (ctx, op) => notesRecreate(ctx, op, 'policy') },
  }),
  {
    ...account,
    kind: 'access_app_policy_update',
    methods: ['PUT'],
    pattern: new RegExp(`^/access/apps/${ID}/policies/${ID}$`),
    resource: (m) => ({ type: 'access_app_policy', id: `${m[1]}/${m[2]}` }),
    readOnlyFields: POLICY_READ_ONLY,
    inverse: 'put_before',
    validate: validatePolicy,
  },
  {
    ...account,
    kind: 'access_app_policy_delete',
    methods: ['DELETE'],
    pattern: new RegExp(`^/access/apps/${ID}/policies/${ID}$`),
    resource: (m) => ({ type: 'access_app_policy', id: `${m[1]}/${m[2]}` }),
    readOnlyFields: POLICY_READ_ONLY,
    inverse: 'recreate',
    destructive: true,
    nameField: 'name',
    notes: (ctx, op) => notesRecreate(ctx, op, 'app policy'),
  },
  ...crud({
    prefix: 'access_group', collection: 'groups', type: 'access_group', readOnly: GROUP_READ_ONLY, validate: validateGroup,
    remove: { notes: (ctx, op) => notesRecreate(ctx, op, 'group') },
  }),
  ...crud({
    prefix: 'access_idp', collection: 'identity_providers', type: 'access_idp', readOnly: IDP_READ_ONLY, validate: validateIdp,
    create: { secretFields: IDP_SECRET_FIELDS, redact: IDP_REDACT },
    update: {
      secretFields: IDP_SECRET_FIELDS, redact: IDP_REDACT, inverse: putWithoutSecrets([...IDP_READ_ONLY, ...IDP_SECRET_FIELDS, ...IDP_REDACT]),
      read: (m, base) => `${base}/access/identity_providers/${m[1]}`, notes: (ctx, op) => notesSecretUpdate(op),
    },
    remove: { inverse: 'none', redact: IDP_REDACT, notes: (ctx, op) => notesIdpDelete(ctx, op) },
  }),
  ...crud({
    prefix: 'access_service_token', collection: 'service_tokens', type: 'access_service_token', readOnly: TOKEN_READ_ONLY,
    create: {
      validate: tokenValidator(['name', 'duration']), secretSink: ['client_id', 'client_secret'], redact: ['client_secret'],
      notes: () => notesTokenCreate(),
    },
    // client_id is half of the credential the sink file holds; it stays out of snapshots too.
    update: { validate: tokenValidator(['name', 'duration', 'enabled']), redact: ['client_id'] },
    remove: { inverse: 'none', notes: (ctx, op) => notesTokenDelete(ctx, op) },
  }),
  {
    ...account,
    kind: 'access_org_update',
    methods: ['PUT'],
    pattern: /^\/access\/organizations$/,
    resource: () => ({ type: 'access_org', id: 'organization' }),
    readOnlyFields: ORG_READ_ONLY,
    inverse: 'put_before',
    validate: validateOrg,
    notes: (ctx, op) => notesOrg(ctx, op),
  },
];

// { kind, ids } of an Access op from its path alone (lockoutRisks and notes
// get no plan); null for any other op.
function parse(op) {
  const target = opTarget(op);
  const hit = target && matchKind(KINDS, op.method, target.scope, target.rest);
  return hit ? { kind: hit.entry.kind, ids: hit.match.slice(1).filter(Boolean), base: target.base } : null;
}

// ---------- notes ----------

const findApp = (ctx, id) => (ctx?.apps ?? []).find((a) => a.id === id);

function notesAppDelete(ctx, op) {
  const id = parse(op)?.ids[0];
  const app = findApp(ctx, id);
  const domains = app?.domains?.length ? list(app.domains) : 'its domains';
  return [
    `Deleting Access app ${app ? appLabel(app) : id}: ${domains} are no longer protected by Access, and its app-scoped policies are deleted with it. A rollback re-creates the app with a new id and a new AUD; origins that validate the Access JWT (Cf-Access-Jwt-Assertion) must be updated to the new AUD.`,
  ];
}

function notesRecreate(ctx, op, what) {
  const ids = parse(op)?.ids ?? [];
  const id = ids.at(-1);
  const name = [...(ctx?.policies ?? []), ...(ctx?.groups ?? []), ...(ctx?.apps ?? []).flatMap((a) => a.policies ?? [])].find((x) => x.id === id)?.name;
  return [`A rollback re-creates ${what} ${name ? `${name} (${id})` : id} with a new id.`];
}

function notesSecretUpdate(op) {
  const fields = isPlainObject(op?.secret_fields_from_env) ? Object.keys(op.secret_fields_from_env) : [];
  if (!fields.length) return [];
  return [`Not reversible: ${op.method} ${op.path} sends ${list(fields)} from the environment; claudeflare never stores secrets, so a rollback cannot restore the previous value.`];
}

function notesIdpDelete(ctx, op) {
  const id = parse(op)?.ids[0];
  const idp = (ctx?.idps ?? []).find((i) => i.id === id);
  return [`Users who sign in with identity provider ${idp?.name ? `${idp.name} (${id})` : id} lose access; re-creating it needs its client secret again and gives a new id.`];
}

function notesTokenCreate() {
  return ['The service token client secret is shown only once: apply writes client_id and client_secret to .claudeflare/secrets/<plan id>-<op index>.json (mode 0600) and prints only the path; claudeflare never prints the values.'];
}

function notesTokenDelete(ctx, op) {
  const id = parse(op)?.ids[0];
  return [`Clients that send service token ${id} are denied once it is deleted; a new token has new credentials, so every client must be updated.`];
}

function notesOrg(ctx, op) {
  const next = op?.body?.auth_domain;
  const now = ctx?.auth_domain;
  if (!nonEmpty(next)) return [];
  if (nonEmpty(now) && now.toLowerCase() === next.toLowerCase()) return [];
  return [`Changing the team domain${nonEmpty(now) ? ` from ${now}` : ''} to ${next} ends existing sessions and breaks bookmarks and login links to the old domain.`];
}

// ---------- gather ----------

// Token template permission per Access area (spec 12). The module probe
// names the Apps and Policies one; gather names the one a 403 came from.
const PERM = {
  apps: 'Access: Apps and Policies Edit',
  org: 'Access: Organizations, Identity Providers, and Groups Edit',
  tokens: 'Access: Service Tokens Edit',
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

// Account reads for lockout analysis, dependencies, notes and verification.
// Every list is read to the last page, so an app or policy on page two still
// counts (Review Focus 1). auth_domain sits at the top of ctx, where
// verify.mjs teamDomainOf reads it.
async function gather(client, base, ops) {
  const read = (path, permission, fn) => withPermission(permission, path, fn);
  const org = await read(`${base}/access/organizations`, PERM.org, () => client.request('GET', `${base}/access/organizations`));
  const apps = await read(`${base}/access/apps`, PERM.apps, () => listAll(client, `${base}/access/apps`));
  const policies = await read(`${base}/access/policies`, PERM.apps, () => listAll(client, `${base}/access/policies`));
  const groups = await read(`${base}/access/groups`, PERM.org, () => listAll(client, `${base}/access/groups`));
  const idps = await read(`${base}/access/identity_providers`, PERM.org, () => listAll(client, `${base}/access/identity_providers`));
  // Service token ops need their own permission; probe it so a 403 names it
  // before confirm_name or apply reads a token.
  if (ops.some((op) => parse(op)?.kind.startsWith('access_service_token_'))) {
    await read(`${base}/access/service_tokens`, PERM.tokens, () => client.request('GET', `${base}/access/service_tokens`, { query: { per_page: 1 } }));
  }
  const ctx = {
    auth_domain: nonEmpty(org?.auth_domain) ? org.auth_domain.toLowerCase() : null,
    org: { name: org?.name ?? null, auth_domain: org?.auth_domain ?? null },
    apps: apps.map(summarizeApp),
    policies: policies.map(summarizePolicy),
    groups: groups.map((g) => ({ id: g.id, name: g.name ?? null })),
    idps: idps.map((i) => ({ id: i.id, name: i.name ?? null, type: i.type ?? null, logins: loginTargets(i.config) })),
  };
  ctx.in_use = inUse(ctx, ops);
  return ctx;
}

// What still uses each resource a delete in this plan removes, after the
// plan's earlier ops ran: keyed `<kind> <id>`, values are descriptions.
function inUse(ctx, ops) {
  const items = ops.map((op, index) => ({ ...parse(op), op, index })).filter((p) => p.kind);
  const out = {};
  for (const del of items) {
    const earlier = items.filter((p) => p.index < del.index);
    if (del.kind === 'access_policy_delete') out[`${del.kind} ${del.ids[0]}`] = appsUsingPolicy(ctx, del.ids[0], earlier);
    if (del.kind === 'access_group_delete') out[`${del.kind} ${del.ids[0]}`] = policiesReferencing(ctx, 'group', del.ids[0], earlier);
    if (del.kind === 'access_service_token_delete') out[`${del.kind} ${del.ids[0]}`] = policiesReferencing(ctx, 'service_token', del.ids[0], earlier);
  }
  return out;
}

function appsUsingPolicy(ctx, policyId, earlier) {
  const users = new Map();
  for (const app of ctx.apps ?? []) {
    if ((app.policies ?? []).some((p) => p.id === policyId)) users.set(app.id, `Access app ${app.name ?? app.id} (${app.id})`);
  }
  for (const p of earlier) {
    const body = p.op.body;
    if (p.kind === 'access_app_delete') users.delete(p.ids[0]);
    if ((p.kind === 'access_app_update' || p.kind === 'access_app_create') && Array.isArray(body?.policies)) {
      const key = p.kind === 'access_app_update' ? p.ids[0] : `new:${p.index}`;
      if (body.policies.some((ref) => idOf(ref) === policyId)) {
        users.set(key, p.kind === 'access_app_update' ? `Access app ${findApp(ctx, key)?.name ?? key} (${key})` : `new Access app ${body.name ?? ''} (op ${p.index})`);
      } else {
        users.delete(key);
      }
    }
  }
  return [...users.values()];
}

function policiesReferencing(ctx, refKind, id, earlier) {
  const users = new Map();
  for (const h of policyHolders(ctx)) if (refersTo(h.policy, refKind, id)) users.set(h.key, h.label);
  const set = (key, label, body) => (refersTo(body, refKind, id) ? users.set(key, label) : users.delete(key));
  for (const p of earlier) {
    const body = p.op.body;
    if (p.kind === 'access_policy_delete') users.delete(`p:${p.ids[0]}`);
    if (p.kind === 'access_policy_update') set(`p:${p.ids[0]}`, `policy ${body?.name ?? p.ids[0]} (${p.ids[0]})`, body);
    if (p.kind === 'access_policy_create') set(`new:${p.index}`, `new policy ${body?.name ?? ''} (op ${p.index})`, body);
    if (p.kind === 'access_app_policy_delete') users.delete(`l:${p.ids[0]}/${p.ids[1]}`);
    if (p.kind === 'access_app_policy_update') set(`l:${p.ids[0]}/${p.ids[1]}`, `policy ${body?.name ?? p.ids[1]} (${p.ids[1]}) of app ${findApp(ctx, p.ids[0])?.name ?? p.ids[0]}`, body);
    if (p.kind === 'access_app_delete') {
      for (const key of [...users.keys()]) if (key.startsWith(`l:${p.ids[0]}/`)) users.delete(key);
    }
    if (p.kind === 'access_app_update' && Array.isArray(body?.policies)) {
      const kept = new Set(body.policies.map(idOf).filter(Boolean));
      for (const key of [...users.keys()]) {
        if (key.startsWith(`l:${p.ids[0]}/`) && !kept.has(key.split('/')[1])) users.delete(key);
      }
    }
  }
  return [...users.values()];
}

// resource_in_use (Ruling 15: body problems are invalid_op in validate).
function dependencies(ctx, op, entry) {
  const id = parse(op)?.ids[0];
  return ctx?.in_use?.[`${entry.kind} ${id}`] ?? [];
}

// ---------- lockout analysis (spec 6 items 1 to 4) ----------

const ROLLBACK_HINT = 'If it happens, roll this plan back with claudeflare rollback from this terminal (the API token still works).';

// Policies of an app after one op, or null when the op leaves them alone.
function policiesAfter(ctx, app, p, op) {
  const current = app.policies ?? [];
  const policyId = p.ids.at(-1);
  switch (p.kind) {
    case 'access_app_update':
      return p.ids[0] === app.id && Array.isArray(op.body?.policies) ? op.body.policies.map((ref) => resolveRef(ctx, app, ref)) : null;
    case 'access_app_policy_delete':
      return p.ids[0] === app.id ? current.filter((x) => x.id !== policyId).map((ref) => resolveRef(ctx, app, ref)) : null;
    case 'access_app_policy_update':
    case 'access_policy_update':
      if (p.kind === 'access_app_policy_update' && p.ids[0] !== app.id) return null;
      if (!current.some((x) => x.id === policyId)) return null;
      return current.map((x) => (x.id === policyId ? { ...summarizePolicy(op.body), id: policyId } : resolveRef(ctx, app, x)));
    case 'access_policy_delete':
      return current.some((x) => x.id === policyId) ? current.filter((x) => x.id !== policyId).map((ref) => resolveRef(ctx, app, ref)) : null;
    default:
      return null;
  }
}

// Item 1: an app loses its last allow policy with a non-empty include.
function lostAllowLines(ctx, p, op) {
  const lines = [];
  for (const app of ctx.apps ?? []) {
    const after = policiesAfter(ctx, app, p, op);
    if (!after) continue;
    const before = (app.policies ?? []).map((ref) => resolveRef(ctx, app, ref));
    if (!before.some(usableAllow) || after.some(usableAllow)) continue;
    lines.push(`${LOCKOUT_PREFIX} Access app ${appLabel(app)} has no allow policy with a non-empty include after ${op.method} ${op.path}; every user is denied at login. ${ROLLBACK_HINT}`);
  }
  return lines;
}

// A deny policy whose include is empty or `everyone` (spec 5.1).
function denyEveryone(policy) {
  if (policy?.decision !== 'deny') return false;
  const include = Array.isArray(policy.include) ? policy.include : [];
  return include.length === 0 || include.some((rule) => isPlainObject(rule?.everyone));
}

// Item 1, second half: an app gains a policy that denies everyone, even when
// an allow policy survives.
function denyEveryoneLines(ctx, p, op) {
  const line = (label, policy) => `${LOCKOUT_PREFIX} Access app ${label} gets deny policy ${policy.name ?? policy.id ?? '(inline)'} ${policy.include?.length ? 'that includes everyone' : 'with an empty include'} after ${op.method} ${op.path}; every user may be denied at login. ${ROLLBACK_HINT}`;
  const lines = [];
  for (const app of ctx.apps ?? []) {
    const after = policiesAfter(ctx, app, p, op);
    if (!after) continue;
    const before = new Set((app.policies ?? []).map((ref) => resolveRef(ctx, app, ref)).filter(denyEveryone).map((x) => x.id));
    for (const policy of after.filter(denyEveryone)) {
      if (policy.id === undefined || !before.has(policy.id)) lines.push(line(appLabel(app), policy));
    }
  }
  if (p.kind === 'access_app_create' && Array.isArray(op.body?.policies)) {
    for (const policy of op.body.policies.map((ref) => resolveRef(ctx, null, ref)).filter(denyEveryone)) lines.push(line(op.body.name ?? 'new app', policy));
  }
  return lines;
}

// Item 2: an app domain covers an IdP login host or the team domain.
function coveredLoginLines(ctx, p, op) {
  if (p.kind !== 'access_app_create' && p.kind !== 'access_app_update') return [];
  const name = op.body?.name ?? p.ids[0] ?? 'new app';
  const lines = [];
  for (const domain of appDomains(op.body)) {
    if (ctx.auth_domain && covers(domain, { host: ctx.auth_domain, path: '/' })) {
      lines.push(`${LOCKOUT_PREFIX} Access app ${name} domain ${domain} covers ${ctx.auth_domain}, the team domain where every Access login happens; sign-in loops and nobody can log in. ${ROLLBACK_HINT}`);
    }
    for (const idp of ctx.idps ?? []) {
      const hit = (idp.logins ?? []).find((target) => covers(domain, target));
      if (hit) {
        lines.push(`${LOCKOUT_PREFIX} Access app ${name} domain ${domain} covers ${hit.host}, the login host of identity provider ${idp.name ?? idp.id}; sign-in through it loops back to Access and its users cannot log in. ${ROLLBACK_HINT}`);
      }
    }
  }
  return lines;
}

// Item 3: the only IdP of an app or of the organization is removed or
// changed, or an app is limited to IdPs that do not exist.
function onlyIdpLines(ctx, p, op) {
  const lines = [];
  if (p.kind === 'access_idp_delete' || p.kind === 'access_idp_update') {
    const id = p.ids[0];
    const idp = (ctx.idps ?? []).find((i) => i.id === id);
    const label = `${idp?.name ?? id} (${id})`;
    const verb = p.kind === 'access_idp_delete' ? 'Deleting' : 'Changing';
    const apps = (ctx.apps ?? []).filter((a) => a.allowed_idps.length === 1 && a.allowed_idps[0] === id);
    if (apps.length) {
      lines.push(`${LOCKOUT_PREFIX} ${verb} identity provider ${label}, the only identity provider allowed by Access app(s) ${list(apps.map(appLabel))}; their users cannot sign in if it fails. ${ROLLBACK_HINT}`);
    }
    if ((ctx.idps ?? []).length === 1 && ctx.idps[0].id === id) {
      lines.push(`${LOCKOUT_PREFIX} ${verb} identity provider ${label}, the only login method of the organization; nobody can sign in to any Access app if it fails. ${ROLLBACK_HINT}`);
    }
  }
  if ((p.kind === 'access_app_create' || p.kind === 'access_app_update') && Array.isArray(op.body?.allowed_idps)) {
    const known = new Set((ctx.idps ?? []).map((i) => i.id));
    const unknown = op.body.allowed_idps.filter((id) => !known.has(id));
    if (unknown.length) {
      lines.push(`${LOCKOUT_PREFIX} Access app ${op.body.name ?? p.ids[0]} allows identity provider(s) ${list(unknown.map(String))} that are not configured in this account; users cannot sign in through them. ${ROLLBACK_HINT}`);
    }
  }
  return lines;
}

// Item 4: the allow policy of the Zero Trust dashboard app (Dashboard SSO).
function dashboardLines(ctx, p, op) {
  const lines = [];
  for (const app of (ctx.apps ?? []).filter((a) => a.type === 'dash_sso')) {
    const allows = (app.policies ?? []).map((ref) => resolveRef(ctx, app, ref)).filter((x) => x.decision === 'allow');
    let removed = [];
    if (p.kind === 'access_app_delete' && p.ids[0] === app.id) removed = allows;
    if (p.kind === 'access_app_policy_delete' && p.ids[0] === app.id) removed = allows.filter((x) => x.id === p.ids[1]);
    if (p.kind === 'access_policy_delete') removed = allows.filter((x) => x.id === p.ids[0]);
    if (p.kind === 'access_app_update' && p.ids[0] === app.id && Array.isArray(op.body?.policies)) {
      const kept = new Set(op.body.policies.map(idOf).filter(Boolean));
      removed = allows.filter((x) => !kept.has(x.id));
    }
    for (const policy of removed) {
      lines.push(`${LOCKOUT_PREFIX} ${op.method} ${op.path} removes allow policy ${policy.name ?? policy.id} (${policy.id}) of the Zero Trust dashboard app ${app.name ?? app.id} (Dashboard SSO); with Dashboard SSO on, admins can no longer sign in to the Cloudflare dashboard. ${ROLLBACK_HINT}`);
    }
  }
  return lines;
}

function lockoutRisks(ctx, ops) {
  const lines = [];
  for (const op of ops) {
    const p = parse(op);
    if (!p) continue;
    lines.push(...lostAllowLines(ctx, p, op), ...denyEveryoneLines(ctx, p, op), ...coveredLoginLines(ctx, p, op), ...onlyIdpLines(ctx, p, op), ...dashboardLines(ctx, p, op));
  }
  return [...new Set(lines)];
}

// ---------- conflicts ----------

// A legacy app policy op and an update or delete of the same app would each
// snapshot the app's policies; the second snapshot would be stale.
function conflicts(ops, classified) {
  const mine = classified
    .map((c, index) => (c?.module?.product === 'access' ? { kind: c.entry.kind, app: c.match[1], index } : null))
    .filter(Boolean);
  for (const legacy of mine.filter((x) => x.kind.startsWith('access_app_policy_'))) {
    const other = mine.find((x) => (x.kind === 'access_app_update' || x.kind === 'access_app_delete') && x.app === legacy.app);
    if (other) {
      throw new CfError('plan_conflict', `Ops ${Math.min(legacy.index, other.index)} and ${Math.max(legacy.index, other.index)} both change the policies of Access app ${legacy.app}; split them into separate plans`);
    }
  }
}

// ---------- verification (spec 8) ----------

function skipped(name, detail) {
  return { name, once: true, run: async () => ({ ok: true, detail }) };
}

// The app's policy ids after apply equal the ids the body sent (order free;
// precedence decides order).
function appPoliciesReadback(post, sent) {
  return {
    name: 'readback policies',
    once: true,
    run: async () => {
      if (!isPlainObject(post)) return { ok: false, detail: 'no post-apply read to compare' };
      const got = (Array.isArray(post.policies) ? post.policies : []).map(idOf);
      const want = sent.map(idOf);
      if (got.length !== want.length) return { ok: false, detail: `read-back has ${got.length} policies, sent ${want.length}` };
      const missing = want.filter((id) => id && !got.includes(id));
      return missing.length ? { ok: false, detail: `read-back lacks policy ${list(missing)}` } : { ok: true, detail: 'policies match the sent ids' };
    },
  };
}

function appPolicyCheck(client, path, appId, policyId) {
  return {
    name: `app_policy ${appId}`,
    run: async () => {
      if (!client) return { ok: false, detail: 'no API client to read the app' };
      const app = await client.request('GET', path);
      const ids = (Array.isArray(app?.policies) ? app.policies : []).map(idOf);
      return ids.includes(policyId) ? { ok: true, detail: `app still uses policy ${policyId}` } : { ok: false, detail: `app no longer lists policy ${policyId}` };
    },
  };
}

// A self-hosted app: each public hostname (domain, self_hosted_domains,
// public destinations) answers an unauthenticated GET with a 302 to the team
// domain. A wildcard domain cannot be fetched.
function loginChecks(op, ctx, post, deps) {
  const type = op.body?.type ?? post?.type;
  if (type !== 'self_hosted') return [];
  return appDomains(op.body).map((domain) => {
    const url = domain.includes('/') ? `https://${domain}` : `https://${domain}/`;
    if (domain.includes('*')) return skipped(`access_login ${url}`, 'skipped: wildcard domain');
    return accessLoginCheck(url, teamDomainOf(ctx), { fetchImpl: deps?.fetchImpl });
  });
}

function verifyChecks(op, entry, ctx, result, post, deps) {
  if (String(op.method).toUpperCase() === 'DELETE') return [];
  const ignore = [...entry.readOnlyFields, ...(entry.secretFields ?? []), ...(entry.redact ?? []), ...(entry.secretSink ?? [])];
  const isApp = entry.kind === 'access_app_create' || entry.kind === 'access_app_update';
  const checks = [readbackCheck(post, op.body, isApp ? [...ignore, 'policies'] : ignore)];
  if (isApp) {
    if (Array.isArray(op.body?.policies)) checks.push(appPoliciesReadback(post, op.body.policies));
    checks.push(...loginChecks(op, ctx, post, deps));
  }
  const p = parse(op);
  if (entry.kind === 'access_policy_update' || entry.kind === 'access_app_policy_update') {
    const policyId = p.ids.at(-1);
    if (!Array.isArray(ctx?.apps)) {
      checks.push(skipped(`app_policy ${policyId}`, 'skipped: no preflight context'));
    } else {
      const apps = entry.kind === 'access_app_policy_update'
        ? [p.ids[0]]
        : ctx.apps.filter((a) => (a.policies ?? []).some((x) => x.id === policyId)).map((a) => a.id);
      for (const appId of apps) checks.push(appPolicyCheck(deps?.client, `${p.base}/access/apps/${appId}`, appId, policyId));
    }
  }
  return checks;
}

// ---------- entitlement ----------

// Access needs a Zero Trust organization (spec 9); the API cannot create one.
async function entitlement(client, base) {
  let org;
  try {
    org = await withPermission(PERM.org, `${base}/access/organizations`, () => client.request('GET', `${base}/access/organizations`));
  } catch (err) {
    if (err instanceof CfError && err.code === 'not_found') {
      return { ok: false, detail: 'no Zero Trust organization on this account; create one in the Zero Trust dashboard first' };
    }
    throw err;
  }
  return nonEmpty(org?.auth_domain)
    ? { ok: true, detail: `Zero Trust organization ${org.auth_domain}` }
    : { ok: false, detail: 'no Zero Trust organization on this account; create one in the Zero Trust dashboard first' };
}

/** @type {import('./index.mjs').ProductModule} */
export const ACCESS = {
  product: 'access',
  kinds: KINDS,
  permission: { read: 'Access: Apps and Policies Read', edit: PERM.apps },
  probePath: (base) => `${base}/access/apps`,
  entitlement,
  gather,
  dependencies,
  lockoutRisks,
  conflicts,
  verifyChecks,
};
