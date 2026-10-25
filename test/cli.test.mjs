import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeApproval } from '../scripts/lib/approvals.mjs';

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

test('cli report writes the audit file and prints { file, overall, domains }', async (t) => {
  const cwd = tempDir(t, 'claudeflare-cli-');
  const findings = [{ id: 'ssl.mode.flexible', domain: 'ssl', severity: 'critical', title: 'SSL mode is Flexible' }];
  writeFileSync(join(cwd, 'findings.json'), JSON.stringify(findings));
  const res = await run(cwd, ['report', '--file', 'findings.json', '--zone', 'example.com']);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(Object.keys(out), ['file', 'overall', 'domains']);
  assert.match(out.file, /\.claudeflare[/\\]reports[/\\]example\.com[/\\]\d{8}-\d{6}-audit\.md$/);
  assert.equal(out.overall, 75);
  assert.deepEqual(out.domains, { ssl: 75 });
  assert.match(readFileSync(out.file, 'utf8'), /Overall score: 75\/100/);
});

const SSL_DRAFT = {
  zone_id: ZID,
  zone_name: 'example.com',
  summary: 'Set SSL to strict',
  risk: 'r',
  slug: 'SSL Strict!!',
  ops: [
    { method: 'PATCH', path: '/zones/{zone_id}/settings/ssl', body: { value: 'strict' } },
    { method: 'PATCH', path: '/zones/{zone_id}/settings/always_use_https', body: { value: 'on' } },
  ],
};

async function newPlan(cwd) {
  writeFileSync(join(cwd, 'draft.json'), JSON.stringify(SSL_DRAFT));
  const res = await run(cwd, ['plan', 'new', '--file', 'draft.json']);
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout);
}

// Signs an approval with the same key dir the child process uses.
function approveInCwd(cwd, planId) {
  const saved = process.env.CLAUDEFLARE_KEY_DIR;
  process.env.CLAUDEFLARE_KEY_DIR = join(cwd, '.key');
  try {
    writeApproval(cwd, { plan_id: planId, session_id: 's1' });
  } finally {
    if (saved === undefined) delete process.env.CLAUDEFLARE_KEY_DIR;
    else process.env.CLAUDEFLARE_KEY_DIR = saved;
  }
}

// Stub: GET settings return the old value; PATCH succeeds unless the setting is in `failing`.
async function settingsStub(t, failing = []) {
  return stubServer(t, (req, res) => {
    const id = req.url.split('/').pop();
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'PATCH' && failing.includes(id)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ success: false, errors: [{ code: 1, message: 'rejected' }] }));
    }
    const value = req.method === 'GET' ? 'off' : 'new';
    return res.end(JSON.stringify({ success: true, result: { id, value } }));
  });
}

test('cli plan new stores the slugified slug', async (t) => {
  const cwd = tempDir(t, 'claudeflare-cli-');
  const plan = await newPlan(cwd);
  assert.equal(plan.slug, 'ssl-strict');
  assert.ok(plan.id.endsWith('-ssl-strict'));
});

test('cli snapshot writes a preview file for drafts and refuses applied plans', async (t) => {
  const cwd = tempDir(t, 'claudeflare-cli-');
  const base = await settingsStub(t);
  const env = { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_API_BASE: base };
  const plan = await newPlan(cwd);
  const dir = join(cwd, '.claudeflare', 'snapshots', 'example.com');

  const snap = await run(cwd, ['snapshot', plan.id], env);
  assert.equal(snap.code, 0, snap.stderr);
  assert.ok(existsSync(join(dir, `${plan.id}.preview.json`)));
  assert.equal(existsSync(join(dir, `${plan.id}.json`)), false);

  approveInCwd(cwd, plan.id);
  assert.equal((await run(cwd, ['apply', plan.id], env)).code, 0);
  const baseline = readFileSync(join(dir, `${plan.id}.json`), 'utf8');
  const again = await run(cwd, ['snapshot', plan.id], env);
  assert.equal(again.code, 1);
  assert.equal(JSON.parse(again.stderr).error.code, 'not_draft');
  assert.equal(readFileSync(join(dir, `${plan.id}.json`), 'utf8'), baseline);
});

test('cli rollback of an applied plan creates a draft plan with rollback_of', async (t) => {
  const cwd = tempDir(t, 'claudeflare-cli-');
  const base = await settingsStub(t);
  const plan = await newPlan(cwd);
  approveInCwd(cwd, plan.id);
  const applied = await run(cwd, ['apply', plan.id], { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_API_BASE: base });
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).status, 'applied');

  const res = await run(cwd, ['rollback', plan.id]);
  assert.equal(res.code, 0, res.stderr);
  const rollback = JSON.parse(res.stdout);
  assert.equal(rollback.status, 'draft');
  assert.equal(rollback.rollback_of, plan.id);
  assert.equal(rollback.slug, 'rollback-ssl-strict');
  assert.deepEqual(rollback.ops.map((op) => [op.path.split('/').pop(), op.body.value]), [
    ['always_use_https', 'off'],
    ['ssl', 'off'],
  ]);
});

