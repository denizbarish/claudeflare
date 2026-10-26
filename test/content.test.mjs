import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const list = (dir) => readdirSync(new URL(dir, root), { withFileTypes: true });

// Minimal frontmatter reader: top-level `key: value` lines between the --- fences.
function frontmatter(text, file) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, `${file} has no frontmatter`);
  const fields = {};
  for (const line of match[1].split('\n')) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

const markdownFiles = (dir) =>
  list(dir)
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => `${dir}/${e.name}`);

test('every skills/*/SKILL.md has frontmatter name equal to folder and a description', () => {
  const folders = list('skills').filter((e) => e.isDirectory()).map((e) => e.name);
  assert.ok(folders.length > 0, 'no skills found');
  for (const folder of folders) {
    const file = `skills/${folder}/SKILL.md`;
    const fm = frontmatter(read(file), file);
    assert.equal(fm.name, folder, `${file} name`);
    assert.ok(fm.description, `${file} description`);
  }
});

test('every agents/*.md has name and description frontmatter', () => {
  const files = markdownFiles('agents');
  assert.ok(files.length > 0, 'no agents found');
  for (const file of files) {
    const fm = frontmatter(read(file), file);
    assert.ok(fm.name, `${file} name`);
    assert.ok(fm.description, `${file} description`);
  }
});

test('every commands/*.md has description frontmatter', () => {
  const files = markdownFiles('commands');
  assert.ok(files.length > 0, 'no commands found');
  for (const file of files) {
    assert.ok(frontmatter(read(file), file).description, `${file} description`);
  }
});

test('.mcp.json declares cloudflare http server at https://mcp.cloudflare.com/mcp', () => {
  const server = JSON.parse(read('.mcp.json')).mcpServers.cloudflare;
  assert.equal(server.type, 'http');
  assert.equal(server.url, 'https://mcp.cloudflare.com/mcp');
});

test('cf-core contains the strings "claudeflare plan new", "/claudeflare:approve", "claudeflare apply", "claudeflare rollback"', () => {
  const core = read('skills/cf-core/SKILL.md');
  for (const needle of ['claudeflare plan new', '/claudeflare:approve', 'claudeflare apply', 'claudeflare rollback']) {
    assert.ok(core.includes(needle), `cf-core missing ${needle}`);
  }
});

// Asserts every heading appears as an exact `## ` line, in the given order.
function assertHeadingsInOrder(text, headings, file) {
  const lines = text.split('\n');
  let last = -1;
  for (const heading of headings) {
    const index = lines.indexOf(heading);
    assert.ok(index !== -1, `${file} missing heading "${heading}"`);
    assert.ok(index > last, `${file} heading "${heading}" out of order`);
    last = index;
  }
}

const DOMAIN_SECTIONS = ['## Read current state', '## Checks', '## Applying changes', '## Traps'];

function assertDomainSkill(folder, findingIds, sections = DOMAIN_SECTIONS) {
  const file = `skills/${folder}/SKILL.md`;
  const text = read(file);
  assertHeadingsInOrder(text, sections, file);
  for (const id of findingIds) {
    assert.ok(text.includes(`\`${id}\``), `${file} missing finding id ${id}`);
  }
}

const ZONE_CORE_FINDINGS = {
  'cf-dns': ['dns.proxy.origin_exposed', 'dns.dnssec.off', 'dns.caa.missing', 'dns.records.dangling', 'dns.mx.proxied', 'dns.proxy.non_http_service'],
  'cf-ssl': [
    'ssl.mode.flexible', 'ssl.mode.full_not_strict', 'ssl.always_https.off', 'ssl.min_tls.below_1_2',
    'ssl.hsts.off', 'ssl.tls13.off', 'ssl.auto_rewrites.off',
  ],
  'cf-cache': [
    'cache.rules.none_for_static', 'cache.browser_ttl.too_low', 'cache.tiered.off',
    'cache.html.cached_with_cookies', 'cache.level.bypass',
  ],
  'cf-performance': ['perf.http3.off', 'perf.brotli.off', 'perf.early_hints.off', 'perf.polish.off', 'perf.rocket_loader.risky'],
  'cf-rules': ['rules.page_rules.present', 'rules.redirect.chain', 'rules.redirect.loop_risk'],
};

