// Single entry point for running wrangler: argument array (no shell), explicit env, redacted output.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { redact } from './api.mjs';
import { CfError } from './errors.mjs';

const DEFAULT_TIMEOUT_MS = 300000;
const KILL_GRACE_MS = 5000;
const EXIT_GRACE_MS = 1000;
const FAILURE_TAIL_LINES = 20;
const REQUIRED_MAJOR = 4;
const INSTALL_HINT = 'Install wrangler 4 in the project: npm i -D wrangler@4';
const RESERVED_ENV = new Set(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'WRANGLER_OUTPUT_FILE_PATH']);
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const USE_PROCESS_GROUP = process.platform !== 'win32';

function missing(message) {
  return new CfError('wrangler_missing', message, { hint: INSTALL_HINT });
}

// wrangler's package "exports" does not expose bin/wrangler.js, so resolve the
// exported package.json and follow its "bin" entry.
function resolveProjectWrangler(cwd) {
  let pkgPath;
  try {
    pkgPath = createRequire(join(resolve(cwd ?? '.'), 'package.json')).resolve('wrangler/package.json');
  } catch {
    throw missing('wrangler is not installed in the project');
  }
  let bin;
  try {
    bin = JSON.parse(readFileSync(pkgPath, 'utf8')).bin;
  } catch {
    throw missing('wrangler package.json could not be read');
  }
  const rel = typeof bin === 'string' ? bin : bin?.wrangler;
  if (typeof rel !== 'string' || !rel) throw missing('wrangler package has no wrangler bin entry');
  return join(dirname(pkgPath), rel);
}

export function wranglerCommand(cwd) {
  const override = process.env.CLAUDEFLARE_WRANGLER;
  if (override && /\.(mjs|js)$/.test(override)) return { file: process.execPath, prefixArgs: [override] };
  if (override) return { file: override, prefixArgs: [] };
  return { file: process.execPath, prefixArgs: [resolveProjectWrangler(cwd)] };
}

function sanitize(text, sensitive) {
  let out = String(text).replace(ANSI_PATTERN, '');
  for (const value of sensitive) out = redact(out, value);
  return out;
}

function sanitizeValue(value, sensitive) {
  if (typeof value === 'string') return sanitize(value, sensitive);
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, sensitive));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeValue(v, sensitive)]));
  }
  return value;
}

function buildEnv({ token, accountId, outputFile, extraEnv }) {
  for (const key of Object.keys(extraEnv)) {
    if (RESERVED_ENV.has(key)) throw new CfError('invalid_input', `extraEnv may not set ${key}`);
  }
  const env = { ...process.env, ...extraEnv };
  // Only the token passed here reaches wrangler (and any build it runs, such
  // as the preflight dry-run); a Global API Key never does.
  for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL']) delete env[key];
  if (token) env.CLOUDFLARE_API_TOKEN = token;
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  env.WRANGLER_SEND_METRICS = 'false';
  env.CI = '1';
  env.NO_COLOR = '1';
  env.WRANGLER_OUTPUT_FILE_PATH = outputFile;
  return env;
}

function readEvents(outputFile, sensitive) {
  let raw;
  try {
    raw = readFileSync(outputFile, 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // wrangler may leave partial lines; ignore anything that is not JSON.
    }
    events.push(sanitizeValue(parsed, sensitive));
  }
  return events;
}

function signalTree(child, signal) {
  if (USE_PROCESS_GROUP && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // group already gone or not ours; fall back to the direct child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already exited
  }
}

