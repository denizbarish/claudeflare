// Executes the REST ops of a plan (zone plans, REST-only account plans and
// their rollbacks). Product ops get their `secret_fields_from_env` values
// injected into the request at send time only; responses are redacted by the
// kind's field paths before anything is returned, and `secretSink` fields go
// to a 0600 file under .claudeflare/secrets. No secret value reaches the
// results, the post states or an error message (spec 4.2, 4.6).

import { CfError } from './errors.mjs';
import { redact } from './api.mjs';
import { classifyProductOp } from './products/index.mjs';
import { productReadPath, resultId } from './rest-engine.mjs';
import { getPath, omitPaths, redactPaths, setPath } from './products/fields.mjs';
import { recordSecretFile, writeSecretFile } from './secret-files.mjs';
import { isReservedEnvName, RESERVED_ENV_PREFIXES } from './wrangler-ops.mjs';

// Ids kept when a result cannot be redacted become a rollback path segment.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function envMap(op) {
  const map = op?.secret_fields_from_env;
  return isPlainObject(map) ? Object.entries(map) : [];
}

// Reads one secret source variable. Refuses claudeflare's own variables and a
// value equal to the API token in use (invalid_op), and a missing or empty
// variable (secret_env_missing). Messages name the variable, never a value.
export function readSecretEnv(name, env = process.env) {
  if (isReservedEnvName(name)) {
    throw new CfError('invalid_op', `Environment variable ${name} is reserved for claudeflare and cannot be a secret source`, {
      hint: `Store the secret in a variable whose name does not start with ${RESERVED_ENV_PREFIXES.join(', ')}`,
    });
  }
  const value = env?.[name];
  if (typeof value !== 'string' || value === '') {
    throw new CfError('secret_env_missing', `Environment variable ${name} is not set`, {
      hint: `Ask the user to export ${name} in the shell that runs claudeflare apply`,
    });
  }
  const tokens = [process.env.CLOUDFLARE_API_TOKEN, env?.CLOUDFLARE_API_TOKEN].filter((t) => typeof t === 'string' && t !== '');
  if (tokens.includes(value)) {
    throw new CfError('invalid_op', `Environment variable ${name} holds the Cloudflare API token claudeflare uses; it cannot be sent as a secret`, {
      hint: `Export the intended secret in ${name}`,
    });
  }
  return value;
}

// Runs before the snapshot, so a refused variable sends nothing and keeps the
// approval.
export function assertSecretFieldsEnv(plan, env = process.env) {
  for (const op of plan?.ops ?? []) {
    for (const [, name] of envMap(op)) readSecretEnv(name, env);
  }
}

// Every string leaf under value.
function strings(value, out = []) {
  if (typeof value === 'string') {
    if (value !== '') out.push(value);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) strings(item, out);
  }
  return out;
}

// Replaces known secret values inside every string leaf; a value echoed at a
// path the kind does not declare is still caught.
function scrub(value, secrets) {
  if (typeof value === 'string') return redact(value, undefined, secrets);
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, secrets)]));
  }
  return value;
}

function secretPaths(entry) {
  return [...(entry.redact ?? []), ...(entry.secretSink ?? []), ...(entry.secretFields ?? [])];
}

const IDENTIFIER_KEYS = new Set(['id', 'name']);

// Every value held at an `id` or `name` key anywhere in value.
function idValues(value, out = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) idValues(item, out);
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (IDENTIFIER_KEYS.has(key) && (typeof item === 'string' || typeof item === 'number')) out.add(String(item));
      idValues(item, out);
    }
  }
  return out;
}

// Identifiers are not secrets even where a secret block repeats them (a
// tunnel's credentials_file holds the AccountTag, TunnelID and TunnelName).
// Scrubbing them would break rollback ids, rewrite every string containing a
// short name and make every post state look drifted, so values equal to the
// plan's account or zone id or to any `id` or `name` in the response are
// never collected.
function collect(secrets, response, entry, plan) {
  const ids = idValues(response);
  for (const id of [plan?.account_id, plan?.zone_id]) if (typeof id === 'string' && id !== '') ids.add(id);
  for (const path of secretPaths(entry)) {
    for (const value of strings(getPath(response, path))) if (!ids.has(value)) secrets.add(value);
  }
}

// scrub, except that the top-level id stays as returned.
function scrubKeepingId(value, secrets) {
  const out = scrub(value, secrets);
  if (isPlainObject(value) && 'id' in value) out.id = value.id;
  return out;
}

// Post-apply state of a product op: the created resource for a create (no
// resource key, id from the result), otherwise the kind's read path or the op
// path. Null when there is nothing left to read.
function postReadPath(op, classified, result) {
  if (String(op.method).toUpperCase() === 'DELETE') return null;
  return productReadPath(op, classified, result);
}

function writeSink(cwd, plan, index, raw, entry) {
  let data = {};
  let found = false;
  for (const path of entry.secretSink) {
    const value = getPath(raw, path);
    if (value === undefined) continue;
    data = setPath(data, path, value);
    found = true;
  }
  if (!found) return null;
  const file = writeSecretFile(cwd, `${plan.id}-${index}.json`, data);
  recordSecretFile(cwd, file);
  return file;
}

// The stored result of an op that ran: secret paths redacted and known values
// scrubbed; if even that fails, only a usable id is kept so rollback still
// covers the op.
function safeResult(raw, entry, secrets) {
  try {
    return scrubKeepingId(redactPaths(raw, secretPaths(entry)), [...secrets]);
  } catch {
    const id = isPlainObject(raw) ? raw.id : undefined;
    return (typeof id === 'string' || typeof id === 'number') && SAFE_ID.test(String(id)) ? { id } : true;
  }
}

