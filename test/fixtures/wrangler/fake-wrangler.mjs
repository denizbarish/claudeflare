#!/usr/bin/env node
// Test double for wrangler. Behavior is driven by environment variables:
// - FAKE_WRANGLER_SCRIPT: JSON file mapping args.join(' ') to { stdout, stderr, code, events }
// - FAKE_WRANGLER_LOG: file that receives one JSON line per invocation (never stdin content or the token)
// - FAKE_WRANGLER_DELAY_MS: wait this long before responding (timeout tests)
// - WRANGLER_OUTPUT_FILE_PATH: receives the entry's events as ND-JSON
import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);

async function readStdin() {
  let length = 0;
  for await (const chunk of process.stdin) length += chunk.length;
  return length;
}

function loadScript() {
  const path = process.env.FAKE_WRANGLER_SCRIPT;
  if (!path) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

const stdinLength = await readStdin();

if (process.env.FAKE_WRANGLER_LOG) {
  const record = {
    argv,
    stdinLength,
    env: {
      CI: process.env.CI,
      WRANGLER_SEND_METRICS: process.env.WRANGLER_SEND_METRICS,
      NO_COLOR: process.env.NO_COLOR,
      hasToken: Boolean(process.env.CLOUDFLARE_API_TOKEN),
    },
  };
  appendFileSync(process.env.FAKE_WRANGLER_LOG, `${JSON.stringify(record)}\n`);
}

const delay = Number(process.env.FAKE_WRANGLER_DELAY_MS || 0);
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

const key = argv.join(' ');
const entry = loadScript()[key];
if (!entry) {
  process.stderr.write(`fake-wrangler: no script entry for "${key}"\n`);
  process.exit(99);
}

const outFile = process.env.WRANGLER_OUTPUT_FILE_PATH;
if (outFile && Array.isArray(entry.events)) {
  appendFileSync(outFile, entry.events.map((e) => `${typeof e === 'string' ? e : JSON.stringify(e)}\n`).join(''));
}
if (entry.stdout) process.stdout.write(entry.stdout);
if (entry.stderr) process.stderr.write(entry.stderr);
process.exitCode = entry.code ?? 0;
