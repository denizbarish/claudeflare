// Post-change verification of product ops (spec 8). Report only: checks read,
// never write, and a failed check never undoes anything. Apply records the
// outcome and drafts a rollback plan that still needs the user's approval.

import { Socket } from 'node:net';
import { tryOnce } from './health-check.mjs';
import { omitPaths } from './products/fields.mjs';

/**
 * One verification check. run never throws on purpose; a throw counts as a
 * failed try with the error message as detail.
 * @typedef {object} Check
 * @property {string} name
 * @property {() => Promise<{ ok: boolean, detail: string }>} run
 * @property {boolean} [once]  The result cannot change on a retry (a read-back
 *   of the stored post state), so runVerify runs it once.
 */

export const VERIFY_TIMEOUT_MS = 60000;
export const VERIFY_INTERVAL_MS = 5000;
const FETCH_TIMEOUT_MS = 10000;
const TCP_TIMEOUT_MS = 5000;
const BODY_LIMIT = 65536;
const ACCESS_SUFFIX = '.cloudflareaccess.com';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function attempt(check) {
  try {
    const out = await check.run();
    return { ok: out?.ok === true, detail: String(out?.detail ?? '') };
  } catch (err) {
    return { ok: false, detail: String(err?.message ?? err) };
  }
}

// Runs every check, then retries the failed ones every intervalMs until all
// pass or timeoutMs has passed since the start; a failed check keeps the
// detail of its last try. now() returns milliseconds.
export async function runVerify(checks, {
  timeoutMs = VERIFY_TIMEOUT_MS,
  intervalMs = VERIFY_INTERVAL_MS,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  const start = now();
  const state = checks.map((check) => ({ check, ok: false, detail: 'not run', done: false }));
  for (;;) {
    for (const s of state) {
      if (s.done) continue;
      Object.assign(s, await attempt(s.check));
      if (s.ok || s.check.once) s.done = true;
    }
    if (state.every((s) => s.done) || now() - start >= timeoutMs) break;
    await sleep(intervalMs);
  }
  const out = state.map(({ check, ok, detail }) => ({ name: check.name, ok, detail }));
  return { ok: out.every((c) => c.ok), checks: out };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Path of the first sent value the read-back does not hold. Objects compare
// as subsets (the API adds defaults and read-only fields), arrays by length
// and element, everything else strictly.
function firstMismatch(sent, got, path) {
  if (isPlainObject(sent)) {
    if (!isPlainObject(got)) return path || '(root)';
    for (const key of Object.keys(sent)) {
      const miss = firstMismatch(sent[key], got[key], path ? `${path}.${key}` : key);
      if (miss !== null) return miss;
    }
    return null;
  }
  if (Array.isArray(sent)) {
    if (!Array.isArray(got) || got.length !== sent.length) return path || '(root)';
    for (let i = 0; i < sent.length; i++) {
      const miss = firstMismatch(sent[i], got[i], `${path}.${i}`);
      if (miss !== null) return miss;
    }
    return null;
  }
  return Object.is(sent, got) ? null : path || '(root)';
}

// post: the redacted state read right after the op; sentBody: op.body as
// planned; ignore: field paths left out (read-only, reformatted or secret).
// Values only appear in the detail as a path, never as content.
export function readbackCheck(post, sentBody, ignore = []) {
  return {
    name: 'readback',
    once: true,
    run: async () => {
      if (post === null || post === undefined) return { ok: false, detail: 'no post-apply read to compare' };
      const sent = isPlainObject(sentBody) && ignore.length ? omitPaths(sentBody, ignore) : sentBody;
      const miss = firstMismatch(sent ?? {}, post, '');
      return miss === null ? { ok: true, detail: 'read-back matches the sent body' } : { ok: false, detail: `read-back differs at ${miss}` };
    },
  };
}

function hostOf(location) {
  try {
    return new URL(location).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Unauthenticated GET without redirect follow. ok on exactly 302 with a
// Location host equal to teamDomain (the org auth_domain, case-insensitive).
// Without a team domain (rollback plans have no preflight ctx) any
// <team>.cloudflareaccess.com host passes.
export function accessLoginCheck(url, teamDomain, { fetchImpl = globalThis.fetch } = {}) {
  const team = typeof teamDomain === 'string' && teamDomain !== '' ? teamDomain.toLowerCase() : null;
  return {
    name: `access_login ${url}`,
    run: async () => {
      const { status, location } = await tryOnce(fetchImpl, url, FETCH_TIMEOUT_MS);
      if (status === null) return { ok: false, detail: `no response from ${url}` };
      const host = location ? hostOf(location) : null;
      if (status !== 302 || !host) return { ok: false, detail: `expected 302 to the Access login, got ${status}${location ? ` to ${location}` : ''}` };
      const ok = team ? host === team : host.endsWith(ACCESS_SUFFIX) && host.length > ACCESS_SUFFIX.length;
      return ok
        ? { ok: true, detail: `302 to ${location}` }
        : { ok: false, detail: `302 to ${location}, expected host ${team ?? `<team>${ACCESS_SUFFIX}`}` };
    },
  };
}

export function statusCheck(url, code, { fetchImpl = globalThis.fetch } = {}) {
  return {
    name: `status:${code} ${url}`,
    run: async () => {
      const { status } = await tryOnce(fetchImpl, url, FETCH_TIMEOUT_MS);
      if (status === null) return { ok: false, detail: `no response from ${url}` };
      return status === code ? { ok: true, detail: `got ${status}` } : { ok: false, detail: `expected ${code}, got ${status}` };
    },
  };
}

const TUNNEL_ERROR = /error(?:\s+code)?:?\s*(1016|1033)\b/i;

// ok when the body carries no 1016 / 1033 error code and the status is below
// 500 or Cloudflare answered (cf-ray present: the origin itself replied).
export function tunnelServingCheck(url, { fetchImpl = globalThis.fetch } = {}) {
  return {
    name: `tunnel_serving ${url}`,
    run: async () => {
      let response;
      try {
        response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      } catch (err) {
        return { ok: false, detail: `no response from ${url}: ${err?.message ?? err}` };
      }
      let body = '';
      try {
        body = String(await response.text()).slice(0, BODY_LIMIT);
      } catch {
        // An unreadable body carries no error code.
      }
      const code = TUNNEL_ERROR.exec(body)?.[1];
      if (code) return { ok: false, detail: `${url} answered with Cloudflare error ${code} (status ${response.status})` };
      const ray = Boolean(response.headers?.get?.('cf-ray'));
      return response.status < 500 || ray
        ? { ok: true, detail: `status ${response.status}${ray ? ', cf-ray present' : ''}` }
        : { ok: false, detail: `status ${response.status} without cf-ray` };
    },
  };
}

// poolPath: the pool resource path (/accounts/<a>/load_balancers/pools/<id>).
// ok when the health endpoint lists at least one data center and all are healthy.
export function poolHealthyCheck(client, poolPath) {
  return {
    name: `pool_healthy ${poolPath}`,
    run: async () => {
      const health = await client.request('GET', `${poolPath}/health`);
      const pops = Object.entries(health?.pop_health ?? {});
      if (!pops.length) return { ok: false, detail: 'no health data yet' };
      const sick = pops.filter(([, value]) => value?.healthy !== true).map(([pop]) => pop);
      return sick.length ? { ok: false, detail: `unhealthy from ${sick.join(', ')}` } : { ok: true, detail: `healthy from ${pops.length} data centers` };
    },
  };
}

function netConnect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`timed out after ${timeoutMs} ms`));
    });
    socket.once('error', (err) => {
      socket.destroy();
      reject(err);
    });
    socket.connect(port, host);
  });
}

