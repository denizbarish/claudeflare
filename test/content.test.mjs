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
