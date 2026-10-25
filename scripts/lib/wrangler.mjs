// Single entry point for running wrangler: argument array (no shell), explicit env, redacted output.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact } from './api.mjs';
import { CfError } from './errors.mjs';

const DEFAULT_TIMEOUT_MS = 300000;
const KILL_GRACE_MS = 5000;
const FAILURE_TAIL_LINES = 20;
const REQUIRED_MAJOR = 4;
const INSTALL_HINT = 'Install wrangler 4 in the project: npm i -D wrangler@4';
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export function wranglerCommand() {
  const override = process.env.CLAUDEFLARE_WRANGLER;
  if (override && /\.(mjs|js)$/.test(override)) return { file: process.execPath, prefixArgs: [override] };
  if (override) return { file: override, prefixArgs: [] };
  return { file: 'npx', prefixArgs: ['--no-install', 'wrangler'] };
}

function sanitize(text, sensitive) {
  let out = String(text).replace(ANSI_PATTERN, '');
  for (const value of sensitive) out = redact(out, value);
  return out;
}

function buildEnv({ token, accountId, outputFile, extraEnv }) {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  if (token) env.CLOUDFLARE_API_TOKEN = token;
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  return {
    ...env,
    WRANGLER_SEND_METRICS: 'false',
    CI: '1',
    NO_COLOR: '1',
    WRANGLER_OUTPUT_FILE_PATH: outputFile,
    ...extraEnv,
  };
}

function readEvents(outputFile, sensitive) {
  let raw;
  try {
    raw = readFileSync(outputFile, 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of sanitize(raw, sensitive).split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // wrangler may leave partial lines; ignore anything that is not JSON.
    }
  }
  return events;
}

function spawnAndCollect(file, argv, { cwd, env, stdin, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, argv, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let killTimer;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      fn(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.on('error', () => {
      // The child may exit without reading stdin (EPIPE); its exit code tells the story.
    });
    child.on('error', (err) => finish(reject, err));
    child.on('close', (code, signal) =>
      finish(resolve, {
        code: code ?? (signal ? 1 : 0),
        timedOut,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );

    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

export async function runWrangler(
  args,
  { cwd, token, accountId, stdin, secrets = [], timeoutMs = DEFAULT_TIMEOUT_MS, extraEnv = {} } = {},
) {
  const { file, prefixArgs } = wranglerCommand();
  const outputFile = join(tmpdir(), `claudeflare-wrangler-${randomUUID()}.ndjson`);
  const sensitive = [token, ...secrets].filter((v) => typeof v === 'string' && v.length > 0);
  sensitive.sort((a, b) => b.length - a.length);
  const env = buildEnv({ token, accountId, outputFile, extraEnv });
  try {
    let raw;
    try {
      raw = await spawnAndCollect(file, [...prefixArgs, ...args], { cwd, env, stdin, timeoutMs });
    } catch (err) {
      if (err?.code === 'ENOENT') {
        throw new CfError('wrangler_missing', 'wrangler could not be started', { hint: INSTALL_HINT });
      }
      throw new CfError('wrangler_failed', sanitize(`wrangler could not be started: ${err?.message}`, sensitive));
    }
    if (raw.timedOut) {
      throw new CfError('wrangler_failed', `wrangler ${args[0] ?? ''} timed out after ${timeoutMs} ms`.trim());
    }
    return {
      code: raw.code,
      stdout: sanitize(raw.stdout, sensitive),
      stderr: sanitize(raw.stderr, sensitive),
      events: readEvents(outputFile, sensitive),
    };
  } finally {
    rmSync(outputFile, { force: true });
  }
}

export function failureMessage(result) {
  const failed = (result?.events ?? []).filter((e) => e?.type === 'command-failed' && typeof e.message === 'string');
  if (failed.length) return failed[failed.length - 1].message;
  const lines = String(result?.stderr ?? '')
    .split('\n')
    .filter((line) => line.trim());
  return lines.slice(-FAILURE_TAIL_LINES).join('\n');
}

export async function assertWranglerVersion(cwd, opts = {}) {
  const result = await runWrangler(['--version'], { ...opts, cwd });
  const match = result.code === 0 ? /(\d+)\.\d+\.\d+/.exec(result.stdout) : null;
  if (!match) {
    throw new CfError('wrangler_missing', 'wrangler is not installed or did not report a version', {
      hint: INSTALL_HINT,
    });
  }
  if (Number(match[1]) !== REQUIRED_MAJOR) {
    throw new CfError('wrangler_version', `wrangler ${match[0]} found; major version ${REQUIRED_MAJOR} is required`, {
      hint: INSTALL_HINT,
    });
  }
  return match[0];
}
