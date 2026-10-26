#!/usr/bin/env node
// Test double for wrangler. Behavior is driven by environment variables:
// - FAKE_WRANGLER_SCRIPT: JSON file mapping args.join(' ') to { stdout, stderr, code, events }
// - FAKE_WRANGLER_LOG: file that receives one JSON line per invocation (never stdin content or the token)
// - FAKE_WRANGLER_DELAY_MS: wait this long before responding (timeout tests)
// - WRANGLER_OUTPUT_FILE_PATH: receives the entry's events as ND-JSON
// Keys ending in " *" are prefix matches (for args with temp paths).
// Entry flags: echoStdin (write stdin to stdout), ignoreSigterm, grandchild (spawn a
// long-lived child that inherits stdio and ignores SIGTERM; its pid is logged), hang.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function log(record) {
  if (process.env.FAKE_WRANGLER_LOG) appendFileSync(process.env.FAKE_WRANGLER_LOG, `${JSON.stringify(record)}\n`);
}

function loadScript() {
  const path = process.env.FAKE_WRANGLER_SCRIPT;
  if (!path) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

const stdin = await readStdin();

log({
  argv,
  stdinLength: stdin.length,
  env: {
    CI: process.env.CI,
    WRANGLER_SEND_METRICS: process.env.WRANGLER_SEND_METRICS,
    NO_COLOR: process.env.NO_COLOR,
    hasToken: Boolean(process.env.CLOUDFLARE_API_TOKEN),
    hasGlobalKey: Boolean(process.env.CLOUDFLARE_API_KEY || process.env.CLOUDFLARE_EMAIL),
  },
});

const delay = Number(process.env.FAKE_WRANGLER_DELAY_MS || 0);
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

const key = argv.join(' ');
const script = loadScript();
// A key ending in " *" matches any argv that starts with the rest of the key.
const entry = script[key] ?? Object.entries(script).find(([k]) => k.endsWith(' *') && key.startsWith(k.slice(0, -1)))?.[1];
if (!entry) {
  process.stderr.write(`fake-wrangler: no script entry for "${key}"\n`);
  process.exit(99);
}

if (entry.ignoreSigterm) process.on('SIGTERM', () => {});
if (entry.grandchild) {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
    stdio: 'inherit',
  });
  log({ grandchildPid: child.pid });
}

const outFile = process.env.WRANGLER_OUTPUT_FILE_PATH;
if (outFile && Array.isArray(entry.events)) {
  appendFileSync(outFile, entry.events.map((e) => `${typeof e === 'string' ? e : JSON.stringify(e)}\n`).join(''));
}
if (entry.stdout) process.stdout.write(entry.stdout);
if (entry.stderr) process.stderr.write(entry.stderr);
if (entry.echoStdin) process.stdout.write(stdin);
if (entry.hang) setInterval(() => {}, 1000);
process.exitCode = entry.code ?? 0;