test('cli apply with a failing op exits 1 with apply_failed and prints the plan', async (t) => {
  const cwd = tempDir(t, 'claudeflare-cli-');
  const base = await settingsStub(t, ['always_use_https']);
  const plan = await newPlan(cwd);
  approveInCwd(cwd, plan.id);
  const res = await run(cwd, ['apply', plan.id], { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 1);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'partially_applied');
  assert.equal(out.error.op_index, 1);
  const { error } = JSON.parse(res.stderr);
  assert.equal(error.code, 'apply_failed');
  assert.equal(error.hint, `Run claudeflare rollback ${plan.id} to revert the ops that succeeded`);
});

test('cli apply whose first op fails says no write was made and does not suggest rollback', async (t) => {
  const cwd = tempDir(t, 'claudeflare-cli-');
  const base = await settingsStub(t, ['ssl']);
  const plan = await newPlan(cwd);
  approveInCwd(cwd, plan.id);
  const res = await run(cwd, ['apply', plan.id], { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stdout).status, 'failed');
  const { error } = JSON.parse(res.stderr);
  assert.equal(error.code, 'apply_failed');
  assert.match(error.hint, /no write was made/);
  assert.doesNotMatch(error.hint, /rollback/);
});

test('cli report accepts { domains, findings } and scores clean domains', async (t) => {
  const cwd = tempDir(t, 'claudeflare-cli-');
  const audit = {
    domains: ['ssl', 'dns', 'cache'],
    findings: [{ id: 'ssl.mode.flexible', domain: 'ssl', severity: 'critical', title: 'SSL mode is Flexible' }],
  };
  writeFileSync(join(cwd, 'audit.json'), JSON.stringify(audit));
  const res = await run(cwd, ['report', '--file', 'audit.json', '--zone', 'example.com']);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.overall, 92);
  assert.deepEqual(out.domains, { cache: 100, dns: 100, ssl: 75 });
  const md = readFileSync(out.file, 'utf8');
  assert.match(md, /Overall score: 92\/100/);
  assert.match(md, /\| dns \| 100 \|/);
});

test('cli plan new rejects ops outside the zone, Page Rule creates, placeholders and odd methods', async (t) => {
  const cwd = tempDir(t, 'claudeflare-cli-');
  const OTHER = 'fedcba9876543210fedcba9876543210';
  const bad = [
    { method: 'POST', path: '/accounts/abc/rulesets' },
    { method: 'PATCH', path: `/zones/${OTHER}/settings/ssl` },
    { method: 'PATCH', path: '/zones/{zone_id}' },
    { method: 'PATCH', path: '/zones/{zone_id}/../../accounts/abc/settings' },
    { method: 'PATCH', path: '/zones/{zone_id}/%2e%2e/x' },
    { method: 'PATCH', path: '/zones/{zone_id}/%2E%2e/%2e%2e/accounts/abc' },
    { method: 'PATCH', path: '/zones/{zone_id}/settings/ssl\t' },
    { method: 'PATCH', path: '/zones/{zone_id}/settings/ssl#frag' },
    { method: 'PATCH', path: '/zones/{zone_id}/..\\..\\accounts/abc' },
    { method: 'POST', path: '/zones/{zone_id}/pagerules' },
    { method: 'PATCH', path: '/zones/{zone_id}/rulesets/{ruleset_id}/rules/abc' },
    { method: 'PATCH', path: '/zones/{zone_id}/rulesets/RULESET_ID/rules/abc' },
    { method: 'patch', path: '/zones/{zone_id}/settings/ssl' },
    { method: 'OPTIONS', path: '/zones/{zone_id}/settings/ssl' },
    { method: 'PATCH ', path: '/zones/{zone_id}/settings/ssl' },
  ];
  for (const op of bad) {
    const draft = { zone_id: ZID, zone_name: 'example.com', summary: 's', risk: 'r', slug: 'x', ops: [op] };
    writeFileSync(join(cwd, 'draft.json'), JSON.stringify(draft));
    const res = await run(cwd, ['plan', 'new', '--file', 'draft.json']);
    assert.equal(res.code, 1, JSON.stringify(op));
    assert.equal(JSON.parse(res.stderr).error.code, 'invalid_op', JSON.stringify(op));
  }
  assert.equal(existsSync(join(cwd, '.claudeflare', 'plans')), false);
  const ok = { method: 'PATCH', path: '/zones/{zone_id}/settings/ssl', body: { value: 'strict' } };
  writeFileSync(join(cwd, 'draft.json'), JSON.stringify({ zone_id: ZID, zone_name: 'example.com', summary: 's', risk: 'r', slug: 'x', ops: [ok] }));
  assert.equal((await run(cwd, ['plan', 'new', '--file', 'draft.json'])).code, 0);
});