// A rollback op may target a resource an earlier op of the same plan creates
// (a device profile re-created with a new id, then its lists PUT to it). Its
// path holds one CREATED_ID segment and `created_id_from: n` names the op n
// places earlier whose apply result id fills it. Returns the op to send
// (unchanged when it has no created_id_from); throws rollback_ambiguous when
// that op returned no usable id.
export const CREATED_ID = '{created_id}';

export function resolveCreatedId(ops, i, results, plan) {
  const op = ops[i];
  if (!isPlainObject(op) || !('created_id_from' in op)) return op;
  const back = op.created_id_from;
  const fail = (why) => {
    throw new CfError('rollback_ambiguous', `Op ${i} needs the id created by an earlier op: ${why}`);
  };
  if (!Number.isInteger(back) || back < 1 || back > i) fail(`created_id_from ${JSON.stringify(back)} names no earlier op`);
  const segments = String(op.path).split('/');
  if (segments.filter((s) => s === CREATED_ID).length !== 1) fail(`its path needs exactly one ${CREATED_ID} segment`);
  const j = i - back;
  const source = classifyProductOp(ops[j], plan);
  const id = source ? resultId(source.entry, results[j]) : undefined;
  if (id === undefined) fail(`op ${j} returned no usable id`);
  const { created_id_from: _from, ...rest } = op;
  return { ...rest, path: segments.map((s) => (s === CREATED_ID ? id : s)).join('/') };
}

// Returns { status, results, error?, post }. Op failures are recorded, not
// thrown; anything that still escapes is redacted first. Zone and other
// non-product ops behave as the v1 executor did, with post[i] = null.
// beforeOp(op, i), when given, runs before each op; a non-null return is
// stored as the op's result and the op is not sent (rollback drift skips).
export async function executeRestOps({ client, plan, cwd, env = process.env, beforeOp }) {
  const ops = plan.ops ?? [];
  const results = ops.map(() => null);
  const post = ops.map(() => null);
  // Every injected value is known up front, so any error is redacted with all of them.
  const secrets = new Set();
  for (const op of ops) {
    for (const [, name] of envMap(op)) if (typeof env?.[name] === 'string' && env[name] !== '') secrets.add(env[name]);
  }
  const clean = (text) => redact(String(text), undefined, [...secrets]);
  const product = ops.map(() => false);
  // A value first seen in a later response is scrubbed from earlier ones too.
  const finish = (outcome) => {
    for (let i = 0; i < ops.length; i++) {
      if (!product[i]) continue;
      results[i] = scrubKeepingId(results[i], [...secrets]);
      post[i] = scrubKeepingId(post[i], [...secrets]);
    }
    return outcome;
  };
  const stop = (i, sent, err, extra = {}) => finish({
    status: i === 0 && !sent ? 'failed' : 'partially_applied',
    results,
    error: { op_index: i, code: err?.code || 'internal', message: clean(err?.message ?? err), ...extra },
    post,
  });

  try {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      let classified = null;
      let raw;
      let sent = false;
      try {
        const skip = beforeOp ? await beforeOp(op, i) : null;
        if (skip) {
          results[i] = skip;
          continue;
        }
        const send = resolveCreatedId(ops, i, results, plan);
        classified = classifyProductOp(send, plan);
        // Copies only: plan.ops stays exactly as hashed and stored.
        let body = op.body;
        for (const [field, name] of envMap(op)) body = setPath(body, field, env[name]);
        raw = (await client.request(send.method, send.path, { body })) ?? true;
        sent = true;
        if (!classified) {
          results[i] = raw;
          continue;
        }
        const { entry } = classified;
        product[i] = true;
        collect(secrets, raw, entry, plan);
        let result = safeResult(raw, entry, secrets);
        results[i] = result;
        if (entry.secretSink?.length) {
          let file;
          try {
            file = writeSink(cwd, plan, i, raw, entry);
          } catch (err) {
            // The op ran; its result stays so rollback still covers it.
            return stop(i, true, { message: `Op ${i} applied but its secret file could not be written: ${err?.message ?? err}` }, {
              hint: 'The one-time secret is lost: rotate or recreate the credential, then store the new value yourself',
            });
          }
          if (file && isPlainObject(result)) results[i] = result = { ...result, secret_file: file };
        }
        const readPath = postReadPath(send, classified, raw);
        if (readPath === null) continue;
        try {
          if (readPath === undefined) throw new Error('no usable id in the apply result');
          // A kind may read more than the resource (Gateway: the rules of its phase).
          const read = entry.capturePost ? await entry.capturePost(client, readPath, send) : await client.request('GET', readPath);
          collect(secrets, read, entry, plan);
          const stored = redactPaths(omitPaths(read, entry.secretFields ?? []), [...(entry.redact ?? []), ...(entry.secretSink ?? [])]);
          post[i] = scrubKeepingId(stored, [...secrets]);
        } catch (err) {
          // The write already happened; a failed read only loses the post state.
          post[i] = null;
          if (isPlainObject(result)) results[i] = { ...result, note: `post_error: ${err?.code || 'internal'}: ${clean(err?.message ?? err)}` };
        }
      } catch (err) {
        // A failure after the request keeps the op's result, so rollback covers it.
        if (sent && results[i] === null) {
          results[i] = classified ? safeResult(raw, classified.entry, secrets) : raw;
          product[i] = Boolean(classified);
        }
        return stop(i, sent, err);
      }
    }
    return finish({ status: 'applied', results, post });
  } catch (err) {
    if (err && typeof err === 'object') {
      err.message = clean(err.message);
      if (typeof err.hint === 'string') err.hint = clean(err.hint);
    }
    throw err;
  }
}
