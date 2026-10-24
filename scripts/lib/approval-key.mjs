import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CfError } from './errors.mjs';

const KEY_FILE = 'approval.key';
const KEY_BYTES = 32;

export function keyDir() {
  return process.env.CLAUDEFLARE_KEY_DIR || join(homedir(), '.config', 'claudeflare');
}

// A key file of the wrong length counts as missing: approvals never verify
// against it and a new approval is refused until the file is deleted.
function readKey(file) {
  let key;
  try {
    key = readFileSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return key.length === KEY_BYTES ? key : null;
}

function badKey(file) {
  return new CfError('bad_key', `Approval key ${file} is not ${KEY_BYTES} bytes`, {
    hint: `Delete ${file}; a new key is created on the next /claudeflare:approve (existing approvals become invalid)`,
  });
}

export function getApprovalKey({ create = false } = {}) {
  const dir = keyDir();
  const file = join(dir, KEY_FILE);
  if (!create) return readKey(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  try {
    writeFileSync(file, key, { flag: 'wx', mode: 0o600 });
    return key;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const existing = readKey(file);
  if (!existing) throw badKey(file);
  return existing;
}