function spawnAndCollect(file, argv, { cwd, env, stdin, timeoutMs, stopAfterMs, maxOutputBytes }) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(file, argv, {
        cwd,
        env,
        shell: false,
        detached: USE_PROCESS_GROUP,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }
    const stdout = [];
    const stderr = [];
    const timers = [];
    let reason = null; // 'timeout' | 'stopped'
    let collected = 0;
    let truncated = false;
    let settled = false;

    const result = (code, signal) => ({
      code: code ?? (signal ? 1 : 0),
      reason,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      truncated,
    });
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      fn(value);
    };
    const stop = (why) => {
      if (reason || settled) return;
      reason = why;
      signalTree(child, 'SIGTERM');
      timers.push(setTimeout(() => signalTree(child, 'SIGKILL'), KILL_GRACE_MS));
    };

    timers.push(setTimeout(() => stop('timeout'), timeoutMs));
    if (stopAfterMs !== undefined) timers.push(setTimeout(() => stop('stopped'), stopAfterMs));

    // maxOutputBytes bounds memory for long-running reads (tail): past it,
    // output is dropped and the child is stopped.
    const collect = (into) => (chunk) => {
      if (truncated) return;
      collected += chunk.length;
      if (maxOutputBytes !== undefined && collected > maxOutputBytes) {
        truncated = true;
        stop('stopped');
        return;
      }
      into.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.stdin.on('error', () => {
      // The child may exit without reading stdin (EPIPE); its exit code tells the story.
    });
    child.on('error', (err) => finish(reject, err));
    child.on('exit', (code, signal) => {
      if (!reason) return;
      // A grandchild may still hold the pipes; do not wait for 'close' forever.
      timers.push(
        setTimeout(() => {
          signalTree(child, 'SIGKILL');
          child.stdout.destroy();
          child.stderr.destroy();
          finish(resolvePromise, result(code, signal));
        }, EXIT_GRACE_MS),
      );
    });
    child.on('close', (code, signal) => finish(resolvePromise, result(code, signal)));

    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

export async function runWrangler(
  args,
  { cwd, token, accountId, stdin, secrets = [], timeoutMs = DEFAULT_TIMEOUT_MS, stopAfterMs, maxOutputBytes, extraEnv = {} } = {},
) {
  const { file, prefixArgs } = wranglerCommand(cwd);
  const outputFile = join(tmpdir(), `claudeflare-wrangler-${randomUUID()}.ndjson`);
  const sensitive = [token, ...secrets].filter((v) => typeof v === 'string' && v.length > 0);
  sensitive.sort((a, b) => b.length - a.length);
  const env = buildEnv({ token, accountId, outputFile, extraEnv });
  try {
    let raw;
    try {
      raw = await spawnAndCollect(file, [...prefixArgs, ...args], { cwd, env, stdin, timeoutMs, stopAfterMs, maxOutputBytes });
    } catch (err) {
      if (err?.code === 'ENOENT') throw missing('wrangler could not be started');
      throw new CfError('wrangler_failed', sanitize(`wrangler could not be started: ${err?.message}`, sensitive));
    }
    if (raw.reason === 'timeout') {
      throw new CfError('wrangler_failed', `wrangler${args[0] ? ` ${args[0]}` : ''} timed out after ${timeoutMs} ms`);
    }
    const out = {
      code: raw.code,
      stdout: sanitize(raw.stdout, sensitive),
      stderr: sanitize(raw.stderr, sensitive),
      events: readEvents(outputFile, sensitive),
    };
    if (raw.reason === 'stopped') out.stopped = true;
    if (raw.truncated) out.truncated = true;
    return out;
  } finally {
    rmSync(outputFile, { force: true });
  }
}

export function failureMessage(result) {
  const failed = (result?.events ?? []).filter((e) => e?.type === 'command-failed' && typeof e.message === 'string');
  if (failed.length) {
    // wrangler puts the API error code in its own field, not in the message.
    const { message, code } = failed[failed.length - 1];
    return Number.isInteger(code) && !message.includes(`code: ${code}`) ? `${message} [code: ${code}]` : message;
  }
  const lines = String(result?.stderr ?? '')
    .split('\n')
    .filter((line) => line.trim());
  return lines.slice(-FAILURE_TAIL_LINES).join('\n');
}

export async function assertWranglerVersion(cwd, { runner = runWrangler, ...opts } = {}) {
  const result = await runner(['--version'], { ...opts, cwd });
  const match = result.code === 0 ? /(\d+)\.\d+\.\d+/.exec(result.stdout) : null;
  if (!match) throw missing('wrangler is not installed or did not report a version');
  if (Number(match[1]) !== REQUIRED_MAJOR) {
    throw new CfError('wrangler_version', `wrangler ${match[0]} found; major version ${REQUIRED_MAJOR} is required`, {
      hint: INSTALL_HINT,
    });
  }
  return match[0];
}