// connect(host, port, timeoutMs) resolves when a TCP connection opens.
export function tcpOpenCheck(host, port, { connect = netConnect } = {}) {
  return {
    name: `tcp_open ${host}:${port}`,
    run: async () => {
      try {
        await connect(host, port, TCP_TIMEOUT_MS);
        return { ok: true, detail: `connected to ${host}:${port}` };
      } catch (err) {
        return { ok: false, detail: `cannot connect to ${host}:${port}: ${err?.message ?? err}` };
      }
    },
  };
}

// Team domain of the Access org from a product's preflight ctx; null when the
// ctx does not hold it (rollback plans, products without an org read).
export function teamDomainOf(ctx) {
  const value = ctx?.auth_domain ?? ctx?.org?.auth_domain ?? ctx?.organization?.auth_domain;
  return typeof value === 'string' && value !== '' ? value : null;
}

function hostPort(url) {
  const parsed = new URL(url);
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  return [parsed.hostname, port];
}

// Checks for one applied product op: the module's defaults plus the op's own
// `verify` (validated by resources.mjs), which adds a check and replaces none.
// deps: { client, fetchImpl, connect, readPath } where readPath is the op's
// resource path (pool_healthy). ctx is {} on rollback plans.
export function opVerifyChecks(op, entry, module, ctx, result, post, deps = {}) {
  const checks = [...(module.verifyChecks?.(op, entry, ctx ?? {}, result, post, deps) ?? [])];
  const verify = op?.verify;
  if (!verify) return checks;
  const { fetchImpl = globalThis.fetch, connect, client, readPath } = deps;
  const expect = String(verify.expect);
  if (expect === 'access_login') checks.push(accessLoginCheck(verify.url, teamDomainOf(ctx), { fetchImpl }));
  else if (expect.startsWith('status:')) checks.push(statusCheck(verify.url, Number(expect.slice(7)), { fetchImpl }));
  else if (expect === 'tunnel_serving') {
    checks.push(verify.url
      ? tunnelServingCheck(verify.url, { fetchImpl })
      : { name: 'tunnel_serving', once: true, run: async () => ({ ok: true, detail: 'skipped: no verify.url' }) });
  } else if (expect === 'pool_healthy') {
    checks.push(client && readPath
      ? poolHealthyCheck(client, readPath)
      : { name: 'pool_healthy', once: true, run: async () => ({ ok: false, detail: 'pool path unknown' }) });
  } else if (expect === 'tcp_open') {
    const [host, port] = hostPort(verify.url);
    checks.push(tcpOpenCheck(host, port, connect ? { connect } : {}));
  }
  return checks;
}
