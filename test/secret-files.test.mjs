import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../scripts/lib/paths.mjs';
import { listSecretFiles, recordSecretFile, writeSecretFile } from '../scripts/lib/secret-files.mjs';

function tmp(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'claudeflare-secrets-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

const mode = (file) => statSync(file).mode & 0o777;

test('paths names the secrets dir and the secret files index', () => {
  assert.equal(paths('/w').secrets, join('/w', '.claudeflare', 'secrets'));
  assert.equal(paths('/w').secretFilesIndex, join('/w', '.claudeflare', 'secret-files.json'));
});

test('writeSecretFile writes JSON with mode 0600 under .claudeflare/secrets and returns the path', (t) => {
  const cwd = tmp(t);
  const file = writeSecretFile(cwd, 'plan-1-0.json', { client_id: 'cid', client_secret: 'csec' });
  assert.equal(file, join(paths(cwd).secrets, 'plan-1-0.json'));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { client_id: 'cid', client_secret: 'csec' });
  assert.equal(mode(file), 0o600);
  assert.equal(mode(paths(cwd).secrets), 0o700);
});

test('writeSecretFile keeps mode 0600 when the file already existed with a wider mode', (t) => {
  const cwd = tmp(t);
  mkdirSync(paths(cwd).secrets, { recursive: true });
  const existing = join(paths(cwd).secrets, 'x.json');
  writeFileSync(existing, '{}', { mode: 0o644 });
  writeSecretFile(cwd, 'x.json', { a: 1 });
  assert.equal(mode(existing), 0o600);
});

test('writeSecretFile refuses names that leave the secrets dir', (t) => {
  const cwd = tmp(t);
  for (const name of ['../x.json', 'a/b.json', '.hidden', '', 'a\\b.json', '..']) {
    assert.throws(() => writeSecretFile(cwd, name, {}), /secret file name/, name);
  }
});

test('.claudeflare/.gitignore gets one secrets/ line, created or appended, idempotent', (t) => {
  const cwd = tmp(t);
  const gitignore = join(cwd, '.claudeflare', '.gitignore');
  writeSecretFile(cwd, 'a.json', {});
  assert.equal(readFileSync(gitignore, 'utf8'), 'secrets/\n');
  writeSecretFile(cwd, 'b.json', {});
  assert.equal(readFileSync(gitignore, 'utf8'), 'secrets/\n');

  const other = tmp(t);
  mkdirSync(join(other, '.claudeflare'), { recursive: true });
  writeFileSync(join(other, '.claudeflare', '.gitignore'), 'tmp/');
  writeSecretFile(other, 'a.json', {});
  writeSecretFile(other, 'b.json', {});
  assert.equal(readFileSync(join(other, '.claudeflare', '.gitignore'), 'utf8'), 'tmp/\nsecrets/\n');
});

test('recordSecretFile adds each path once and listSecretFiles returns them', (t) => {
  const cwd = tmp(t);
  assert.deepEqual(listSecretFiles(cwd), []);
  const a = writeSecretFile(cwd, 'a.json', {});
  const b = writeSecretFile(cwd, 'b.json', {});
  recordSecretFile(cwd, a);
  recordSecretFile(cwd, b);
  recordSecretFile(cwd, a);
  assert.deepEqual(listSecretFiles(cwd), [a, b]);
  assert.deepEqual(JSON.parse(readFileSync(paths(cwd).secretFilesIndex, 'utf8')), { files: [a, b] });
});

test('recordSecretFile refuses a relative path', (t) => {
  const cwd = tmp(t);
  assert.throws(() => recordSecretFile(cwd, 'secrets/a.json'), /absolute/);
});

test('a symlinked secrets dir or .claudeflare dir is refused and nothing is written through it', (t) => {
  const cwd = tmp(t);
  const elsewhere = tmp(t);
  mkdirSync(join(cwd, '.claudeflare'));
  symlinkSync(elsewhere, paths(cwd).secrets);
  assert.throws(() => writeSecretFile(cwd, 'a.json', { s: 'x' }), /symlink/);
  assert.deepEqual(readdirSync(elsewhere), []);

  const other = tmp(t);
  const target = tmp(t);
  symlinkSync(target, join(other, '.claudeflare'));
  assert.throws(() => writeSecretFile(other, 'a.json', { s: 'x' }), /symlink/);
  assert.throws(() => recordSecretFile(other, join(target, 'a.json')), /symlink/);
  assert.deepEqual(readdirSync(target), []);
});

test('a symlink at the target file, the index or .gitignore is refused', (t) => {
  const cwd = tmp(t);
  const outside = join(tmp(t), 'victim.txt');
  writeFileSync(outside, 'keep');
  mkdirSync(paths(cwd).secrets, { recursive: true });
  symlinkSync(outside, join(paths(cwd).secrets, 'x.json'));
  assert.throws(() => writeSecretFile(cwd, 'x.json', { s: 'x' }), /symlink/);
  assert.equal(readFileSync(outside, 'utf8'), 'keep');

  symlinkSync(outside, paths(cwd).secretFilesIndex);
  assert.throws(() => recordSecretFile(cwd, join(paths(cwd).secrets, 'y.json')), /symlink/);
  assert.equal(readFileSync(outside, 'utf8'), 'keep');

  const other = tmp(t);
  mkdirSync(join(other, '.claudeflare'));
  symlinkSync(outside, join(other, '.claudeflare', '.gitignore'));
  assert.throws(() => writeSecretFile(other, 'a.json', {}), /symlink/);
  assert.equal(readFileSync(outside, 'utf8'), 'keep');
  assert.equal(existsSync(join(other, '.claudeflare', 'secrets', 'a.json')), false);
});
