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
  'cf-dns': ['dns.proxy.origin_exposed', 'dns.dnssec.off', 'dns.caa.missing', 'dns.records.dangling', 'dns.mx.proxied'],
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