test('cli plan new accepts account plans with wrangler ops and the Pages rollback REST op', async (t) => {
  const cwd = tempDir(t, 'claudeflare-cli-');
  const AID = 'abcdef0123456789abcdef0123456789';
  const rollback = { method: 'POST', path: `/accounts/${AID}/pages/projects/my-site/deployments/0a1b2c3d-4e5f-6789-abcd-ef0123456789/rollback` };
  const draft = {
    scope: 'account',
    account_id: AID,
    account_name: 'Acme Corp',
    project_dir: cwd,
    summary: 's',
    risk: 'r',
    slug: 'deploy',
    ops: [{ kind: 'wrangler', args: ['deploy'] }, rollback],
  };
  writeFileSync(join(cwd, 'draft.json'), JSON.stringify(draft));
  const res = await run(cwd, ['plan', 'new', '--file', 'draft.json']);
  assert.equal(res.code, 0, res.stderr);
  const plan = JSON.parse(res.stdout);
  assert.equal(plan.scope, 'account');
  assert.equal(plan.account_slug, 'acme-corp');
  assert.match(plan.id, /^acmecorp-\d{8}-\d{6}-deploy$/);
  assert.deepEqual(plan.ops, draft.ops);
});

test('cli plan new rejects account plan ops outside the allowlist and wrangler ops in zone plans', async (t) => {
  const cwd = tempDir(t, 'claudeflare-cli-');
  const AID = 'abcdef0123456789abcdef0123456789';
  const OTHER = 'fedcba9876543210fedcba9876543210';
  const pages = `/pages/projects/my-site/deployments/0a1b2c3d/rollback`;
  const bad = [
    { method: 'GET', path: `/accounts/${AID}${pages}` },
    { method: 'POST', path: `/accounts/${OTHER}${pages}` },
    { method: 'POST', path: `/accounts/${AID}${pages}/extra` },
    { method: 'POST', path: `/accounts/${AID}/pages/projects/my-site/deployments` },
    { method: 'DELETE', path: `/accounts/${AID}/workers/scripts/api` },
    { method: 'POST', path: `/accounts/${AID}/pages/projects/my-site/deployments/../../x/deployments/y/rollback` },
    { method: 'PATCH', path: `/zones/${ZID}/settings/ssl` },
    { kind: 'wrangler', args: [] },
    { kind: 'wrangler', args: 'deploy' },
    { kind: 'wrangler' },
  ];
  const account = { scope: 'account', account_id: AID, account_name: 'Acme', project_dir: cwd, summary: 's', risk: 'r', slug: 'x' };
  for (const op of bad) {
    writeFileSync(join(cwd, 'draft.json'), JSON.stringify({ ...account, ops: [op] }));
    const res = await run(cwd, ['plan', 'new', '--file', 'draft.json']);
    assert.equal(res.code, 1, JSON.stringify(op));
    assert.equal(JSON.parse(res.stderr).error.code, 'invalid_op', JSON.stringify(op));
  }
  const zone = { zone_id: ZID, zone_name: 'example.com', summary: 's', risk: 'r', slug: 'x', ops: [{ kind: 'wrangler', args: ['deploy'] }] };
  writeFileSync(join(cwd, 'draft.json'), JSON.stringify(zone));
  const res = await run(cwd, ['plan', 'new', '--file', 'draft.json']);
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stderr).error.code, 'invalid_op');
  assert.equal(existsSync(join(cwd, '.claudeflare', 'plans')), false);
});

test('cli plan new reports invalid_account for a relative project_dir', async (t) => {
  const cwd = tempDir(t, 'claudeflare-cli-');
  const draft = {
    scope: 'account',
    account_id: 'abcdef0123456789abcdef0123456789',
    account_name: 'Acme',
    project_dir: '.',
    summary: 's',
    risk: 'r',
    slug: 'x',
    ops: [{ kind: 'wrangler', args: ['deploy'] }],
  };
  writeFileSync(join(cwd, 'draft.json'), JSON.stringify(draft));
  const res = await run(cwd, ['plan', 'new', '--file', 'draft.json']);
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stderr).error.code, 'invalid_account');
  assert.equal(existsSync(join(cwd, '.claudeflare', 'plans')), false);
});
