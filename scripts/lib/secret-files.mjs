// Files under .claudeflare/secrets hold credentials the API returns once
// (service token client secrets). They are written with mode 0600, kept out of
// git by .claudeflare/.gitignore and listed in secret-files.json so the user
// can find and delete them. Nothing here prints a file's contents.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { paths } from './paths.mjs';

const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const GITIGNORE_LINE = 'secrets/';

function ensureGitignore(cwd) {
  const file = join(paths(cwd).root, '.gitignore');
  let content = '';
  try {
    content = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (content.split(/\r?\n/).some((line) => line.trim() === GITIGNORE_LINE)) return;
  const separator = content && !content.endsWith('\n') ? '\n' : '';
  writeFileSync(file, `${content}${separator}${GITIGNORE_LINE}\n`);
}

// name is a plain file name inside the secrets dir. Returns the absolute path.
export function writeSecretFile(cwd, name, data) {
  if (typeof name !== 'string' || !SAFE_NAME.test(name) || name.includes('..')) {
    throw new TypeError(`Invalid secret file name: ${JSON.stringify(name)}`);
  }
  const dir = paths(cwd).secrets;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // The ignore line goes in before the secret lands on disk.
  ensureGitignore(cwd);
  const file = join(dir, name);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  // mode applies only when the file is created.
  chmodSync(file, 0o600);
  return file;
}

export function listSecretFiles(cwd) {
  try {
    const index = JSON.parse(readFileSync(paths(cwd).secretFilesIndex, 'utf8'));
    return Array.isArray(index?.files) ? index.files.filter((f) => typeof f === 'string') : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export function recordSecretFile(cwd, absPath) {
  if (typeof absPath !== 'string' || !isAbsolute(absPath)) {
    throw new TypeError(`Secret file path must be absolute: ${JSON.stringify(absPath)}`);
  }
  const files = listSecretFiles(cwd);
  if (files.includes(absPath)) return;
  mkdirSync(paths(cwd).root, { recursive: true });
  writeFileSync(paths(cwd).secretFilesIndex, `${JSON.stringify({ files: [...files, absPath] }, null, 2)}\n`);
}
