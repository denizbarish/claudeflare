import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));

test('plugin.json has name claudeflare and semver version 0.3.1', () => {
  const p = readJson('.claude-plugin/plugin.json');
  assert.equal(p.name, 'claudeflare');
  assert.equal(p.version, '0.3.1');
  assert.ok(p.description);
  assert.equal(p.license, 'MIT');
});

test('package.json version matches plugin.json', () => {
  assert.equal(readJson('package.json').version, readJson('.claude-plugin/plugin.json').version);
});

test('CHANGELOG has a 0.3.0 entry and its compare link', () => {
  const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8');
  assert.match(changelog, /^## \[0\.3\.0\] - \d{4}-\d{2}-\d{2}$/m);
  assert.match(changelog, /^\[0\.3\.0\]: https:\/\/github\.com\/denizbarish\/claudeflare\/compare\/v0\.2\.1\.\.\.v0\.3\.0$/m);
});

test('marketplace.json lists claudeflare with source "./"', () => {
  const m = readJson('.claude-plugin/marketplace.json');
  assert.equal(m.name, 'claudeflare');
  assert.equal(m.plugins[0].name, 'claudeflare');
  assert.equal(m.plugins[0].source, './');
});

test('package.json is ESM, engines node >=18, no dependencies', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=18');
  assert.ok(!pkg.dependencies && !pkg.devDependencies);
});
