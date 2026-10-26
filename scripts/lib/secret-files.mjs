// Files under .claudeflare/secrets hold credentials the API returns once
// (service token client secrets). They are written with mode 0600, kept out of
// git by .claudeflare/.gitignore and listed in secret-files.json so the user
// can find and delete them. Nothing here prints a file's contents.
//
// No write follows a symlink: .claudeflare and .claudeflare/secrets must be
// real directories, and every file is created with O_EXCL | O_NOFOLLOW (an
// existing regular file is removed first), so a planted link cannot redirect
// a secret elsewhere and a file never exists with a wider mode.

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { keyDir } from './approval-key.mjs';
import { paths } from './paths.mjs';

const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const GITIGNORE_LINE = 'secrets/';
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function refuseLink(path, stat) {
  if (stat?.isSymbolicLink()) throw new Error(`Refusing to write through the symlink ${path}`);
}

// Creates the directory if needed and refuses a symlink or a non-directory.
function realDir(path, mode) {
  if (!lstatOrNull(path)) mkdirSync(path, { recursive: true, mode });
  const stat = lstatSync(path);
  refuseLink(path, stat);
  if (!stat.isDirectory()) throw new Error(`${path} is not a directory`);
}

function writeFd(fd, content, mode) {
  try {
    fchmodSync(fd, mode);
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

// Replaces file with content, never following a link at the file itself.
// The content goes to a new temp file in the same folder first and is renamed
// over file, so a crash or a failed write never leaves file missing or half
// written (the index would otherwise lose its entries).
function replaceFile(file, content, mode) {
  const stat = lstatOrNull(file);
  refuseLink(file, stat);
  if (stat && !stat.isFile()) throw new Error(`${file} is not a regular file`);
  const temp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
  try {
    writeFd(fd, content, mode);
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

export function readOrEmpty(file) {
  const stat = lstatOrNull(file);
  if (!stat) return '';
  refuseLink(file, stat);
  return readFileSync(file, 'utf8');
}

function ensureGitignore(cwd) {
  const file = join(paths(cwd).root, '.gitignore');
  const content = readOrEmpty(file);
  if (content.split(/\r?\n/).some((line) => line.trim() === GITIGNORE_LINE)) return;
  const separator = content && !content.endsWith('\n') ? '\n' : '';
  const flags = content === '' && !lstatOrNull(file)
    ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW
    : constants.O_WRONLY | constants.O_APPEND | NOFOLLOW;
  const fd = openSync(file, flags, 0o644);
  try {
    writeSync(fd, `${separator}${GITIGNORE_LINE}\n`);
  } finally {
    closeSync(fd);
  }
}

// name is a plain file name inside the secrets dir. Returns the absolute path.
export function writeSecretFile(cwd, name, data) {
  if (typeof name !== 'string' || !SAFE_NAME.test(name) || name.includes('..')) {
    throw new TypeError(`Invalid secret file name: ${JSON.stringify(name)}`);
  }
  const { root, secrets } = paths(cwd);
  realDir(root, 0o755);
  realDir(secrets, 0o700);
  chmodSync(secrets, 0o700);
  // The ignore line goes in before the secret lands on disk.
  ensureGitignore(cwd);
  const file = join(secrets, name);
  replaceFile(file, `${JSON.stringify(data, null, 2)}\n`, 0o600);
  return file;
}

function readIndex(file) {
  const content = readOrEmpty(file);
  if (content === '') return [];
  const index = JSON.parse(content);
  return Array.isArray(index?.files) ? index.files.filter((f) => typeof f === 'string') : [];
}

function addToIndex(dir, dirMode, file, absPath) {
  if (typeof absPath !== 'string' || !isAbsolute(absPath)) {
    throw new TypeError(`Secret file path must be absolute: ${JSON.stringify(absPath)}`);
  }
  const files = readIndex(file);
  if (files.includes(absPath)) return;
  realDir(dir, dirMode);
  replaceFile(file, `${JSON.stringify({ files: [...files, absPath] }, null, 2)}\n`, 0o600);
}

export function listSecretFiles(cwd) {
  return readIndex(paths(cwd).secretFilesIndex);
}

export function recordSecretFile(cwd, absPath) {
  addToIndex(paths(cwd).root, 0o755, paths(cwd).secretFilesIndex, absPath);
}

// Per-user index in the approval key dir (guarded like the key): the guard
// finds a secret file here even when no project index is in reach.
export const globalSecretIndex = () => join(keyDir(), 'secret-files.json');

export function listGlobalSecretFiles() {
  return readIndex(globalSecretIndex());
}

export function recordGlobalSecretFile(absPath) {
  addToIndex(keyDir(), 0o700, globalSecretIndex(), absPath);
}