for (const [folder, ids] of Object.entries(ZONE_CORE_FINDINGS)) {
  test(`${folder} has the four domain sections in order and every finding id`, () => {
    assertDomainSkill(folder, ids);
  });
}

const SECURITY_FINDINGS = {
  'cf-waf': [
    'waf.managed.off', 'waf.owasp.off', 'waf.custom.admin_unprotected', 'waf.skip.too_broad',
    'waf.security_level.essentially_off',
  ],
  'cf-bots-ratelimit': ['bots.fight_mode.off', 'ratelimit.login.missing', 'ratelimit.api.missing', 'turnstile.forms.missing'],
};

for (const [folder, ids] of Object.entries(SECURITY_FINDINGS)) {
  test(`${folder} has the four domain sections in order and every finding id`, () => {
    assertDomainSkill(folder, ids);
  });
}

test('cf-incident has Detect, Contain, Return to normal and Report in order, incident- slugs and GraphQL detection', () => {
  const file = 'skills/cf-incident/SKILL.md';
  const text = read(file);
  assertHeadingsInOrder(text, ['## Detect', '## Contain', '## Return to normal', '## Report'], file);
  assert.ok(/"slug": "incident-[a-z0-9-]+"/.test(text), `${file} has no incident- slug example`);
  assert.ok(text.includes('path: "/client/v4/graphql"'), `${file} has no GraphQL detection example`);
});

const TROUBLESHOOT_TREES = [
  '520', '521', '522', '523', '524', '525-526', '1xxx',
  'redirect-loop', 'cache-miss', 'cors', 'waf-false-positive',
];

for (const tree of TROUBLESHOOT_TREES) {
  test(`cf-troubleshoot tree ${tree} exists with Evidence, Hypotheses, Fix and Sources in order`, () => {
    const file = `skills/cf-troubleshoot/trees/${tree}.md`;
    const text = read(file);
    assert.ok(text.startsWith('# '), `${file} has no title`);
    assertHeadingsInOrder(text, ['## Evidence', '## Hypotheses', '## Fix', '## Sources'], file);
  });
}

test('cf-troubleshoot SKILL.md links every tree', () => {
  const file = 'skills/cf-troubleshoot/SKILL.md';
  const text = read(file);
  for (const tree of TROUBLESHOOT_TREES) {
    assert.ok(text.includes(`trees/${tree}.md`), `${file} does not link trees/${tree}.md`);
  }
});

// v2 developer platform

const DEV_FINDINGS = {
  'cf-workers': [
    'workers.compat_date.stale', 'workers.observability.off', 'workers.global_fetch.missing',
    'workers.cpu_limit.near', 'workers.routes.unprotected_workers_dev', 'workers.versions.no_gradual',
  ],
  'cf-pages': ['pages.production_branch.unprotected', 'pages.build.no_cache', 'pages.preview.public', 'pages.custom_domain.missing'],
  'cf-storage': [
    'd1.time_travel.unused_before_migration', 'd1.migrations.pending', 'r2.bucket.public_dev_url',
    'kv.namespace.unused', 'queues.dlq.missing',
  ],
};

for (const [folder, ids] of Object.entries(DEV_FINDINGS)) {
  test(`${folder} has the four domain sections in order, every finding id and sources`, () => {
    assertDomainSkill(folder, ids, [...DOMAIN_SECTIONS, '## Sources']);
  });
}

const DEV_TREES = ['1101', '1102', '1042', 'missing-binding', 'memory-limit', 'deploy-failed', 'pages-build-failed'];

for (const tree of DEV_TREES) {
  test(`cf-dev-troubleshoot tree ${tree} exists with Evidence, Hypotheses, Fix and Sources in order`, () => {
    const file = `skills/cf-dev-troubleshoot/trees/${tree}.md`;
    const text = read(file);
    assert.ok(text.startsWith('# '), `${file} has no title`);
    assertHeadingsInOrder(text, ['## Evidence', '## Hypotheses', '## Fix', '## Sources'], file);
  });
}

