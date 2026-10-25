import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { computeSourceHash } from '../scripts/lib/source-hash.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/;

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const GIT = hasGit();

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cf-source-hash-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(dir, rel, content) {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function makeTree(dir) {
  mkdirSync(dir, { recursive: true });
  write(dir, 'src/index.js', 'export default { fetch() { return new Response("hi"); } };\n');
  write(dir, 'wrangler.jsonc', '{ "name": "api" }\n');
  write(dir, 'package.json', '{ "name": "api" }\n');
  return dir;
}

function git(dir, ...args) {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

function gitTree(dir) {
  makeTree(dir);
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  return dir;
}

// Non-git mode

test('returns sha256:<hex> and is stable for the same tree', () => {
  const dir = makeTree(join(root, 'p'));
  const h = computeSourceHash(dir);
  assert.match(h, HASH);
  assert.equal(computeSourceHash(dir), h);
});

test('identical trees in different directories hash the same', () => {
  const a = makeTree(join(root, 'a'));
  const b = makeTree(join(root, 'b'));
  assert.equal(computeSourceHash(a), computeSourceHash(b));
});

test('content change, new file, deleted file and rename change the hash', () => {
  const dir = makeTree(join(root, 'p'));
  const base = computeSourceHash(dir);

  write(dir, 'src/index.js', 'changed\n');
  const changed = computeSourceHash(dir);
  assert.notEqual(changed, base);

  write(dir, 'src/extra.js', 'x\n');
  const added = computeSourceHash(dir);
  assert.notEqual(added, changed);

  unlinkSync(join(dir, 'src/extra.js'));
  assert.equal(computeSourceHash(dir), changed);
  unlinkSync(join(dir, 'package.json'));
  assert.notEqual(computeSourceHash(dir), changed);

  const fresh = makeTree(join(root, 'q'));
  const before = computeSourceHash(fresh);
  renameSync(join(fresh, 'src/index.js'), join(fresh, 'src/main.js'));
  assert.notEqual(computeSourceHash(fresh), before);
});

test('changes in excluded directories do not change the hash', () => {
  const dir = makeTree(join(root, 'p'));
  const base = computeSourceHash(dir);
  write(dir, '.claudeflare/plans/x.json', '{}');
  write(dir, 'node_modules/dep/index.js', 'module.exports = 1;');
  write(dir, '.wrangler/tmp/bundle.js', 'bundle');
  write(dir, '.git/HEAD', 'ref: refs/heads/main');
  write(dir, 'src/node_modules/nested/index.js', 'nested');
  assert.equal(computeSourceHash(dir), base);
});

test('file count limit -> project_too_large', () => {
  const dir = makeTree(join(root, 'p'));
  assert.match(computeSourceHash(dir, { maxFiles: 3 }), HASH);
  assert.throws(() => computeSourceHash(dir, { maxFiles: 2 }), { code: 'project_too_large' });
});

test('symlink is hashed by its target string and not followed', (t) => {
  const dir = makeTree(join(root, 'p'));
  const outside = join(root, 'outside');
  write(outside, 'secret.txt', 'one');
  try {
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'link'));
  } catch (err) {
    t.skip(`symlinks unavailable: ${err.code}`);
    return;
  }
  symlinkSync(outside, join(dir, 'linkdir'));
  const base = computeSourceHash(dir);

  write(outside, 'secret.txt', 'two');
  write(outside, 'new.txt', 'new');
  assert.equal(computeSourceHash(dir), base, 'outside content must not affect the hash');

  unlinkSync(join(dir, 'link'));
  symlinkSync(join(outside, 'new.txt'), join(dir, 'link'));
  assert.notEqual(computeSourceHash(dir), base, 'retargeting a link changes the hash');
});

// Git mode

