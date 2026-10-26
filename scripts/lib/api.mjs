import { CfError, mapError } from './errors.mjs';

const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4';
const BASE_BACKOFF_MS = 1000;
const MAX_WAIT_MS = 60_000;

// extra: further secret values (injected or received during an apply). The
// longest value is replaced first, so a value that contains a shorter one is
// never left half visible.
export function redact(text, token, extra = []) {
  const values = [token, ...(extra ?? [])].filter((v) => typeof v === 'string' && v !== '');
  if (!values.length) return text;
  values.sort((a, b) => b.length - a.length);
  let out = String(text);
  for (const value of values) out = out.split(value).join('[REDACTED]');
  return out;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildUrl(baseUrl, path, query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${baseUrl}${path}?${qs}` : `${baseUrl}${path}`;
}

function retryDelay(response, attempt) {
  const header = response.headers.get('Retry-After');
  const seconds = Number(header);
  if (header !== null && header.trim() !== '' && Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_WAIT_MS);
  }
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_WAIT_MS);
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function redactError(err, token) {
  err.message = redact(err.message, token);
  err.hint = redact(err.hint, token);
  return err;
}

export function createClient({
  token = process.env.CLOUDFLARE_API_TOKEN,
  baseUrl = process.env.CLOUDFLARE_API_BASE || DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  maxRetries = 5,
  sleep = defaultSleep,
} = {}) {
  if (!token) {
    throw new CfError('missing_token', 'CLOUDFLARE_API_TOKEN is not set');
  }

  async function send(method, url, body) {
    const headers = { Authorization: `Bearer ${token}` };
    const init = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    try {
      return await fetchImpl(url, init);
    } catch (err) {
      throw new CfError('network', redact(err?.message ?? String(err), token));
    }
  }

  // envelope: true returns the whole body ({ result, result_info, ... }) for
  // paginated reads; otherwise only `result`.
  async function request(method, path, { query, body, envelope = false } = {}) {
    const url = buildUrl(baseUrl, path, query);
    for (let attempt = 0; ; attempt++) {
      const response = await send(method, url, body);
      if (response.status === 429 && attempt < maxRetries) {
        await sleep(retryDelay(response, attempt));
        continue;
      }
      const data = await readJson(response);
      if (!response.ok || data?.success === false) {
        throw redactError(mapError(response.status, data), token);
      }
      return envelope ? data : data?.result;
    }
  }

  return { request };
}