test('cf-dev-troubleshoot links every tree and shows claudeflare tail and a workersInvocationsAdaptive GraphQL query', () => {
  const file = 'skills/cf-dev-troubleshoot/SKILL.md';
  const text = read(file);
  for (const tree of DEV_TREES) assert.ok(text.includes(`trees/${tree}.md`), `${file} does not link trees/${tree}.md`);
  assert.ok(text.includes('claudeflare tail'), `${file} does not use claudeflare tail`);
  assert.ok(text.includes('workersInvocationsAdaptive'), `${file} has no workersInvocationsAdaptive query`);
  assert.ok(text.includes('path: "/client/v4/graphql"'), `${file} has no GraphQL example in canonical form`);
});

test('cf-core documents account plans, the wrangler op fields, preflight, tail, secrets and the v2 errors and statuses', () => {
  const core = read('skills/cf-core/SKILL.md');
  for (const needle of [
    '"scope": "account"', '"kind": "wrangler"', 'confirm_name', 'value_from_env', 'health_check', 'on_failed_check',
    'claudeflare preflight', 'claudeflare tail', 'source_hash', 'pending_migrations',
    'preflight_failed', 'source_changed', 'source_hash_missing', 'secret_env_missing', 'account_mismatch', 'wrangler_failed',
    'resource_not_empty', 'rollback_not_empty', 'rollback_ambiguous', 'applied_check_failed', 'rolled_back_auto',
  ]) {
    assert.ok(core.includes(needle), `cf-core is missing ${needle}`);
  }
  assert.match(core, /never ask the user to paste a secret/i);
});

test('cf-audit lists the workers, pages and storage domains', () => {
  const audit = read('skills/cf-audit/SKILL.md');
  for (const domain of ['workers', 'pages', 'storage']) {
    assert.ok(audit.includes(`\`${domain}\``), `cf-audit is missing domain ${domain}`);
  }
});

// v3 Zero Trust and network

const ZT_FINDINGS = {
  'cf-tunnel': [
    'tunnel.status.down', 'tunnel.connectors.single', 'tunnel.config.no_catch_all',
    'tunnel.dns.stale_cname', 'tunnel.config.local_managed',
  ],
  'cf-access': [
    'access.policy.everyone_allow', 'access.app.no_mfa', 'access.session.long',
    'access.service_token.expiring', 'access.group.unused', 'access.idp.single_login_method',
  ],
  'cf-gateway': [
    'gateway.dns.no_security_baseline', 'gateway.rule.shadowed', 'gateway.tls.decrypt_off_with_http_rules',
    'gateway.list.unused', 'gateway.location.none',
  ],
  'cf-devices': [
    'devices.switch.unlocked_with_posture', 'devices.exclude.no_local_networks', 'devices.profile.unused', 'devices.posture.unused',
  ],
};

for (const [folder, ids] of Object.entries(ZT_FINDINGS)) {
  test(`${folder} has the four domain sections in order, every finding id and sources`, () => {
    assertDomainSkill(folder, ids, [...DOMAIN_SECTIONS, '## Sources']);
  });
}

test('cf-tunnel documents tunnel-token with --env-path and the connector templates', () => {
  const file = 'skills/cf-tunnel/SKILL.md';
  const text = read(file);
  for (const needle of [
    'claudeflare tunnel-token', '--env-path', 'TUNNEL_TOKEN', 'cloudflare/cloudflared:<pinned tag>',
    'tunnel --no-autoupdate run', 'restart: unless-stopped', 'replicas: 2', 'EnvironmentFile=', 'kubectl create secret',
    '"config_src": "cloudflare"', 'confirm_name', 'Lockout risk:', '1016', '1033',
  ]) {
    assert.ok(text.includes(needle), `${file} is missing ${needle}`);
  }
  assert.ok(!/tunnel-token[^\n]*--env-file/.test(text), `${file} documents --env-file for tunnel-token`);
});

