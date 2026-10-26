import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));

test('plugin.json has name claudeflare and semver version 0.2.1', () => {
  const p = readJson('.claude-plugin/plugin.json');
  assert.equal(p.name, 'claudeflare');
  assert.equal(p.version, '0.2.1');
  assert.ok(p.description);
  assert.equal(p.license, 'MIT');
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