test('git: tracked plus untracked non-ignored files; ignored files excluded', (t) => {
  if (!GIT) return t.skip('git not available');
  const dir = gitTree(join(root, 'g'));
  write(dir, '.gitignore', 'dist/\n*.log\n');
  const base = computeSourceHash(dir);

  write(dir, 'dist/out.js', 'built');
  write(dir, 'debug.log', 'log');
  assert.equal(computeSourceHash(dir), base, 'ignored files do not count');

  write(dir, 'src/untracked.js', 'u');
  assert.notEqual(computeSourceHash(dir), base, 'untracked non-ignored files count');
});

test('git: content change, deletion and rename change the hash; excluded dirs do not', (t) => {
  if (!GIT) return t.skip('git not available');
  const dir = gitTree(join(root, 'g'));
  const base = computeSourceHash(dir);

  write(dir, '.claudeflare/plans/x.json', '{}');
  write(dir, 'node_modules/dep/index.js', 'x');
  write(dir, '.wrangler/state/x', 'x');
  assert.equal(computeSourceHash(dir), base);

  write(dir, 'src/index.js', 'changed\n');
  const changed = computeSourceHash(dir);
  assert.notEqual(changed, base);

  unlinkSync(join(dir, 'wrangler.jsonc'));
  const deleted = computeSourceHash(dir);
  assert.notEqual(deleted, changed, 'tracked file deleted from disk changes the hash');

  renameSync(join(dir, 'src/index.js'), join(dir, 'src/main.js'));
  assert.notEqual(computeSourceHash(dir), deleted);
});

test('git: tracked node_modules is still excluded', (t) => {
  if (!GIT) return t.skip('git not available');
  const dir = gitTree(join(root, 'g'));
  const base = computeSourceHash(dir);
  write(dir, 'node_modules/dep/index.js', 'x');
  git(dir, 'add', '-f', 'node_modules');
  assert.equal(computeSourceHash(dir), base);
});

test('git and non-git trees with the same files hash the same', (t) => {
  if (!GIT) return t.skip('git not available');
  const plain = makeTree(join(root, 'plain'));
  const repo = gitTree(join(root, 'repo'));
  assert.equal(computeSourceHash(repo), computeSourceHash(plain));
});

test('git: project_dir in a repo subdirectory lists only its own files', (t) => {
  if (!GIT) return t.skip('git not available');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  write(repo, 'README.md', 'top');
  makeTree(join(repo, 'apps/api'));
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  const sub = join(repo, 'apps/api');
  const base = computeSourceHash(sub);

  assert.equal(base, computeSourceHash(makeTree(join(root, 'plain'))), 'paths are relative to project_dir');
  write(repo, 'README.md', 'changed');
  write(repo, 'apps/other/x.js', 'x');
  assert.equal(computeSourceHash(sub), base, 'files outside project_dir do not count');
  write(sub, 'src/index.js', 'changed');
  assert.notEqual(computeSourceHash(sub), base);
});

test('git: file count limit -> project_too_large', (t) => {
  if (!GIT) return t.skip('git not available');
  const dir = gitTree(join(root, 'g'));
  assert.match(computeSourceHash(dir, { maxFiles: 3 }), HASH);
  assert.throws(() => computeSourceHash(dir, { maxFiles: 2 }), { code: 'project_too_large' });
});

test('git: symlink is hashed by its target string', (t) => {
  if (!GIT) return t.skip('git not available');
  const dir = gitTree(join(root, 'g'));
  const outside = join(root, 'outside');
  write(outside, 'a.txt', 'one');
  try {
    symlinkSync(join(outside, 'a.txt'), join(dir, 'link'));
  } catch (err) {
    t.skip(`symlinks unavailable: ${err.code}`);
    return;
  }
  git(dir, 'add', 'link');
  const base = computeSourceHash(dir);
  write(outside, 'a.txt', 'two');
  assert.equal(computeSourceHash(dir), base);
  unlinkSync(join(dir, 'link'));
  symlinkSync(join(outside, 'b.txt'), join(dir, 'link'));
  assert.notEqual(computeSourceHash(dir), base);
});