test('cf-audit lists the tunnel domain', () => {
  const audit = read('skills/cf-audit/SKILL.md');
  assert.ok(audit.includes('`cf-tunnel`'), 'cf-audit does not name cf-tunnel');
  assert.ok(audit.includes('`tunnel`'), 'cf-audit is missing domain tunnel');
});

test('cf-access documents secret_fields_from_env, the service token secret file and the lockout lines', () => {
  const file = 'skills/cf-access/SKILL.md';
  const text = read(file);
  for (const needle of [
    'secret_fields_from_env', '"config.client_secret"', '.claudeflare/secrets/', 'shown only once', '[redacted]',
    'confirm_name', 'Lockout risk:', 'resource_in_use', 'not_entitled', 'new AUD', 'cloudflareaccess.com', '"expect": "access_login"',
  ]) {
    assert.ok(text.includes(needle), `${file} is missing ${needle}`);
  }
  assert.ok(!/"client_secret":\s*"[^<]/.test(text), `${file} shows a literal client_secret`);
});

test('cf-audit lists the access domain', () => {
  const audit = read('skills/cf-audit/SKILL.md');
  assert.ok(audit.includes('`cf-access`'), 'cf-audit does not name cf-access');
  assert.ok(audit.includes('`access`'), 'cf-audit is missing domain access');
});

test('cf-gateway documents rule order, list limits, the lockout lines and the honest verification note', () => {
  const file = 'skills/cf-gateway/SKILL.md';
  const text = read(file);
  for (const needle of [
    'precedence', 'plan_conflict', 'too_large', 'resource_in_use', 'not_entitled', 'confirm_name', 'Lockout risk:',
    'could not analyze traffic expression of rule', 'cloudflareaccess.com', 'cloudflareclient.com', 'dig ',
    'filtering itself is only verified from a device behind Gateway', 'PATCH `/gateway/configuration`',
  ]) {
    assert.ok(text.includes(needle), `${file} is missing ${needle}`);
  }
});

test('cf-audit lists the gateway domain', () => {
  const audit = read('skills/cf-audit/SKILL.md');
  assert.ok(audit.includes('`cf-gateway`'), 'cf-audit does not name cf-gateway');
  assert.ok(audit.includes('`gateway`'), 'cf-audit is missing domain gateway');
});

test('cf-devices documents the mode switch, the lockout lines, the MDM templates and the secret placeholder rule', () => {
  const file = 'skills/cf-devices/SKILL.md';
  const text = read(file);
  for (const needle of [
    'plan_conflict', 'resource_in_use', 'not_entitled', 'invalid_op', 'confirm_name', 'Lockout risk:', 'switch_locked', 'disable_for_time',
    'cloudflareaccess.com', '{created_id}', 'device behavior is only verified on a device', 'mdm.xml', 'com.cloudflare.warp.plist',
    'auth_client_secret', 'REPLACE_WITH_SERVICE_TOKEN_CLIENT_SECRET', 'Explain the steps by default',
  ]) {
    assert.ok(text.includes(needle), `${file} is missing ${needle}`);
  }
  // Every secret field in a template is the placeholder, never a value.
  for (const m of text.matchAll(/auth_client_secret(?:<\/key>\s*<string>|"\s*:\s*")([^<"]*)/g)) {
    assert.equal(m[1], 'REPLACE_WITH_SERVICE_TOKEN_CLIENT_SECRET', `${file} shows a literal auth_client_secret`);
  }
  assert.ok([...text.matchAll(/auth_client_secret(?:<\/key>\s*<string>|"\s*:\s*")/g)].length >= 3, `${file} lacks an MDM template per OS`);
});

test('cf-audit lists the devices domain', () => {
  const audit = read('skills/cf-audit/SKILL.md');
  assert.ok(audit.includes('`cf-devices`'), 'cf-audit does not name cf-devices');
  assert.ok(audit.includes('`devices`'), 'cf-audit is missing domain devices');
});
