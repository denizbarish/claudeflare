import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
