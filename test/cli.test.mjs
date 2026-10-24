import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../scripts/cf.mjs', import.meta.url));
const TOKEN = 'tok-SECRET-1234567890';
const ZID = '0123456789abcdef0123456789abcdef';

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Async spawn: the stub server lives in this process, so spawnSync would deadlock.
function run(cwd, args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, env: { PATH: process.env.PATH, CLAUDEFLARE_KEY_DIR: join(cwd, '.key'), ...env } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });
}

async function stubServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('cli init twice leaves a single .claudeflare/ line in .gitignore', async (t) => {
  const cwd = tempDir(t, 'claudeflare-cli-');
  writeFileSync(join(cwd, '.gitignore'), 'node_modules/');
  for (let i = 0; i < 2; i++) {
    const res = await run(cwd, ['init']);
    assert.equal(res.code, 0, res.stderr);
  }
  const lines = readFileSync(join(cwd, '.gitignore'), 'utf8').split('\n');
  assert.equal(lines.filter((l) => l === '.claudeflare/').length, 1);
  assert.ok(lines.includes('node_modules/'));
  for (const dir of ['plans', 'approvals', 'snapshots', 'reports']) {
    assert.ok(existsSync(join(cwd, '.claudeflare', dir)), dir);
  }
});

test('cli init creates .gitignore when missing', async (t) => {
  const cwd = tempDir(t, 'claudeflare-cli-');
  const res = await run(cwd, ['init']);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(readFileSync(join(cwd, '.gitignore'), 'utf8'), '.claudeflare/\n');
});

test('cli plan new marks purge_cache as Not reversible in risk', async (t) => {
  const cwd = tempDir(t, 'claudeflare-cli-');
  const draft = {
    zone_id: ZID,
    zone_name: 'example.com',
    summary: 'Purge and set SSL',
    risk: 'Brief cache miss spike.',
    slug: 'purge',
    ops: [
      { method: 'PATCH', path: '/zones/{zone_id}/settings/ssl', body: { value: 'strict' } },
      { method: 'POST', path: '/zones/{zone_id}/purge_cache', body: { purge_everything: true } },
    ],
  };
  writeFileSync(join(cwd, 'draft.json'), JSON.stringify(draft));
  const res = await run(cwd, ['plan', 'new', '--file', 'draft.json']);
  assert.equal(res.code, 0, res.stderr);
  const plan = JSON.parse(res.stdout);
  assert.equal(plan.risk, `Brief cache miss spike.\nNot reversible: POST /zones/${ZID}/purge_cache`);
  assert.equal(plan.slug, 'purge');
  assert.equal(plan.status, 'draft');

  const shown = await run(cwd, ['plan', 'show', plan.id]);
  assert.deepEqual(JSON.parse(shown.stdout), plan);
  const listed = await run(cwd, ['plan', 'list']);
  assert.deepEqual(JSON.parse(listed.stdout).map((p) => p.id), [plan.id]);
});

test('cli plan new rejects conflicting ops before writing anything', async (t) => {
  const cwd = tempDir(t, 'claudeflare-cli-');
  const op = { method: 'PATCH', path: '/zones/{zone_id}/dns_records/abc123', body: { ttl: 60 } };
  const draft = { zone_id: ZID, zone_name: 'example.com', summary: 's', risk: 'r', slug: 'dup', ops: [op, op] };
  writeFileSync(join(cwd, 'draft.json'), JSON.stringify(draft));
  const res = await run(cwd, ['plan', 'new', '--file', 'draft.json']);
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stderr).error.code, 'plan_conflict');
  assert.equal(existsSync(join(cwd, '.claudeflare', 'plans')), false);
});

test('cli get prints the result and passes query parameters', async (t) => {
  const cwd = tempDir(t, 'claudeflare-cli-');
  let seen;
  const base = await stubServer(t, (req, res) => {
    seen = { url: req.url, auth: req.headers.authorization };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, result: [{ id: ZID, name: 'example.com' }] }));
  });
  const res = await run(cwd, ['get', '/zones', '--query', 'name=example.com', '--query', 'per_page=5'], {
    CLOUDFLARE_API_TOKEN: TOKEN,
    CLOUDFLARE_API_BASE: base,
  });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), [{ id: ZID, name: 'example.com' }]);
  assert.equal(seen.url, '/zones?name=example.com&per_page=5');
  assert.equal(seen.auth, `Bearer ${TOKEN}`);
});

test('cli errors print JSON on stderr, exit code 1, no token in output', async (t) => {
  const cwd = tempDir(t, 'claudeflare-cli-');
  const base = await stubServer(t, (req, res) => {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    // A hostile upstream echoing the credential must still not leak it.
    const message = `Authentication error for ${req.headers.authorization}`;
    res.end(JSON.stringify({ success: false, errors: [{ code: 10000, message }] }));
  });
  const res = await run(cwd, ['get', '/zones'], { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 1);
  assert.equal(res.stdout, '');
  const { error } = JSON.parse(res.stderr);
  assert.equal(error.code, 'permission');
  assert.equal(typeof error.message, 'string');
  assert.equal(typeof error.hint, 'string');
  assert.ok(!res.stderr.includes(TOKEN));

  const missing = await run(cwd, ['get', '/zones'], { CLOUDFLARE_API_BASE: base });
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stderr).error.code, 'missing_token');

  const unknown = await run(cwd, ['frobnicate'], { CLOUDFLARE_API_TOKEN: TOKEN });
  assert.equal(unknown.code, 1);
  assert.equal(JSON.parse(unknown.stderr).error.code, 'usage');
  assert.ok(!unknown.stderr.includes(TOKEN));
});

test('cli apply without approval is refused with not_approved', async (t) => {
  const cwd = tempDir(t, 'claudeflare-cli-');
  let hits = 0;
  const base = await stubServer(t, (req, res) => {
    hits++;
    res.end('{}');
  });
  const draft = {
    zone_id: ZID,
    zone_name: 'example.com',
    summary: 's',
    risk: 'r',
    slug: 'ssl',
    ops: [{ method: 'PATCH', path: '/zones/{zone_id}/settings/ssl', body: { value: 'strict' } }],
  };
  writeFileSync(join(cwd, 'draft.json'), JSON.stringify(draft));
  const plan = JSON.parse((await run(cwd, ['plan', 'new', '--file', 'draft.json'])).stdout);
  const res = await run(cwd, ['apply', plan.id], { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stderr).error.code, 'not_approved');
  assert.equal(hits, 0);
});

test('cli report writes the audit file and prints its path', async (t) => {
  const cwd = tempDir(t, 'claudeflare-cli-');
  const findings = [{ id: 'ssl.mode.flexible', domain: 'ssl', severity: 'critical', title: 'SSL mode is Flexible' }];
  writeFileSync(join(cwd, 'findings.json'), JSON.stringify(findings));
  const res = await run(cwd, ['report', '--file', 'findings.json', '--zone', 'example.com']);
  assert.equal(res.code, 0, res.stderr);
  const file = res.stdout.trim();
  assert.match(file, /\.claudeflare[/\\]reports[/\\]example\.com[/\\]\d{8}-\d{6}-audit\.md$/);
  assert.match(readFileSync(file, 'utf8'), /Overall score: 75\/100/);
});
