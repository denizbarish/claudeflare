// `claudeflare tail`: runs `wrangler tail --format json` for a bounded time
// and returns a summary (outcome counts, top exceptions, a few samples) with
// secret-looking values redacted. Read-only.

import { CfError } from './errors.mjs';
import { failureMessage, runWrangler } from './wrangler.mjs';

const WORKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const STATUSES = new Set(['ok', 'error', 'canceled']);
const MAX_SECONDS = 60;
const SAMPLE_COUNT = 5;
const LOGS_PER_SAMPLE = 5;
const MAX_TEXT = 500;
const TOP_EXCEPTIONS = 5;

export function clampSeconds(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) throw new CfError('usage', `--seconds must be a number, got ${JSON.stringify(value)}`);
  return Math.min(MAX_SECONDS, Math.max(1, n));
}

// URL query strings and credentials, bearer and basic auth, values of
// secret-named keys, Stripe-style keys, long hex ids and long base64 runs.
export function redactText(value) {
  return String(value)
    .replace(/(https?:\/\/[^\s?#"']+)\?[^\s#"']*/g, '$1?[REDACTED]')
    .replace(/(\/\/)[^\/@\s"']+@/g, '$1[REDACTED]@')
    .replace(/((?:Bearer|Basic)\s+)\S+/gi, '$1[REDACTED]')
    .replace(/((?:password|passwd|pass|secret|token|api[_-]?key|authorization|auth|cookie|session)["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|pk|rk|whsec)_(?:live_|test_)?[A-Za-z0-9]{8,}/g, '[REDACTED]')
    .replace(/\b[0-9a-f]{32,}\b/gi, '[REDACTED]')
    // Long runs with letters and digits mixed (keys, JWT parts), not long hostnames or slugs.
    .replace(/[A-Za-z0-9+_-]{40,}={0,2}/g, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? '[REDACTED]' : run))
    .slice(0, MAX_TEXT);
}

// wrangler prints one pretty-printed JSON object per event; split them by
// brace depth outside strings. Non-JSON lines are ignored.
export function splitJsonObjects(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"' && depth > 0) inString = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0) {
        try {
          objects.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // a partial object at a hard stop; skip it
        }
      }
    }
  }
  return objects;
}

function logText(log) {
  const parts = Array.isArray(log?.message) ? log.message : [log?.message];
  return redactText(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '));
}

function sample(event) {
  const out = { outcome: event.outcome ?? null };
  const url = event.event?.request?.url;
  if (typeof url === 'string') out.url = redactText(url);
  const status = event.event?.response?.status;
  if (typeof status === 'number') out.status = status;
  const exceptions = (Array.isArray(event.exceptions) ? event.exceptions : []).map((e) => redactText(`${e?.name ?? 'Error'}: ${e?.message ?? ''}`));
  if (exceptions.length) out.exceptions = exceptions;
  const logs = (Array.isArray(event.logs) ? event.logs : []).slice(0, LOGS_PER_SAMPLE).map((l) => `${l?.level ?? 'log'}: ${logText(l)}`);
  if (logs.length) out.logs = logs;
  return out;
}

export function summarizeTail(events) {
  const outcomes = {};
  const exceptions = new Map();
  for (const event of events) {
    const outcome = typeof event?.outcome === 'string' ? event.outcome : 'unknown';
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    for (const e of Array.isArray(event?.exceptions) ? event.exceptions : []) {
      const message = redactText(`${e?.name ?? 'Error'}: ${e?.message ?? ''}`);
      exceptions.set(message, (exceptions.get(message) ?? 0) + 1);
    }
  }
  const top = [...exceptions.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_EXCEPTIONS)
    .map(([message, count]) => ({ message, count }));
  const failed = events.filter((e) => e?.outcome !== 'ok');
  const samples = [...failed, ...events.filter((e) => e?.outcome === 'ok')].slice(0, SAMPLE_COUNT).map(sample);
  return { events: events.length, outcomes, top_exceptions: top, samples };
}

export async function runTail({ cwd, worker, seconds, status, accountId }, { runner = runWrangler } = {}) {
  if (typeof worker !== 'string' || !WORKER_NAME.test(worker)) throw new CfError('usage', `Invalid --worker ${JSON.stringify(worker)}`);
  if (status !== undefined && !STATUSES.has(status)) throw new CfError('usage', '--status must be ok, error or canceled');
  if (accountId !== undefined && !ACCOUNT_ID.test(accountId)) throw new CfError('usage', `Invalid --account ${JSON.stringify(accountId)}`);
  const limit = clampSeconds(seconds);
  const args = ['tail', worker, '--format', 'json', ...(status ? ['--status', status] : [])];
  const result = await runner(args, {
    cwd,
    token: process.env.CLOUDFLARE_API_TOKEN,
    accountId,
    stopAfterMs: limit * 1000,
    timeoutMs: limit * 1000 + 15000,
  });
  if (!result.stopped && result.code !== 0) {
    throw new CfError('wrangler_failed', `wrangler tail failed: ${failureMessage(result)}`);
  }
  return { worker, seconds: limit, ...summarizeTail(splitJsonObjects(result.stdout)) };
}
